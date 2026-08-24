# 子代理/外部 Agent 与工具层评审报告

- 日期：2026-08-24
- 范围：`src/subagents/**`（discovery / tool / runs / external/\*）、`src/tools/**`、`src/executor.ts`，以及它们在 `src/agent/session-events.ts`、`src/agent/prompt/sections.ts`、`src/playbooks/agent-delegation.md` 上的接缝
- 基线：`142e73b`（0.9.1-beta.2）
- 与前一份评审的关系：`2026-08-23-delegation-and-task-chain.md` 覆盖的是"委派 ↔ tasks 台账"的接缝，其 P0 已由 `f22879e`/`1eacf65` 修掉。本次不重复那条线，专看**委派本身的执行语义**和**工具层的日常质量**。
- 性质：评审输入，不是设计记录。落地方案应另起 spec 或按§4 的顺序分批改。

---

## 0. 总体判断

**骨架依然是对的，而且这半年积累的加固是真加固**，不是补丁堆积：

- `SubAgentRunManager` 的三个幂等标记（`settledAt` / `usageRecorded` / `wakeEnqueued`）把"不可重放的副作用"和"可覆盖的普通数据"划开了（`runs.ts:23-30`）；`settle()` 先 required-persist 终态、失败即回滚快照再抛（`runs.ts:571-586`），这是整条链路能扛住重启的根本。
- `finalizeExternalRun` 是外部 run 判定的唯一实现，live 退出和重启重连共用（`external/settlement.ts`）。
- 外部进程 stdout/stderr 直接 `stdio` 到文件、`close` 监听器在任何 `await` 之前挂载、`pidStartedAt` 做 pid 复用识别（`external/run.ts:245/283/298`）——长跑运行时里最容易漏的三处都没漏。
- 工具层的 `withToolDetails` 单点盖章 `kind` + 转换 `RecoverableToolError`（`tools/tool-details.ts:77`），是个正确且便宜的抽象。
- `TOOL_REGISTRY` 用 `availableToSubagents` + `enabledBy` 声明式地同时定义主集与子代理集（`tools/registry.ts`），避免了两份名单漂移。

**问题集中在两类，都不是骨架问题**：

1. **委派链路上有三处"默认值/适配器把外部 agent 的能力悄悄削掉"**（§1.1–§1.3）。它们不报错、不进日志，只在 `op=show` 的 argv 里能看出来，而这恰恰打在"用 token 杠杆换成果"的正中间——你花钱雇了一个 heavy agent，运行时替它把 effort 调到最低，或者在它跑满 90 分钟被墙钟砍掉时把全部产出丢掉。
2. **工具层集体没有兑现项目自己在 AGENTS.md 里立的两条规矩**："错误要能被模型自己修就用 `RecoverableToolError`"和"每条错误/截断输出都要带下一步指令"。新工具（`memory_manage`/`task_manage`/`subagent*`）做到了，老的高频工具（`read`/`grep`/`edit`/`write`/`bash`）一条都没做（§2.1）。加上 `executor` 在超时路径上把最多 10MB 原始输出塞进错误消息（§2.2），这是当前**最直接的 token 与体验损耗**。

按"健壮而直接、不要精巧而脆弱"的标准看，本次没有发现需要拆掉的过度设计——`workspace-lease`、`ROLE_FIELD_MATRIX`、幂等标记这几处复杂度都买到了对应的正确性。唯一一处"复杂度没买到东西"的是 skill 的内容扫描（§2.7）。

---

## 1. 委派链路（P1，按影响排序）

### 1.1 `thinkingLevel` 的内置默认值泄漏成外部 CLI 的显式 effort 参数——每一次外部派发都被强制降智

`resolveSubAgentConfig` 对所有 runtime 统一兜底（`discovery.ts:954-957`）：

```ts
const thinkingLevel =
    thinkingLevelOverride?.value ?? baseConfig?.thinkingLevel ??
    (purpose === "verify" ? "medium" : "off");   // work → "off"
```

这个 `"off"` 原本是**内置**子代理的合理默认（不开扩展思考），但它被原样传给外部 harness（`tool.ts:866` → `external/run.ts:155`），而两个适配器都把它翻译成一个**显式命令行参数**：

- `claude-code.ts:28-36,72`：`off → "low"`，随后 `args.push("--effort", "low")`
- `codex-cli.ts:25-33,69`：`off → "none"`，随后 `baseArgs.push("-c", "model_reasoning_effort=none")`

