# Sub-agent 链路修复方案

日期：2026-08-09
基线：`1e9d333`
对应审查：`docs/subagent-chain-review-2026-08-09.md`（已逐条核实，结论见该文件的 triage 回复）

三批提交，互不阻塞，建议按 A → B → C 顺序。A 修的是"结果会静默丢失"，B 修的是"跨重启的生命周期承诺"，C 是准确性与体验清理。

---

## A 批：结果不再静默丢失（约 150 行）

### A-1 外部路径复用同一份任务信封

**问题**：`src/subagents/tool.ts:773` 直接传 `task: params.task`。外部角色的 `contextMode` / `memory` / `paths`（`discovery.ts:620-626` 已解析）永不生效；`purpose=verify` 不注入 VERDICT 协议，却在 `external/run.ts:277` 解析它 —— 外部 verify 目前基本必然 FAIL。

**改法**：外部分支复用已有的两个函数，不引入新抽象。

`src/subagents/tool.ts`，`if (config.runtime === "external")` 分支内，`launchExternalRun` 调用前：

```ts
const contextualBlocks = await buildContextualBlocks(params.task, config, options, currentModel);
const envelopedTask = buildSubAgentTask(
    params.task,
    config,
    options.runtimeContext,
    contextualBlocks,
    runContext,
    returns,
);
```

`launchExternalRun({ ..., task: envelopedTask, ... })`。

`buildContextualBlocks` 在 `config.contextMode !== "contextual"` 时返回 `[]`，外部角色默认 `isolated`，所以默认行为不变；只有显式声明了 `contextMode` 的角色才会拿到 context。

**follow_up**：`src/tools/subagent-manage.ts` 的 resume 复用已有会话，运行时上下文已在首轮注入，正文保持原样；只在 `record.purpose === "verify"` 时把 `buildSubAgentTask` 里那 4 行 Verification protocol 追加到 `task` 尾部。为此把这段协议文本从 `buildSubAgentTask` 抽成导出的 `buildVerificationProtocol(taskPath: string): string`，两处共用。

**验证**：新测试断言外部 dispatch 后 `<artifactDir>/prompt.txt` 含工作目录、产物目录、`paths`，`purpose=verify` 时含 `VERDICT: PASS`。

---

### A-2 archive 失败不得阻断完成唤醒

**问题**：`src/runtime/store.ts:151` 队列满时抛错；`runs.ts:502` 的 `await this.options.store?.logSubAgentRun(...)` 让异常穿出 `settle()`，wake 永不发出。内存里 `settledAt` 已置，重试直接 return —— 完成结果永久沉默。

**改法**：`src/subagents/runs.ts`，`settle()` 内：

```ts
await this.options.store
    ?.logSubAgentRun(record.channelId, { ... })
    .catch((error) => log.logWarning(`Failed to archive sub-agent run ${record.runId}`, errorMessage(error)));
```

可观测面失败绝不能吃掉交付。

---

### A-3 restore 补发未送达的 wake

**问题**：`restore()` 只处理 `status === "running"`；`settledAt` 已置但 `wakeEnqueued` 未置的记录（A-2 那类崩溃、或 dispatch 抛错后走了 `announce()` 的 early return）永远等不到唤醒。

**改法**：`src/subagents/runs.ts` `restore()` 循环内，现有两个 `runtime` 分支之后、GC 之前：

```ts
if (isTerminal(record.status) && record.settledAt && !record.wakeEnqueued) {
    const outputText = await readFile(join(record.artifactDir, "output.md"), "utf-8").catch(() => "");
    await this.announce(record, outputText, Boolean(outputText.trim())).catch((error) => {
        log.logWarning(`Failed to re-announce sub-agent run ${record.runId}`, errorMessage(error));
    });
}
```

durable dispatch 对同一 `dispatchId` 幂等，所以重复 announce 无害。

---

### A-4 settle 顺序：持久化先于副作用

