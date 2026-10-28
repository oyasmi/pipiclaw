# 064 实施计划

设计见 [design.md](./design.md)。决策编号 D1–D35、不变量 INV-1–INV-9 以设计为准。本计划规定实施顺序、每一步改哪些文件、删哪些代码和测试、写哪些测试，以及做到什么程度算完成。计划与代码事实冲突时，按设计原则就地决定，写进设计文档 §20「实施记录」（规则见「偏差处理」）。

## 阶段总览

| 阶段 | 步骤 | 交付 | 对应决策 | 风险 |
|---|---|---|---|---|
| P0 基线与核实 | P0 | 用例数、门禁结果；设计 §19 七项核实结论 | §19 | 低 |
| P1 任务领域 | P1.1–P1.6 | 新 frontmatter 与状态、新日志、状态推导、存储转换、全量/增量 brief、`TaskControl` 端口、`/tasks` 命令；删除票据与 steer 文件 | D2–D10、D15、D16、D24、D25 | 中 |
| P2 agent 与工具 | P2.1–P2.3 | `RunnerProfile`；删除会话切换；任务与聊天两套工具；删除 `taskId` 参数；提示词 | D13、D14、D18、D21–D23 | **高** |
| P3 运行时 | P3.1–P3.5 | `TaskLane`；结算直达任务；删除 driver 与任务唤醒；ingress / turn-run 清理；接线；命令 | D11、D12、D16、D17、D19、D20、D26–D30 | **高** |
| P4 deterministic e2e | P4 | 重写任务 e2e；事故回归用例 | D35 | 中 |
| P5 playbook 与提示词 | P5 | 重写 `task-lead.md`，修改其余手册 | D32 | 中 |
| P6 评测 | P6 | graders / controls / cases 更新；dev 用例运行记录 | D35 | 中 |
| R 收尾 | R1–R4 | 文档、迁移说明与演练、验收、上线 | D33、D34 | R2 **高**（数据）；R4 需用户在场 |

依赖：P0 → P1 → P2 → P3 → P4 → P5 → P6 → R1 → R2 → R3 → R4。P1–P3 是同一条链路的拆分，**门禁点合并在 P3 结束**（见下文「门禁」）。P5 的 playbook 正文可以与 P2/P3 并行起草，但必须在 P3 定稿后逐句对照最终实现再提交。

---

## 通用规则（每一步都适用）

**分支**：在 `feat/task-lane` 上开发，不直接在 master 上提交。每个阶段结束时 rebase 到最新 master。

**门禁**：

- 每个提交：`npm run lint && npm run arch`。
- P1–P3 之间的提交允许 `typecheck` 暂时失败（删除票据会同时打断 tools / runtime / subagents / jobs 的引用，无法逐提交保持类型正确）；**P3 结束时**以及之后的每一步结束时，以下全部通过：

```bash
npm run check                 # lint + typecheck + arch + deadcode + test
npm run test:e2e              # 会先 build
npm run test:evals            # 改了 evals/ 时
npm run build && node dist/main.js --version
```

**不允许跳过测试、缩小测试发现范围或调大超时来通过门禁。**

**提交纪律**：conventional commits（`feat:`、`refactor:`、`test:`、`docs:`、`chore:`）；每个提交只做一件能说清楚的事；纯移动与逻辑修改分开（移动用 `scripts/move-modules.mjs`）。遵守 CLAUDE.md：**不加 `Co-Authored-By` 等署名尾注**。

**代码约束**（本次特别容易违反的）：

- **被取代的代码直接删除**：不留兼容别名、re-export 垫片、旧字段读取、旧日志种类读取、`@deprecated` 标记或「以后再删」的注释。设计 §17 的删除清单在 R3 逐项用 `rg` 验证为零引用。
- 不读旧格式：`state: open|parked`、`ticket`、`usage.expired`、`expired` 记录、旧形状的 `step` 记录、`.steer/` 目录都不被新代码识别；转换只写在 `docs/task-migration.md`。
- `src/tasks/` 仍是叶子模块（只依赖 layer 0–1）：车道相关的调度与接线放 `src/runtime/`；工具层通过 `src/tasks/control.ts` 的接口作用于车道，不导入 `runtime/`。
- 文件不超过 800 行；`scripts/architecture-baseline.json` 只能缩小。
- 新的数值阈值是代码常量，不进 `settings.json`。
- 日志：`log.logWarn(event, message, { channelId, reason, fields })`，事件名 `<domain>.<object>.<verb>`，任务车道用 `tasks.lane.*` / `tasks.task.*` / `tasks.step.*`。
- 用户文案遵守 spec 053：中文、四个标记、不出现工具名和内部标签；界面用语集中在 `taskStateLabel` 与 `commands/catalog.ts`。

**测试纪律**（AGENTS.md「Unit-test admission and size control」与 e2e 硬规则）：

- 针对被删除机制的测试**直接删除**，按新代码重新设计，不在旧测试上逐步改造。
- 已有功能的单测与 e2e **总用例数默认不增加**。新增用例必须写明它防的故障；deterministic e2e 新用例必须做变异检查并写进用例注释。
- 矩阵归属：状态推导归 `tasks/` 的纯函数测试；槽位、守护、对账归车道单测（假 runner、假管理器）；工具的参数与互斥归工具测试；命令只测解析和端口调用，不测文案字面（文案由 `test/user-copy-shape.test.ts` 结构化约束）。
- 每一步结束时在设计 §20 写下单测、e2e 各自的用例数 before → after 和原因。

**偏差处理**：

- 计划与代码事实不符时，按设计原则就地决定，写进 §20：步骤、偏差、理由。
- **遇到会改变用户可见行为、某个不变量或数据格式的决定，停下来问用户，不要自行拍板。** 例如：执行槽数、单步时限、守护阈值、命令或工具的增删、回执的增删、frontmatter 或日志字段的增删。

