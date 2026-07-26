# Pipiclaw 深度架构 / 设计 / 功能评审

日期：2026-07-25  
评审方式：只读代码审查 + 契约交叉验证 + `npm run check`  
评审基线：`0.8.10-beta.2`（命令输出）

## 1. 评审范围与方法

### 1.1 方法

本轮先按文档建立契约，再从装配根沿真实调用链向下追踪，最后用测试门禁验证理解：

1. 先读 `AGENTS.md`、`CLAUDE.md`、`docs/architecture.md`，以域边界、错误分类、并发队列和公开 API 约束作为判断基准。域划分与工程规则分别见 `AGENTS.md:8-20`、`AGENTS.md:42-52`。
2. 再读 `docs/scaling-and-concurrency.md`、`docs/memory.md`、`docs/security.md`，并在进入工具、用量、fallback、任务、durable wake、配置/API 子系统前对照 spec 015/016/017/027/031/035/036；例如 spec 035 明确把公开 API 收到 daemon embedding 的 21 个名字，见 `docs/specs/035-config-and-api-surface/design.md:68-76`。
3. 从 `src/runtime/bootstrap.ts` 追踪消息、任务和 durable dispatch；从 `src/agent/channel-runner.ts` 追踪 turn、SDK、用量和回传；从 `src/tools/registry.ts` 追踪所有 leaf tool；从 memory scheduler/gate/job 追踪后台维护；从 task driver/store/commands 追踪任务状态落盘。
4. 对每个疑点继续搜索所有生产调用者，不以文件名或注释推测调用关系。例如 NetworkGuard 的生产消费点落在 `src/web/client.ts:163-175`，而 `bash` 执行前只调用 command guard，见 `src/tools/bash.ts:165-182`。
5. 运行 `npm run check`；lint、typecheck、deadcode、测试全部通过，测试结果为 110 files / 884 tests。该结果证明当前发现不属于现有门禁已捕获的常规编译或单测回归，但不能反证并发交错、真实断网或宿主安全边界正确。

### 1.2 覆盖范围

- 架构：runtime / agent / memory / tools / security / web / models / subagents / tasks / shared 的依赖方向；`src/index.ts` 公共面；DingTalk 与 TUI 的 `ChannelContext` 实现。
- 设计：`ChannelQueue`、turn 内 `RunQueue`、共享 memory queue、`TurnPhase`、任务 transition table、记忆 gate/scheduler、工具 registry/details、settings 常量边界。
- 功能：DingTalk 入站与忙态路由、AI Card/plain fallback、停止与 steer、durable synthetic dispatch、重连、记忆固化/折叠/tombstone、工具 guard 与审计、usage/fallback、任务 driver/claim/finish/recurrence。
- 故障路径：队列拒绝、handler throw、模型首请求失败、卡片失败降级、配置/状态损坏、后台记忆 skip、task no-progress、daemon shutdown。

### 1.3 明确盲区

- 未连接真实钉钉 Stream、AI Card 或真实模型提供方；重连、限流、半开连接、重复回调和卡片 API 的结论来自实现与测试，不是线上故障注入。重连实现入口在 `src/runtime/dingtalk.ts:580-689`，本轮未做真实网络验证。
- 未执行恶意 `bash` payload，也未在容器/独立账号中验证逃逸面；安全结论是静态能力边界分析。安全文档也明确其不是 OS sandbox，见 `docs/security.md:441-465`。
- 未做 kill -9、磁盘写满、断电或跨文件系统 rename 的进程级 crash test；durable 与原子写结论基于代码顺序和现有测试。
- 未做多进程/多实例共享同一 workspace 的验证；当前文档定位为单实例，`ChannelQueue` 和 serial queue 都是进程内对象，见 `src/runtime/channel-queue.ts:12-37`、`src/shared/serial-queue.ts:5-24`。
- 未做长时间压测、内存/RSS、磁盘增长和 API rate-limit 压测。文档已记录 Runner 不驱逐和无全局 LLM 限流，见 `docs/scaling-and-concurrency.md:40-48`。
- 未逐行审计上游 `@earendil-works/pi-coding-agent` fork；只审查了本仓库对 SDK 的适配与少量私有字段耦合。
- specs 数量较多；本轮完整/重点核对当前实现直接相关的 015/016/017/027/031/035/036，其他历史 memory/security/task specs 按具体代码疑点定向查阅，没有重新验证每个历史决策的全部验收项。
- 未运行 `npm run test:coverage`、真实 TUI 交互和 E2E 外部服务套件；本轮只运行仓库统一门禁 `npm run check`。

## 2. 架构评估（A）

### A.1 域边界与依赖方向

#### P-08 🟡 agent 层仍依赖 DingTalk 事件类型，传输解耦只完成了投递半边

**影响子系统 / 触发条件：** job completion wake、未来新增第三种 transport、DingTalk event shape 变化。