**问题**：`runs.ts:459-479` 先做副作用（写 output、放 lease）再 `persist(record)`，且该 persist 不是 required。持久化失败后副作用已发生，重启读到旧的 `running` 记录会重新结算 → 重复记账。

**改法**：重排为「终态先落盘，落盘失败就整体退回」，这是重排不是 saga：

```ts
const previous = { status: record.status, finishedAt: record.finishedAt, settledAt: record.settledAt };
record.status = input.status;
/* ...其余终态字段... */
record.finishedAt = Date.now();
record.settledAt = record.finishedAt;
try {
    await this.persist(record, true);
} catch (error) {
    Object.assign(record, previous);   // 未产生任何副作用，留在 running 让重启重来
    throw error;
}
// —— 以下才是副作用 ——
const outputSaved = await this.writeOutputFile(record, input.outputText);
releaseWorkspaceLease(record.leaseKey);
record.leaseKey = undefined;            // 见 A-6
this.cancelHandles.delete(runId);
this.externalLaunches.delete(runId);
/* usage → archive(A-2) → wake */
```

**不做**：ledger 按 `runId` 去重。需要读回 ledger 才能实现，换来的只是"磁盘写失败后 token 统计多算一次"，个人助手场景不值。

---

### A-5 外部 `durationMs` 归零

**问题**：`external/run.ts:320` 固定写 `durationMs: 0`，唤醒消息显示 `0s`，archive 同样失真（`/subagents` 用 `elapsedMs` 所以人侧正确）。

**改法**：`run.ts` 在 `setLaunched` 之后记 `const startedAt = Date.now();`，settle 时传 `durationMs: Date.now() - startedAt`。取消/失败分支的 `failedSettleInput` 同样带上。

---

### A-6 终态记录不再显示"持有写锁"

**问题**：`settle()` 释放了 lease 但保留 `record.leaseKey`，`subagent-manage.ts:49` 与 `runtime/subagent-commands.ts:103,218` 都据此显示 "lease held" / "持有写锁"。

**改法**：见 A-4，释放后立即 `record.leaseKey = undefined`。展示面不用改——`leaseKey` 从此就是"当前是否持锁"的准确表达。

---

### A-7 取消 / 超时的状态词汇统一

三处，都很小：

1. **外部超时理由**（`external/run.ts:233`）：wall-clock timer 里先写 `terminationReason`（B-9 引入的字段，A 批可先用内存局部变量 `timedOut`），settle 时理由改为 `Wall time budget exceeded (${maxWallTimeSec}s)`，而不是退化成"未见终态事件"。
2. **内置取消结算成 `cancelled`**（`tool.ts:1149`、`fatalSettleInput`）：`status: externallyCancelled ? "cancelled" : "failed"`。用户看到的是"已取消"而不是"失败"。
3. **launch 竞态窗口**（`run.ts:229` 之后）：`registerCancelHandle` 装上真正的 kill handle 后，立刻重查一次

   ```ts
   if (cancelledBeforeSpawn) void killProcessGroup(pid);
   ```

   覆盖「claim 之后、handle 装好之前」到达的 cancel。

---

### A-8 启动时先 await restore

`src/runtime/bootstrap.ts:1293`：`void restoreAllSubAgentRuns();` → `await restoreAllSubAgentRuns();`

一次本地目录扫描，`durableDispatch.start()`（1474 行）重投递挂起的 wake 之前必须完成，否则 `beginWakeConsumption` 找不到记录。B-9 的 lease 重建也依赖这个顺序。

---

## B 批：外部 run 真正可收养（约 250 行 + 1 个集成测试）

### 现状与目标

`external/run.ts:171-176` 用 `stdio: ["pipe","pipe","pipe"]`、无 `unref()`，`events.jsonl` 由**父进程**转写。daemon 一死，子进程写向断裂管道 → 多数 CLI 直接 EPIPE 退出。所以"detached 跨重启存活"这个承诺目前根本没兑现：重启后要么进程已死、事件文件残缺被判 `failed`，要么（忽略 SIGPIPE 的进程）永远卡在 `running`，占着并发额度、对应任务永不唤醒。