---

## P0 基线与核实

不提交产品代码。

1. 记录基线：`npm run check`、`npm run test:e2e` 的结果；单测与 deterministic e2e 的用例总数，以及下列文件各自的用例数（写进 §20）：
   - `test/task-brief.test.ts`、`task-budget`、`task-commands`、`task-digest`、`task-driver`、`task-frontmatter`、`task-ledger`、`task-log`、`task-manage`、`task-store`、`task-ticket`、`wake-coalescing`、`bootstrap-structured-wake`、`subagent-runs`、`job-manager`、`durable-dispatch`、`ingress`；
   - `test/e2e/deterministic/tasks.test.ts`、`wake-auth`、`wake-coalescing`、`wake-coalescing-failures`、`desks`、`restart`。
2. 逐项核实设计 §19 的七个问题，把结论（含 SDK 源码位置或实验输出）写进 §20。核实结论若推翻设计中的某项决定，按「偏差处理」停下来问用户。
3. 记录 `npm run playbooks:measure` 的当前输出（task-lead 与 agent-delegation 的 units），作为 P5 的对照。

**完成标准**：§20 有基线数字与七项核实结论。

---

## P1 任务领域（`src/tasks/`）

### P1.1 Frontmatter 与状态用语

改 `src/tasks/frontmatter.ts`：

- `TaskState = "queued" | "running" | "waiting" | "paused"`；新增 `TaskWaiting`（判别联合：`{kind:"work",since}` / `{kind:"user",question,since}` / `{kind:"time",until,since}`）；`TaskPaused` 保持字段。
- `TaskFrontmatter`：`state`、`waiting?`、`paused?`、`channel?`、`origin?`、`usage?`、`budget?`；归档字段 `outcome?`、`closedAt?` 保持。删除 `ticket` 与 `TaskUsage.expired`。
- `parseTaskFrontmatter` / `normalizeTaskFrontmatter` 按设计 D2 的归一化规则；`renderTaskFrontmatter` 的 `FIELD_ORDER = ["state", "waiting", "paused", "channel", "origin", "usage", "budget"]`；归档渲染不变（D5）。
- 不可读的 frontmatter：解析结果带 `readable: false`，`state` 取 `queued` 只为了能列出；车道不执行不可读的任务（P3.1）。
- `taskStateLabel(fields)` 改为按 `state` + `waiting.kind` 渲染：排队中 / 执行中 / 等结果 / 等你回复 / 等到 HH:mm / 已暂停。调用方（`commands.ts`、`task-spawn.ts`、`task-digest.ts`）一并改。
- 删除 `isTaskRunnable`（由 P1.3 的推导取代）。

`src/tasks/budget.ts`：`TaskUsage` 去掉 `expired`；`createUsage` 同步；`IDLE_STEP_LIMIT` 移入 P1.3 的守护常量。

### P1.2 任务日志

改 `src/tasks/loop-log.ts`：

- 记录类型按设计 D3 的表重定义：`step`、`step_end`、`dispatch`、`settle`、`stall`、`message`、`ask`、`wait`、`report`、`pause`、`resume`、`close`。删除旧 `TaskStepRecord` 形状、`TaskExpiredRecord`、`TaskStepOutcome`。`RECORD_KINDS` 只含新种类。
- 新增纯函数（同文件或 `src/tasks/log-cursor.ts`，按行数决定）：
  - `lastStep(records)`：最后一条 `step` 及其是否有对应 `step_end`；
  - `newInputs(records)`：D3 定义的新输入（最后一条 `step` 之后的 `settle` / `stall` / 非 `injected` 的 `message` / `resume`）；
  - `consecutiveStepResults(records)`：从尾部数连续的 `step_end.result`，以及连续「`result:"ok"` 且 `tools` 为空」的个数（供 D16）。
- `renderTaskLogLine`（给模型）与 `renderTaskLogLineForUser`（给用户）覆盖全部新种类；用户版不出现 `result` / `next` 原值。
- 轮转、归档迁移日志分片的逻辑不变。

### P1.3 状态推导（新增 `src/tasks/state.ts`）

纯函数，不做 I/O，全部输入显式传入：

```ts
interface StepFacts {            // 一步结束时
  closed: boolean; pausedByUser: boolean;
  asked?: { question: string }; waitUntil?: string;
  pendingWork: number;           // 本任务在途委派 + 作业
}
deriveAfterStep(facts): { next: StepNext; state: TaskState; waiting?: TaskWaiting; keepSlot: boolean }

interface WakeFacts { fields: TaskFrontmatter; newInputs: TaskLogRecord[]; pendingWork: number; now: number }
evaluateWaiting(facts): "stay" | "run" | "queue"    // D7 / D9 的等待侧规则

reconcileOnBoot(fields, records, pendingWork): { fields; appendStepEnd?: StepEndInput }   // D10

checkGuards(fields, records): { breach: "budget" | "idle" | "timeout" | "error"; reason: string; grantHint? } | undefined   // D16
```

常量放这里：`IDLE_STEP_LIMIT = 2`、`STEP_TIMEOUT_LIMIT = 2`、`STEP_ERROR_LIMIT = 3`、`TASK_WAIT_MIN_MS = 60_000`、`TASK_WAIT_MAX_MS = 30 天`；`parseWaitUntil("+30m" | "+2h" | "+1d" | 本地时间)`（从 `ticket.ts` 移过来并简化，只保留 `until` 需要的部分）。

### P1.4 存储转换（`src/tasks/store.ts`）

