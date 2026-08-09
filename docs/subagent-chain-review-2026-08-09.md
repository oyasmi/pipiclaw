# Sub-agent 链路审查：统一抽象已成，生命周期尚未闭环

日期：2026-08-09  
审查基线：`1e9d333a4b64703bf99a3d9525db3b4af32b7d92`  
范围：角色发现、提示与 playbook、`subagent` / `subagent_manage`、内置执行、外部 harness、run 生命周期、写锁、持久化、唤醒、任务衔接、用量与人侧命令。

## 结论

这轮改造选对了主轴：**委派应统一“选谁、如何记录、如何交付”，不强行统一执行器**。角色目录、统一 run、协议终态、产物目录、短 runId、人侧 `/subagents`、模型侧 `subagent_manage`、外部安全边界的如实披露，已经把原先“一个 typed tool 对一段外部 prose”的结构性偏斜扳正。它不是简单增加 Claude/Codex 适配器，而是在建立 Pipiclaw 作为主控 Agent 的核心控制面。

但目前还不能把这条链路称为“重启安全、生命周期闭环”。最危险的不是 happy path，而是三个契约断点：

1. **外部 run 跨 daemon 重启的承诺没有实现闭环**：活进程不会被重新观察，超时、取消、写锁也不会被重新接管。
2. **结算标记只能防止同进程重复，不能修复半完成阶段**：归档或持久化窗口可能让已完成 run 永久不唤醒，usage 的“恰好一次”也没有真实成立。
3. **外部路径没有收到与内置路径等价的任务信封**：`context`、`paths`、runtime 路径和 `purpose=verify` 协议没有送进外部 Agent。

这三项应作为 0.9 前的发布阻断项；先把事实状态机做实，再扩更多角色、harness 或编排能力。

## 值得保留的设计取舍

- **统一 run、不统一执行**是正确边界。内置 worker 与外部 CLI 的成本、恢复和权限模型确实不同；共同部分应止于准入、状态、产物、结算和交付。
- **外部一轮一个短命进程**显著降低了协议复杂度；后续轮次用 resume 产生新 run，也保住了审计与成本边界。
- **结构化 harness 以协议终态判成功**，不把 exit 0 当完成证据；`exec` 被明确降级且禁止承担 verify，这个取舍诚实。
- **外部角色不静默降级为内置角色**，避免“看似完成、实则换了执行能力”的隐性失败。
- **角色目录按 runtime / workload / mutates 分组**，加上精炼的 `agent-delegation.md`，让主 Agent 按工作性质选人，而不是按 CLI 品牌选人。
- **工作目录逐次决定、写委派取排他 lease、并行写用独立 worktree**，这是主控 Agent 应承担的正确职责。
- **`/stop` 与委派取消解耦**、同时提供不经模型的 `/subagents cancel`，使长任务不再被主回合偶然中止，也保留了用户的最终控制权。
- **外部 Agent 不经过 Pipiclaw guard** 已在文档中明确说明；`mutates` 没有被包装成沙箱，这是正确的诚实边界。

## 发布阻断项

### P0-1 外部 run 的重启恢复只是一次探针，不是重新接管