于是：**任何角色文件里没有写 `thinkingLevel:` 的 external work 角色，每一次派发都被显式钉死在最低推理档**。这不是"沿用 CLI 默认"，而是主动覆盖用户在 `~/.claude/settings.json` / `~/.codex/config.toml` 里配好的默认值。

- 已实测确认 `claude 2.1.241` 的 `--effort` 合法值为 `low|medium|high|xhigh|max`（`--effort none` 会 warn 并忽略），所以映射表本身没错——错的是"默认也要传"。
- **影响面（2026-08-24 复核修正）**：`examples/sub-agents/` 的 11 个模板**全部已显式声明 `thinkingLevel`**，且 `test/subagent-phase1.test.ts` 已逐个断言其取值，所以随包发出的角色不受影响。真正暴露的是两类：**用户自己写的、省略了 `thinkingLevel` 的外部角色**，以及 inline 子代理（它压根没有角色文件可写）。这一条的严重性因此低于初稿的表述，但方向不变——运行时不应替目标 CLI 决定推理档位。
- 可观测性为零：不进 `invocationWarnings`，只有 `subagent_manage op=show` 打印 argv 时才看得见。

**建议**：区分"显式设置"和"兜底默认"。最小改法是让 `resolveSubAgentConfig` 对 `runtime === "external"` 时不兜底 `DEFAULT_WORK_THINKING_LEVEL`（保留 `verify` 的 `medium` 兜底，那是有意的安全边际），把 `thinkingLevel` 保持 `undefined`；两个适配器已经写好了 `if (!existing.effort && effort && ...)`，`undefined` 天然不追加。副产物是外部角色的 effort 从此**只有两个来源**：角色 frontmatter 或本次调用的 `thinkingLevel` 参数——正好和 `model` 的规则对齐（`model` 已经明确"external 只能来自 frontmatter"，`discovery.ts:876-880`）。

### 1.2 claude-code 适配器在超时/取消时丢掉全部产出、用量和会话可续接性

`claude-code.ts:123-127` 只在 `type === "result"` 事件里取 `finalText` / `usage` / `cost`：

```ts
if (record.type === "result") { ... if (typeof record.result === "string") finalText = record.result; ... }
```

而 `result` 事件只在**正常收尾**时出现。一个跑满 `maxWallTimeSec`（外部默认 1800s，`effort: deep` 时 5400s）被 `killProcessGroup` 砍掉的 run，或者被 `op=cancel` 停掉的 run：

- `finalText === ""` → `settle` 的 `outputText` 为空 → `writeOutputFile` 直接 return false（`runs.ts:312`）→ **不写 `output.md`**
- 唤醒文本因此走"没有文本产出"分支（`runs.ts:707`），只给出 artifact 目录，不给出可读入口
- `usageKnown === false` → 一次 90 分钟的运行**在 ledger 里记 0 token**

对比 `codex-cli.ts:112-118`：它在每个 `item.completed` 上增量更新 `finalText`，所以被砍掉时仍保留最后一条 agent 消息。**这是适配器之间的不对称，不是协议限制**——claude-code 的 stream-json 同样会在每一轮吐 `{"type":"assistant","message":{content:[{type:"text",text}]}}`。

`external/settlement.ts:39-46` 的设计意图写得很清楚（"cancel/timeout 只覆盖 status/failureReason，不动 usage、output、sessionId"），但 claude-code 这一侧根本没有产出可保留，意图落空。

**建议**：在 `parseOutcome` 里累积 `assistant` 事件的文本作为 `finalText` 的兜底（只在没看到 `result` 时使用），同样累积 `message.usage`；`parserVersion` 随之 +1。改动局限在一个文件，且有 `test/claude-code-harness.test.ts` 兜底。

### 1.3 inline 子代理无法声明 `mutates`，工作区写锁对"默认路径"完全失效

- `subagentSchema`（`tool.ts:54-118`）**没有 `mutates` 参数**。
- inline 角色的 `mutates` 只能靠 `inferMutatesFromTools` 从 `tools` 推定，且只看 `write`/`edit`（`discovery.ts:525`）。
- inline 的默认工具集是 `["read", "bash"]`（`discovery.ts:16`）→ 推定为 `read` → **不取工作区写锁**。
- 而 `subagent` 工具的 description 把 inline 明确写成"Default path"。