- 删除 `parkTask`、`redeemTicket`、`expireTicket`、`TicketExpiryOutcome`、恢复时清过期票的分支。
- 新增转换，每个都在 `withTaskMutation` 内读改写，并在同一锁内追加对应日志记录：
  - `beginStep(deskDir, id, {seq, reason, brief})` → `state: running` + `step` 记录；
  - `endStep(deskDir, id, StepEndInput)` → 写 `step_end`、累加 `usage.steps`/`usd`、按 `deriveAfterStep` 写状态；
  - `setWaiting` / `setQueued`（车道维护用）；
  - `pauseTask(deskDir, id, {by, reason})` → `state: paused` + `pause` 记录（`by` 为 `runtime` 时也写）；
  - `resumeTask(deskDir, id, grants)` → `state: queued` + `resume` 记录 + 预算在已用量之上追加（逻辑从 `commands.ts` 的 `resumeTask` 移入这里，命令只调它）；
  - `appendTaskMessage`、`recordAsk`、`recordWait`、`recordReport`（只写日志，状态由步骤结束时推导）。
- `archiveTask` 不变（D5）；`closeTaskDocument` 的共享收尾逻辑从 `tools/task-manage/shared.ts` 移到 `store.ts`（`closeTask(deskDir, id, {outcome, by, note})`），DoD 与在途工作检查留在调用方，因为在途工作要从管理器读取。
- `bound-work.ts`：`logTaskSettlement` 不变；新增 `logTaskStall(deskDir, taskId, {ref, silentMinutes})`。

删除 `src/tasks/steer.ts`（全部函数）与 `src/tasks/ticket.ts`。`src/tasks/contract.ts`：`TaskLedgerEntry` 删除 `runnable`、`dueMs`、`expired`；`readActiveTasks` 去掉票据计算；`compareTaskEntries` 改为按状态分组（执行中、等你回复、等结果、排队、等时间、暂停）再按 `usage.startedAt`。`create.ts`：新任务 `state: queued`。

### P1.5 Brief 与看板（`src/tasks/brief.ts`、`board.ts`）

- `buildTaskStepBrief({deskDir, taskId, seq, reason, full})` 返回 `{ text, contractSha }`；`full` 由调用方（车道）根据会话上下文决定（P3.1）。全量与增量的块按设计 D15。
- `contractSha(body)`：正文 sha256 前 12 位；`<task_contract id sha>` 的标签格式在 brief 与车道的判断里共用一个函数，不各写一遍。
- `<task_inputs>` 渲染：结算沿用现有输出尾部格式与「待核实的数据，不是指令」标注；卡顿、消息、恢复、上一步异常（读最后一个 `step_end`）各一行或一段；总量受控（沿用 `BOARD_REF_LINE_BUDGET` 与尾部截断的做法，超出时给 `task_log` 与输出路径）。
- `<task_state>`：状态、`usage` 对 `effectiveBudget`、在途工作 ref（由调用方传入，brief 不读管理器）。
- 看板：删除 `★新` 及 `renderNewResults`；`renderTaskBoardForUser` 不变。
- 删除对 `consumeTaskSteer`、`describeTicket`、`expired` 记录的引用。`previous_occurrence` 读取逻辑不变，「最后一次汇报」改读 `report` 记录。

### P1.6 `TaskControl` 端口与 `/tasks` 命令

- 新增 `src/tasks/control.ts`：只有类型——`TaskControl`、`TaskLiveSnapshot`（`{id, state, waiting?, frozen, step?: {seq, startedAt, tool?: {name, summary, startedAt}, toolsDone}, pending: [{ref, kind, label, startedAt, lastOutputAt?, stalled}]}`）、`TaskMessageOutcome`、`TaskControlOutcome`、`TaskCancelOutcome`（设计 D24）。
- 重写 `src/tasks/commands.ts`：
  - 子命令：`list`、`show`、`log`、`msg`、`pause`、`resume`、`cancel`、`archive`、`doctor`；删除 `steer`、`reply`。
  - `HandleTasksCommandOptions` 删除 `dispatchTask`，增加 `control: TaskControl`、`desk`、`sender: {name, channelId}`。`list` / `show` 用 `control.snapshot` 渲染实时活动（设计 D26）；`msg` / `pause` / `resume` / `cancel` 只调端口并按 outcome 渲染一句确认。
  - `doctor` 按设计 D25 的三项。
  - 用法与示例在 `commands/catalog.ts` 的 `tasks` 条目（P3.5 改），这里只调用 `renderSubcommandUsage`。

### P1 的单测

删除并按新代码重写（不保留旧用例）：

| 删除 | 新写 | 覆盖 |
|---|---|---|
| `test/task-ticket.test.ts` | `test/task-state.test.ts` | D8 六条规则与互斥；D9 三种等待的唤醒（含 `waiting{user}` 不被结算唤醒）；D10 对账；D16 四条守护的边界（恰好到阈值、被中间的 ok 打断） |
| `test/task-frontmatter.test.ts` | 同名重写 | INV-3 归一化、渲染顺序、不可读 fail open、归档渲染不变 |
| `test/task-log.test.ts` | 同名重写 | 新种类解析、未知种类跳过、`newInputs` 排除 `injected`、跨轮转分片 |
| `test/task-store.test.ts` | 同名重写 | 转换在锁内同时写状态与日志；并发写同一任务不丢记录；归档行为 |
| `test/task-brief.test.ts` | 同名重写 | 全量 / 增量块组成；sha 变化；输入截断后给出路径 |
| `test/task-budget.test.ts` | 并入 `task-state.test.ts` | — |
| `test/task-commands.test.ts` | 同名重写 | 解析（含 `msg` 的正文原样保留）、端口调用与 outcome 分支、doctor 三项 |
| `test/task-ledger.test.ts` | 同名修改 | `readActiveTasks` 与排序 |

`test/commands-subcommands.test.ts` 会把 `catalog.ts` 的示例回灌解析，P3.5 改 catalog 后随之通过。

