# 067：工具执行与委派结果回收提速

| 字段 | 内容 |
| --- | --- |
| 状态 | 已完成范围内实现、离线门禁及定向真实模型验收；分段调度已移出范围；未建立发布质量基线 |
| 日期 | 2026-11-04 |
| 依据 | [延迟排查](../../reviews/2026-11-04-tool-and-delegation-latency.md)、[064 任务车道](../064-task-lane/design.md)、[066 外部 harness](../066-cursor-cli-harness/design.md) |
| 实施计划 | [plan.md](./plan.md) |
| 适用范围 | task、普通聊天、内部委派、外部委派和后台 shell job；DingTalk 与 Web API 共用运行时路径 |

## 1. 目标和范围

减少工作已经结束之后的无效等待，让主 Agent 能在下一个安全推理边界处理结果，同时维持写入顺序、恢复和计费正确性。

本次交付范围：

| 交付 | 范围 | 依赖 |
| --- | --- | --- |
| A：完成通知与委派等待 | 接管外部 run 的及时观察、job 主动通知、频道容量释放重试、task 步骤内结果注入、内部委派短等待、收尾限时及必要追踪 | 当前 pi SDK，可在本仓库独立实施 |

2026-11-04 按用户要求，只使用官方发布的 pi SDK。官方包不支持原 B 的分段调度，因此删除该特性及其 SDK 构建、接入工作包。它不再是 spec067 的待办或验收条件；不维护 SDK 补丁、本地包或另一套 agent loop。

本设计不改变 task 的事实推导状态、不增加模型可写的 waiting/state 字段、不改变任务车道的唯一执行权。保留频道通知、现有并发名额、写锁、工具安全检查、结果保留期和逐次模型请求的完整工具结果配对。不新增用户配置开关、工具 schema、任务文件版本或迁移路径。

## 2. 当前问题与设计目标

| 问题 | 当前机制 | 本次目标 |
| --- | --- | --- |
| daemon 重启接管后提前结束的外部进程 | restore 检查一次，之后到 deadline 才再查 | 接管期间每约 10 秒检查，deadline 保留超时职责 |
| 后台 job 结束后等待检测 | 10 秒 sweep；主动 poll 每 3 秒查看 | 本地完成文件事件立即触发核实，poll 使用事件通知 |
| 频道队列满后继续等待 | pending 依赖 30 秒 drain | 释放队列容量时主动重试被拒记录 |
| task 正在工作时看不到新委派结果 | 任务日志持久化，下个 step brief 才读取 | 复用现有 steer 和输入回执，在下一工具批次边界读取 |
| 内部委派占住工具批次 | 共享最长 120 秒同步 grace | task 立即异步派发；聊天只保留 10 秒快速返回窗口 |
| 可选诊断拖住结果发布 | close 等元数据探测，Git 摘要无 timeout | 诊断与发布解耦；探测和 Git 子进程有执行期限 |

数值都是代码常量，可通过测试依赖覆写，不进入 `settings.json`。目标是在空闲消费者、正常本机 I/O 下去掉 10/30 秒及剩余 deadline 级别的相位等待，不承诺缩短外部执行器或模型自身耗时。

## 3. 必须保持的约束

| 编号 | 约束 |
| --- | --- |
| I1 | `SubAgentRunManager` 独占结算、计费、租约释放和完成唤醒；观察器只提供事实和触发检查 |
| I2 | 结果先持久化并记入所属任务，再通知消费者；内存队列接收不等于输入已消费 |
| I3 | 进程仍可能写入时不释放写锁；terminal 文本和文件变更都只作为检查提示 |
| I4 | 同一个 run/job 的多路观察、取消、超时和重试，不能重复记账或产生多个完成 wake |
| I5 | 停止后不启动新观察和新模型请求；已派发工作继续遵循现有 `/stop`、shutdown 和恢复语义 |
| I6 | 按 desk/task/channel/runner generation 路由；换绑、冻结、暂停、取消和归档不得把结果送入其他上下文 |
| I7 | 新输入只在完整工具批次之后进入模型，不取消已经派发的同批工具，不形成第二个并发 task step |
| I8 | 队列容量重试尊重 lease、`nextAttemptAt` 和 poison-pill 计数；真实失败的退避继续生效 |
| I9 | 文件工具的 guard、fingerprint 和串行标记保持；不会把模型声明只读当成 shell 权限保证 |

## 4. D1：接管外部 run 后持续观察完成

### 4.1 观察范围和时钟