**事实。** `ChannelContext` 本身是 transport-neutral contract，注释也明确 runner/session-events 只依赖该接口，见 `src/runtime/channel-context.ts:1-13`、`src/runtime/channel-context.ts:61-83`；TUI 确实用自己的 renderer 实现它，见 `src/tui/terminal-context.ts:1-16`、`src/tui/terminal-context.ts:79-109`。但 agent 域的 `ChannelJobManager` 直接 import `DingTalkEvent`，其 dispatch port 和完成通知都使用、构造该具体类型，见 `src/agent/job-manager.ts:4-7`、`src/agent/job-manager.ts:66-71`、`src/agent/job-manager.ts:367-394`。同一层的出站队列错误日志还硬编码 `DingTalk API error`，见 `src/agent/run-queue.ts:10-20`。

**契约差异。** `docs/architecture.md` 对 `ChannelContext` 的描述成立，但“传输与 agent 解耦”若理解为完整双向端口则不成立：出站 delivery 已抽象，后台 wake 的入站事件仍是 DingTalk shape。`AGENTS.md:10-18` 把 runtime 和 agent 划成不同域，当前存在 agent → runtime 的反向依赖。

**建议与权衡。** 引入 transport-neutral 的 `SyntheticChannelEvent`/`ChannelDispatchPort`，由 runtime adapter 转成 DingTalk 或 TUI 事件；同时把 `RunQueue` 日志改为 delivery-neutral。改动代价是 bootstrap、event/task/job 三类 synthetic wake 要统一迁移；不改的代价是每新增 transport 都必须理解 DingTalk 字段，并持续扩大 agent → runtime 依赖。

### A.2 公共 API 与配置面

#### O-01 🔵 `src/index.ts` 与 spec 035 的最小 embedding API 一致

**事实。** spec 035 要求只保留 daemon embedding 所需的 21 个名字并移除 memory/tool/usage 等内部实现，见 `docs/specs/035-config-and-api-surface/design.md:68-76`；当前 barrel 只导出路径常量、bootstrap、`ChannelContext`、DingTalk facade 和 `PipiclawSettings`，见 `src/index.ts:1-40`。未发现不应公开的 memory、sidecar、tool factory 或 SDK reflection helper。

**建议。** 保持现状，并继续把 `src/index.ts` 当 knip blind spot 审核。增加名字会扩大兼容承诺；不增加的代价是内部消费者必须使用深路径，但该项目明确不是通用 SDK，这个代价可接受。

#### O-02 🔵 `settings.json` 的“产品意图 / 数值常量”边界已落实

**事实。** 用户输入类型只保留模型引用、boolean、enum 和决定额外 LLM 调用的选项，见 `src/settings.ts:159-184`；task driver 和 memory maintenance 的数值通过默认常量/getter 下发，见 `src/settings.ts:444-472`；历史数值键被列为 retired 并告警，见 `src/settings.ts:270-314`。这与 spec 035 的 D1/D2 一致，见 `docs/specs/035-config-and-api-surface/design.md:31-58`。

**建议。** 保持 runtime DI interface 宽、用户输入 interface 窄的双层设计。其代价是两个类型形状不镜像，但换来了算法参数不成为长期配置兼容面。

## 3. 设计评估（B）

### B.1 并发模型

#### P-01 🟠 任务文件是原子写，但任务状态更新没有串行事务，存在 lost update

**影响子系统 / 触发条件：** TaskDriver 与 `/tasks approve|pause|resume|run`、turn 内 `task_manage`、attempt finish 同时修改同一 task；忙态下最容易触发。

**事实。** 通用更新路径是“读文件 → 内存修改 → 原子覆盖”，中间没有 per-task queue、版本号或 compare-and-swap，见 `src/tasks/store.ts:70-85`。attempt claim/finish 都复用这条读改写路径，见 `src/tasks/store.ts:94-113`、`src/tasks/store.ts:132-174`；TaskDriver 会在扫描中 heal/open/claim，见 `src/runtime/task-driver.ts:350-371`、`src/runtime/task-driver.ts:409-475`。与此同时，DingTalk 在 runner busy 时立即处理 `/tasks`，不进入频道 turn queue，见 `src/runtime/dingtalk.ts:1348-1353`；这些命令也独立 read + write 同一文件，例如 approve/pause/resume，见 `src/runtime/task-commands.ts:250-308`。`task_manage` 的 set/progress/done 同样自行读写/rename，见 `src/tools/task-manage/lifecycle.ts:28-48`、`src/tools/task-manage/lifecycle.ts:51-80`、`src/tools/task-manage/lifecycle.ts:141-158`。

**后果。** `writeFileAtomically` 只能防止半文件，不能防止两个读者基于同一旧版本先后覆盖。可能丢失 approval、pause、usage increment、verification 或 progress；done/cancel 的 rename 与 finish/update 并发还可能让后写者落到旧路径或读到 archive 的不同版本。