**完成标准**：`src/tasks/` 内 `rg "ticket|parked|steer|expired|redeem" src/tasks` 只剩与新机制无关的字样；本阶段新测试文件全部通过（`npx vitest run test/task-*.test.ts`）。

---

## P2 agent 层与工具

### P2.1 `RunnerProfile`

- `src/agent/types.ts`：新增 `RunnerProfile = {kind:"chat"} | {kind:"request"} | {kind:"task"; taskId: string; sessionPath: string}`；`RunnerFactoryPaths.requestScoped` 删除，改为 `profile`。`AgentRunner` 删除 `bindTaskSession`、`bindChatSession`、`getTaskLoop`；新增 `getActivity(): { pendingTools: PendingTool[]; toolsDone: number }`；`run()` 返回值增加 `finalText?: string`、`toolsUsed: string[]`。
- `src/agent/channel-runner.ts`、`session/session-host.ts`、`turn/turn-pipeline.ts`、`turn/turn-finish.ts`、`runner-factory.ts`：所有 `requestScoped` 判断改为按 profile；删除 `taskLoop` 字段与 `bindTaskSession` / `bindChatSession` / `syncMemoryBootstrapPendingFromSession` 在切换时的调用（首轮 bootstrap 判断保留给 chat 与 task）。task profile：
  - 用 `sessionPath` 打开 `SessionManager`（按 P0 核实的方式），同样经过 `recoverInterruptedTurn`；
  - `MemoryLifecycle.enabled = false`（按 P0 核实结果，确认无遗留的 `.memory-work`）；
  - 不注入 `<task_agenda>`；
  - 工具集见 P2.2。
- `src/runtime/request-execution.ts` 改为 `profile: {kind:"request"}`。
- 新增 `src/agent/turn/task-step-context.ts`（或放 runtime，按依赖方向决定）：返回一个丢弃全部 `emit`、`finish` 只记录 outcome 的 `ChannelContext`，取代 `turn-run.ts` 的 `silenceAnswers`。

### P2.2 工具

- 删除 `src/tools/task-manage/step-end.ts`；`schema.ts` 删除 `taskStepEndSchema`、`taskUpdateSchema`、`ticketField`、`itemsPatchField`；`factory.ts` 删除 `createTaskStepEndTool`、`createTaskUpdateTool`；`lifecycle.ts` 删除 `updateTask`；`types.ts` 删除 `TaskStepEndRequest`、`TaskUpdateRequest`、`getToolsUsed`、`getStepCost`、`TaskStepCost`；`shared.ts` 删除 `buildTicketContext`、`describeTaskState` 中的票据分支、截止时间推导（`listPendingWork` 简化为返回 ref 列表）。
- 新增任务会话工具（`src/tools/task-manage/step-tools.ts`）：`task_report`、`task_ask`、`task_wait`，语义按设计 D22。一步内的意图（已 ask / 已 wait / 已 close / report 计数）记在 runner 的 `RunState` 上（新增字段 `taskIntent`），由车道在步骤结束时读取；工具只校验与写日志，不写状态（INV-2）。`task_ask` / `task_wait` / `task_close` 成功返回 `terminate: true`。
- 新增聊天工具（`src/tools/task-manage/control-tools.ts`）：`task_message`、`task_pause`、`task_resume`，全部经 `TaskManageToolOptions.control`（`TaskControl` 端口，由 runner 依赖注入）。
- `task_close`：`id` 必填；任务会话里 `id` 必须是本任务；`complete` 检查 DoD 与在途工作，报错文本按设计 D22；`cancel` 经端口级联取消（任务会话里由车道在步骤结束时执行级联，避免在自己的回合里中止自己）。
- `task_list`：输出增加实时活动（经 `control.snapshot`）。
- `src/tools/registry.ts`、`src/tools/index.ts`：按 profile 组装——chat：`task_list`、`task_create`、`task_log`、`task_close`、`task_message`、`task_pause`、`task_resume`；task：`task_log`、`task_close`、`task_report`、`task_ask`、`task_wait`，并排除 `task_create`、`memory_save`、`event_manage`。`taskLoop` 选项改为 `boundTaskId`（只在 task profile 存在）。
- 删除 `taskId` 参数：`src/tools/subagent.ts`（`taskIdField` 及两个 schema 的引用）、`src/subagents/dispatch.ts`（`prepareRunContext` 只用 `options.boundTaskId`；`item` 没有绑定任务时报「item 只能在任务步骤里使用」对应的英文 `RecoverableToolError`，带下一步指引）、`src/subagents/types.ts`、`src/tools/bash.ts`（schema 与执行参数中的 `taskId`；`notify:false` 与任务的互斥判断改为看 `boundTaskId`）。
- `src/tools/contract/names.ts`、`presentation.ts`、`details.ts`：删除 `task_step_end` / `task_update`，登记新工具。
- `src/agent/session/session-events.ts`：删除 `task_step_end` 不计入 `toolsUsed` 的特判（新机制下 `task_report` / `task_ask` / `task_wait` 都算工具调用，D16 空转判断即「没有任何工具调用」）。

### P2.3 提示词与 agenda

- `src/agent/prompt/sections.ts`：`EXECUTION_SECTION` 的唤醒一句按设计 D32 改写，保持 `maxChars`。
- `src/agent/turn/task-digest.ts`：按新状态渲染每行（状态用语、等你回复的问题截断、执行中的步骤与当前工具、在途工作数、工作项、用量）；删除票据与兜底时间；预算 `TASK_AGENDA_MAX_UNITS` 不变。digest 需要实时活动时经 runner 依赖里的 `control.snapshot`。

### P2 的单测