正常由当前 daemon 启动的外部 run 继续使用 `close` 回调。仅将 restore 后仍在运行、没有本进程 child handle 的 run 加入接管观察集合。不要把进度 tail 的定时器改成结算依据。

在 `subagents/` 内抽出外部恢复观察协作者，例如 `external/recovery.ts`。它拥有一个按最早到期项驱动的 timeout 和每个 run 的 in-flight 标记，使用回调读取最新记录、进行一次核实、报告错误。协作者不 import manager，不写 run 文件、不释放租约；manager 注入职责。现有恢复算法可移到同域 `external/reconciliation.ts`，输入与输出保持结构化，由 manager 调用结算入口，降低 `runs.ts` 行数。

- 重启接管属于冷链路，按用户裁决采用 `ADOPTED_RUN_CHECK_MS = 10_000`；每项下次检查时间取 `min(上次完成检查时间 + 10s, deadlineAt)`。restore 时仍立即核实一次，deadline 较近时按 deadline 提前检查。
- 同一个 run 不允许检查重入；不同 run 不共用一个贯穿 I/O 的全局锁，避免一个慢进程拖住全部接管对象。
- 检查失败保留记录和观察资格，下一周期重试；已 terminal 或 manager stopped 就移出集合。
- `stop()` 清除 timer，禁止启动新检查及重新安排检查。已经进入 manager 的结算允许完成必要提交，保留当前“停止观察不取消结算”的语义；尚未进入结算的检查返回后不再启动新的恢复工作。shutdown 的 ingress/lane 停止负责阻止新模型请求，不把已派发工作取消。
- 缺少 deadline 的异常当前格式记录仍可观察进程消失，但不臆造运行预算；不再因没有 deadline 就完全失去完成观察。

### 4.2 一次检查的决定

| 事实 | 行为 |
| --- | --- |
| pid 不存在 / 原进程确认结束 | 读取现有产物，经既有 finalizer 和 manager 结算；核实残留工作进程的安全结束边界 |
| pid 存活、身份一致、未到期限 | 保持运行，安排下一检查 |
| pid 存活、身份一致、期限已到 | 先持久化超时意图，再按现有进程组终止规则处理，确认后结算 |
| pid 存活、身份信息暂不可读 | `unknown`，继续观察，不把探测失败当成退出，也不对不明归属进程发信号 |
| pid 已复用 | 不向新进程发信号；按原运行的产物和既有失败分类收尾 |
| 已有 settlement intent | 优先完成已有意图，不重新生成一份成本或结果 |

身份判断复用 `same / different / unknown`，不能继续用布尔比较把 `ps` 超时映射成“原进程已结束”。未记录启动身份时沿用现有保守规则，不增加旧格式兼容字段。子进程组仍有本 run 的写入进程时不得提前释放租约；不能证明归属/停止时保持受管理状态并记录可诊断原因。

所有正常与接管路径共用产物解析、termination reason、verdict 和结果保存。`exec` 在重启后没有可信退出码时仍遵循当前失败分类，不能为得到绿色测试而补一个 `exitCode: 0`。

## 5. D2：job 完成主动通知，并唤醒 poll

### 5.1 宿主文件观察能力

job 通过 `Executor` 执行，文件内容由 `FileStore` 处理。给 foundation 的 `FileStore` 增加可选目录观察能力，形如 `watchDirectory?(path, onChange, onError)`，返回可关闭句柄；事件只携带 basename 或“目录发生变化”，不携带终态判断。宿主实现使用 `fs.watch`；其他 FileStore 可以不实现，继续使用 sweep，不要求远程执行器假装拥有本地文件事件。

manager 在 `jobs/completion-observer.ts` 内维护运行 job 的 `.exit` basename 到记录的映射；同一目录共用 watcher。事件不会拼接任意路径去读取，只查 manager 已登记的 artifacts。filename 缺失时核实该目录已登记的运行 job。

1. 已确定 artifacts 目录存在后，在命令启动前订阅；启动太快、事件早于记录提交时，只标记 dirty。
2. 启动记录持久化并登记后，立即安排一次核实，关闭“已完成但 watcher 刚装上”的窗口。
3. 恢复时先建立观察，再读取当前状态。失败、rename 重复事件和启动/恢复交叉到达均经过同一核实入口。
4. 事件合并窗口为一个 event-loop 调度批次；批量 `probeAll` 后仍逐 job 经过既有 reconcile queue。事件不是可信 exit code，空文件、无效整数和 PID 身份不明继续按原规则处理。
5. 最后一个订阅结束时关闭目录 watcher；manager stop 时全部关闭，不影响 detached job。
6. watcher 出错时记录固定 English warning，退回 sweep；后续 sweep 可重建观察，不能高频失败重建。保留 10 秒 sweep 处理漏事件、超时及不支持观察的 FileStore。