目标：子进程自己写产物；重启后由一个 sweeper 重新接管观察、超时与取消。

### B-9.1 进程 I/O 改为文件描述符直写

`src/subagents/external/run.ts`：

```ts
const eventsFile = await open(eventsPath, "a");
const stderrFile = await open(stderrPath, "a");
try {
    child = spawnFn(invocation.executable, invocation.args, {
        detached: true,
        cwd: input.workingDirectory,
        env: ...,
        stdio: ["pipe", eventsFile.fd, stderrFile.fd],
    });
} finally {
    await eventsFile.close();
    await stderrFile.close();
}
...
child.stdin?.end(stdinContent);
child.unref();
```

删除 `createWriteStream` 两条流、两个 `on("error")` 兜底、`child.stdout/stderr.on("data")` 转写、以及 close 回调里的 `eventsStream.end` / `stderrStream.end`。`parseOutcome` 本来就从磁盘读 `events.jsonl`，不受影响。

`close` 事件仍会触发，本进程内的快路径不变。

### B-9.2 `RunRecord` 字段调整

```ts
- fingerprint?: string;          // 随机串，从未被消费，删除
+ pidStartedAt?: string;         // `ps -p <pid> -o lstart=` 的输出，用于 PID 复用校验
+ deadlineAt?: number;           // spawn 时刻 + maxWallTimeSec * 1000
+ terminationReason?: "timeout" | "cancelled";
```

`setLaunched(runId, { pid, pidStartedAt, argv, deadlineAt, sessionId })`，仍是 required persist。

`src/shared/host-process.ts` 新增：

```ts
/** 进程启动时刻，用来在 PID 复用时拒绝误杀。macOS/Linux 的 ps 都支持 lstart。 */
export async function readProcessStartTime(pid: number): Promise<string | undefined>;
```

一次外部 launch 多一次 `ps`（外部 launch 本来就重），换掉的是一个纯粹的死字段，字段数净持平。

### B-9.3 单一 sweeper 接管 deadline 与收养

`src/subagents/runs.ts` 模块级、全 host 一个定时器：

```ts
const SWEEP_INTERVAL_MS = 30_000;
// configureSubAgentRuntime() 里启动，unref'd；导出 stopSubAgentSweeper() 供 shutdown 与测试使用
```

`SubAgentRunManager.sweep(now)` 对每条 `status === "running" && runtime === "external" && pid` 的记录：

1. **deadline 到期**（`deadlineAt && now >= deadlineAt && !terminationReason`）：置 `terminationReason = "timeout"` 并 persist → 校验进程身份 → `killProcessGroup(pid)`。下一 tick 或 `close` 回调完成结算。
2. **本进程有 live cancel handle**（即本次启动 spawn 的）：跳过，它自己的 `close` 回调会结算。
3. **被收养的 run**：`isProcessAlive(pid)` 且 `pidStartedAt` 匹配 → 仍在跑，跳过；否则走已有的 `reconcileExternalRun(record)` 从 `events.jsonl` 判终态。

`ps` 只在「deadline 到期准备 kill」和「收养的 run 做存活判定」时调用，活跃的本进程 run 一次都不调。

**同时删除** `run.ts` 里的 `wallClockTimer` —— deadline 只剩 sweeper 一个机制，本进程 run 与收养 run 走同一条路径，代价是最多 30s 的超时松弛（预算是 300–1800s 量级，可接受）。

`close` 回调与 `reconcileExternalRun` 都改为读 `record.terminationReason` 决定终态：

| terminationReason | 结算 |
|---|---|
| `"timeout"` | `failed`，理由 `Wall time budget exceeded (Ns)` |
| `"cancelled"` | `cancelled`，不 announce |
| 未设置 | 现有 `classifyExternalOutcome` 判定 |