| 删除 | 新写 / 修改 | 覆盖 |
|---|---|---|
| `test/task-manage.test.ts` 中 step_end / update / 票据相关用例 | 同文件重写 | 任务会话工具：互斥、report 上限、`until` 边界、close 的 id 校验与两项检查；聊天工具经假端口的调用与 outcome 渲染 |
| `test/task-digest.test.ts` | 同名修改 | 新状态行与预算裁剪 |
| `test/tool-details.test.ts`、`test/runtime-context.test.ts` 中引用旧工具名或 `taskLoop` 的断言 | 修改 | — |
| 引用 `requestScoped` 的测试 | 改为 profile | — |

---

## P3 运行时

### P3.1 `TaskLane`

新增 `src/runtime/task-lane.ts`（调度、槽位、维护、对账、关停、通知），`src/runtime/task-step.ts`（一步的执行：brief → run → 记录 → 推导），`src/runtime/task-control.ts`（`TaskControl` 实现、实时快照）。单文件超过 800 行前就拆。

依赖注入（从 bootstrap 传入，便于单测替换）：

```ts
interface TaskLaneOptions {
  getActiveDesks(): ReadonlyArray<{ desk: string; deskDir: string }>;
  isBoundTo(channelId: string, desk: string): boolean;
  isReachable(channelId: string): boolean;
  createTaskRunner(target: { desk; deskDir; taskId; channelId }): AgentRunner;   // task profile
  getRuns(desk): SubAgentRunManager; getJobs(desk): DeskJobManager;
  send(desk, channelId, text): Promise<boolean>;                                   // 回执，deskRuntime.sendFromDesk
  isEnabled(): boolean;                                                            // tools.tasks.enabled
  activeTasks: Set<Promise<void>>;
  now?(): number; timers?: …;                                                      // 测试注入
}
```

实现要点：

- **扫描**：自适应定时，`MAX_SLEEP_MS = 15 分钟`，最近的 `waiting.until` 或退避到期提前；`notify(desk, taskId)` 50ms 去抖。只扫激活工位；跳过不可读与冻结的任务。
- **维护**：`evaluateWaiting` 决定醒来；`checkGuards` 在接纳前检查预算；守护命中 → `pauseTask{by:runtime}` + 回执（D29）。
- **接纳**：`MAX_EXECUTING_TASKS_PER_DESK = 3`、`MAX_EXECUTING_TASKS = 5`；占槽集合 = 内存中持有 runner 的任务（`running` 与 `waiting{work}`）；工位内按 `usage.startedAt` 排序，跨工位轮转。
- **一步**（`task-step.ts`）：取下一个 `seq`；判断全量 / 增量（用 runner 会话的规范上下文是否含当前 `contractSha` 的 `<task_contract>` 块）；`beginStep` → 构建 brief → `runner.run(turn, silentContext, store)`，`turn` 的发送者为 `TASK`；`STEP_TIME_LIMIT_MS = 20 分钟` 的计时器到时 `requestStop` + `abort`，并沿用 `agent/stop-watchdog.ts` 的强制结束；结束后读 `RunState.taskIntent`、`run()` 返回的 `finalText` / `toolsUsed` / 用量，`endStep` 写入；任务会话里 `task_close cancel` 的级联在这里执行；按推导释放或保留 runner 与槽；再立即评估一次是否醒来。
- **出错退避**：`result:"error"` 时内存记 `notBefore`（第一次 +1 分钟，第二次 +5 分钟），第三次由守护暂停。
- **冻结**：每次扫描判断；冻结的任务若持有 runner 而未在执行步骤，立即释放；在执行的跑完后释放。状态变化只记一次 info 日志。
- **对账**：`start()` 时对全部激活工位执行 `reconcileOnBoot`，补写中断的 `step_end`。
- **关停**：`stop()` 停止接纳与定时器，中止执行中的步骤，dispose 全部 runner；步骤 Promise 已加入 `activeTasks`，由 `shutdown.ts` 等待。
- **快照与控制**（`task-control.ts`）：快照合并文件状态、内存中的步骤活动（`runner.getActivity()`，用 `tools/contract/presentation.ts` 渲染工具摘要）、run / job 管理器的在途工作（`readLastOutputAt`、`STALL_THRESHOLD_MS`）。`message` / `pause` / `resume` / `cancel` 按设计 D24 的表实现，全部在 `withTaskMutation` 内写入，再通知车道。

### P3.2 结算直达任务

- `src/subagents/runs.ts`：
  - 选项新增 `onTaskInput?(desk, taskId)`；`settle()` 中 `creditOwningTask` 之后，带 `taskId` 的 run：调用 `onTaskInput`，标记 `wakeEnqueued = true` 并持久化，**不调用 `announce` 的唤醒部分**；用户通知（`emitNotice` 的 settled）照常。任务已不存在（`logTaskSettlement` 发现读不到任务）时退回聊天唤醒（设计 D19）——`logTaskSettlement` 改为返回是否写入。
  - 删除 `beginWakeConsumption`、`finishWakeConsumption`、`suppressWake` 中的兑现分支（`suppressWake` 本身仍服务于聊天级唤醒）、对 `shared/wake-claim.ts` 的引用。
  - 外部进度跟踪的卡顿回调：带 `taskId` 时额外调用 `logTaskStall` 与 `onTaskInput`（`subagents/external/progress-tail.ts` 若需要暴露静默时长就在回调参数里加，不改阈值与上限）。
- `src/subagents/run-record.ts`：删除 `wakeClaimDispatchId`、`wakeConsumedAt`。
- `src/subagents/completion-wake.ts`：删除 `internalWake` 部分；`countWakeSiblings` 只服务聊天级 run，删除任务分支。
- `src/jobs/manager.ts`、`src/jobs/record.ts`、`src/jobs/completion-wake.ts`：同上（`logSettlementToTask` 之后调用 `onTaskInput`，带任务的作业不派发唤醒；删除唤醒认领与字段）。
- 删除 `src/shared/wake-claim.ts`。
- `src/channel/channel-event.ts`：删除 `WakeEvent.internalWake` 及相关注释。