`manager.ts` 的记录、状态转换和通知归属不移到 watcher。可把现有批量 probe 组装解析提取到 `jobs/probe.ts`，让新逻辑有文件预算；不增加 architecture baseline。

### 5.2 poll 的等待

`poll()` 不再无条件睡满 3 秒。每个 manager 维护完成 revision 与一次性等待者：先登记观察集合和 revision，再核实、检查是否有终态，最后等待“revision 改变 / 3 秒回查 / 原 30 秒总期限 / abort”。每次等待结束清理订阅；采用登记后复核，避免检查完成到注册等待之间丢信号。

仅在既有 `finish` 和任务记账/通知职责完成后发布 revision，失败仍通过 sweep/poll 重试。不因任意 poll 订阅存在就全局抑制 task 或其他频道通知。保持现有 inline 返回与完成 wake 的判定，终态幂等标记继续保证最多一个业务完成 wake；显式 poll 与已经发出的 wake 同时读到结果不解释为双重结算。

## 6. D3：频道容量释放后立即重试 pending

[ChannelQueue](../../../src/runtime/channel-queue.ts) 增加轻量 `onCapacity` 回调，由 ingress 注入。已排队元素被取出或普通取消后触发；停止、`/stop` 批量清理和会话重置不触发新投递。回调携带队列实例代际，ingress 在通知前确认它仍是该频道当前队列，且 shutdown/stop watchdog 未占有该频道。回调只通知运行时，不 await drain，也不进入当前队列的串行工作，避免循环等待。

`DurableDispatchService` 为本进程因容量拒绝的记录维护 `channelId → dispatchId 集合`。拒绝被确认时，在异步写 pending 之前同步登记，防止容量释放通知与登记交错造成漏重试。所有记录仍以磁盘为准，集合只是加速索引，启动扫描会重新建立；没有第二份持久队列。

新增 `notifyCapacity(channelId)`：同频道事件合并，一次只 drain 已登记的 id；处理期间再收到通知置 dirty，完成后再跑一轮。每个 id 继续通过原来的 serial queue 和 `drainRecord`，重新核实 pending、可达性、lease、`nextAttemptAt` 以及投递次数。成功、已吸收、删除、exhausted 的记录从索引移除。

30 秒 scan 保留为恢复保障。`/stop` 清理完成后的重投递时机仍受既有 stop epoch、队列重置及 admission 约束；不在用户停止的旧 generation 中重新塞工作。用户消息顺序、每频道一个回合和队列上限保持。

## 7. D4：运行中的 task 在工具边界接收完成结果

### 7.1 路由复用

目前 `LaneControl.message()` 已采用“任务日志落盘 → `queueSteer` → 会话 transcript 回执”的路径。完成结果沿用同一消费语义。

保留无参数 `notify()` 处理创建、控制与维护；为结果通知新增带作用域的 lane 入口 `inputAvailable(desk, taskId)`。bootstrap 的两个 `onTaskInput` 回调传递已有的 desk/taskId，不能只转换成一次全局扫描。入口只标记 dirty 并安排处理，不等待主 Agent，不在 run 的 settlement 锁中执行 steer。

对没有运行步骤的任务仍按现有 50ms 通知合并和事实扫描启动。对有运行步骤的任务，合并读取其 `newInputs`，筛选本次可交付的、非 inline 的 settle 记录；stall 维持既有策略，用户 message 维持现有控制入口。

### 7.2 同步骤去重与真实消费确认