**契约差异。** 文档宣称“同一频道内串行”，但同时明确 `/tasks` busy 时立即响应，见 `docs/scaling-and-concurrency.md:24-31`。turn 串行不等于 task ledger mutation 串行；架构并发表没有 task mutation queue，见 `docs/architecture.md:152-166`。

**建议与权衡。** 以 `channelId/taskId` 建 keyed serial queue，把 store update、command mutation、task_manage、claim/finish、archive/rename 都收口到一个 repository transaction API；若希望未来多进程共享 workspace，再加 revision/CAS 或锁文件。只加进程内 queue 实现简单且覆盖当前部署模型，但不解决多实例；加 CAS/锁更可靠，却需要定义冲突重试和 stale writer 行为。不改的代价是低频但不可审计的状态丢失。

#### O-03 🔵 三类关键串行化各自只管一个明确对象

**事实。** `ChannelQueue` 每频道串行 turn 且异常后继续下一项，见 `src/runtime/channel-queue.ts:27-37`；`RunQueue` 以 promise chain 保序单 turn 投递，见 `src/agent/run-queue.ts:10-30`；共享 memory queue 是进程级 singleton，见 `src/memory/channel-maintenance-queue.ts:7-15`，底层 serial queue 会在 rejection 后继续并在尾项结束时清理 key，见 `src/shared/serial-queue.ts:5-24`。这三者与 `docs/architecture.md:152-166` 的职责表相符。

**建议。** 保持队列按“turn / outbound / memory writes”分层，避免合成一个全频道大锁；大锁会让慢投递或 LLM 维护阻塞无关状态写入。

### B.2 状态机与任务治理

#### O-04 🔵 任务非法跃迁已收口到单一 transition table

**事实。** 六个 canonical statuses、terminal statuses 和所有 action 的 from/to 都集中在 `src/tasks/transitions.ts:19-61`；非法 from 或非法 caller status 统一抛 `RecoverableToolError`，见 `src/tasks/transitions.ts:95-119`。这避免了 command/tool 两边各维护一套状态机。

**建议。** 保持 transition table 为唯一状态语义源；后续新增状态必须同时明确 driver disposition，而不是只加 UI 标签。

#### P-03 🟠 自主任务没有全局 token/cost 支出闸，默认 12 attempts 不是成本上限

**影响子系统 / 触发条件：** tasks enabled、多个频道/任务无人值守运行、模型价格高或单 attempt 上下文很大。

**事实。** `TaskBudget` 只剩 `maxAttempts`，源码注释明确成本控制应属于尚未实现的 global spend guard，见 `src/tasks/control.ts:19-36`；默认值是 12，见 `src/tasks/control.ts:220-230`；TaskDriver 的确定性 governor 只检查 deadline 和 attempts，见 `src/tasks/control.ts:397-405`、`src/runtime/task-driver.ts:373-389`。usage ledger 只提供 record/summarize，没有 admission/cap API，见 `src/usage/ledger.ts:79-144`。

**契约差异。** 这不是实现误读，而是 spec 036 明确接受的残余敞口：spec 直接写明 `src/usage/` 无 cap/guard，并建议全局支出闸，见 `docs/specs/036-task-governance-slimming/design.md:25-32`、`docs/specs/036-task-governance-slimming/design.md:295-299`。因此代码与 spec 一致，但与“长期无人值守 daemon”的风险目标仍有缺口。

**建议与权衡。** 在 TaskDriver dispatch admission 前加入日/月全局 token 与已知成本上限，触顶时暂停自动派发并发送一次去重通知；未知价格模型应至少受 token cap 约束。全局闸会造成多个频道争用配额，需要定义优先级和人工恢复；不改则任何单 task attempt limit 都无法限制任务数量乘积或单次超大上下文的总支出。

### B.3 记忆 gate 与长期运行

#### P-06 🟡 memory-review 的 gate-skip 去重在三 job 轮询下基本失效

**影响子系统 / 触发条件：** memory maintenance 开启、频道长期 idle/未达 gate、scheduler 周期扫描。

**事实。** scheduler 对一个频道依次跑 session refresh、checkpoint、structural maintenance，只有某项实际 `ran` 才提前返回，见 `src/memory/scheduler.ts:151-180`。三个 job 的 gate 拒绝都会各写一条 skip，见 `src/memory/maintenance-jobs.ts:159-181`、`src/memory/maintenance-jobs.ts:240-258`、`src/memory/maintenance-jobs.ts:320-336`。去重状态却是每个 log path 只记“上一条 skip fingerprint”，仅相邻 fingerprint 相同才丢弃，见 `src/memory/review-log.ts:29-32`、`src/memory/review-log.ts:58-72`。三个不同 job 的 fingerprint 每 tick 轮流覆盖，因此下一 tick 的同类 skip 不再与 map 中上一条相同。