结果：模型走推荐路径派一个"跑数据迁移脚本 / 跑 codemod"的 inline agent，它通过 `bash` 真实写入工作树，但对 `workspace-lease.ts` 完全隐形。两个这样的并行分片会静默落在同一棵树上。

`agent-delegation.md` §3 已经把这条风险写给模型看了——"内置角色的 `mutates` 是按 `tools` 推定（只看 `write`/`edit`，不看 `bash`）…**写清楚 `mutates` 是你的责任**"。问题是**接口没给它写清楚的地方**：对 predefined 角色可以改角色文件，对 inline 角色无路可走。文档在要求一件代码不支持的事。

**建议**：`subagentSchema` 加 `mutates?: "read" | "write"`，缺省时仍走现有推定；`resolveSubAgentConfig` 优先取调用值。约 10 行改动，把一条文档承诺变成可执行的。（顺带：`discovery.ts` 已经为 predefined 角色的"含 bash 却未声明 mutates"加了 warning，inline 路径可以复用同样的判断，在返回给模型的结果里带一句提示。）

### 1.4 外部进程的环境变量过滤既误伤又漏网，且完全静默

`external/run.ts:30-38`：

```ts
const SENSITIVE_ENV_PATTERN = /(?:_API_KEY|_SECRET|_TOKEN|_PASSWORD)$/i;
if (SENSITIVE_ENV_PATTERN.test(key) || key.startsWith("DINGTALK_")) continue;
```

意图正确（外部进程会读目标仓库的 `CLAUDE.md`，不该继承 daemon 的凭据），但后缀正则做安全边界有两个方向的错：