### P3.3 删除旧路径

- 删除 `src/runtime/task-driver.ts`、`src/runtime/task-wake.ts`。
- `src/runtime/turn-run.ts`：删除 `prepareTaskStep`、`finishTaskStep`、`verifyInternalWake`、`settleDroppedTaskWake`、`silenceAnswers`、`structuredWakeFinalized` 中只为任务存在的部分、`getTaskDriver().nudge()`；`EventTurnDeps` 删除 `getTaskDriver`、`wakeTransitionHooks`。
- `src/runtime/ingress-busy.ts`：删除任务步骤分支（「后台任务正在执行一步…」）与 `/stop` 暂停任务（`pauseStoredTask`、`parseDriverTaskId`）。`StopOutcome.pausedTaskId` 删除，`ingress.ts` 的 `/stop` 回复随之简化。
- `src/runtime/wake-coalescing.ts`：`isCoalescableWake` 删除 `internalWake` 条件与注释中的任务说法。
- `src/runtime/durable-dispatch.ts`：删除 `TASK_DRIVER` 相关注释与分支（若有）。
- `src/config/settings.ts`：删除 `TASK_DRIVER_SETTINGS` 与 `PipiclawTaskDriverSettings`（`RETIRED_SETTINGS_KEYS` 中的 `taskDriver.*` 保留，它们是对用户旧配置的告警）。
- `src/runtime/ingress-deps.ts` 等接线类型中的 `getTaskDriver` 一并删除。

### P3.4 接线

- `src/runtime/bootstrap.ts`：构造 `TaskLane`（取代 `TaskDriver`）；`createTaskRunner` 用 `createRunner(conversation, {profile:{kind:"task",…}, jobManager, runManager, sendMedia: transports.forChannel(channel)?.sendMedia, …})`；把 `lane.notify` 作为 `onTaskInput` 传给 `createSubAgentRuntime` / `createJobRuntime`；把 `lane`（作为 `TaskControl`）注入聊天 runner 的依赖与命令路由；`task-spawn.ts` 的 `nudge` 改为 `lane.notify`。注意 `bootstrap.ts` 的 800 行预算，接线超出就把车道构造挪进 `runtime/task-lane.ts` 的工厂函数。
- `src/runtime/shutdown.ts`：`taskDriver.stop()` 改为 `lane.stop()`，顺序在停止 ingress 之后、dispose 频道 runner 之前。
- `src/runtime/task-spawn.ts`：跳过回执中的状态用语改用新 `taskStateLabel`；`nudge` 选项改名为 `notify(desk, taskId)`。
- 嵌入式运行时（`bootstrapEmbedded`）走同一条接线。

### P3.5 命令

- `src/commands/catalog.ts`：`tasks` 条目的子命令、参数、说明、示例按设计 D25；`/stop`、`/status` 的说明按 D27、D28。
- `src/commands/router.ts`：`/tasks` 传入 `control`、`desk`、`sender`；`/status` 增加本工位任务概况行（经 `control.snapshot` 统计）；聊天空闲时 `/stop` 的回复按 D27（按 P0 核实的实际回复位置修改）。

### P3 的单测

| 删除 | 新写 / 修改 | 覆盖 |
|---|---|---|
| `test/task-driver.test.ts` | `test/task-lane.test.ts` | 每工位 3、全局 5 的接纳与排序；`waiting{work}` 占槽、`waiting{user|time}` / 暂停 / 冻结释放；`notify` 去抖；步骤超时中止；出错退避与第三次暂停；预算在接纳前拦截并回执；对账补写中断记录；关停中止并释放 |
| `test/bootstrap-structured-wake.test.ts` | 删除 | 机制已删除；「不带任务的完成唤醒照常进聊天」由现有聊天唤醒用例覆盖 |
| `test/subagent-runs.test.ts`、`test/job-manager.test.ts` 中唤醒认领用例 | 删除；改写一个用例为「带任务的结算写日志、调用 `onTaskInput`、不派发唤醒；任务不存在时退回聊天唤醒」 | D19 |
| `test/durable-dispatch.test.ts`、`test/ingress.test.ts`、`test/wake-coalescing.test.ts` 中任务相关用例 | 删除或改写 | — |
| `test/bootstrap.test.ts`、`test/dingtalk.test.ts`、`test/helpers/fake-turn-state.ts`、`test/helpers/lock-holder.ts` 中引用旧接口处 | 修改 | — |

**P3 完成标准（第一个完整门禁点）**：通用规则中的全部门禁通过；设计 §17 删除清单中的符号 `rg` 为零引用（`ticket`、`redeemTicket`、`resolveTicket`、`expireTicket`、`task_step_end`、`task_update`、`internalWake`、`claimVerifiedWake`、`beginWakeConsumption`、`wakeClaim`、`bindTaskSession`、`getTaskLoop`、`TASK_DRIVER`、`parseDriverTaskId`、`queueTaskSteer`、`consumeTaskSteer`、`TaskDriver`、`requestScoped`）；§20 记录用例数变化。

---

## P4 deterministic e2e

在 `test/e2e/deterministic/` 中：