`dirty` 也只在 activity 时置 true，当前 state reducer 没有清零分支，见 `src/memory/maintenance-state.ts:140-163`；它不直接造成 LLM 调用（gate 仍有其他条件），但使该状态位失去“已维护干净”的长期语义。

**后果。** idle instance 不烧 LLM token 的契约仍成立，但会持续产生 review JSONL、轮转和磁盘 I/O；`memory-review.jsonl` 作为“第一现场”的信噪比下降。文档说它记录每次维护动作/跳过原因，见 `docs/memory.md:59-61`，没有承诺每 tick 三条，因此属于观测设计缺陷而非数据正确性故障。

**建议与权衡。** 将去重 key 改成 `path + job kind`，记录每类最后 fingerprint/时间，只在 reason 改变或经过较长 heartbeat 周期时再写；同时定义成功 checkpoint/session refresh 后 `dirty` 的清零语义。去重会减少逐 tick 取证细节，但保留状态变化和稀疏 heartbeat 足以排障；不改则长驻实例产生稳定无信息写放大。

### B.4 工具契约

#### P-04 🟠 `RecoverableToolError` 规则未在 leaf tools 一致执行

**影响子系统 / 触发条件：** 模型传空 pattern、edit 的 oldText 不匹配/不唯一、job cancel 漏 id 等可自行修复的调用。

**事实。** 项目规则要求“模型能自己修复”时使用 `RecoverableToolError`，且只有 plain Error 到用户聊天，见 `AGENTS.md:50-52`；wrapper 也只把该类型转成 `recoverable: true` 的 normal result，其他错误继续抛出，见 `src/tools/tool-details.ts:76-98`。但 edit 对 oldText 不存在或不唯一抛 plain `Error`，见 `src/tools/edit.ts:193-207`；grep 空 pattern 和 bad regex/path 也抛 plain `Error`，见 `src/tools/grep.ts:197-199`、`src/tools/grep.ts:229-234`；job cancel 缺 ids 同样如此，见 `src/tools/job.ts:67-71`。session-events 会把这些 `event.isError` 结果作为 error progress 发给用户，见 `src/agent/session-events.ts:219-242`。

**建议与权衡。** 对 registry 中每个 tool 做参数/前置条件矩阵审计，并增加 table-driven test：model-fixable → recoverable normal result；guard/approval/corrupt/I/O → plain error。把可修复错误隐藏于模型循环会减少用户可见诊断，但这正是既定产品契约；应通过 structured logs 保留可观测性。不改会让普通自纠错表现为红色故障，并使同类工具 UX 不一致。

#### P-10 🟡 edit 成功结果的 diff 截断没有可执行的下一步

**影响子系统 / 触发条件：** edit diff 超过 40 行，模型需要核对未显示部分。

**事实。** `clampDiffForEcho` 只返回 `[diff truncated, N more lines]`，没有告诉模型用 `read`/`grep` 查看哪个文件或如何继续，见 `src/tools/edit.ts:125-136`。这与 `AGENTS.md:50` 对所有截断输出必须携带 next-step instruction 的规则不一致。

**建议与权衡。** 在 marker 中加入目标 path 和直接动作，例如“Use read on <path> to verify the full result”。多几个 token 的代价很小；不改会让截断结果只能提示“不完整”而不能 steer 下一步。

#### O-05 🔵 registry 的 `kind` 盖章契约确实不可漂移

**事实。** leaf tools 由单一 `TOOL_REGISTRY` 声明 name、subagent availability 和 enable gate，见 `src/tools/registry.ts:95-102`、`src/tools/registry.ts:102-238`；`buildToolSet` 对每个 registration 统一套 wrapper，见 `src/tools/registry.ts:261-280`；wrapper 在 spread tool details 之后最后写 `kind`，见 `src/tools/tool-details.ts:76-85`。工具内部伪造 `details.kind` 无法覆盖 registration name。

**建议。** 保持 stamping 在 build seam，不把 `kind` 重新散回各 tool。代价是 subagent 本身仍在 registry 外单独装配，但注释已经明确这是为避免 registry ↔ subagents 循环，见 `src/tools/registry.ts:95-100`。

## 4. 功能正确性评估（C）

### C.1 消息、投递、停止与重连

#### O-06 🔵 final response 有 card → plain 的双路径降级，空 final 也不会永久卡在 thinking

**事实。** card finalize 失败会 fallback 到 plain，见 `src/runtime/dingtalk.ts:782-807`、`src/runtime/dingtalk.ts:849-855`；session-events 将无文本无 tool 的 turn 视为 silent，避免 progress card 永远停在 thinking，见 `src/agent/session-events.ts:323-347`；真实 final 通过串行 queue 投递并只在成功后标记，见 `src/agent/session-events.ts:350-370`。