设计稿要求 `detached + unref + stdio 直接落盘`，实现却用 `stdio: ["pipe", "pipe", "pipe"]`，由父进程转写文件，也没有 `child.unref()`（[external/run.ts](../src/subagents/external/run.ts#L159)）。这有两个后果：正常关闭可能被 child/pipe 引用拖住；daemon 消失后，子进程继续向已经断开的 pipe 写，不能可靠地把协议事件留在产物目录。

restore 对活 pid 只做一次 `isProcessAlive()` 后返回（[runs.ts](../src/subagents/runs.ts#L689)）。它没有重新建立：

- 结束观察或周期性 reconcile；活进程稍后退出后，记录会一直是 `running`，直到下一次 daemon 重启；
- 原有 deadline；`maxWallTimeSec` 甚至没有进 `RunRecord`，重启后可无限运行；
- cancel handle；重启后取消只会把 run 标成 `lost`，不会杀进程；
- workspace lease；lease 是进程内 Map，restore 没有重建，新的写委派可与尚存的旧进程写同一 checkout；
- 可靠的进程身份校验；当前 `fingerprint` 是未被消费的随机串，既没写 `run.json`，也不能防 PID 复用。

此外，bootstrap 用 `void restoreAllSubAgentRuns()`（[bootstrap.ts](../src/runtime/bootstrap.ts#L1287)），新消息可能在恢复完成前进入准入，导致并发计数、短 ID 和写锁都只看到部分状态。

**建议**：把外部执行改成真正可收养的 supervisor 模型。

1. spawn 前持久化 `deadlineAt`、最终 argv、cwd、process-group identity 和 capability snapshot；stdout/stderr 以文件描述符直接指向产物，child `unref()`。
2. 用一个很薄的 wrapper 写 durable `exit.json`（exit code / signal / finishedAt）；runtime sweeper 只读 pid identity、exit receipt 和事件文件，不依赖旧父进程的 `close` 事件。
3. 启动时**先 await restore，再开放委派准入**；对仍活的 run 重建 lease、deadline timer/sweeper 和可验证的进程组取消能力。
4. 进程身份使用 OS 可核实的 start time / process-group 信息，而不是随机 cookie；无法核实时宁可 `lost`，绝不误杀复用 PID。

应新增一个真实重启集成测试：启动会延迟写文件的 detached writer → 销毁首个 manager/runtime → 新 runtime restore → 验证写锁仍被占用、可取消、到期会杀、自然结束会自动结算并只唤醒一次。

### P0-2 结算有幂等标记，但没有可恢复的分阶段提交

`settle()` 先在内存设置 `settledAt`，然后写 output、释放 lease、best-effort persist，再记 usage、写 archive、最后 enqueue wake（[runs.ts](../src/subagents/runs.ts#L459)）。原则上顺序合理，问题在于每一步失败后的恢复语义没有闭合：

- 首次 settlement persist 不是 required；失败后仍会继续副作用，重启读取到旧的 `running` 记录可重复结算。
- `usageRecorded = true` 在 ledger 接受记录之前设置；ledger 使用 `tryAppend`，可能丢弃，且没有按 `runId` 去重。
- `store.logSubAgentRun()` 队列满会抛错；异常会阻断后面的 wake。此时内存已有 `settledAt`，后续 `settle()` 直接 return；重启时 terminal record 也不会补做缺失的 usage/archive/wake，于是完成结果可永久沉默。
- crash 在 ledger append 与 marker persist 之间会重复计费；三个 marker 目前只“防重”，没有驱动“补齐未完成阶段”。

`SubAgentRunManager` 作为唯一结算权威的方向没错，但权威必须拥有**阶段推进与恢复**，不能只拥有一个大函数。

**建议**：将结算收敛成可重放的 saga：

```text
terminal persisted
  → output persisted
  → usage/archive recorded（各自以 runId 幂等）
  → durable wake accepted
  → phase markers persisted
```

- 每个阶段转换都 required persist；restore 对所有 terminal record 补做未完成阶段，而不只处理 `running`。
- archive 是观测面，失败不得阻塞 wake；可异步重试或按 runId 去重后 at-least-once 写入。
- usage ledger 应在写入端或汇总端以 `kind + runId` 去重；跨文件副作用无法仅靠 run JSON 中的布尔值获得 exactly-once。
- lease 释放应发生在进程组确认结束后，并把“当前是否持锁”与历史 `leaseKey` 分开，否则终态记录仍会被 UI 显示为“持有写锁”。

测试应在 persist、output、ledger、archive、dispatch 每个边界注入一次失败并重启，验证最终状态相同、没有重复账、没有丢 wake。

### P0-3 内外两条路径没有共享同一份委派任务信封

内置路径会调用 `buildContextualBlocks()` 与 `buildSubAgentTask()`，注入 runtime 路径、session/relevant memory、`paths`、artifact 目录和 verify 协议（[tool.ts](../src/subagents/tool.ts#L1017)）。外部路径却直接把原始 `params.task` 与角色正文交给 `launchExternalRun()`（[tool.ts](../src/subagents/tool.ts#L752)）。因此：

- 外部角色配置或调用中的 `context` / `paths` 实际不生效；
- 外部 Agent 不知道 channel/task 文件和 artifact 目录；
- `purpose=verify` 虽会事后解析 `VERDICT`，却没有像内置 verifier 那样注入 task 文件位置、逐项验收要求和精确结尾协议；
- follow-up 继承 verify purpose 时也存在同一问题。

这不是文档措辞问题，而是统一调用契约在 runtime 分叉处丢了一半。外部 advisory verify 很容易因为根本没收到协议而稳定得到 FAIL，或只凭调用者偶然把全部要求写进 task 才工作。

**建议**：在选择 runtime 之前生成唯一的 `DelegationEnvelope`，至少包含 task contract、working/artifact/channel/task 路径、context blocks、purpose protocol、output contract 和不可信输出声明。内置 worker与外部 harness只负责传输这个信封；harness 不应重新决定业务语义。对于明确只支持某 runtime 的字段，要么实现，要么在 resolved runtime 后返回 recoverable rejection，不能静默忽略。

## 高优先级问题

### P1-1 cancel、timeout 与状态词汇尚未一致

- 内置 cancel 只设置 `externallyCancelled` 并 abort；最终通常按 `failed` 结算，而不是 `cancelled`。
- 外部 timeout 只 kill process group，没有记录 `timedOut`。若 CLI 在 SIGTERM 后输出成功终态，run 甚至可能被判 `completed`；失败时也不会得到设计承诺的“wall time budget exceeded”原因。
- 外部 launch 在检查 `cancelledBeforeSpawn` 后，先 await `setLaunched()`，再替换 live cancel handle（[external/run.ts](../src/subagents/external/run.ts#L201)）。这个窗口内的 cancel 只设置一个已经检查过的 flag，进程会继续跑。
- 重启后 cancel 不杀外部进程，见 P0-1。

建议让 manager 持久化 `cancelRequestedAt` / `terminationReason`，由唯一 supervisor 完成“请求终止 → 确认进程组退出 → 解析部分产出 → 以 cancelled/failed(timeout) 结算 → 释放 lease”。状态不能从最后一条协议事件猜出终止原因。

### P1-2 follow-up 没有绑定原 invocation 的能力快照

`follow_up` 从旧 record 取 harness，却从热加载后的同名 role 取 command、shell、model、prompt 和 mutates（[subagent-manage.ts](../src/tools/subagent-manage.ts#L110)）。角色若从 Codex 改成 Claude，代码会用旧 `codex-cli` harness 解析新 Claude command；role 改名或删除则已有 session 也无法续接。

同时，`BuildInvocationResult.resumable` 从未被持久化或消费；`shell: true` 明确构造 `resumable: false`，工具仍仅凭 harness 名允许 follow-up。其 resumeSessionId 不会被加到 shell command，却会回报“resuming”。

建议持久化不可变的 invocation snapshot（harness、command/argv template、shell、model、thinking、system-prompt hash、env key names、resumable、role config hash）。follow-up 默认沿用该快照；若用户已更新角色，应明确选择“沿用旧会话”或“按新角色新开 run”，不能混搭。至少应硬性校验 current role harness/config fingerprint 与原 run 相容。

### P1-3 调用 schema、实现、spec 与 playbook 已出现语义漂移

- `docs/sub-agents.md` 说 `effort` 仅内置使用；spec 040 设计的是 external `600/1800/5400s`；代码却把内置 `120/300/900s` 元组直接套到 external。playbook 又写“外部角色高 effort 放宽墙钟”。同一个参数有三种事实。
- discovery 接受 `thinkingLevel: max`，工具 schema 没有 `max`。
- spec 仍标 `PROPOSED`，实现和用户文档却把它当已完成；spec 声称的 `run.json`、fingerprint 校验和 24h 辅助产物清理并不存在。
- `outputTruncated`、`promptFiles`、`resumable` 等字段产生后没有进入 run 或展示面；`exec` 的 stdout 超 16k 时只把头部写进 `output.md`，与“全文在 output.md”的 playbook 承诺不符。

建议建立一张可执行的 runtime capability matrix，并由测试生成/校验文档关键表格：每个字段对 internal、structured external、exec、shell external 是 implemented / rejected / ignored 中哪一种。**不允许 ignored**。spec 状态改为 `PARTIALLY IMPLEMENTED`，列出 conformance gaps，直到 P0 项关闭再标 implemented。

### P1-4 可观测数据会给出错误判断

- 外部 live settlement 的 `durationMs` 固定写 `0`，因此完成 wake 显示 `0s`，archive 也失真；人侧 list 因使用 started/finished 尚能显示正确耗时。
- settled record 保留 `leaseKey`，模型侧和人侧列表会继续显示“lease held”。
- timeout/cancel 丢弃部分 output/usage；原始 events 虽在磁盘，`/subagents output` 不会回退读取它。
- 结构化 parser 的 schema 漂移只在解析失败后暴露，没有把 CLI version、parser version、terminal event 摘要记进 run，运维很难区分“Agent 失败”与“适配器过期”。

建议让展示只消费明确的当前状态字段：`leaseHeld`、`deadlineAt`、`terminationReason`、`outputTruncated`、`parserVersion`、`cliVersion?`。所有 truncation 都给出可执行的下一步和原始文件路径。

### P1-5 `subagent` 仍大量用普通 Error 表达模型可修复的拒绝

未知角色、非法 taskId、缺 task、workingDirectory 不存在、verify 角色不合规、lease/并发冲突，绝大多数都可由主 Agent 自行修正，却在 [tool.ts](../src/subagents/tool.ts#L688) 使用普通 `Error`。这违反项目已经确立的错误边界，也会把正常准入拒绝显示成用户可见故障；`subagent_manage` 在这方面反而做得更好。

建议把参数、角色选择、状态转换和容量前置条件统一改为 `RecoverableToolError`，并为每条错误保留一个直接可执行的下一步。I/O、状态损坏、审计写失败和真实运行故障继续使用普通 Error。

## 测试与评估判断

本次验证：

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| sub-agent 相关 12 个测试文件 | 通过，131 tests |
| `npm run test` | 通过，132 files / 1087 tests；另有 1 file / 2 tests skipped |

现有测试对 parser、正常 spawn/settle、单进程 cancel/timeout、准入上限、lease 冲突、命令展示和内置同步转异步覆盖较扎实；这解释了 happy path 的完成度。缺口集中在产品最在意的故障维度：

1. 没有“restore 时 pid 仍活，之后才退出”的测试；也没有重启后 cancel/deadline/lease 测试。
2. 没有 settlement 每个阶段失败后重启补偿的 fault-injection 测试。
3. 没有断言外部 Agent 收到 context、paths、runtime context 和 verify protocol 的测试。
4. 没有覆盖 launch claim 到 live cancel handle 之间的所有竞态点。
5. 没有角色热更新后 follow-up 相容性、`shell: true` resume、PID 复用测试。
6. 行为评估只有一次显式的内置只读委派；缺少“主 Agent 正确选择 heavy external → 结束回合 → durable wake → 验收/任务恢复”的完整行为用例。
7. harness schema 测试来自手写事件 fixture，没有针对真实 CLI 版本的 opt-in contract smoke test。

建议把测试金字塔分成三层：纯 parser/capability contract；带 fake child 和 fault injector 的确定性 lifecycle；少量真实 OS process 的 restart/kill/pipe/lease 集成测试。真实 Claude/Codex 只做非门禁 smoke，记录 CLI version 与事件样本，避免协议漂移长期无感。

## 建议的收敛顺序

### 第一阶段：先兑现生命周期承诺

1. 重做外部进程 I/O 与 supervisor，完成可收养、可超时、可取消、可重建 lease 的 restart 流程。
2. 把 settlement 拆成可恢复阶段，restore 修复 terminal-but-incomplete run；usage/archive 按 runId 幂等。
3. 在开放 runtime 入口前 await restore，补齐跨重启 fault-injection 测试。

### 第二阶段：统一业务契约

1. 引入唯一 `DelegationEnvelope`，内外共享 context、路径、purpose 与输出协议。
2. 统一 cancel/timeout 状态与部分产出语义。
3. 固化 invocation snapshot 与 follow-up 相容性规则。

### 第三阶段：收紧交互与可观测性

1. 消除 capability matrix 中所有 silent ignore；对齐 schema、spec、用户文档和 playbook。
2. 修正 duration、lease、truncation、termination reason、CLI/parser version 展示。
3. 统一 RecoverableToolError，补 external-routing 与 durable-wake 行为评估。

## 最终判断

Pipiclaw 已经有了一条形状正确的委派主干：主 Agent 能发现角色、选人、派发、拿 runId、看产物、等唤醒、做验收。现在最应克制的是继续横向加能力。外部 Agent 的真正难点从来不是“能不能 spawn”，而是 daemon 死在任意一行之后，系统是否仍知道：**谁在跑、谁能写、该不该停、结果是什么、账记过没有、该不该叫醒主 Agent。**

把这六个问题变成可恢复、可测试的事实，sub-agents 才会从“功能可用”成为 Pipiclaw 值得托付重活的核心能力。