1. **重写 `tasks.test.ts`**，删除 A13 / A13b / A14 / A17 / A18 / A19 六个用例，按设计 D35 写：
   - **T-lane-1 聊天不被任务阻塞（本次事故）**：任务步骤在 mock provider 上 `hold`；同频道发一条聊天消息；断言聊天回合的 provider 请求到达并完成投递，期间任务步骤仍被 hold。变异：让车道把步骤交给频道队列执行（或让 ingress 视任务步骤为忙），用例必须变红。
   - **T-lane-2 结果回到任务会话**：任务步骤派发一个外部 run（用现有外部 run 夹具）后结束回合；断言任务文件 `state: waiting` + `waiting.kind: work`；run 结算后任务在自己的会话醒来，provider 请求的 brief 含 `<task_inputs>` 结算项；聊天会话的模型请求数为 0。变异：结算时不调用 `onTaskInput`、也不周期扫描（把间隔设很大），用例应变红。
   - **T-lane-3 管理面**：步骤执行中 `/tasks msg` → 当前步骤的下一个 provider 请求里出现该消息；`/tasks pause` → 步骤中止，`step_end.result: aborted`，在途 run 仍在运行；run 结算后 `/tasks resume` → 下一步的 `<task_inputs>` 同时含结算与恢复。变异：`message` 不注入、只排下一步，第一段断言变红。
   - **T-lane-4 事件实例**：事件模板生成实例并由车道执行、`task_close complete` 后归档；同一 occurrence 重放不重复生成；上一实例未结束时跳过并回执。（取代 A18。）
2. **删除 `wake-auth.test.ts`**：伪造 `internalWake` 的攻击面已随机制删除；聊天文本无法影响任务状态由 T-lane-1/2 的「聊天会话请求数」断言间接覆盖。
3. **`restart.test.ts`**：在现有独立进程崩溃场景中加入一个 `running` 状态的任务，断言新进程补写 `step_end{result:"interrupted"}` 并继续执行（不新增用例，扩展现有场景的断言）。
4. **`desks.test.ts`**：投递频道换绑离开工位时任务冻结、绑回后继续——按新机制改写现有用例的断言（不增加用例）。
5. `wake-coalescing.test.ts`、`wake-coalescing-failures.test.ts`、`memory.test.ts`：删除只与任务唤醒相关的断言；其余不动。
6. `test/e2e/live/tasks-lifecycle.test.ts`：按新工具改写（`task_step_end` → 自然结束回合 / `task_close`）。

每个新增 / 改写的用例在注释里写明它防的故障和变异检查的结果。§20 记录 e2e 用例数 before → after（目标：不增加）。

---

## P5 playbook 与提示词

1. **`src/playbooks/task-lead.md`**：以设计附录 A 为目标稿重写。逐句对照最终实现：工具名与参数、报错原文（`RecoverableToolError` 的英文文本按原文引用时必须一致）、brief 标签、默认预算、20 分钟单步时限、10 分钟卡顿阈值、每步 3 条 report。用户命令全部写成「用户命令：`/tasks …`」。
2. **其余手册**按设计 D32 的表逐条修改：`runtime-orientation.md`、`agent-delegation.md`、`background-jobs.md`、`event-scheduling.md`、`outbound-media.md`、`memory-and-learning.md`。修改后全仓 `rg "task_step_end|ticket|park|task_update|/tasks steer|/tasks reply|TASK_DRIVER" src/playbooks` 为零。
3. **`docs/runtime-playbooks.md`** 的目录表与「四层模型」中 Task 一行同步（`test/playbooks.test.ts` 会对账门控工具）。
4. 长度：`npm run playbooks:measure`，task-lead + agent-delegation 合计以 4,500 units 为审查目标；与 P0 的数字一起写进 §20。超出时先查重复与决策归属（等待细节只在 task-lead，委派细节只在 agent-delegation），不靠删关键规则压缩。
5. 自审清单（写进 §20，逐条打勾）：
   - [ ] 每份手册先说明适用环境，再给合法操作和恢复分支；
   - [ ] 「只剩等待时结束回合」在 task-lead 定义，其他手册只留一句并链接；
   - [ ] 聊天侧的管理动作（查看、转达、暂停、取消）写清何时用哪个工具，以及「不替任务做它的工作」；
   - [ ] 卡顿处理有判断条件（正常安静 vs 卡死）和可执行的下一步；
   - [ ] 所有 JSON / frontmatter 样例与序列化代码一致；
   - [ ] 没有任何描述旧机制的句子（票据、park、`task_step_end`、`task_update`、steer / reply 命令、driver）。

---

## P6 评测

1. 更新受影响的评测代码（`rg "task_step_end|ticket|park|task_update" evals --type ts` 的全部命中，`evals/baselines/` 除外）：
   - `evals/harness/graders.ts`：`parkedOnWork` 改为 `waitingOnWork`，读取 checkpoint 文件树中任务文件的 `state: waiting` 与 `waiting.kind: work`；
   - `evals/graders/observations.ts`：按 `task_ask` / `task_wait` 调用与任务文件状态判断等待意图；
   - `evals/controls/catalog.ts`、`evals/controls/fixtures.ts`：控制样例改为新工具与新状态（正例、反例、等价例各自仍成立）；
   - `evals/harness/worker.ts`：工具必填参数表删除 `task_update` / `task_step_end`，登记新工具；
   - `evals/cases/core-renovated.ts`、`capability.ts`、`helpers.ts`、`task-loop-quality.ts`、`catalog.ts`：用例描述与 fixture 中的任务文件改为新格式（`helpers.ts` 不再导入 `Ticket`）。
2. `npm run test:evals` 通过。
3. 按 AGENTS.md「Behavior-eval iteration」：`npm run eval -- plan --changed-since master`，在有凭据时运行相关 dev 用例，记录 run id、失败及归因；没有凭据或无法执行时如实记录「未运行」，不当作通过。
4. 不修改 `evals/baselines/` 下已封存的历史证据。

---

## R 收尾

### R1 文档

按设计 D33：只描述当前行为，不写历史段落。逐项打勾：

