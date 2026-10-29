# Spec 064 任务车道：设计与实现审查

审查日期：2026-10-29。代码基准：`e83d9ee`，核心实现提交 `9ed0a94`，设计提交 `724863b`。本次只提交报告，不修改产品实现、既有测试或真实部署数据。

## 结论

**拆开聊天车道和任务车道的方向正确，正常执行路径已落地，但当前还不能把 INV-4「可唤醒」、INV-6「不丢输入」、INV-7「冻结」以及单步时限视为已经完整兑现。建议修复下面的 P1 后，再做迁移演练和真实上线。**

最重要的设计缺口是：把「运行时看得见的事实」作为状态来源之后，还需要定义事实何时算持久化、何时算被消费、如何在跨文件写入失败后重放。现在多处把排队当成送达、把互斥锁当成事务、把发出 abort 当成已经结束；正常路径成立，崩溃和并发路径就会偏离。

本次确认 10 项发现：7 项 P1、3 项 P2。其中 9 个临时探针复现了具体边界行为；其他结论标明为代码路径分析，没有把未经执行的场景写成实测。

| 编号 | 级别 | 发现 | 主要性质 |
|---|---|---|---|
| R1 | P1 | 步骤开始即推进输入边界，模型尚未收到的输入可能永久漏投 | 设计与实现 |
| R2 | P1 | 提问未送达，仍进入没有超时的用户等待 | 设计与实现 |
| R3 | P1 | 冻结后连续步骤继续执行，启动对账也改写冻结任务 | 实现偏离 INV-7 |
| R4 | P1 | 单步超时和暂停只有协作式 abort，没有结束保证 | 已披露的实现偏差 |
| R5 | P1 | `step_end` 与 frontmatter 之间崩溃，步数和成本无法正确恢复 | 持久化协议 |
| R6 | P1 | 归档失败仍向用户报告完成或取消 | 实现 |
| R7 | P1 | 聊天完成检查与归档不互斥，可以归档刚启动的任务 | 实现及端口取舍 |
| R8 | P2 | 等待工作的新输入可以绕过连续错误退避 | 实现 |
| R9 | P2 | 用通用 edit 维护契约正文，没有加入任务写入协议 | 设计缺口 |
| R10 | P2 | 评测调度语义已改变，但用例时间与观察点没有同步调整 | 评测可信度 |

P1 表示应在真实上线前处理的正确性或控制能力问题；P2 表示有明确影响、应安排修复的问题。本次没有发现需要定为 P0 的证据。

## 范围与实际验证

阅读了指定的 [design.md](../specs/064-task-lane/design.md)、[plan.md](../specs/064-task-lane/plan.md)、[spec 索引](../specs/README.md)，并对照验收记录、任务领域、车道及控制面、工具适配、runner/SDK、作业和委派结算、deterministic e2e 与评测 worker。