**误伤**（外部 agent 里工具突然不能用，且不给任何线索）：
- `GITHUB_TOKEN` / `GH_TOKEN` → `gh` CLI 在外部 agent 里全面失效
- `NPM_TOKEN` → 私有 registry 装不上
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` → 如果用户就是靠 env 给外部 CLI 供 key（而不是 OAuth/keychain），**每一次外部派发都必然失败**，错误信息还是 CLI 自己的"未认证"，很难反推到 pipiclaw 删了变量

**漏网**（后缀不匹配的常见凭据照样继承）：
- `AWS_SECRET_ACCESS_KEY`（结尾是 `_KEY`）、`AWS_ACCESS_KEY_ID`
- `GOOGLE_APPLICATION_CREDENTIALS`（指向凭据文件的路径）
- `SSH_AUTH_SOCK`（等价于把 SSH agent 转发给外部进程）

**建议**：既然真正的权限边界是"角色命令 + CLI 沙箱 + 宿主账号"（AGENTS.md 已明确），这层过滤应该定位成**减少误继承的礼貌性措施**，而不是安全控制。相应地：(a) 改成显式变量名清单 + 可在角色 `env:` 里加回（已支持）；(b) **把本次实际丢弃的变量名写进 `invocationWarnings`**，`op=show` 就能看到，这比调正则更值钱；(c) 在 `docs/sub-agents.md` 里点名说明"外部 agent 默认拿不到 `*_TOKEN`，需要 `gh`/`npm` 的角色请在 `env:` 里显式加回"。

### 1.5 `[Dispatched]` 占位符的 `details` 是两份手写字面量

`tool.ts:912-928`（external）和 `tool.ts:1359-1375`（internal）各自手写了一份完整的 `SubAgentToolFields` 字面量，而不是走 `createDetails()`（`tool.ts:707`）。目前字段是全的，但这是典型的"下次加字段时漏一处"结构——`SubAgentToolFields` 加一个必填字段，TS 会同时报三处；加一个可选字段，只有这两处会静默缺失，而 `session-events.ts:151` 的 `mergeSubAgentUsage` 正是消费方。

**建议**：给 `createDetails` 加一个 `dispatched?: boolean` 出口，两处改为调用它。纯重构，无行为变化。

### 1.6 `buildContextualBlocks` 抛错 = 派发失败（degrade 缺失）

`tool.ts:1130`（internal，在 `runToCompletion` 内）和 `tool.ts:845`（external，在 launch 前）都是裸 `await`。`recallRelevantMemory` 内部对 LLM rerank 失败做了 catch（`memory/recall.ts:648`），但候选库读取、会话文件读取等路径没有兜底。一次瞬时 I/O 错误会让一个本可以正常执行的委派在开工前失败（internal 路径还会先注册 run、再 settle 成 failed）。

**建议**：`const blocks = await buildContextualBlocks(...).catch(err => { log.logWarning(...); return []; })`。上下文注入是**增强**，不是前置条件——降级到"无上下文块"永远好过不派发。两处各一行。

### 1.7 已复核、确认不是问题的几处（避免后来者重复排查）

- **`announce()` 忽略 `dispatch()` 的返回值**（`runs.ts:725-731`）：看起来像"入队失败也标记 `wakeEnqueued`"，实际安全——`DurableDispatchService` 在 `enqueueEvent` 被拒时把记录退回 `pending`（`durable-dispatch.ts:238` 附近），30s 周期 drain 会重投。值得**补一行注释**说明这一点，否则每次评审都要重新推一遍。相关数字：`EVENT_QUEUE_LIMIT = 5`（`dingtalk.ts:253`）小于 `MAX_RUNNING_SUBAGENT_RUNS_PER_CHANNEL = 6`，6 个并发 run 同时结束确实会撞上限，但正是靠这条 durable 重投兜住。
- **`settle()` 在 serial queue 内 `await dispatch()`**：不会自锁——`enqueueEvent` 只入队不执行回合（`dingtalk.ts:764-780`），所以不会回头再进同一个 `runId` 的队列。
- **codex `resume` 的 argv 顺序**：`codex exec <父级 flags> resume <id> --json -` 已在 `codex 0.5x` 实测可解析（父级 flags 前置合法，`resume` 子命令自带 `--json`）。
- **`claude --append-system-prompt-file`**：实测 `claude 2.1.241` 接受该 flag（未在主 help 列出，但在 `--bare` 说明里被引用且不报 unknown option）。
- **verify 的 TOCTOU**（`assertVerifyAdmissible` 只查锁不取锁）：已知且有意——attestation 对 external 标 `advisory`，`resolveVerificationOutcome` 在无法比对时 fail-closed。不建议改。

---

## 2. 工具层（P1–P2）

### 2.1 高频工具集体违反项目自己的错误契约——模型可自修的失败全部变成用户可见的红色报错

AGENTS.md 写得很明确：

> Reject a bad tool call with `RecoverableToolError` when the model can fix it alone… Only plain errors reach the user's chat, so the test is "can the model resolve this alone?", not "how severe is it?"

而实际分布是：

| 文件 | `throw new Error` 次数 | `RecoverableToolError` 次数 |
|---|---|---|
| `read.ts` | 8 | **0** |
| `edit.ts` | 6 | **0** |
| `grep.ts` | 3 | **0** |
| `bash.ts` | 3 | **0** |
| `write-content.ts` | 2 | **0** |
| `send-media.ts` | 5 | **0** |
| `skill-manage.ts` + `skill-security.ts` | 15 | **0** |
| `job.ts` | 1 | **0** |
| `memory-manage.ts` | 2 | 多处 ✅ |
| `task-manage/**`、`subagent-manage.ts`、`subagents/tool.ts` | 少量（都是该 plain 的） | 多处 ✅ |

后果不是理论上的。`session-events.ts:199-201`：

```ts
if (treatAsError && showProgress) {
    queue.enqueue(() => ctx.respond(formatProgressEntry("error", truncate(resultStr, 200)), false), "tool error");
}
```

所以**每一次 edit 锚点没对上、每一次 read offset 越界、每一次 grep 正则写错、每一次 skill 名字打错**，钉钉频道里都弹一条红色错误，然后模型下一轮自己就修好了。用户看到的是一个不断报错的助手，实际什么事都没发生。对使用频率最高的三个工具（`read`/`bash`/`edit`）来说，这是**最主要的体验噪音来源**。

**建议**：按下表逐条改类。注意 `RecoverableToolError extends Error`，且现有测试断言的是 `rejects.toThrow(<message>)`（`test/edit.test.ts:97,107,117`、`test/read.test.ts:62`）——**测试不需要改**，因为它们直接调用未包装的工具。

| 位置 | 现状 | 应为 | 理由 |
|---|---|---|---|
| `read.ts:239` offset 越界 | plain | **Recoverable** | 已带 `Use offset=N` 指引，模型直接重试 |
| `read.ts:205/266`（文本）与 `read.ts:160`（图片）`Failed to read file` | plain | **Recoverable** + 加指引 | 绝大多数是路径拼错；应提示"用 `read` 打开父目录确认路径" |
| `read.ts` pdftotext 未安装 / 扫描件 | plain | 保持 plain ✅ | 需要人装 poppler 或换文件 |
| `read.ts` / `grep.ts` / `edit.ts` / `write-content.ts` path guard 拒绝 | plain | 保持 plain ✅ | 用户可能要改 `security.json` |
| `grep.ts:198` 空 pattern | plain | **Recoverable** | |
| `grep.ts:232` `grep failed`（exit ≥ 2） | plain | **Recoverable** | 已带"检查 ERE 语法"指引 |
| `edit.ts:188` 文件读不到 | plain | **Recoverable** | |
| `edit.ts:195` 锚点未匹配 | plain | **Recoverable** | 最高频的一条 |
| `edit.ts:204` 多处匹配 | plain | **Recoverable** | 已给出 `replaceAll` 出路 |
| `edit.ts:229` 单次 no-op（消息在 230） | plain | **Recoverable** | |
| `edit.ts:223` 连续 3 次 no-op 的 `STOP.` | plain | 保持 plain ✅ | 有意升级为硬停；让用户看见卡死是对的 |
| `bash.ts:192` interceptor 拦截 | plain | **Recoverable** | "换个工具"完全是模型自己的事 |
| `bash.ts:208` async 不可用 | plain | **Recoverable** | 已给出"去掉 async"的出路 |
| `bash.ts:181` command guard 拒绝 | plain | 保持 plain ✅ | |
| `job.ts:70` cancel 缺 ids | plain | **Recoverable** | |
| `send-media.ts:90/99` 非普通文件 / 空文件 | plain | **Recoverable** | |
| `send-media.ts:107` 发送失败 | plain | 保持 plain ✅ | 传输故障，用户要知道 |
| `skill-manage.ts` 名称缺失 / 已存在 / 不存在 / patch 未命中或多处命中 / `write_file` 缺 filePath | plain | **Recoverable** | 全部是参数问题 |
| `skill-security.ts` 内容扫描拒绝 | plain | **Recoverable**（另见 §2.7） | 模型改写内容即可 |
| `memory-manage.ts:225` forget 命中多条 | plain | **Recoverable** | 已给出候选列表 |
| `event-manage.ts:124` 事件文件无法解析 | plain | 保持 plain ✅ | 要人去 `/events` 修 |

顺带一条 knip 相关的小事：`isRecoverableRejection`（`tool-details.ts:65`）只有测试在用，生产侧 `session-events.ts:185` 直接读了 `details?.recoverable === true`。要么让 session-events 用它，要么删掉。

### 2.2 bash 超时/中断把最多 10MB 原始输出原样塞进模型上下文，且不带任何下一步指令

`executor.ts:117-124`：

```ts
rejectOnce(new Error(`${stdout}\n${stderr}\nCommand aborted`.trim()));
rejectOnce(new Error(`${stdout}\n${stderr}\nCommand timed out after ${options?.timeout} seconds`.trim()));
```

`stdout`/`stderr` 各自被截到 10MB（`executor.ts:99-108`）。这个 `Error` 冒泡出 `bash` 工具 → `withToolDetails` 只转换 `RecoverableToolError`，其余原样抛 → pi SDK 的 `createErrorToolResult(error.message)`（`node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:471`）**把整条 message 原样当作 tool result 内容，无任何截断**。

也就是说：**一条超时的 `npm test`、一条超时的 `docker build`，就能一次性吞掉整个上下文窗口。** 这条路径完全绕开了 `truncateTail` + spill 文件那套本来就存在、而且写得很好的机制（`bash.ts:248-290`）。

同一个问题的第二面：超时错误里没有任何可执行的下一步。AGENTS.md 要求"每个工具错误或截断输出必须带模型能直接照做的下一步指令"，这里应该说的是"重试时传 `timeout: N`，或者用 `async: true` 让它后台跑"。

**建议**（这是本次最高性价比的单点修改）：

1. `executor.exec` 不再用"reject + 全量输出"表达超时/中断。加 `ExecResult.timedOut?: boolean` / `aborted?: boolean`，正常 resolve，把 `stdout`/`stderr` 交给调用方。
2. `bash.ts` 走已有的 `truncateTail` + spill 文件路径，在输出尾部追加：
   `[Timed out after Ns. Full output: /tmp/…. Retry with timeout=<更大值>, or async: true to run it in the background.]`
3. 附带修掉一个真实的 CPU 尖刺：`executor.ts:99-100` 的 `stdout = stdout.slice(0, 10MB)` 是**每来一个 chunk 就整体拷贝一次 10MB**。一条产出 100MB 的命令 ≈ 1600 次 chunk × 10MB memcpy ≈ 十几 GB 的拷贝，期间事件循环被卡住，整个 daemon（含其它频道）停摆。改成到上限后置一个 `capped` 标志、直接丢弃后续数据即可。

### 2.3 `base64 < file` 撞上 10MB stdout 上限 → 大图静默损坏、大文件静默发错

两处走同一条路：

- `read.ts:158`：图片 → `base64 < file` → 直接作为 `{type:"image", data}` 送模型
- `send-media.ts:93`：任意文件 → `base64 < file` → `Buffer.from(...)` → 发给用户

`base64` 会把文件放大到 4/3。executor 的 10MB stdout 上限意味着**约 7.5MB 以上的文件，base64 会被静默截断**，而截断后的 base64 仍然能被 `Buffer.from` 解码成一个"看起来正常"的短 buffer。于是：

- `read` 把一张损坏的图片送进模型上下文（provider 侧要么报"invalid base64"，要么模型看到半张图）
- `send_media` 给用户发出一个**损坏的文件**，同时向模型汇报 `Sent file "x.zip" (7500.0KB) to the channel.` —— **静默数据损坏 + 谎报成功**，这是本节最严重的一条

两处都没有任何前置大小检查。

**建议**：发送/读取前先 `stat` 拿大小（`send-media.ts:88` 已经在跑一次 `test -f`，顺手取 size 即可），超过阈值（建议 5MB，留出 base64 与协议头的余量）给一条可执行的错误：图片 → "先用 `bash` 压缩或裁剪后再 read"；`send_media` → "该文件 XMB 超出发送上限，请压缩或改为提供路径"。更彻底的做法是这两处改用 `node:fs` 直读（本地 `HostExecutor` 是唯一实现，没有远程执行的抽象需求），一并绕开 shell 与 stdout 上限。

### 2.4 `write` / `edit` 非原子，且 `edit` 是无保护的 read-modify-write

- `write-content.ts:65`：`cat > <path>` —— 先截断再写。进程在中途死掉（或磁盘写满）就留下一个**被截断的文件**。仓库里 `shared/atomic-file.ts` 的 `writeFileAtomically`（temp + fsync + rename + 目录 fsync）已经存在，`skill_manage`、config、run 记录都在用，唯独两个最常写文件的工具没用。
- `edit.ts:186→ writeContent`：`cat file` 读 → 内存替换 → `cat > file` 写回，中间**不校验文件是否变过**。这在本项目里不是理论风险：后台 job（`bash async`）、外部 agent（`mutates: write` 只在委派之间互斥，`agent-delegation.md` §3 明确说"你自己的 write/edit/bash 不受这把锁保护"）都可能在这个窗口里改同一个文件，结果是**静默覆盖**。

**建议**：(a) `writeContent` 改走 `writeFileAtomically`（注意保留 `createParentDir` 语义，`writeFileAtomically` 本身已经 `mkdir -p`）；(b) `edit` 在读文件时一并取 `mtime`+size，写回前复查，不一致就抛 **Recoverable** 错误"文件在本次编辑期间被改动，请重新 read 后再编辑"。这比任何锁都便宜，且正好符合"直接、不精巧"。

### 2.5 `read` 的每次调用要 spawn 2–3 个进程并全量扫一遍文件

`read.ts:200-201` 为了拿总行数跑 `awk 'END { print NR }' <file>`——**完整读一遍文件只为得到一个数字**，随后 `read.ts:264` 再跑一次 `cat|head -c` 拿窗口。加上 shell 本身，一次普通 `read` = 2 次 `sh -c` spawn + 1.x 次全文件扫描。

代码里已经为第二次读做过一轮很到位的优化（`read.ts:252-259` 的注释解释了为什么用 `head -c` 限窗），但第一次的全量扫描被留下了。对最高频的工具来说，这是每次调用都付的常数成本。

**建议**：合并成一条 `sh -c`（`wc -l` 与窗口读取一次完成），或者直接用 `node:fs` 的流式读取——后者同时解决 §2.3 的 shell/上限问题。属于收益明确、风险低的优化，不急。

### 2.6 bash 的 spill 文件永不回收

`bash.ts:27` 把超限输出写到 `/tmp/pipiclaw-bash-<rand>.log`，`mode 0600`，**没有任何清理**。对照 `job-manager.ts:199-201` 是有 GC 的。长跑 daemon 上这些文件会一直堆积（重启机器才清）。

**建议**：复用 run 记录那套"按 age 的日投 GC"思路，或者干脆把 spill 文件放进 `<channelDir>/tmp/` 让现有清理逻辑覆盖。低优先级，但很便宜。

### 2.7 skill 的内容扫描：复杂度没买到安全，只买到误伤

`skill-security.ts:11-26` 的 `BLOCKED_CONTENT_PATTERNS` 有 13 条正则（prompt injection 措辞、`rm -rf /`、`curl | sh`、凭据文件访问、不可见 unicode……），在 `create`/`patch`/`write_file` 时对内容做拦截。

问题在于**这道防线装错了方向**：

- 它只拦"agent 自己写入 skill"。用户手工放进 `workspace/skills/` 的文件、`git clone` 进来的 skill、`bash` 写进去的文件，**一律不过扫描**——而这些恰恰才是不可信来源。真正的注入面在**加载/注入侧**，那里没有扫描。
- 反过来对合法内容误伤明显：一个讲 prompt engineering 的 skill 写不了 `you are now a ...`；一个讲部署的 skill 写不了 `curl … | sh` 的安装说明；`cat .env.example` 这种也会中招。
- 而且它是 plain `Error`（§2.1），误伤直接弹到用户频道。

**建议**（二选一，都算做减法）：

- **A（推荐）**：把写入侧的扫描降级为**警告**（写入成功，结果里带一条"这条内容包含 X 措辞，注入到系统提示时请留意"），把真正的防线移到"skill 内容进入系统提示"的那一步——如果那里认为不需要防线，那写入侧这套就该整体删掉。
- **B（最小）**：保留拦截但改成 `RecoverableToolError`，并在消息里明确说"这是关键词级别的启发式，若确属正常内容请换个措辞或改由用户手工放置"。

留着现状是最差的：既挡不住真实威胁，又在正常工作里制造摩擦。

### 2.8 其它小项

- **`web_fetch` 在子代理路径静默忽略 `offset`**（`web-fetch.ts:97-108`）：没有 `channelDir` 时直接单次 fetch，`offset` 参数被丢弃。子代理传 `offset=4000` 想翻页，拿回来的还是第一屏——它没法区分"到底了"和"翻页无效"，容易空转。**建议**：这条分支里若 `offset > 0`，明确返回"该上下文不支持分页；用更大的 `maxChars` 或改由主 agent 抓取"。
- **`task_manage` / `skill_manage` 用 `JSON.stringify(result, null, 2)` 回给模型**（`task-manage.ts:75`、`skill-manage.ts:307`）：纯缩进的 token 浪费，对每回合都调用的 `task_manage progress` 尤其不值。改 `JSON.stringify(result)` 即可，模型解析 JSON 不需要缩进。
- **`resolveSkillPath` 里的恒假条件**（`skill-security.ts:90`）：`skillDir !== resolve(skillsDir, name)` 永远为 false（上一行刚这么算的）。真正起作用的是后半段 `startsWith` 检查，而且 `name` 已经过 `SKILL_NAME_REGEX`。删掉前半段，别让读代码的人以为那里有防线。
- **`edit` 的 `noopCounts` Map 无上界**（`edit.ts:150`）：按 `(path,oldText,newText)` 累积，只在成功编辑时 `clear()`。一次长会话里若持续产生不同的 no-op，Map 单调增长。影响极小（工具实例随 runner 代际重建），提一句备案。
- **`command-optimizer` 每条 bash 命令多一次 spawn**（`command-optimizer.ts:63`）：`rtk rewrite` 是同步阻塞在 bash 调用路径上的（2s 超时）。默认关闭，开启时值得知道这个成本；如果 rtk 的重写规则相对稳定，可以考虑按 command 前缀做一层小 LRU 缓存。

---

## 3. 横切观察

### 3.1 "错误要能被自己修 / 错误要带下一步"这两条规矩需要一个执行点

§2.1 的分布说明：把规矩写进 AGENTS.md 只能约束**新写的**代码。老代码不会自己迁移，而且没有任何机制会提醒。

**建议**：加一条针对 `src/tools/**` 的轻量 lint 或单测——例如遍历 `TOOL_REGISTRY` 构造出的工具，对一批已知的"坏参数"输入断言返回的是 `recoverable: true` 的结果而不是抛错。测试写起来不难（`test/tool-details.test.ts` 已经有 `withToolDetails` 的模式），而且它是**唯一**能防止这条规矩再次腐化的东西。

### 3.2 输出预算：委派侧做得很好，工具侧有洞

`MAX_SUBAGENT_RESULT_UNITS`（1200 units，`tool.ts:222`）、`WAKE_OUTPUT_TAIL_CHARS`（2000）、`LIST_CAP`（50）、`STDERR_TAIL_CHARS`（2000）—— 委派链路上每一条流向模型上下文的路径都有显式预算，而且全文都落盘、都给了取回路径。这是这个项目做得最好的部分之一。

工具侧的洞正是 §2.2（超时错误无上限）和 §2.3（base64 无上限）。补上这两个，"没有任何单次工具调用能吞掉上下文窗口"才是一条真正成立的不变量——它值得被写进 AGENTS.md 并配一条测试。

### 3.3 值得保留、不要"简化"掉的复杂度

评审时特意检查过这几处是不是过度设计，结论是**都不是**，建议明确保留：

- `runs.ts` 的三个幂等标记：每一个都对应一个真实不可重放的副作用（写产物/释放锁、计费、唤醒）。
- `ROLE_FIELD_MATRIX`（`discovery.ts:508`）：把"哪些字段对哪个 runtime 有意义"变成数据后，静默忽略变成了显式驳回。这类表格是在**减少**分支，不是增加。
- `workspace-lease` 只做写-写互斥、不做读写分级：模块头注释已经论证过为什么不引入第二个锁维度，论证成立。
- `expandPlaceholders` 的"值缺失就整 token 丢弃 + 记 warning"（`harness.ts:167`）：比把字面量 `$MODEL` 传给子进程正确得多。

---

## 4. 建议的落地顺序

分四批，每批都能独立发布、独立验证。

**第一批（半天，收益最大）**
1. §2.2 executor 超时/中断改为正常结果 + 截断 + spill + 下一步指令；顺手修 `slice` 拷贝尖刺
2. §2.3 `read` 图片与 `send_media` 加大小前置检查（先堵住静默损坏，`fs` 直读可以后做）
3. §1.1 external 不再兜底 `thinkingLevel`

**第二批（一天）**

4. §2.1 按表迁移错误类（机械改动，测试不用动）
5. §3.1 加一条防腐化的注册表级测试
6. §1.2 claude-code 适配器兜底 `finalText`/`usage`，`parserVersion` +1

**第三批（一天）**

7. §1.3 `subagent` schema 增加 `mutates`
8. §2.4 `write` 走原子写；`edit` 加 mtime 复查
9. §1.4 env 过滤改显式清单 + 丢弃项写进 `invocationWarnings` + 文档说明
10. §1.6 `buildContextualBlocks` 降级；§1.5 占位符 details 收敛到 `createDetails`

**第四批（零散，随手做）**

11. §2.7 skill 扫描定位（先决策 A/B，再改）
12. §2.5 `read` 合并进程；§2.6 spill GC；§2.8 全部小项；§1.7 补注释

---

## 5. 附：本次评审的验证方式

- 代码通读：`src/subagents/**` 全量（3800 行）、`src/tools/**` 全量（约 4500 行）、`src/executor.ts`、`src/agent/session-events.ts` 相关分支、`src/runtime/durable-dispatch.ts` 与 `dingtalk.ts` 的入队路径。
- 外部 CLI 实测（本机 `claude 2.1.241` / `codex`）：`--append-system-prompt-file` 可用；`--effort` 合法值集合；`codex exec <flags> resume <id> --json -` 的 argv 顺序可解析；`-c model_reasoning_effort=none` 不在配置加载阶段被拒。
- SDK 行为核对：`pi-agent-core` 的 `executePreparedToolCall` 确认抛出的 `Error.message` 原样成为 tool result 内容且无截断（`agent-loop.js:466-475`）。
- 未运行 `npm run check`（本次是纯评审，未改动任何源码）。
