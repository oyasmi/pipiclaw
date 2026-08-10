# 委派链路一致性加固：把三份实现收敛成一份事实

| 字段 | 值 |
|------|------|
| 状态 | IMPLEMENTED（2026-08-10，三个阶段全部落地并通过 `npm run check`；细节见文末"实施记录"） |
| 日期 | 2026-08-10 |
| 前置 | 040 async-delegation-and-external-agents（本 spec 修的是它的实现分叉，不改它的任何设计取舍） |
| 触发 | [`docs/subagent-review-2026-08-10.md`](../../subagent-review-2026-08-10.md)（基线 `8070148`） |
| 关联实现 | `src/subagents/`（`runs.ts`、`discovery.ts`、`tool.ts`、`workspace-lease.ts`、`external/*`）、`src/tools/subagent-manage.ts`、`src/runtime/subagent-commands.ts`、`src/runtime/bootstrap.ts`、`src/shared/host-process.ts`、`src/usage/ledger.ts`、`docs/sub-agents.md`、`src/playbooks/agent-delegation.md`、`examples/sub-agents/` |

## 背景

spec 040 把外部智能体吸收进 sub-agents，两轮审查后生命周期已经闭环：外部进程可跨 daemon 重启被重新接管、可超时、可取消、写锁可重建、结算前置持久化可回滚、准入在 restore 之后才开放。这些都成立。

第二轮审查（2026-08-10）发现的问题换了性质。它们**不是机制缺失，而是同一个机制有多份实现，实现之间在分叉**：

- `SettleInput` 被构造了三次（内置、外部活进程、重启对账），三份的信息量不同；
- "对某种 runtime 无意义的字段一律驳回"这条纪律只在 frontmatter 面被执行，调用面与 `follow_up` 面各有一批字段被默默吞掉；
- 文档描述的边界与代码实际的边界已经错位，其中一条是数据外发（外部进程会收到频道记忆），而文档说它不存在。

单看每一条都很小、都能忍。但这类问题会稳定地互相拉开距离：今天三份结算实现的差距是"用量和验收结论"，再放一轮就会变成没人敢动的三条独立路径。本 spec 的目标不是加能力，是**在差距还小的时候把缝合上**。