| 验证 | 本次结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run arch` | 通过，0 条依赖例外、0 个文件循环，3 个既有超长文件 |
| `npm run test` | 143 个文件、974 个用例通过 |
| `npm run test:e2e`，含构建 | 26 个文件、68 个用例通过 |
| `npm run test:evals`，含评测构建 | 5 个文件、69 个用例通过 |
| 临时边界探针 | 9 个通过；断言的是下文所述的错误行为确实发生 |

临时探针复用了 `test/task-lane.test.ts` 的现有 harness，运行后已移出仓库，永久测试用例数变化为 **0**。探针使用脚本 runner，不调用真实模型；其中模拟崩溃窗口的探针构造对应的落盘状态，并不等价于独立进程 crash e2e。完整测试通过，说明现有覆盖尚未识别这些边界，并不推翻复现结果。

本次未运行真实模型评测、真实钉钉冒烟或迁移，也未更改 `~/.pipiclaw`。未将这些项目算作通过。

## 详细发现

### R1 · P1：输入消费边界早于模型接收，INV-6 在崩溃时不成立

位置：[store.ts 的 beginStep](../../src/tasks/store.ts#L132)、[loop-log.ts 的 newInputs](../../src/tasks/loop-log.ts#L439)、[task-step.ts](../../src/runtime/task-step.ts#L104)、[task-control.ts 的 message](../../src/runtime/task-control.ts#L97)。对应 D3、D14、D24。

`beginStep` 读取新输入后，先写新的 `step`。此后 `newInputs` 就只读这条 `step` 后面的输入。但构建 brief、调用 `runner.run`、将用户消息写入任务会话都发生在之后。

可复现顺序：

1. 任务日志已有一条用户消息 `NEVER_SEEN_INPUT`。
2. `beginStep` 返回的 `inputs` 包含它，但尚未调用 runner。
3. 模拟此时崩溃，执行 `reconcileTaskState` 后再启动任务。
4. 新 brief 不含这条消息；它也从未进入任务会话，只留在旧日志里。

**实测：上述消息确实从恢复后的 brief 消失。** 结算结果和恢复指示也受同一消费边界影响。这里的“丢”指失去正常投递机会，原始日志通常仍在；不能依赖负责人主动翻历史补救。

中途注入还有第二个窗口：`message` 先 `queueSteer`、后写日志，且 steer 返回就标记 `injected`。本地 SDK 的 `Agent.steer` 实际是入内存队列；终止工具结束回合时，agent loop 可以在再次取 steering 队列前返回。进程崩溃、暂停或 runner 释放都可能让尚未消费的 steering 消失，但下一步仍永久排除这条记录。后一个场景本次通过 SDK 和调用链确认，未做独立进程复现。

**建议：** 先把输入写入日志，再尝试注入；为输入建立稳定身份和可恢复的消费确认。确认依据应是消息已持久化进入任务会话，而不是 `queueSteer` 返回或 `step` 开始。对于未确认的输入允许重投，并按身份去重。恢复一个未完成步骤时，重放它已经认领但未确认消费的输入；不要只调整“最后一条 step”的搜索位置。

### R2 · P1：用户没有收到问题，任务却无限等回答

位置：[endStep](../../src/tasks/store.ts#L180)、[afterStep 的 user 分支](../../src/runtime/task-lane.ts#L520)、[say](../../src/runtime/task-lane.ts#L616)。对应 INV-4、D22、D29。

实际顺序是先持久化 `waiting{user}`，再释放 runner，最后投递问题。`deliver` 的 `false` 被 `say` 忽略，异常也仅记录日志；没有待投递记录、重试或启动补发。崩溃若发生在状态落盘与投递之间，同样没有恢复路径。

**实测：让问题投递返回 false，连续扫描后任务仍是 `waiting{user}`，只执行过一步。** 这与 INV-4 的“问题已发给用户”不一致。聊天 agenda 能展示问题，提供了偶然补救渠道，但不等于用户已经收到提问。

**建议：** 保留“等用户没有超时”的决定；补齐问题投递生命周期。用持久化待投递项关联 task/step/question，失败重试、启动重放，并记录投递确认。不要通过给用户等待增加超时来掩盖投递失败。其他完成与暂停回执也可复用投递保障，但问题优先，因为它决定任务是否能继续。

### R3 · P1：冻结只挡扫描，挡不住连续 drive

位置：[drive/afterStep](../../src/runtime/task-lane.ts#L486)、[readDesk](../../src/runtime/task-lane.ts#L234)、[isExecuting](../../src/runtime/task-lane.ts#L50)。对应 INV-7、D17。

`continue` 分支检查预算与总开关后直接开下一步，没有再次检查频道是否仍绑定、是否可达。只有 `work` 分支的 `reevaluate` 检查冻结。冻结发生在步骤运行中时，任务可以连续执行到预算或其他守护命中。

**实测：第一步结束前使频道失去绑定，第二步仍执行并调用提问，任务状态被写成 `waiting{user}`。** D17 允许当前步骤跑完，但要求随后释放，不能继续新步骤。

还有两处相关边界：

- **实测：启动时一个冻结的 `running` 任务被对账改成 `queued`，并追加中断记录。** `readDesk` 先对账、后计算 frozen，违反冻结期间不写状态的明确要求。
- 代码分析：计数先把 frozen 任务排除，而正在运行的 drive 尚未停止，可能同时接纳其他任务，使物理上的执行数量超过 3/5。冻结的 `waiting{work}` 恢复后也直接按已占槽任务运行，需要明确超额恢复规则。

**建议：** 每次步骤入口统一复核存活条件；当前步骤结束后立即停止 frozen drive。启动对账先排除冻结任务，在恢复可达后再处理。槽位释放应跟随实际停止的执行生命周期；“冻结不占槽”与“冻结时当前步骤允许继续”的瞬间重叠，应在设计中写明，避免计数与资源实际占用不一致。

### R4 · P1：20 分钟只是发起中止，没有形成时长上界

位置：[abortStep](../../src/runtime/task-step.ts#L52)、[等待 runner.run 返回](../../src/runtime/task-step.ts#L164)，对照 [聊天 stop-watchdog](../../src/agent/stop-watchdog.ts)。对应 D14、D24，设计 §20 偏差 5。

计时器只调用 `requestStop` 和异步 `abort`。如果 runner 卡在忽略 signal 的工具、供应商或回合收尾，`executeStep` 仍一直 await，不能写 `step_end`、释放槽或完成暂停。`live.step.abort` 已设置后，后续中止也不再升级处理。

**实测：runner 收到 abort 但 run promise 不结束，超时后仍无 `step_end`，snapshot 仍有执行中的步骤。** 探针最后人为释放 promise 以清理夹具。现有超时单测把 abort 模拟成必定结束 run，因此覆盖不到此故障。

这是已披露偏差，但它直接削弱本 spec 要解决的“卡死时仍可控制”目标，不宜仅留作按需优化。聊天已经能响应，不代表用户能停住任务。

**建议：** 增加有界中止宽限与任务 runner 隔离流程。超限后撤销旧步骤的写入、派发和回执资格，再结束车道持有的等待；迟到结果不能覆盖新步骤或新状态。不能只用 `Promise.race` 提前返回再创建 runner，否则旧执行还在写同一 cwd 和会话。复用聊天看门狗经验，但必须验证任务会话与工具副作用的隔离。

### R5 · P1：日志与状态文件并非事务，恢复时漏记账、漏恢复意图

位置：[endStep](../../src/tasks/store.ts#L176)、[reconcileOnBoot](../../src/tasks/state.ts#L140)。对应 D10、D14、D16。

`endStep` 先 append `step_end`，再更新并原子替换任务 Markdown。任务锁只能排除其他写者，不能使这两个文件在进程崩溃时一起提交。若第一项成功、第二项尚未发生，重启看到 `running` 和“已有 step_end”，就不再累计该步步数或成本。

**实测：落盘一条 `usd: 4` 的结束记录，但 frontmatter 仍是 0 步/$0；恢复并执行一步后，用量只有 1 步/$0.01，正确值应为 2 步/$4.01。** 预算因此可被突破。

同一窗口还会丢失该步的等待或关闭意图：对账无条件按“interrupted + 当前在途工作”推导，不按已有结束记录恢复；`next:user/time/closed` 不足以独立还原完整状态。反过来，`beginStep` 在写 step 后、写 running 前崩溃，对账又只按 frontmatter state 判断，也可能漏补中断。

**建议：** 明确一个可重放的提交协议：日志事件携带恢复所需的数据，frontmatter 保存已应用位置或等价幂等标记；启动重放未应用记录，按 seq 恢复步数、成本与状态。不要单纯交换两次写入顺序，那只会把漏记变成另一种重复/遗漏。恢复应同时检查日志与快照，不只检查 `state === running`。

### R6 · P1：关闭失败被吞掉，仍发送成功回执

位置：[closeForLeader](../../src/runtime/task-lane.ts#L594)。对应 D22、D29。

`closeTask` 抛错后只记录 warning，后续仍 dispose runner 并发送 `completedReceipt` 或 `cancelledByLeaderReceipt`。任务文件可能仍活动，下一次扫描还会继续执行。

**实测：预置同名归档条目触发 archive 拒绝覆盖，活动任务保留 `state: running`，用户却收到“已完成”。** 磁盘写入/重命名失败也会走同样路径。归档函数已有回滚处理，但调用方把失败变成成功文案。

**建议：** 只有确认关闭成功后才发送成功回执。失败保留可恢复的关闭意图，停止普通步骤推进，并给出可操作的异常通知。这里需要的是关闭失败分支，不是放宽 archive 的完整性检查。取消在途工作失败也不能静默伪装成“全部取消”。

### R7 · P1：聊天完成检查与任务接纳之间存在竞态

位置：[closeTaskFromChat](../../src/tools/task-manage/lifecycle.ts#L91)、[factory 的 close 工具](../../src/tools/task-manage/factory.ts#L86)。对应 D23，设计 §20 偏差 3。

聊天先读取任务、检查不是 running，再异步检查在途工作，最后才调用持锁的 `closeStoredTask`。整个验证与提交没有处在同一个任务锁内。车道可在中间对 queued 任务执行 `beginStep`；关闭函数不会重新检查状态。

**实测：在 `jobManager.list` 返回前插入真实 `beginStep`，随后聊天完成工具仍成功归档该任务。** 也就是说“正在执行时拒绝完成”的保护只对旧快照成立。对应真实运行中，任务 runner 可能继续操作，却失去活动任务文件。

**建议：** 将聊天完成纳入车道控制端口，并在与接纳互斥的提交段内复核状态、DoD 和在途工作。保留现有端口方法数量没有正确性收益。若仍放在工具侧，至少让检查与关闭共享任务锁，并定义与工作派发的互斥关系；只在 `closeTask` 内加锁不足以修复前面的检查竞态。

### R8 · P2：work 等待路径绕过 1 分钟/5 分钟退避

位置：[afterStep](../../src/runtime/task-lane.ts#L507)、[reevaluate](../../src/runtime/task-lane.ts#L563)、[scanOnce](../../src/runtime/task-lane.ts#L333)。对应 D16。

错误发生后确实设置了 `backoff.notBefore`，但该字段只在 queued 接纳路径检查。如果步骤出错时仍有在途工作，推导结果是 `work`；有新输入时，`reevaluate` 直接返回 run。扫描里的 waiting/work 唤醒也没有检查退避。

**实测：保留一个在途 run，每步期间追加 stall 输入，三个错误步骤在同一次 drive 中连续完成，随即第三次错误暂停，没有经历前两次退避。** 第三次暂停守护仍然生效，因此没有把问题描述成无限错误重试。

**建议：** 将退避作为所有步骤入口的统一条件；占着执行槽不代表可以跳过重试时刻。总开关也应放在同一入口：目前 work 的即时重入路径同样绕过 `isEnabled` 检查。

### R9 · P2：正文交给 edit 后，任务锁不再覆盖所有写者

位置：[通用 editInline](../../src/tools/edit.ts#L450)、[writeStoredTask](../../src/tasks/store.ts#L77)、[任务写锁](../../src/tasks/mutation-lock.ts)。对应 INV-2、INV-9、D4、D31。

负责人用普通 edit 修改正文，但 edit 不参加 `withTaskMutation`；运行时转换状态或结算成本时会读取并重写整份 Markdown。正文与 frontmatter 在逻辑上各有所有者，在物理上却共用一个文件。

代码路径上的竞态包括：运行时先读旧正文，edit 写新正文，运行时再写回旧正文，负责人刚勾选的 DoD 消失；反方向则可能把旧 usage/state 写回。edit 已有 fingerprint 检查，能挡住检查前发生的部分改动；**它不是和写入合一的 CAS，也挡不住运行时稍后写回旧正文**。本次未做真实 FileStore 的交错复现，因此这是已确认缺少共同互斥协议、尚未通过探针验证具体丢写的发现。

**建议：** 保留 Markdown 正文可编辑的体验，但为任务契约写入提供域感知的锁/内容合并入口：正文替换时在锁内读取最新 frontmatter，运行时写状态时保留最新正文。通过注入文件写入策略维持架构层次，避免在 shared/foundation 导入 tasks。无需恢复 `task_update` 的业务参数，也不能只靠 playbook 要求“不要改文件头”。

### R10 · P2：评测 worker 换成车道后，原来的脚本语义已失效

位置：[worker 调度分支](../../evals/harness/worker.ts#L447)、[task-loop-quality 用例](../../evals/cases/task-loop-quality.ts#L19)、[driverDispatchCount](../../evals/harness/graders.ts#L436)。对应 P6、设计 §20 偏差 8。

worker 将 `runTaskDriver` 和 `syntheticTaskTurn` 都执行为 `taskLane.runOnce()` + `drained()`。前者的 `at` 被明确忽略，后者取出的 taskId 只用于 actor 标签，并未限制实际执行的任务。`drained` 又会等待一次 drive 中连续推进的步骤，不再等价于原先的一次调度 tick/指定任务回合。

现有用例仍使用固定时间与 `driverDispatchCount(..., 1)`。例如 TL-note-01 中模型正常写文件、读回，再在下一步完成，这种合理行为会被“必须只启动一步”的断言判失败；TL-ticket-01 的 predicate 又允许 queued，不能单凭通过就证明目标是 waiting/work。离线 evals 测试通过，不意味着这些真实任务场景的观察点和 oracle 已正确。

**建议：** 先为新的车道脚本定义显式语义：推进到哪个可观察检查点、只观察哪个任务、如何推进测试时钟。再调整当前用例和可执行正反例，解除与“一次 tick 一步”的绑定。区分模型行为失败和调度 fixture/oracle 失效；保留封存证据，不覆盖历史失败。`TaskLaneOptions` 已支持 now，worker 的“没有时钟可注入”是当前接线限制，不是车道能力限制。

## 还应补齐的设计取舍

以下不额外计入上述 10 项，主要用于完善修复方案与后续优化。

**结算日志不能只是 best effort。** [bound-work.ts](../../src/tasks/bound-work.ts#L34) 分开更新 usage 和追加 settle；[runs.ts](../../src/subagents/runs.ts#L567) 与 [jobs/manager.ts](../../src/jobs/manager.ts#L659) 在写任务记录前就设置幂等标记，失败被捕获后仍可持久化“已记账”。这部分机制有承接代码，不应一概算成 064 新增回归；但 064 现在依靠任务日志作为唯一正常输入路径，日志失败后不再有聊天 wake 携带完整结果，风险更直接。应区分“任务确实已不存在”和“任务存在但存储失败”，后者持久化待重试，幂等以接收端 ref 为依据。完整性需要和 R5 一起设计。

**取消应先封住新派发，再清理存量。** `LaneControl.cancel` 发起 abort 后立刻快照并取消工作，没有等步骤完全停止；正在提交的派发可能在快照之后才注册。`cancelBoundWork` 的失败也只记录日志，任务仍可归档。需要定义取消的提交点和迟到工作处置，复核工具的 signal 与注册阶段，而不是只对现有 pending 列表逐个 cancel。本次为并发路径分析，未做真实外部进程复现。

**“不占槽”与“没有外部资源消耗”不同。** D12 用“有外部进程消耗资源”解释 waiting/work 占槽，但暂停、等用户、等时间也可能保留在途工作。现行决定可以保留，文档应明确 3/5 限制的是负责人执行生命周期；外部工作资源另由 run/job 限额控制，不能宣称任务释放槽就释放所有资源。

**增量 brief 收益成立，但不要把它归因于 runner 对象常驻。** 保留 runner 有利于注入、观察和控制；持久化会话本身已能支持重建后继续增量输入。还需验证“步骤开始前查到契约块，run 内的预防性压缩又移除了它”的窗口：是否会在本次 provider 请求前补回完整契约。当前验收只说未验证真实压缩，建议用 mock provider + 真实压缩机制证明，不必先做付费实验。

**扫描成本与 D11 的描述有差距。** 设计说读取日志尾部；实际 `readTaskLog` 每次读全部保留 shard，单任务最多约 12 MiB，并在维护、守护、begin/end 相关路径重复解析。先保证上面的正确性，再用按任务通知、文件版本缓存和可恢复输入游标减少重复 I/O；不建议在当前协议未稳定前叠加复杂缓存。

## 测试与验收需要如何调整

现有 T-lane-1…4 已证明聊天与任务分离、正常结算回任务、正常控制和事件生成路径。值得保留。缺口主要在持久化写入之间、输入确认与中止不响应等故障窗口，不能靠增加正常路径样例补上。

建议优先扩展现有链条，新增场景必须按 AGENTS.md 解释风险和用例数变化：

| 现有覆盖位置 | 应补的机制断言 | 对应发现 |
|---|---|---|
| task-log/store 与现有 restart e2e | step 认领后、会话落盘前崩溃，输入仍送达；step_end 落盘后崩溃，账务只应用一次 | R1、R5 |
| T-lane-3 控制链 | steer 仅入队后中止/释放 runner，恢复不漏消息；abort 不结束时隔离旧步骤 | R1、R4 |
| DESK-3 | 在 held 步骤运行中换绑，释放后没有第二次 provider 请求；启动时冻结文件保持原样 | R3 |
| task-lane 现有守护用例 | 错误伴随在途工作和新输入，下一步仍遵守退避与总开关 | R8 |
| task-lane/工具完成用例 | archive 失败不发成功；完成校验期间接纳任务不能产生错误归档 | R6、R7 |
| 真实投递接线与恢复 | 提问投递 false/异常/投递前崩溃，重启补发并保持问题关联 | R2 |

至少一个真实独立进程崩溃场景应覆盖日志和快照不一致。当前把该项留给单测，没有证明旧回调消失后的恢复。新 deterministic 场景仍需 hold/arrived/release 控制时间、断言磁盘和请求侧效应，并按项目规则做变异检查。

迁移演练是 R2.2 的隔离副本工作，不需要真实部署批准才能准备。验收记录将它推迟到“用户在场”，把 R2 与真实上线 R4 混在了一起。建议在副本中先完成演练，给出转换数量、读取核验和恢复结果，再由用户决定真实部署。当前 spec 索引的“已实施，R4 待执行”也容易弱化 R2 和进程崩溃验证尚未完成的事实，应在验收入口清楚列出这些缺项。

## 临时探针记录

执行方式：复制现有 task-lane harness，仅添加审查用脚本，`npx vitest run test/task-lane-review-tmp.test.ts -t REVIEW`。最终输出 **9 passed / 18 skipped**；18 个 skipped 是名称过滤未执行的原测试，原测试已在完整单测中另行通过。临时文件随后移出仓库。

| 探针 | 实际观察 |
|---|---|
| frozen mid-step still executes a second step | 冻结后 brief 数量为 2，状态被写成 waiting/user |
| failed ask delivery leaves an indefinite user wait | deliver=false 后仍 waiting/user，再扫描没有补发/继续 |
| archive failure still sends completion and leaves task active | 活动文件仍 running，deliveries 却含完成回执 |
| work inputs bypass error backoff | 同一次 drive 连续 3 次错误，随后 error 守护暂停 |
| crash after step_end loses accounted usage | 结束记录中的 $4/1 步未恢复，只剩下一步的 $0.01/1 步 |
| begin-before-prompt crash loses unread input | begun.inputs 有消息，恢复后的首个 brief 没有该消息 |
| chat completion can archive a step admitted during validation | 校验期间 beginStep 成功，完成工具仍返回 archived=true |
| timeout asks abort but never settles a stuck runner | 已收到 abort，仍没有 step_end，snapshot 保留当前步骤 |
| startup mutates frozen running task | 冻结任务启动后被改成 queued，并追加 interrupted |

临时原始输出位于本次工作环境 `/tmp/pipiclaw-064-review-{unit,e2e,evals,probes}.log`，探针源码为 `/tmp/pipiclaw-064-review-probes.test.ts`；这些临时文件不是永久证据，关键触发顺序与观察已完整写在本报告。以上探针是问题确认工具，未作为修复后的回归安全网提交。