**建议。** 保持 final delivery 的两层 fallback；未来若引入 durable outbound，应只对用户可见 final/command result 做幂等重试，避免 progress revision 重放。

#### P-09 🟡 command/steer 确认是 best-effort，失败只返回 `false` 且调用者普遍忽略

**影响子系统 / 触发条件：** access token 或 plain API 短暂失败，尤其 `/stop`、`/tasks approve`、`/usage` 等状态已改变但回复未送达。

**事实。** `sendPlain` 以 boolean 表达失败，token 不可用直接返回 false，见 `src/runtime/dingtalk.ts:861-870`。runtime command handlers 调用后不检查结果，例如 events/tasks/status/usage，见 `src/runtime/bootstrap.ts:693-743`；busy steer confirmation 也不检查，见 `src/runtime/bootstrap.ts:778-813`。与 final response 不同，这些回复没有 durable outbox 或 retry。

**后果。** 命令可能已经改变 task approval/pause 状态，但用户只看到沉默；重发又可能执行第二次语义。该问题不是入站丢失，而是控制面 response 的 delivery ambiguity。

**建议与权衡。** 至少对状态改变型 command reply 检查 boolean、记录结构化 delivery failure，并提供带 stable id 的有限重试；如果无法保证 exactly-once，应让重复命令本身幂等并在下一次 `/status` 可见。durable reply 会引入重复消息和幂等键管理；不改则 transient outbound failure 永远无法与“命令没执行”区分。

### C.2 Durable dispatch 与恢复

#### P-07 🟡 durable outbox 在 handler 抛错后仍删除记录，语义是“至少开始一次”而非“至少成功处理一次”

**影响子系统 / 触发条件：** synthetic event/task 已入队并进入 handler，但在 command、runner 外层或 task finish 落盘时抛异常，进程没有崩溃。

**事实。** durable service 注释宣称 at-least-once delivery，见 `src/runtime/durable-dispatch.ts:83-88`；running record 会续 lease，重启后 lease 到期重投，见 `src/runtime/durable-dispatch.ts:93-102`、`src/runtime/durable-dispatch.ts:189-220`。但 bootstrap 的 handler catch 只记日志，finally 无条件 `markCompleted`，见 `src/runtime/bootstrap.ts:892-924`；`markCompleted` 直接 unlink record，见 `src/runtime/durable-dispatch.ts:181-186`。

**判断。** 对“投递到 handler”而言注释成立；对“业务处理成功”不成立。正常 runner 已将不少模型错误折叠为 RunResult，因此触发面主要是外层真实 fault；一旦触发，记录不会重试。反过来，简单地“throw 就重试”也可能重复已经发生的外部副作用，所以这不是把 finally 移走即可修复。

**建议与权衡。** 明确 durable contract 是 admission-at-least-once 还是 effect-at-least-once；若目标是后者，给 handler 返回结构化 outcome，并按 task/event 类型定义 retryable failure、terminal failure 与已提交 checkpoint。更强语义要求 side effect idempotency；不改则应修正文档，避免维护者把它当业务完成保证。

### C.3 安全护栏与 sub-agent

#### P-02 🟠 sub-agent 的 memory write deny 可被其默认 `bash` 工具绕过

**影响子系统 / 触发条件：** sub-agent 使用 `bash` 对频道 `SESSION.md`/`MEMORY.md`/`HISTORY.md` 写入；默认 sub-agent toolset 就包含 read + bash。

**事实。** sub-agent 代码明确说要“结构性”禁止这三个文件，避免绕过 shared memory queue 后静默损坏，并把绝对路径追加到 `pathGuard.writeDeny`，见 `src/subagents/tool.ts:344-365`。但 sub-agent toolset 来自 registry，`bash` 对 sub-agent 可用，见 `src/tools/registry.ts:102-120`；verify purpose 只过滤 write/edit，不过滤 bash，见 `src/subagents/tool.ts:373-399`。`bash` 执行前只调用 command guard，没有调用 path guard，见 `src/tools/bash.ts:153-182`。因此 `printf ... > <channelDir>/MEMORY.md`、`sed -i` 等不经过该 write deny。

**契约差异。** `docs/memory.md` 明确说频道记忆文件不应手工编辑，因为会与维护队列竞态，见 `docs/memory.md:40-47`；`src/subagents/tool.ts:344-351` 也把此处当结构性保证。代码实际只保护 dedicated write/edit，不保护同样能写文件的 shell executor。

**建议与权衡。** 短期对 sub-agent/verify purpose 移除 unrestricted bash，或提供只读/受限 executor；长期把 workspace mount、文件权限或 sandbox 放在 executor boundary，使任何写路径都受同一 policy。尝试解析 shell 字符串中的所有重定向/子命令不完备；移除 bash 会降低 sub-agent coding 能力，但当前“允许 bash + 宣称结构性 write deny”是不可同时成立的承诺。