设计过程中另外确认了一条审查时漏掉的、同源的缺陷：外部 run 在超时或取消时，在读取 `events.jsonl` **之前**就结算（[external/run.ts:284](../../../src/subagents/external/run.ts#L284)），因此 `outputText` 为空、usage 全零、`sessionId` 丢失。一个跑满 40 分钟才超时的 run 记账为 $0，一个被取消的 codex 会话再也无法 `follow_up`。这与 040 D10.3 明写的"预算耗尽不丢弃已有产出"直接矛盾，成因和上面第一条完全一样。

## 五条修复原则

### F1 一个事实只在一处被构造

三个 `SettleInput` 构造点是本轮几乎所有正确性缺陷的共同根因。修法不是"让落后的那处补齐字段"——那只是把分叉推迟一轮——而是**让它不再自己构造**。判据：如果两处代码在回答同一个问题（这个 run 结算成什么？这个验收结论是什么？这个字段合法吗？），就必须只有一处代码真的在回答。

### F2 结算所需的输入必须先于进程落盘

活进程 watcher 的闭包里攒着一堆没被持久化的东西（`verifySubjectBefore`、`maxWallTimeSec`、真实进程启动时刻），于是重启后的对账**没有能力**做出和活进程一样的判断。这不是遗漏，是判据反了。正确的判据：**凡是 settle 需要读的东西，spawn 之前必须已经在 run 记录里。** 一个字段"只有 daemon 活着才知道"就等于"重启后一定会错"。

### F3 静默忽略是缺陷，不是宽容

040 的 P2 已经确立这条，它现在只在一个面上执行。继续在三个函数里补 `if` 会让下一次遗漏必然发生；把矩阵变成**数据**，让执行点只有一个，让测试可以遍历它。

### F4 承诺要么兑现，要么收缩，不留"大体上是这样"

三条承诺目前处于中间态：`mutates` 的并发保证（内置推定漏 `bash`）、外部 context 注入（文档说不存在）、CLI flag 契约（无任何真实验证）。每一条都要落到"代码追上文档"或"文档追上代码"，不允许停在模糊处。收缩不丢脸，模糊才危险。

### F5 不引入新的配置面

沿用 040 的 P4。本轮全部是内部一致性问题，**不产出任何新的 `settings.json` 键、`security.json` 段或用户操作步骤**。唯一涉及用户可见默认值的改动（D4 的外部 `memory` 缺省）通过改缺省而不是加开关来完成。

## 设计

### D1 结算收敛：一个 outcome，一份 `SettleInput`

新增 `src/subagents/external/settlement.ts`，只放纯函数（不 import run manager，避免与 `runs.ts` 形成运行时环；`SettleInput` 用 `import type`）：

```ts
/** 把一次外部 run 的观察结果翻译成唯一的结算输入。D4 状态判定、终止原因优先级、
 *  usage 映射、部分产出保留，全部只在这里发生。 */
export function buildExternalSettleInput(input: {
  harnessId: RunHarness;
  outcome: ExternalOutcome;
  durationMs: number;
  durationEstimated?: boolean;
  terminationReason?: "timeout" | "cancelled";
  maxWallTimeSec?: number;
}): SettleInput;

/** verify 判定规则（内外共用）：改了工作区 → fail；没有 VERDICT 结尾 → fail；
 *  其余按声明。只做判定，不做 IO —— attestation 的写入与 strength 由调用方决定。 */
export function resolveVerificationOutcome(input: {
  subjectBefore?: string;
  subjectAfter?: string;
  gitStateBefore?: string;   // 内置路径的回退信号，外部路径不传
  gitStateAfter?: string;
  finalText: string;
  runFailed: boolean;
}): { verdict: "pass" | "fail"; workspaceChanged: boolean; evidence: string };
```

两条外部路径改为同一个序列，**没有例外分支**：

```text
读 events.jsonl + stderr.log
  → harness.parseOutcome()
  → （purpose=verify 时）resolveVerificationOutcome() + writeVerificationAttestation(advisory)
  → buildExternalSettleInput()
  → settle()
```

这一步同时修掉四个缺陷，因为它们本来就是同一个缺陷：

| 缺陷 | 修法 |
|---|---|
| 跨重启的 run 丢 usage 却标 `usageKnown: true` | usage 一律取 `outcome.usage`，没有第二个来源 |
| 跨重启的 verify run 不写 attestation、无 verdict | verify 后处理进入共享序列，对账路径自然拥有它 |
| 超时/取消丢弃已解析的产出、usage 和 sessionId | 终止原因不再是"提前 return"，而是 `buildExternalSettleInput` 的一个入参：**先解析，再按终止原因覆盖 status 与 failureReason**，产出/usage/sessionId 原样保留 |
| 对账的 `durationMs` 含 daemon 停机时间 | 见下 |

**终止原因的优先级**保持 040 P1-1 的语义不变（`cancelled` → `cancelled`；`timeout` → `failed` + "Wall time budget exceeded (Ns)"，即使 CLI 在 SIGTERM 落地前恰好打印了成功终态），只是它现在作用于一个**已经带着产出的** outcome，而不是一个空壳。

**F2 的落实**：`setLaunched()` 已经是 spawn 后唯一的持久化点，在它上面追加三个字段，不增加写盘次数：

| 新字段 | 用途 |
|---|---|
| `verifySubjectBefore?: string` | 让对账路径有能力做 verify 判定（当前只活在闭包里） |
| `maxWallTimeSec: number` | 超时文案不再用 `(deadlineAt - startedAt)/1000` 反推（会因 register→spawn 间隔偏差） |
| `processStartedAt: number` | 真实进程启动时刻，区别于 `startedAt`（register 时刻） |

**时长的诚实处理**：对账路径无法知道进程何时结束。用 `events.jsonl` 的 mtime 作为结束时刻的估计（它就是子进程最后一次写盘的时间），拿不到时退回 `Date.now()`；两种情况都置 `durationEstimated: true`，展示层（唤醒文本、`/subagents`、`subagent_manage`）为 true 时显示 `≈12m03s`。

选 `durationEstimated: boolean` 而不是把 `durationMs` 改成可选：后者会波及唤醒文本、`format.ts`、两个列表面和 archive 记录，为一个展示问题付结构代价。这个布尔不守护任何副作用，因此不违反 040 P5 的"只为不可重放的副作用引入标记"——它是数据，不是状态。

**内置路径不并入。** 它的 outcome 形状根本不同（turns、toolCalls、pi usage、convergence turn），强行合并会造出一个两边都不合身的联合类型。内外共享到 `resolveVerificationOutcome`（判定规则）为止；attestation 的写入各自调用，因为 `verificationStrength` 本来就必须不同（`enforced` vs `advisory`，040 D9）。

### D2 派发失败在同一回合如实返回

`launchExternalRun` 改为返回结果而不是 `void`：

```ts
export type ExternalLaunchResult =
  | { ok: true }
  | { ok: false; kind: "missing-binary" | "launch-failed" | "cancelled"; reason: string };
```

三条失败路径（产物文件打不开、spawn 失败、spawn 前被取消）统一改为 **`announce: false`**，由调用方在同一个工具调用里返回失败。理由：这个失败发生在派发的同一回合，模型就在现场；绕一圈用唤醒告诉它，等于白烧一个主代理回合，还会让用户先看到"已派发"再看到"失败"。`cancelled` 那条今天更糟——它 `announce: false` 却仍然返回"已派发，等唤醒"，模型会一直等一个永远不来的结果。

**错误类型按 AGENTS.md 的既有判据分**（"模型能不能独自解决"）：

- `missing-binary`（spawn `ENOENT`/`EACCES`）→ 普通 `Error`。用户必须动手装 CLI 或修 `command`；错误文本给出安装指引，且**不得建议改用内置角色**（040 D5 的既有约束，静默降级正是该 spec 要消灭的失败模式）。
- 其余 → `RecoverableToolError`。

**lease 的归属**写清楚：失败返回时 `settle()` 已经释放并清空了 `record.leaseKey`，调用方**不得**再次释放。D5 的归属校验让重复释放退化为无害的 no-op，但契约仍然只有一个所有者。

### D3 字段合法性矩阵变成数据

把两处硬编码的字段列表换成一张表，`resolveSubAgentConfig` 是唯一执行点：

```ts
type FieldSupport = "supported" | "rejected";
export const ROLE_FIELD_MATRIX: Record<string, Record<SubAgentRuntime, FieldSupport>>;
export const INVOCATION_FIELD_MATRIX: Record<string, Record<SubAgentRuntime, FieldSupport>>;
```

角色面补上 040 D5 矩阵里漏掉的一格：内置角色的 `shell` / `env` 从静默忽略改为驳回。

调用面（当前完全没有执行）新增三格驳回：

| 调用参数 | 外部角色 | 驳回文案给的下一步 |
|---|---|---|
| `tools` | 驳回 | 外部智能体的工具边界由它自己的 `command`（如 `--sandbox read-only`）决定，不在调用面 |
| `model` | 驳回 | 外部角色的模型只能在角色文件里配；pipiclaw 无法校验另一个 CLI 的模型名 |
| `returns: "artifact"` | 驳回 | 外部委派的完整产出固定落在 `output.md`；需要指定产物位置就把它写进 `task` 契约 |

`model` 今天的行为特别值得点名：它不但被忽略，还会**先去 `models.json` 解析**，解析不到就拒掉一次和它完全无关的外部委派。

`returns: "artifact"` 选驳回而不是实现，理由是语义不匹配而非成本：ARTIFACT marker 的既有实现把产物限制在 `artifactDir` 内（防路径逃逸），而外部 Agent 的主产出天然在**工作目录**里。实现它等于造一个和内置同名却不同义的协议。同时**从外部任务信封里删掉 ARTIFACT 协议注入**——今天外部 Agent 会被要求遵守一个没有任何代码读取的协议。

`context` / `paths` 对外部**保持 supported**（那是 040 P0-3 的正确修复），但见 D4。

### D4 外部 context 注入：缺省收缩 + 如实声明

事实：一次 `contextMode: contextual` 的外部委派，会把 `SESSION.md` 摘要和召回的 `MEMORY.md` / `HISTORY.md` 片段写进 `prompt.txt`，交给第三方 CLI，进而交给第三方 API。`docs/sub-agents.md` 目前说外部角色**没有**这两个字段。

三个选项，按 F4 和 F5 取舍：

| 选项 | 结论 |
|---|---|
| 只改文档 | 不够。缺省行为（`contextual` 隐含 `memory: relevant`）把频道记忆送出去，而用户从未做过这个选择 |
| 加 `settings.json` 开关 | 驳回，违反 F5。这是一个角色粒度的决定，不是全局旋钮，而角色文件已经是它正确的位置 |
| **改缺省 + 如实声明** | 采纳 |

具体：

1. **外部角色的 `memory` 缺省改为 `none`**，不再跟随 `contextMode`。显式写 `memory: session|relevant` 才注入，此时 discovery 产生一条**提示级 warning**（不是错误、不影响加载）："该角色会把频道会话状态/记忆片段发送给外部进程"。
2. **调用面的 `context: session|relevant` 对外部角色仍然生效**。它是模型每次委派的显式决定（让外部 reviewer 知道会话背景是正当用途），与角色文件里那个会被忘记的缺省不是一回事。
3. `/subagents roles <name>` 对外部角色也显示 `contextMode` / `memory`（今天只在内置分支显示）。
4. `docs/sub-agents.md` 把这条路径写进"授权与安全边界"一节，与"外部进程继承环境变量"并列——它们是同一类如实声明的暴露面。

`paths` 的注入保留且不作声明：它只是路径名，不是内容。

### D5 lease 归属化

`releaseWorkspaceLease(leaseKey, runId)` 校验 `leases.get(key)?.runId === runId` 才删除。今天按 key 无条件 `delete` 有两个后果：

- restore 时 lease 重建失败只记 warning 就继续（[runs.ts:740](../../../src/subagents/runs.ts#L740)），而该 run 结算时照样释放同一个 key —— **把真正持有者的锁删掉**；
- 重建成功时不回写 `rebuilt.leaseKey`，`realpath` 一旦漂移，锁就泄漏到进程生命周期结束，此后该目录上所有写委派永久被拒。

配套两条：

- 重建成功 → `record.leaseKey = rebuilt.leaseKey` 并持久化；
- 重建失败（冲突）→ `record.leaseKey = undefined`。它**确实没有**锁，让记录如实反映这一点，既避免误删别人的，也让 `/subagents list` 与 `show` 能标注"写锁未能重建，可能与 `<runId>` 并发写同一目录"。

不自动把冲突的 adopted run 判 `lost`：它可能真的在跑，杀掉一个正在写工作区的进程需要人的决定。这一格缺口进风险清单，用可见性补。

### D6 `mutates` 与 `bash`：不动推定，补上声明缺口

`inferMutatesFromTools` 只看 `write` / `edit`，而内置默认工具集是 `read,bash`。于是默认内置角色和全部 inline 委派都被推定为 `mutates: read`、不取写锁——`examples/sub-agents/git-committer.md` 这种会 `git commit` 的角色也在其中。"runtime 保证委派之间不并发写同一棵树"在最常见的内置角色上并不成立。

**把 `bash` 计入推定的方案被驳回**：默认工具集含 `bash`，那样会让两个并行的只读 `explorer` 互相排斥，用一个正确性边界换掉一个高频正常用法，代价倒挂。

采纳的是把决定交还给唯一掌握信息的人：

1. 角色 `tools` 含 `bash` 且**未显式声明** `mutates` 时，discovery 产生一条提示级 warning："该角色可通过 bash 写入但未声明 `mutates`；若它会修改工作区，显式写 `mutates: write` 才会参与写锁"。零行为变更、在 `/subagents list` 尾部与 `roles` 里可见。
2. `examples/sub-agents/git-committer.md` 补 `mutates: write`（它确实会写）。
3. `docs/sub-agents.md` 与 `agent-delegation.md` 如实收缩：`mutates` 对内置角色是**推定**、对外部角色是**自述**，两者 runtime 都无法核实，因此写锁保证的是"**声明了写的委派之间**不并发"，不是"这棵树上只有一个写入者"。040 D10.1 已经声明它不是安全边界，本条补上"它作为并发保证同样依赖声明的诚实"。

### D7 `follow_up` 与首发同源

`follow_up` 今天是首发路径的一份手写近似，三处不一致：信封只补了 verify 协议（缺 runtime context、context blocks，尤其缺**新的 artifact 目录**，外部 Agent 不知道该往哪写）；verify 准入不检查（角色若已改成 `mutates: write` 会照常取锁并派发，而首发对同一情形硬拒）；`artifactDir` 用正则做字符串外科手术。

改为共用首发的两个构件：

```ts
assertVerifyAdmissible({ config, purpose, workingDirectory })   // 新增，首发与 follow_up 共用
buildSubAgentTask(...)                                          // 既有，follow_up 改为也走它
```

`follow_up` 因此变成："构造一个新的 `SubAgentRunContext`（`artifactDir` 用 `join(dirname(prev), newRunId)`）→ 跑同一套 verify 准入 → 用同一个 `buildSubAgentTask` 生成信封 → `launchExternalRun`"。`SubAgentManageToolOptions` 的 `workspaceDir` / `channelDir` 从可选改为**必填**（生产装配一直在传；`?? ""` 的默认值会让审计日志落到进程 cwd、verify 任务路径拼错，是个指向错误方向的默认值）。

**角色热更新的相容性**（040 P1-2 的遗留项）做一半，不做全量 invocation snapshot：run 记录新增 `roleFingerprint`，只覆盖**影响执行契约**的字段（`command`、`externalModelRef`、`shell`；`harness` 已单独校验）。fingerprint 不匹配时拒绝续接并说明原因，让模型改开新委派。

**不纳入** `systemPrompt` 正文与 `maxWallTimeSec`：正文改了继续 resume 是合理的（resume 本就带着旧会话），把它纳入会让"修一个错别字就断掉所有在途续接"。全量 snapshot 被驳回也是同理——它把"改角色修 bug"变成不可能，代价大于它挡住的风险。

### D8 kill 宽限按场景分离

`killProcessGroup` 今天固定 300ms 后无条件 SIGKILL，而且在**每次正常退出**后也被无条件调用。两个后果：coding agent 来不及 flush 终态事件，于是 040 D10.3 承诺的"预算耗尽仍回传部分产出"在实践中几乎拿不到东西（D1 修了丢弃逻辑，这里修的是"根本没写出来"）；每次结算固定多付 300ms。

```ts
export function isProcessGroupAlive(pid: number): boolean;      // kill(-pid, 0)
export async function reapProcessGroup(pid: number): Promise<void>;
export async function killProcessGroup(pid: number, graceMs?: number): Promise<void>;
```

- **取消 / 超时** → `killProcessGroup(pid, 5_000)`。代码常量，落在 sweep 的 30s 窗口内，不影响时序。
- **正常退出后的清理** → `reapProcessGroup(pid)`：先 `isProcessGroupAlive`，组空立即返回。用 `kill(-pid, 0)` 探**进程组**而不是 `isProcessAlive(pid)` 探 leader，正好精确回答现有注释担心的那个问题（"leader 先退、后代还在"），而且不必为此给每个 run 付 300ms。

### D9 GC 挂进 sweep，产物有保留窗口

`collectGarbageIfExpired` 今天只在 `restore()` 内被调用，因此长期在线的 daemon 里终态记录只增不减（内存 + `state/subagent-runs/`），两个列表面（都没有条数上限，`subagent_manage op=list` 还把完整 `RunRecord[]` 放进 `details`）随之无界增长。040 的偏差表也已承认 `subagent-artifacts/` 下的辅助产物无限期保留。

- GC 移入既有的 30s `sweep()`，遍历扩成两段（running/external 的对账 + terminal 的回收）。
- 保留策略分层：**辅助产物 24 小时**（`prompt.txt`、`system-prompt.txt`、`events.jsonl`、`stderr.log`），**run 记录与 `output.md` 7 天**，attestation 随任务台账不动。
- `RETENTION_MS` 从 24h 扩到 7d 是有意的：对一个异步委派系统，"昨天那个 run 查不到了"太短，而磁盘大头是 `events.jsonl`，它按 24h 清就够了。
- 两个列表面加条数上限（50）与尾注"还有 N 条，用 `list all` / filter 收窄"。

### D10 占位符：展开后仍未定义的 token 整个丢弃

`command: claude --model $MODEL` 在角色没配 `model:` 时，今天会真的执行 `claude --model '$MODEL'`（实测确认）。040 D4 之所以坚持 argv 而不是 shell 字符串，原文理由是"引号处理出错的后果是执行一条与设计不同的命令"——这里是同一类失败换了个入口。

规则统一成一条，对所有占位符成立：**任何 token 在展开后仍包含未定义的占位符，整个 token 被丢弃**，并产生一条 invocation warning 记入 run。

选"整 token 丢弃"而不是"删 token 及其成对 flag"：后者要猜哪个前置 token 是配对的 flag，而 `-c model_reasoning_effort=$EFFORT` 这种把 flag 和值放在同一 token 里的写法会让任何配对启发式出错。整 token 丢弃对 `--model $MODEL`（两 token，删掉值后 `--model` 悬空）确实还会留下一个孤儿 flag——因此再补一条 discovery 侧的**前置提示**：角色 `command` 引用 `$MODEL` 但未配置 `model:` 时产生 warning，让错误出现在角色目录里而不是运行时。`$EFFORT` 不做前置判定，因为 `thinkingLevel` 可以由调用面传入，角色未配并不等于无值。

### D11 顺序、命名与其余小项

- **审计写在准入之后**：`external-agent` 事件移到 `runManager.register()` 之后、spawn 之前。它的语义是"记录**被执行**的动作"（040 D8.1），并发上限拒绝时不该留下一条进程从未存在的"已派发"记录。
- **`restoreChannelJobs` 改 `await`**：与已改为 await 的 `restoreAllSubAgentRuns` 是同一条准入竞态，今天只修了一边。
- **角色重名：校验通过才占名**。今天 `knownNames.add(name)` 在校验之前，按文件名排序在前的坏文件会连带吃掉同名的合法角色，而注释写的是相反的意图。改为合法角色才占名；两个都合法时才报 duplicate。
- **补 `child.unref()`**（040 D1 明确要求）。今天靠关停路径的 `process.exit(0)` 掩盖，对 TUI 与测试进程仍是"退不出去"的隐患。`unref()` 只影响事件循环保活，不影响 `close` 事件投递，活进程 watcher 不受影响。
- **`resolveRunWorkingDirectory` 改异步** `stat`（今天在 daemon 事件循环上做 `existsSync` + `statSync`）。
- **`UsageLedgerEntry.runId` 真正成为幂等键**：在 **summarize 侧**按 `kind === "subagent" && runId` 去重。读时去重天然幂等、零写入成本，比在 `record()` 里查历史便宜得多；那个字段今天自称幂等键却从未被任何代码消费。

### D12 CLI 契约的真实验证

`claude-code` / `codex-cli` 的 argv 与事件 schema 目前全部由自写 fixture 断言——测试在证明代码与自己一致，不在证明它与真实 CLI 一致。解析侧尚可容忍（`parseOutcome` 禁止抛异常、无终态永不判成功，失败会降级）；**argv 侧不可容忍**：一个不存在的 flag 会让该角色的每一次委派立刻失败，而目前没有任何先于用户发现它的手段。

- `test/e2e/subagent-external-smoke.test.ts`，默认 skip，由 `PIPICLAW_E2E_HARNESS=claude-code,codex-cli` 打开。每个 harness 一次最小真实委派（"回复 OK"），断言结算为 `completed` 且 `finalText` 非空。非门禁，但把"协议漂移"从"用户先发现"变成"跑一次就知道"。
- run 记录新增 `parserVersion`（代码常量，harness 适配器每次改解析就 +1）与 `cliVersion?`（launch 前 `<executable> --version` 探一次，1s 超时、失败即放弃）。`/subagents show` 展示两者——运维今天分不清"Agent 失败"与"适配器过期"，这两个字段就是那条分界线。

## 已驳回的方案

| 方案 | 结论 | 理由 |
|---|---|---|
| 让重启对账路径逐字段补齐 `SettleInput` | 驳回 | 只把分叉推迟一轮。F1 的判据是"同一个问题只有一处代码在回答" |
| 把内置结算也并入共享构造器 | 驳回 | outcome 形状根本不同（turns/toolCalls/convergence turn），会造出两边都不合身的联合类型。共享到判定规则为止 |
| `durationMs` 改成可选 | 驳回 | 为一个展示问题波及唤醒文本、`format.ts`、两个列表面与 archive。改用 `durationEstimated` 布尔 |
| 把 `bash` 计入 `mutates` 推定 | 驳回 | 默认工具集含 `bash`，会让并行只读委派互斥。用正确性边界换掉高频正常用法，代价倒挂（D6） |
| 为外部 context 注入加 `settings.json` 开关 | 驳回 | 违反 F5。这是角色粒度的决定，角色文件已经是它正确的位置。改缺省即可（D4） |
| 实现外部的 `returns: "artifact"` | 驳回 | 语义不匹配：既有实现把产物限制在 `artifactDir` 内，而外部主产出天然在工作目录。会造一个同名不同义的协议（D3） |
| 全量 invocation snapshot（argv 模板、env key、prompt hash） | 驳回 | 会让"改角色修 bug 后续接旧会话"变成不可能。只 fingerprint 影响执行契约的三个字段（D7） |
| restore 时 lease 冲突就把 adopted run 判 `lost` | 驳回 | 它可能真的在跑。杀一个正在写工作区的进程需要人的决定；改为如实标注 + 可见性（D5） |
| 把 `parseOutcome` 换成按 CLI 版本分派的多版本解析器 | 驳回 | 在真实冒烟存在之前，多版本分支只是没有证据支撑的复杂度。先有 D12 的观测，再谈分派 |

## 非目标

- **不改 040 的任何设计取舍。** 排他写锁不升级为读写锁、主代理仍不参与 lease、外部智能体仍不被沙箱化、角色目录仍热加载、`security.json` 仍不增段。
- **不做外部副作用的幂等账本**（040 的非目标，不变）。本 spec 保证 run 不被重复结算、重复记账、重复唤醒；不保证一个已经 push 的外部 builder 被重派不会造成真实伤害。
- **不新增 harness、不新增角色能力、不做编排。** 审查的结论是"趁缝还小的时候合上比继续加能力更值"，本 spec 严格遵守它。
- **不重构内置子代理的执行路径**（convergence turn、budget abort、工具集裁剪保持原样）。

## 兼容与迁移

| 面 | 影响 |
|---|---|
| 外部角色 `memory` 缺省 | **有变化**：`contextual` 不再隐含 `relevant`，缺省为 `none`。想保留原行为的角色显式写 `memory: relevant` |
| 调用面 `tools` / `model` / `returns: artifact` 作用于外部角色 | **有变化**：静默忽略 → 驳回。模型会看到新的 `RecoverableToolError`，带可执行下一步 |
| 内置角色的 `shell` / `env` | **有变化**：静默忽略 → 驳回。与既有的字段驳回语义一致，**该角色不再加载**并产生 warning。误写过这两个字段的角色会从目录消失，需按 warning 修正 |
| 外部派发失败 | **有变化**：从"[Dispatched] + 稍后唤醒（或永不唤醒）"变为同一回合报错 |
| 超时 / 取消的结算内容 | **有变化**：不再是空产出。会带回已解析的助手文本、usage 与 sessionId（因此超时的 codex run 从此可以 `follow_up`） |
| 跨重启结算的 run | **有变化**：usage 不再为零、verify 会写 attestation、时长带 `≈` |
| 记录与产物保留 | **有变化**：run 记录 24h → 7d；辅助产物新增 24h 清理 |
| 取消 / 超时的 kill 宽限 | **有变化**：300ms → 5s |
| `follow_up` | **有变化**：角色的 `command`/`model`/`shell` 变更后拒绝续接（fingerprint 不匹配） |
| `subagent` 调用 schema | **不变**。一个字段都不增减（040 D6 的承诺继续成立） |
| 角色文件既有字段语义 | **不变**，除上表两行 |
| `settings.json` / `security.json` | **不变**。本 spec 不产出任何配置项 |

## 实现顺序

每阶段结束 `npm run check` 必须通过。

1. **正确性**（D1 + F2 落盘、D2、D5、D10、D11 的审计顺序与 `restoreChannelJobs`）。放在一起是因为它们改的是同一批文件（`runs.ts`、`external/run.ts`、`tool.ts`、`workspace-lease.ts`），拆开只会制造冲突。
2. **契约诚实**（D3、D4、D6、D7、D11 的重名与其余小项）。这一阶段会产生用户可见的驳回与 warning，`docs/sub-agents.md`、`agent-delegation.md`、`examples/` 必须同批更新。
3. **运维与信心**（D8、D9、D12）。可独立发布。

## 测试

按 D 节列出**必须新增**的断言；既有的 12 个 sub-agent 测试文件继续作为回归基线。

- **D1**：跨重启结算的 run 携带解析出的 usage（当前 `subagent-restart-adoption.test.ts` 一条 usage 断言都没有）；跨重启的 `purpose=verify` run 写出 attestation 且 `verificationStrength: advisory`；超时与取消的结算带回非空 `outputText` 与 `sessionId`；对账时长带 `durationEstimated`。
- **D2**：spawn `ENOENT` 时工具**抛出**带安装指引的普通 `Error` 且不产生唤醒；cancel-before-spawn 不返回"[Dispatched]"；两种失败后 lease 已释放且不被二次释放。
- **D3**：矩阵遍历测试——对每个字段 × 每个 runtime 断言 `supported` / `rejected` 与实现一致（这条测试的价值是让下一次遗漏不可能悄悄发生）；外部角色 + 调用面 `model` 时返回驳回而不是去解析 `models.json`；外部信封不含 ARTIFACT 协议。
- **D4**：外部角色未写 `memory` 时 `prompt.txt` 不含会话/记忆片段；显式写 `memory: relevant` 时含且产生 warning；调用面 `context: relevant` 对外部仍生效。
- **D5**：restore 冲突时旧持有者的锁不被后来者的结算删除；重建成功后 `leaseKey` 被回写。
- **D6**：`tools` 含 `bash` 且无 `mutates` 的角色产生 warning 且**行为不变**（不取锁）。
- **D7**：`follow_up` 的 `prompt.txt` 含 runtime context 与新 artifact 目录；verify 准入在 follow_up 上同样生效；`command` 变更后拒绝续接、正文变更后仍允许。
- **D8**：正常退出后不发送任何信号且不等待宽限；取消时等满 5s 宽限。
- **D9**：sweep 回收过期终态记录并删除辅助产物、保留 `output.md`；列表面超上限时给出尾注。
- **D10**：`$MODEL` 未定义时该 token 被丢弃且 run 记录带 warning（当前所有占位符用例都提供了值）；discovery 对"引用 `$MODEL` 但未配 `model:`"产生 warning。
- **D11**：并发上限拒绝时**不写** `external-agent` 审计事件；坏文件不再吃掉同名的合法角色；`/usage` 对重复 `runId` 的 subagent 条目只计一次。
- **D12**：opt-in 冒烟按 env 跳过时不影响 `npm run test`；`/subagents show` 展示 `parserVersion`。

## 风险

1. **第二阶段的驳回是破坏性的。** 内置角色误写 `shell`/`env` 会让角色从目录消失；模型习惯于对外部角色传 `model` 的话会开始收到错误。这是 F3 的必然代价——静默忽略的存量必须被暴露一次才能清掉。缓解：warning 文案给出确切的修正动作，`/subagents roles` 能看到，发布说明点名。
2. **`memory` 缺省收缩会改变已有外部角色的行为。** 一个依赖会话上下文的外部 reviewer 会突然"失忆"。缓解：discovery 对显式声明产生提示、文档给出一行迁移说明、`examples/` 里需要上下文的角色显式补 `memory:`。
3. **7 天保留会让 `state/subagent-runs/` 与 `output.md` 占用上升。** 相对于 24h 清掉的 `events.jsonl`（真正的大头），净效应应为下降，但没有实测数据。缓解：先发，观察一个真实周期再定是否调整。
4. **`roleFingerprint` 可能误伤。** 用户为修一个 `command` 里的拼写错误而改角色，会切断所有在途续接。这是有意选择的方向（宁可让模型新开一个 run），但如果实践中触发频繁，正确的下一步是把 fingerprint 收窄到 `harness` + `executable`，而不是放弃校验。
5. **D12 的真实冒烟依赖本机装了对应 CLI 且已登录**，因此它永远不是门禁，只是一次可主动触发的确认。CLI schema 漂移仍然是 040 就已接受的长期维护成本，本 spec 只是把发现它的时机从"用户报障"提前到"跑一次冒烟"。
6. **本 spec 修的是一致性，不增加任何能力。** 它对用户可见的净收益主要是"跨重启不再丢账和丢验收"与"失败不再假装成功"。如果按能力密度评估，它看起来性价比低；按"下一轮审查的起点"评估则相反——这一点需要在决定做不做的时候明说。

## 实施记录

2026-08-10 三个阶段全部实施完成，逐条对照设计无实质偏差：

- **第一阶段**（D1、D2、D5、D10、D11）：新增 `src/subagents/external/settlement.ts`（`buildExternalSettleInput`/`finalizeExternalRun`，内外结算唯一入口）与 `src/subagents/verification-outcome.ts`（`resolveVerificationOutcome`，内外共用判定规则）；`RunRecord` 新增 `verifySubjectBefore`/`maxWallTimeSec`/`processStartedAt`/`channelDir`/`durationEstimated`/`invocationWarnings` 字段，均在 `setLaunched()` 落盘；`launchExternalRun` 返回 `ExternalLaunchResult` 而非 `void`；`releaseWorkspaceLease` 增加 `runId` 归属校验；`restoreChannelJobs` 改 `await`；`expandPlaceholders` 丢弃未解析占位符的整个 token 并通过 discovery 产出前置提示。
- **第二阶段**（D3、D4、D6、D7）：`discovery.ts` 新增 `ROLE_FIELD_MATRIX` 数据表驱动角色字段合法性；`resolveSubAgentConfig` 对外部角色的 `tools`/`model` invocation override 直接驳回；`tool.ts` 对外部角色的 `returns: "artifact"` 驳回并从外部信封移除 ARTIFACT 协议；外部角色 `memory` 默认值改为 `"none"`（不再跟随 `contextMode`），显式声明产生提示；`bash` 未声明 `mutates` 产生提示；`tool.ts` 导出 `buildSubAgentTask`/`buildContextualBlocks`/`assertVerifyAdmissible`/`SubAgentRunContext`（`buildContextualBlocks` 的 `options` 参数收窄为 `ContextualBlocksOptions`，仅六个字段，供 `follow_up` 复用而不必接入完整 `SubAgentToolOptions`）；`follow_up` 改为构造真实 `SubAgentRunContext` 并复用上述函数；新增 `externalRoleFingerprint()`（覆盖 `command`/`externalModelRef`/`shell`，不含正文），持久化并在 `follow_up` 校验；`SubAgentManageToolOptions` 的 `workspaceDir`/`channelDir` 改为必填。
- **第三阶段**（D8、D9、D12）：`host-process.ts` 拆分为 `isProcessGroupAlive`/`reapProcessGroup`/`killProcessGroup`（默认宽限 300ms→5s，`reapProcessGroup` 探测为空立即返回）；`sweep()` 纳入两层 GC（辅助产物 24h、run 记录与 `output.md` 7 天）；`subagent_manage op=list` 与 `/subagents list` 增加 50 条上限与截断提示（运行中的 run 永不截断）；`ExternalHarness` 新增 `parserVersion`（三个 harness 均为 `1`），新增 `probeCliVersion()`（`--version` 探测，1s 超时、失败静默降级），随 `setLaunched()` 落盘并在 `/subagents show` 展示；新增 `test/e2e/subagent-external-smoke.test.ts`，由 `PIPICLAW_E2E_HARNESS=claude-code,codex-cli` 开启，默认 skip。

**验证**：每个 D 项落地后单独 `npm run check`；三个阶段各自额外跑过一次完整 `npm run check`；最终态 `npm run check` 通过（lint + typecheck + knip + 全部测试）。新增测试覆盖每个 D 项在设计文档"测试"一节列出的断言。