`cancel()` 在调用 handle 前置 `terminationReason = "cancelled"`，`run.ts` 里的局部 `cancelled` 布尔随之删除。

### B-9.4 restore 重建写锁

`restore()` 在判定"仍存活、予以收养"之后：

```ts
if (record.leaseKey) acquireWorkspaceLease({
    runId: record.runId,
    channelId: record.channelId,
    workingDirectory: record.workingDirectory,
});
```

不需要 `record.mutates`（该字段在 `RegisterRunInput` 里根本没传，实际从未被填充）——`leaseKey` 的存在本身就等价于"这是写委派"。`workspaceLeaseKey()` 用 realpath，重建出的 key 与原来一致。

依赖 A-8：必须在放开新委派准入之前完成。

### B-9.5 不采纳

- **wrapper 脚本 + `exit.json`**：结构化 harness 本来就不靠 exit code 判定（`classifyExternalOutcome` 的设计前提），fd 直写的 `events.jsonl` 已是充分证据。为了拿一个不参与判定的 exit code 引入一层壳脚本，不划算。
- **完整 saga / 阶段标记**：A-2/3/4 覆盖了全部已知故障路径。

### B 批测试

一个真实 OS 进程的集成测试即可覆盖整条路径：spawn 一个延迟写 `events.jsonl` 的 detached writer → 销毁首个 manager → 新 manager `restore()` → 断言写锁被重建、pid 身份匹配则不结算、`sweep()` 在 deadline 后 kill、进程自然结束后只结算一次、只唤醒一次。

**已有测试需要同步改**：`test/subagent-external-run.test.ts` 里注入 `spawnFn` 的 fake child 目前依赖 `child.stdout.on("data")`，改成 fd stdio 后要改为直接往产物文件写。

---

## C 批：准确性与体验清理（约 60 行）

### C-10 `subagent` 改用 `RecoverableToolError`

`subagent` 已经过 `withToolDetails` 包装（`src/tools/index.ts:79`），转换机制现成，纯粹是换 throw 类型。以下全部改为 recoverable，并各自带一条可直接执行的下一步：

| 位置 | 拒绝原因 |
|---|---|
| `tool.ts:690` | task 超长 |
| `tool.ts:700` | 未知角色（已带可用角色列表） |
| `tool.ts:288-291` | `verify` 缺 taskId / taskId 非法 / 任务不存在 |
| `tool.ts:276` | `workingDirectory` 不是已存在的目录 |
| `tool.ts:719,724` | verify 角色声明 `mutates: write` / 用了 `exec` harness |
| `tool.ts:730,747` | 目标被写锁占用 / lease 冲突 |
| `runs.ts:329,335,341` | 频道与 host 并发上限、runId 重复 |

保持普通 `Error`：`resolveApiKey` 失败（需用户改 auth）、`runtime: external` 却没配 harness（角色文件坏了）、以及所有 I/O 与状态损坏。

`runs.ts` 从领域代码抛 `RecoverableToolError` 有先例（`src/tasks/transitions.ts`）。

### C-11 `effort` 在外部角色上有确定语义

现状三方矛盾：代码把内置的 `120/300/900s` 套到外部（`deep` = 900s **低于**外部默认 1800s，是反向的）；`docs/sub-agents.md:196` 说"仅内置"；`src/playbooks/agent-delegation.md:35` 说"外部角色高 effort 也要放宽墙钟"。

**取 playbook 的语义**（它符合直觉，也符合 spec 040 的原意）：外部角色的 `effort` 只映射墙钟，用外部量级的数值。

`src/subagents/discovery.ts`：

```ts
/** 外部 run 没有轮次/工具调用预算，effort 只有墙钟一个维度（spec 040 D5）。
 *  standard 保留角色自己的 maxWallTimeSec（默认 1800）。 */
export const SUB_AGENT_EXTERNAL_EFFORT_WALL_TIME_SEC = { quick: 600, deep: 5400 } as const;
```