1. 在步骤开始时将初始 brief 中实际携带的 input ids 登记为该 step 已提交，避免它们因尚未写 ack 又被注入一次。
2. 按日志顺序使用现有 `renderTaskInputs` 渲染结果；保留不可信输出围栏、完整 output 路径和每条 `task_input` id。每批最多携带已有 `BRIEF_INPUT_LIMIT`，只登记实际渲染的 id，超出的仍待处理。
3. 每个 live step 只允许一个注入过程；`submittedInputIds` 是进程内防重集合，绝不代替 `input_ack`。
4. 注入前后及最后一次异步等待之后检查 desk 绑定、运行开关、step seq、runner generation、abort/quarantine 和 task 是否仍存在。已准备 ask/wait/close 的步骤不接收新结果，留给现有状态机。
5. 给既有入队路径增加 expected task step seq 的校验，校验和真正向 SDK 入队位于同一受控操作内。它必须返回 stale/queued，不允许异步等待后把旧步骤结果塞进新步骤。复用现有 pipeline/steer，不另起一个 session。task 的运行时输入准备完成后使用 SDK 公开的同步 `Agent.steer`，不进入会等待交互输入扩展的 `AgentSession.steer`；聊天维持原入口。两者共用同一 Agent 的队列消费与 transcript 持久化。
6. 队列接受后只表示 submitted。实际 transcript 中出现对应 user message id 后，才由现有 `acknowledgeTaskInputs()` 记 ack。停止、错误或重启导致未消费的输入仍进入下一 brief。
7. 步骤结束时先结束注入资格并等待在途注入操作收敛，再做最终 ack 和 endStep。未消费的旧 SDK 队列项必须在下一 step 尚未开始时清理，防止与下一个 brief 重复；这些输入在任务日志中保留，已持久化消息依回执保留。清理仅针对 task 的旧步骤，不能通过无代际校验的操作清空新步骤或聊天的队列。

SDK 在完整工具批次后消费 steer，因此新的结果不会截断当前工具，也不会让模型拿到缺失配对的工具上下文。步骤仍计为同一 step，原有时间和成本预算继续覆盖追加推理。结果风暴按任务合并，不为每个 run 创建独立推理。

当前聊天临时委派继续走频道队列，保留 D3 的加速和现有合并。A 不把其 wake 改成聊天 steer；那需要独立设计 durable dispatch 的消费确认，不能套用 task 的日志回执。

## 8. D5：内部委派减少同步占用

| 发起上下文 | 内部委派策略 |
| --- | --- |
| task step | 启动及持久化成功后立即返回 dispatched，后续统一 `announce: true` 回到所属任务 |
| 普通聊天 | 共享 `CHAT_SYNC_GRACE_MS = 10_000` 的快速返回窗口；窗口内完成继续 inline，超时立即 dispatched |
| 外部委派 | 保持现在启动确认后立即 dispatched |

task 上下文已由 `runtimeContext.taskId` 表达，不增加模型可选的 async 字段。两个委派工具沿用相同策略，worker 自身的预算、收敛回合、取消和备用模型逻辑保持。

task 必须在注册和绑定 dispatch 记录后才向模型返回 dispatched；启动失败仍直接返回原有可恢复错误/真实错误。内部 worker 再快也走 task 异步结算路径，使“已返回结果”和“再发完成输入”互斥。普通聊天继续使用现有 per-turn AbortSignal deadline，不为每次工具调用重新给十秒。

副作用是中等长度聊天委派可能多一次后续模型推理；所以既测批次响应，也测完整任务总耗时、请求数、成本与行为质量。不能仅证明工具早返回就宣称总提速。D4 的合并注入先完成，再启用 task 异步策略，减少快速任务反复开 step 的成本。

真实模型验证修订：最初的 1 秒窗口使两个约 4–6 秒的读取分片转为异步，主模型从 3 次请求增加到 4–5 次。共享窗口改为 10 秒后，同一配对场景保持 3 次请求，避免短工作产生额外回合；更长工作仍异步。最终汇总时间的三次样本中位数基本持平，不宣称普遍的端到端提速；原失败及完整对照见验收记录。

## 9. D6：收尾限时与元数据解耦

- `shared/host-process.ts` 的身份探测增加 1 秒执行 timeout。失败返回 unknown，不触发错误终态。
- 将身份与 CLI version 两个更新拆开，分别通过 manager 的同一 run 队列更新当前记录；不以一个慢 version 探测延后身份信息持久化。
- 正常 `close` 后不等待诊断探测再进入清理和 finalizer。晚到元数据仅更新仍存在、runId/pid/启动代际与该探测对应的记录，允许补充 terminal 记录的诊断字段，绝不复活已结束/已删除 run 或覆盖结算字段。匹配已捕获的启动身份，不要求已退出的 pid 再通过一次存活检查。manager stop/换实例后的可选诊断回调不再写盘；已经进行的必要结算按 D1 收敛。
- `workspace-summary.ts` 内 Git baseline 和完成摘要共用的子进程增加 `GIT_STATUS_TIMEOUT_MS = 1_000`。设置真实 exec timeout，不能只用 `Promise.race` 放弃等待而让 Git 无限留在后台。
- 摘要超时只省略可选摘要，结果、usage、verdict 和完成通知继续发布；不写成“没有改动”。读取型委派继续不执行 Git 摘要。
- 进程组清理、必要结果持久化和任务记账仍是完成发布前置条件，不以 fire-and-forget 绕开。