#### P-05 🟠 path/network guard 只覆盖 dedicated tools，`bash` 是未受这两道闸约束的通用逃逸面

**影响子系统 / 触发条件：** 主 agent 或 sub-agent 使用 `bash` 读取 deny path、写系统/凭据路径，或通过 curl/wget/node 访问 private network；security.json 管理员误以为 path/network policy 对所有执行路径生效。

**事实。** web client 在每次初始请求/redirect 调用 NetworkGuard 并记录 block，见 `src/web/client.ts:157-175`；bash 只调用 command guard，见 `src/tools/bash.ts:165-182`，没有 path/network context enforcement。安全指南实际较准确：command guard 作用于 bash，path guard 只作用于 read/write/edit 等显式文件工具，见 `docs/security.md:9-19`；架构文档却概括为“所有文件/命令/网络工具在执行前都过守卫”，见 `docs/architecture.md:261-269`。两份文档表达不一致。

**判断。** 这是工具层 guard 的能力边界，不等于已发现具体 command-guard bypass；但只要 bash 允许一般命令，path/network deny 就不是全执行面安全边界。安全指南关于“不是 OS sandbox”的警告成立，见 `docs/security.md:441-465`。

**建议与权衡。** 先修正文档和配置说明，把 guard scope 写成 tool-specific；需要强约束的部署把 network/filesystem policy 下沉到容器、独立用户、seccomp/namespace/proxy，或受控 remote executor。继续增强 shell regex 可挡常见误操作但不能形成完备边界；下沉 sandbox 运维成本更高，却是唯一能覆盖 curl、解释器、重定向和子进程的方案。

#### P-11 🟡 event `preAction` 的 command-guard 拒绝没有进入 security audit log

**影响子系统 / 触发条件：** event preAction 被 command guard 拒绝，管理员依赖 `security.log` 审计所有 blocked operation。

**事实。** security logger 提供受 `audit.logBlocked` 控制的 JSONL 记录，见 `src/security/logger.ts:25-45`；bash guard block 会调用它，见 `src/tools/bash.ts:165-180`。event preAction 共用 `guardCommand`，但 block 时只写 runtime warning 并抛 `EventPreActionError`，见 `src/runtime/events.ts:807-818`。架构文档写“拦截写入审计日志；事件 preAction 与 bash 共用 command-guard”，见 `docs/architecture.md:261-269`，代码只满足后半句。

**建议与权衡。** 给 EventsWatcher 注入 security audit context 并复用 `logSecurityEvent`，事件 history 继续保留业务结果。增加一条审计写会有轻微 I/O，但 audit logger 已有 async queue/timeout；不改则 security.log 不是所有 guard refusal 的完整账本。

### C.4 用量、成本与 fallback

#### P-12 🟠 zero-cost / unknown-price turn 不进入 usage ledger，token observability 与 `costKnown` 语义脱节

**影响子系统 / 触发条件：** 本地模型、供应商未提供 pricing metadata、返回 token 但 `cost.total === 0`。

**事实。** ChannelRunner 只有 total cost > 0 才 log summary 并记录 turn entry，见 `src/agent/channel-runner.ts:545-584`；ledger 自身也丢弃所有 `cost.total <= 0` entry，见 `src/usage/ledger.ts:79-97`。但 runner 仍返回 token usage 和 `costKnown`，见 `src/agent/channel-runner.ts:595-602`；任务 ledger 也专门累计 tokens，并以 `costKnown` 表示是否缺 pricing，见 `src/tasks/store.ts:145-154`。usage summary 只从落盘 entries 聚合，见 `src/usage/ledger.ts:102-143`。

**契约差异。** spec 016 有意用“无 API billing → no ledger noise”的策略；当前实现与该历史决策一致。可是架构文档将其描述为用量账本，并声称 Σ(entries) = 真实开销，见 `docs/architecture.md:273-277`。对美元已知且正数时等式成立；对未知价格，账本无法表达“有 token、成本未知”，`/usage` 也看不到这类工作负载。该缺口还会削弱 P-03 建议的 token-based global guard。

**建议与权衡。** ledger 应记录有 token 的 zero-cost entry并增加 `costKnown`，渲染时区分 `$0 known`、`unknown price` 和 local model；若担心 noise，可聚合或只省略 usage.total=0。账本会变大，且旧 schema 需要向后兼容；不改则观测只能叫 cost ledger，不能作为完整 usage ledger 或未知价格模型的预算依据。

#### O-07 🔵 fallback 对 transcript surgery 采取 fail-closed，且只重试一次

**事实。** 只有尾部严格为 `[user, assistant(error)]` 才删除失败 turn，否则返回 null，见 `src/agent/model-fallback.ts:56-76`；caller 在 shape 不符时跳过 fallback，避免破坏 context，见 `src/agent/model-fallback.ts:145-157`；成功切 model 后只再 prompt 一次，见 `src/agent/model-fallback.ts:121-170`。这与 spec 017 的单 fallback 链一致。