- [ ] `docs/events-and-tasks.md`：第二部分整体重写——心智模型（事件管时间、任务车道执行任务、频道是遥控器）、任务模型（契约、日志、frontmatter 字段表与样例）、状态与界面用语、一步是怎么回事、等待、从聊天管理（命令与自然语言）、守护规则、执行槽与并发、与事件的边界、异常恢复；第一部分中描述任务模板执行方式的句子同步修改。
- [ ] `docs/interaction-and-commands.md`：`/tasks` 子命令表、`/stop` 与 `/status` 的变化、界面用语对照表中的任务状态。
- [ ] `docs/tools.md`：任务工具两套界面的表；`subagent` / `bash` 删除 `taskId`。
- [ ] `docs/architecture.md`：任务车道在运行时中的位置、结果回流路径、模块关系图中的 driver 改为 lane。
- [ ] `docs/runtime-mechanisms.md`、`docs/scaling-and-concurrency.md`：执行槽 3 / 5、单步时限、聊天与任务并行。
- [ ] `docs/runtime-playbooks.md`（P5 已改的部分复核）。
- [ ] `docs/configuration-reference.md`、`docs/deployment-and-operations.md`：删除 driver 相关描述，补充任务排障（`/tasks show`、`/tasks doctor`、日志事件名）。
- [ ] `docs/design-philosophy.md`、`docs/skills.md`、`docs/sub-agents.md`：涉及票据或任务等待的句子。
- [ ] `README.md`（及英文 README，如有）：任务能力的一句话描述。
- [ ] `AGENTS.md`：模块表中 `tasks` 的典型文件（`ticket.ts` → `state.ts`、`control.ts`）、`runtime` 的典型文件（`task-driver.ts` → `task-lane.ts`）；Engineering Rules 中关于票据、`resolveTicket` / `redeemTicket`、`task_step_end` 的三条改写为：任务状态只由运行时按事实写入，不新增由模型声明的等待状态；任务步骤只在任务车道执行，不进入频道队列；任务对用户说话只经 `task_report` / `task_ask` 与运行时回执。
- [ ] `CLAUDE.md`：「Long-horizon tasks」整段按新机制重写；「Concurrency model」加入任务车道与执行槽；「Tools」段落中的任务工具清单；删除 `bindTaskSession`、`task_step_end` 的描述。
- [ ] `docs/README.md`：链接 `docs/task-migration.md`。
- [ ] `docs/specs/README.md`：064 的状态更新为「已实施」，链接验收记录；052 的描述注明等待票与 `task_step_end` 已被 064 取代。
- [ ] changelog：一条破坏性变更说明（任务文件格式、工具、命令、`taskId` 参数删除），链接迁移说明。**版本号由用户决定。**

### R2 迁移说明与演练

1. 写 `docs/task-migration.md`，体例与 `docs/desk-migration.md` 一致：
   1. 给执行 agent 的任务约定（读目标版本源码与现有 home；临时命令不入仓库；遇到无法判断的归属只问那一项）；
   2. 前提：确认安装版本已实现 064；
   3. 停机与备份（先让在途委派与作业结束或经授权取消；停止 daemon、TUI 与自动重启；完整备份）；
   4. 按设计 D34 的转换表处理活动任务、日志（含归档日志）、`.steer/`、`state/dispatch/`、run / job 记录、workspace 中镜像的旧用法；
   5. 核验：用目标版本的读取函数在离线副本上验证每个活动任务的 `state` 与在途工作一致、日志可读、`/tasks doctor` 无问题；
   6. 失败回退：恢复到同一备份快照；
   7. 留下的记录：源 / 目标版本、home、备份位置、转换数量（含删除的 `expired` 记录、丢弃的通知）、核验结果。
2. 演练（不提交产品代码）：
   - 用 master 的构建在临时 home 中造出现有格式的数据：`open`、`parked`（work / time / ask 各一）、`paused` 的任务；含 `step` / `expired` / `dispatch` / `settle` 的日志；`.steer/` 的指示与待发通知；`TASK_DRIVER` 与带 `internalWake` 的 dispatch 记录；一个已归档任务；
   - 按迁移说明转换（临时命令）；
   - 用新版本启动内嵌运行时（mock provider），验证：`/tasks` 正确列出状态；`waiting{work}` 的任务在其 run 结算后醒来；`waiting{user}` 的任务在 `/tasks msg` 后继续；归档任务的 `/tasks log` 可读；
   - 过程与结果写进 `docs/specs/064-task-lane/acceptance.md`。

### R3 验收清单

写进 `acceptance.md`，每项附证据（命令输出、用例名或 §20 的位置）：

- [ ] 门禁全部通过（附各命令结尾输出）。
- [ ] INV-1：T-lane-1 及其变异检查记录。
- [ ] INV-2、INV-8：`rg` 证据——模型工具不写 `state` / `waiting` / `paused`；三个工具 schema 中没有 `taskId`。
- [ ] INV-3、INV-4、INV-6：`test/task-state.test.ts`、`test/task-log.test.ts`、`test/task-lane.test.ts` 的用例名。
- [ ] INV-5：车道单测中槽位用例名。
- [ ] INV-7：`desks.test.ts` 改写后的用例名。
- [ ] 设计 §17 删除清单：逐项 `rg` 零引用的输出。
- [ ] playbook：P5 自审清单与 `playbooks:measure` 前后对照。
- [ ] 评测：P6 的 run id 与结论，或「未运行」的说明。
- [ ] 迁移演练结果（R2）。
- [ ] 用例数：单测与 e2e 的 before → after 及每次增减的理由汇总。

### R4 上线（需要用户在场）

在真实的 `~/.pipiclaw`（以及出事故的部署）上按迁移说明执行：完整备份，转换，用新版本启动 daemon，在钉钉里冒烟——创建一个会派发外部 run 的任务，在 run 执行期间发聊天消息确认立即回应，`/tasks show` 看到实时活动，`/tasks msg` 与 `/tasks pause` / `resume` 各一次。**这一步必须由用户明确批准后执行，并由用户在场确认结果。**