`resolveSubAgentConfig` 的 budget 分支：外部角色只覆写 `maxWallTimeSec`，其余三项保持角色/默认值。

同步更新 `docs/sub-agents.md:196,205-215` 的表格与"仅内置"措辞。playbook 那句不用改——改完之后它就是对的。

### C-12 `thinkingLevel` 补 `max`

`src/subagents/tool.ts:100-115` 的 union 加 `Type.Literal("max")`，与 `discovery.ts:26` 的 `ALLOWED_THINKING_LEVELS` 对齐。

### C-13 follow_up 的两条硬校验

`src/tools/subagent-manage.ts`，取到 `role` 之后：

```ts
if (role.harness !== record.harness) {
    throw new RecoverableToolError(
        `Role "${record.agent}" now uses harness ${role.harness}, but run ${resolvedRunId} was started on ${record.harness}. ` +
        "Delegate a new run instead of resuming across a harness change.",
    );
}
if (role.shell) {
    throw new RecoverableToolError(
        `Role "${record.agent}" runs through a shell command, which has no place to pass a resume session id. ` +
        "Delegate a new run, carrying forward whatever context it needs.",
    );
}
```

第一条挡住"用旧 codex-cli harness 解析新 Claude command"；第二条挡住"报告 resuming 但其实开了新会话"。

**不采纳**完整的 invocation snapshot（argv 模板 / env key / role config hash）：这两条覆盖了真实危害，剩下的"角色微调后 follow_up 用了新 prompt"在个人助手场景通常正是用户想要的。

### C-14 清理死字段与截断提示

- 删 `BuildInvocationResult.promptFiles`（`claude-code.ts:79-80`、`codex-cli.ts:76` 产出，无人消费）。
- 删 `ExternalOutcome.outputTruncated`（三个 harness 都产出，无人消费；`runs.ts:516` 是 archive 侧另算的同名字段，保留）。
- `exec` 输出超 16k 时（`exec.ts:36`），在 `output.md` 尾部追加一行指向 `<artifactDir>/events.jsonl`，兑现 playbook 的"全文可取"承诺。

### C-15 spec 状态

`docs/specs/040-async-delegation-and-external-agents/design.md:5` 状态改为 `PARTIALLY IMPLEMENTED`，并列出与实现的偏差：`effort` 的外部语义（C-11 前后各是什么）、`fingerprint` 被 `pidStartedAt` 取代、spec 声称的 24h 辅助产物清理未实现（`collectGarbageIfExpired` 只清 run 记录，不清产物目录）。

**不采纳**"可执行的 capability matrix + 由测试生成文档表格"：真实漂移只有 C-11/C-12 两处，修掉即可，不值得引入平台级治理。

---

## 测试增量（3 个）

1. **重启收养**（真实 OS 进程，B 批）：见 B 批测试一节。
2. **archive 抛错注入**（A 批）：`logSubAgentRun` throw → 断言 wake 仍发出、run 仍为终态、`wakeEnqueued` 已置。
3. **外部信封**（A 批）：外部 dispatch 后读 `prompt.txt`，断言含工作目录、产物目录、`paths`，`purpose=verify` 时含 VERDICT 协议。

**不采纳**三层测试金字塔与真实 CLI 的 opt-in contract smoke：现有 12 个测试文件对 parser、spawn/settle、准入、lease 覆盖已经扎实，缺的就是上面这三个维度。

---

## 落地顺序与验证

| 批次 | 内容 | 门禁 |
|---|---|---|
| A | A-1 ~ A-8 + 测试 2、3 | `npm run check` |
| B | B-9.1 ~ B-9.4 + 测试 1；同步改 `subagent-external-run.test.ts` | `npm run check` + `npm run test:e2e` |
| C | C-10 ~ C-15 | `npm run check` |

A 批优先：外部 `purpose=verify` 目前是坏的（A-1），完成结果可能永久沉默（A-2/A-3）。