## 10. D7：沿用官方 SDK 工具调度

原工具分段并发方案已按用户要求删除。Pipiclaw 只依赖官方发布的 pi SDK，不构建或分发定制 SDK，也不在本仓库复制 agent loop 实现调度。

当前工具批次沿用官方 `parallel` / `sequential` 策略：批次中存在串行工具时整批串行。主会话、task 和内部 worker 保留既有工具声明、包装链、安全检查与结果配对；本规格不增加新的调度模式。

## 11. D8：必要追踪、性能目标和证据

沿用现有结构化日志，不新建 telemetry 服务、数据库或磁盘追踪文件。各域记录自己拥有的阶段，runtime 通过 id 关联；工具参数、结果正文和凭据不加入性能日志。

| 阶段 | 最小字段 | 位置 |
| --- | --- | --- |
| 进程结束被观察 / 开始 finalizer / settlement 完成 | desk、runId、taskId?、observer=live/adopted、时间、阶段耗时 | subagents |
| job 完成提示和终态提交 | desk、jobId、taskId?、trigger=watch/sweep/poll | jobs |
| wake 入队/拒绝/开始处理 | channelId、dispatchId、desk、原因、队列长度 | runtime |
| task 输入 submitted/received | desk、taskId、seq、input ids、generation | runtime/tasks |
| provider 请求开始与首个输出 | conversation/session、run/step 关联、request 序号、时间 | agent 已有 SDK 观察接缝 |
| 工具调度与实际执行 | toolCallId、批次、准备开始、execute 进入、结束 | 现有工具包装与 SDK 事件 |

SDK 的 `tool_execution_start` 在准备阶段之前，不能直接当作 execute 进入时间。历史产物 mtime 也不能充当准确退出时间。无法测量的阶段写 unknown，不推算成 0。

以下是离线受控本机环境的验收预算，不是任意负载下的产品 SLA：

| 路径 | 预算 / 判据 |
| --- | --- |
| 接管进程确认退出 → 检查启动 | 不超过一个 10 秒周期加调度余量；不等到剩余最长运行期限 |
| 支持 watcher 的 job 完成 → 检查启动 | 事件到达后下个合并调度批次；无需 10 秒 tick |
| 队列容量释放 → pending 重试启动 | 下个合并调度批次；无需 30 秒 tick |
| task 输入持久化 → 已运行步骤可见 | 下一完整工具批次边界，合并窗口内提交，不等 step 结束 |
| task 内部委派工具 | 耗时由注册/启动所需 I/O 决定，无 worker 执行等待 |
| 普通聊天内部委派工具 | 最多共享 10 秒结果等待，再加必要注册/启动/结算 I/O |

确定性 e2e 用事件门闩和禁用周期扫描证明机制，不用严格毫秒断言承受 CI 抖动。单元层使用受控时钟验证具体期限。性能样本另外记录 P50/P95、轮数和成本；前后比较固定同一模型、thinking、fixture、工具、并发和输入，不以换模型制造提速。

## 12. 测试与验收边界

详见实施计划中的覆盖与 mutation 表。核心机制必须走真实 producer → bootstrap → consumer，包括：进程崩溃后的外部完成、后台 job 的完成文件、任务内结果注入和队列容量释放。

单元默认扩展既有高价值场景；接管观察生命周期和审查发现的 task 最终入队竞态各增加一个独立场景，实际净增 unit **+2**。确定性 e2e 通过扩展既有链完成，净增 **0**；准入理由和 mutation 证据见验收记录。

用量、消费回执、停止和恢复不能用最终文案证明。行为 probes 验证短 grace、结果合并和步骤内注入是否导致轮询、空转、重复工作或质量下降。缺凭据或运行失败记录为未验证，不宣称质量通过。

## 13. 文档与交付

同步任务、委派、后台作业及并发说明，工具调度保持官方 SDK 的既有策略。性能数据和各阶段真实完成状态记入 `acceptance.md`，设计状态随实际交付更新。

本方案不要求人工逐项确认、自动部署、切换生产配置或执行数据迁移。每个代码交付以 reviewable diff、完整离线门禁、mutation 证据和行为验证记录结束；生产上的性能观察不能替代本地机制验收。