**建议。** 保持 fail-closed；不要为提高 fallback 命中率而猜测多 tool-step transcript 的可删区间。代价是多步失败不会自动降级，但避免 silent context corruption 更重要。

### C.5 记忆数据安全与恢复

#### O-08 🔵 history folding 先存 raw archive，forget tombstone 不保存原文

**事实。** history fold 在 LLM lossy summary 前先 append 原始 older sections 到 archive，见 `src/memory/consolidation.ts:345-360`，最后才 rewrite folded history，见 `src/memory/consolidation.ts:362-385`。forget 会删除目标并写 entry id、content hash、reason/source ids，不写原文，见 `src/memory/files.ts:237-251`；rewrite 前会 best-effort backup 且最终 atomic write，见 `src/memory/files.ts:301-328`。

**建议。** 保持“先保 raw、后 lossy fold”和 hash-only tombstone。需要注意 backup 是 best-effort，磁盘满时不能作为恢复保证；但把 backup 失败变成主写失败会降低 daemon 可用性，当前权衡合理。

## 5. 按严重度排序的问题清单

本轮未确认 🔴 阻塞性问题。下表的 🟠 项应进入近期设计/修复队列；🟡 项适合与相邻改动合并。

| 编号 | 严重度 | 子系统 | 摘要 | 证据 file:line | 建议 |
|---|---|---|---|---|---|
| P-01 | 🟠 | tasks / concurrency | task 文件多条 read-modify-write 路径无 per-task 串行，busy `/tasks` 可与 driver/turn 丢更新 | `src/tasks/store.ts:74-85`; `src/runtime/dingtalk.ts:1348-1353`; `src/runtime/task-commands.ts:250-308` | 建 keyed task transaction queue；多实例再加 revision/CAS |
| P-02 | 🟠 | subagents / memory / security | sub-agent memory write deny 只约束 write/edit，默认 bash 可直接写三层记忆文件 | `src/subagents/tool.ts:344-365`; `src/subagents/tool.ts:373-399`; `src/tools/bash.ts:165-182` | 限制 sub-agent bash，最终把隔离下沉 executor/OS |
| P-03 | 🟠 | tasks / usage | 自主任务只有 maxAttempts，无全局 token/cost cap | `src/tasks/control.ts:19-36`; `src/tasks/control.ts:397-405`; `docs/specs/036-task-governance-slimming/design.md:295-299` | TaskDriver admission 前加日/月全局 spend guard |
| P-04 | 🟠 | tools / UX | 多个 model-fixable bad call 抛 plain Error，违背 RecoverableToolError 契约 | `AGENTS.md:50-52`; `src/tools/edit.ts:193-207`; `src/tools/grep.ts:197-234` | 全 registry 做错误分类矩阵与回归测试 |
| P-05 | 🟠 | security | path/network guard 不覆盖 bash；架构文档比安全指南承诺更强 | `src/tools/bash.ts:165-182`; `src/web/client.ts:163-175`; `docs/security.md:9-19` | 修正文档；强边界下沉 sandbox/executor |
| P-12 | 🟠 | usage / cost | zero-cost/unknown-price 有 token 的 turn 被账本丢弃 | `src/agent/channel-runner.ts:545-584`; `src/usage/ledger.ts:84-97` | 记录 token entry + `costKnown`，区分 local/unknown/$0 |
| P-06 | 🟡 | memory / observability | 三种 skip fingerprint 轮流覆盖，使 review-log 去重跨 tick 失效 | `src/memory/scheduler.ts:151-180`; `src/memory/review-log.ts:58-72` | 按 job kind 去重并保留稀疏 heartbeat |
| P-07 | 🟡 | durable dispatch | handler 异常仍 markCompleted/unlink，durable 只保证进入 handler | `src/runtime/bootstrap.ts:913-924`; `src/runtime/durable-dispatch.ts:181-186` | 定义业务 outcome/checkpoint 与 retryable failure |
| P-08 | 🟡 | architecture / transport | agent JobManager 反向依赖并构造 DingTalkEvent | `src/agent/job-manager.ts:4-7`; `src/agent/job-manager.ts:367-394` | 抽 neutral synthetic event/dispatch port |
| P-09 | 🟡 | DingTalk delivery | command/steer plain reply 失败 boolean 被忽略 | `src/runtime/dingtalk.ts:861-870`; `src/runtime/bootstrap.ts:693-743` | 对状态改变型回复做幂等有限重试/失败观测 |
| P-10 | 🟡 | tools | edit diff truncation 没有模型可执行 next step | `src/tools/edit.ts:125-136`; `AGENTS.md:50` | marker 指向 `read <path>` 等具体动作 |
| P-11 | 🟡 | events / security audit | preAction guard refusal 未写 security audit | `src/runtime/events.ts:807-818`; `src/security/logger.ts:25-45` | EventsWatcher 复用 security audit logger |

## 6. 亮点：值得保持的具体设计

1. **投递抽象已有真实的第二实现。** `ChannelContext` 不只是接口占位；DingTalk 使用 card/plain controller，TUI 使用 renderer，并共享 final/progress 语义，见 `src/runtime/channel-context.ts:1-13`、`src/tui/terminal-context.ts:1-16`。应继续沿这个 seam 扩展，不把 raw response mode 或 DingTalk card id 带入 ChannelRunner。
2. **并发责任切分足够精确。** turn、单 turn outbound、memory writes 分别串行，且 shared memory queue 是 process singleton，见 `src/runtime/channel-queue.ts:27-37`、`src/agent/run-queue.ts:10-30`、`src/memory/channel-maintenance-queue.ts:7-15`。这比“所有东西进一个队列”更能避免 head-of-line blocking。
3. **工具 discriminator 在单一 seam 强制。** registry name 最后盖写 `details.kind`，见 `src/tools/registry.ts:261-280`、`src/tools/tool-details.ts:76-85`；这一不变量可由代码结构保证，不靠作者纪律。
4. **任务状态机与独立验证有明确 fail-closed 行为。** transition table 集中非法跃迁，见 `src/tasks/transitions.ts:49-61`、`src/tasks/transitions.ts:100-119`；task done 会校验 verifier attestation/body/artifact subject，无法重算 subject 时拒绝，见 `src/tools/task-manage/lifecycle.ts:106-133`。
5. **记忆的 lossy 操作前有可恢复原料。** history fold 先 archive raw blocks，见 `src/memory/consolidation.ts:345-360`；forget tombstone 保存 hash 而非敏感原文，见 `src/memory/files.ts:237-251`。这两个选择同时照顾恢复与隐私。
6. **fallback 宁可不切换也不猜 transcript。** surgery 只接受严格尾形，shape 异常直接跳过，见 `src/agent/model-fallback.ts:56-76`、`src/agent/model-fallback.ts:145-157`。这是长期 session 中正确的失败偏好。
7. **配置与 public API 已主动收缩。** 用户 settings 不再承诺算法数字，retired key 有诊断；barrel 只服务 embedding daemon，见 `src/settings.ts:270-327`、`src/index.ts:1-40`。

## 7. 未覆盖 / 后续建议

按收益与依赖顺序，下一轮建议：

1. 先为 P-01 写一个确定性交错测试：两个 deferred read 同时读取同一 task，再分别 approve 与 finish，证明现状 lost update；随后设计 task repository transaction seam。现有 update 是明显的读改写窗口，见 `src/tasks/store.ts:74-85`。
2. 为 P-02/P-05 做 executor-boundary threat model：列出主 agent、sub-agent、event preAction、async job 四个 shell 入口及其 filesystem/network 权限；不要把 shell parser 增强等同 sandbox。文档已承认 command guard 不完整，见 `docs/security.md:455-465`。
3. 把 global spend guard 与 usage schema 一起设计：若先不解决 P-12，unknown-price model 的 global cost guard 仍会 fail-open；至少要有 token cap 和 `costKnown=false` policy。
4. 做 kill/fault matrix：durable record 写后、enqueue 后、markStarted 后、外部 effect 后、finishTaskAttempt 前后分别 kill，定义每点期望的 replay/idempotency。当前 record 生命周期见 `src/runtime/durable-dispatch.ts:169-220`，bootstrap completion 点见 `src/runtime/bootstrap.ts:893-924`。
5. 用 fake clock 跑数百个 memory scheduler ticks，量化 P-06 的 JSONL 增长与 rotation；同时补“每 job fingerprint 去重”测试。现有 review-log rotation 只限制文件大小，见 `src/memory/review-log.ts:29-55`。
6. 对 TOOL_REGISTRY 自动遍历 error taxonomy 与 truncation contract；本轮只列出已确认样例，尚未为每个 tool 的每个 error branch 建完整矩阵。registry 全量入口见 `src/tools/registry.ts:102-238`。
7. 做真实 DingTalk chaos test：token 过期、card create 成功但 stream/finalize 失败、plain 429、WebSocket 半开、同 callback 重放，并验证用户能区分“命令执行了但回复丢了”。plain command 调用点见 `src/runtime/bootstrap.ts:693-743`。

## 结论

Pipiclaw 当前最需要保护的不是模块数量，而是三个跨域不变量：**同一持久实体只能有一个 mutation seam、所有执行能力必须在同一安全边界下受控、计量必须能表达未知而不是把未知当作零并丢弃**。现有 `ChannelContext`、分层队列、registry stamping、task transition table 和 memory archive/tombstone 已经给出了正确的结构化做法；P-01、P-02/P-05、P-12 应沿用同样思路，在单一 seam 处建立不可绕过的约束，而不是继续给各调用点补局部判断。
