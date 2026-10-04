# Tasks 机制探查与「Leader 化」迭代方向

日期：2026-10-04 · 基线：master `ea3dc16`（Task v4 / spec 051 已上线约一个月）

## 0. 结论

1. **作用域**：task 是**频道级**机制。数据（`workspace/<channelId>/tasks/`）、工具、`/tasks`、`<task_agenda>`、票据校验都绑定单个频道；只有 TaskDriver 是一个进程级扫描器，按频道轮询。events 则是**定义存于 workspace 级目录、投递目标是单个频道**。
2. **tasks 没有吸收 events，两者仍然并行**。tasks 只吸收了 events 里"为任务服务"的那部分（任务续跑、`.schedule` 任务事件），spec 051 D8 明确保留 events。两者之间还剩一条 `signal` 票的耦合边，外加两套各自实现的 cron 调度。
3. **现状评估**：v4 修掉了生产里真实发生过的故障（"停泊即失踪"），票据 + 兜底时限这条不变量值得保留。但它的定位是**"pipiclaw 自己带着契约一步步干活的自驱循环"**，不是"leader 管理一个委派项目"：Plan 和委派 run 之间没有关联，验收做成了平台级的防自证体系，周期性和 events 重叠。概念面偏重（6 种票、cycle/step/round 三种时间尺度、5 维预算、6 个正文段、4+3 种结束方式）。
4. **方向**：先**做减法**（去掉周期性、去掉验收门禁、去掉 v3 迁移残留、合并正文段），再**只加一样东西**：工作项与委派 run 之间的关联。预计任务侧代码约 5.4k 行可以降到 3.3k 行左右（粗估），工具参数大约减半。

---

## 1. Task 的定义

### 1.1 载体

| 物件 | 路径 | 作用 |
|---|---|---|
| 契约 | `workspace/<ch>/tasks/<id>.md` | frontmatter + 正文段；每一步都会全量注入（4 KB 目标） |
| 循环日志 | `tasks/<id>.jsonl` | append-only，记录 step / round / expired / close |
| 任务会话 | `tasks/.sessions/<id>-<cycle>.jsonl` | 每个 cycle 一份，与频道聊天会话隔离 |
| 附属 | `.steer/`、`.verifications/`、`.v3/`、`archive/` | 用户指示与通知、验收 attestation、迁移备份、归档 |

### 1.2 Frontmatter 字段（`src/tasks/frontmatter.ts:46`）

| 字段 | 类型 | 含义 |
|---|---|---|
| `state` | `open` / `parked` / `done` | 不变量：`parked` ⟺ 存在 `ticket` |
| `paused` | `{by: user\|runtime, reason, at}` | 出现即暂停，与 state 正交 |
| `schedule` | cron | 有它就是周期任务，最小间隔 30 分钟 |
| `ticket` | 6 种 kind + 运行时盖章的 `by` | 等待票，由 `ticket.ts:114 resolveTicket` 唯一生成 |
| `cycle` | `{id, startedAt, steps, rounds, usd, usdEstimated, expired}` | 本周期计数 |
| `budget` | `{steps, wallMin, usd, rounds, until}` | 默认值 40 / 180 / 8 / 4（`budget.ts:13`） |
| `verify` | `required` | 关闭前必须有一条有效的 PASS attestation |
| `outcome` / `closedAt` | 只在归档文件中出现 | |

票据 kind（`ticket.ts:23`）共 6 种：`time` / `schedule` / `run` / `job` / `ask` / `signal`。

### 1.3 正文段

`# 标题` → `## Goal` → `## DoD`（必须是 checklist）→ `## Manual` → `## Verification` → `## Plan`（P1..Pn，四种状态）→ `## 上次结果`（由运行时覆盖写入）。
验收 PASS 绑定 Goal 到 Verification 这一段的 hash（`ledger.ts:113`），不绑定 Plan 和上次结果。

### 1.4 工具参数（`src/tools/task-manage/schema.ts`）

| 工具 | 参数 |
|---|---|
| `task_create` | id, title, goal, dod, plan, manual, verificationPlan, verificationRequired, schedule, budget（10 个） |
| `task_update` | id, planSteps, schedule, budget, verificationRequired |
| `task_close` | id, outcome(complete/skip/cancel), summary, evidence, residualRisk, reason |
| `task_step_end` | outcome(continue/park/done/blocked), note, planSteps, ticket, notify, summary, evidence, residualRisk, reason（9 个） |
| `task_list` / `task_log` | — / id, cycle, limit |

另外，`subagent` / `subagent_inline` 有 `purpose: work|verify` 和 `taskId` 两个参数，job 有 `taskId`。

---

## 2. 作用域：频道级还是 workspace 级

| 维度 | tasks | events |
|---|---|---|
| 存储 | `workspace/<channelId>/tasks/`，**频道级** | `workspace/events/*.json`，**workspace 级**共享目录（全局上限 50 个） |
| 归属 | 由目录隐式确定 | 每个文件显式写 `channelId` |
| 管理工具 | 绑定 `channelDir`（`task-manage/shared.ts:19`） | `event_manage` 按 channel 过滤并校验归属 |
| 调度器 | `TaskDriver`：进程单例，扫描所有频道，频道间 round-robin | `EventsWatcher`：进程单例，监听一个目录 |
| 执行 | 频道队列中的普通条目，运行在任务会话里 | 频道队列中的普通条目，运行在聊天会话里 |
| 跨频道 | 不支持（票据要求 run/event 与任务属于同一频道） | 不支持（只投递到一个频道） |

结论：**task 是频道级的数据和语义，由一个运行时级的调度器驱动。**对 leader 场景来说这是合适的，因为一个频道对应一个"老板"，没必要升级到 workspace 级。

---

## 3. tasks 与 events：并行，没有吸收

演进脉络：早期任务的续跑和周期都靠 events 驱动 → spec 022 起 tasks 有了原生 driver → spec 027 起周期性也原生化，退役 `.schedule` 任务事件 → spec 051 D8 **明确保留 events 子系统**，只新增一条 `signal` 票作为两者唯一的交叉点。

现在的重叠和耦合：

| 点 | 位置 | 说明 |
|---|---|---|
| 两套 cron 调度 | `tasks/task-schedule.ts`（TaskDriver）与 `events/events.ts`（EventsWatcher） | 用的都是 croner，30 分钟下限也写了两份（`task-schedule.ts:11`、`event-validation.ts:23`） |
| 时间唤醒重叠 | task 的 `time` 票 ≈ one-shot event；task 的 `schedule` ≈ periodic event | |
| `signal` 票 | `events.ts:778` 调用 `redeemTicket`；`ticket.ts` 的 signal 分支 | events 反向 import 了 `tasks/frontmatter`、`tasks/store`、`tasks/task-events` |
| 孤儿清理 | `events.ts:671 orphanedOwnerReason` | events 要读任务文件，判断 `task.<ch>.<id>.*` 事件是否该退役 |

spec 051 自己在 F6 中已经承认"一整个事件子系统在为一条 cron 服务"，当时选择推迟处理。

---

## 4. 现状评估

### 4.1 体量

| 部分 | 行数 |
|---|---|
| `src/tasks/*` | 3,023 |
| 任务工具、`runtime/task-*`、task-digest | 2,418 |
| 其中验收专用（verification、artifact-subject、rounds、verification-outcome） | 933 |
| 散落在 bootstrap / runs / subagents/tool / settlement / channel-runner 的胶水 | 约 400（估） |
| 任务测试 | 2,206 |
| 对照：events 子系统 | 1,658 |

### 4.2 做对了、要保留的

- **票据不变量**：停泊必须有一个可兑现的来源，并带运行时盖章的兜底时限；同一周期第二次过期就暂停并发出零 LLM 的确定性回执。这一条来自真实故障（停泊后静默了 9 天和 13 天），是整个机制里最有价值的部分。
- **任务会话与聊天会话隔离**：任务不会把聊天上下文撑大。对 leader 来说更重要，因为调度噪音不该污染和用户的对话。
- **append-only 循环日志**、幂等的 `redeemTicket`，以及 `SubAgentRunManager` 结算时把成本记到任务名下。
- **预算耗尽时确定性停止并回执**（不是去猜"有没有干活"）。

### 4.3 问题（按对目标场景的影响排序）

1. **模型是"自己干"，不是"带团队干"。**`## Plan` 里的步骤只有 id/status/text，和委派 run 没有任何关联；run 只通过 `taskId` 挂在任务上。leader 看不到"W2 派给了谁、run 是哪个、结果怎样、是否已验收"。一张 `run` 票只能指向一个 run，并行派 N 个时，模型要自己挑"真正阻塞的那个"（playbook 专门写了一段来解释）。
2. **验收做成了平台级的防自证体系。**attestation 绑定契约 hash 和产物 subject hash（base-relative git 快照、untracked 基线、transient 目录白名单），区分 enforced / advisory 两种证明强度，关闭时还要重新核验最后一条 round。这部分 933 行加上 runs/tool/settlement 中的胶水，是任务侧最重的一块，防的是"模型自己骗自己"。在个人助手的场景里，"检查结果"本来就该是 leader 的判断，不是运行时的门禁。
3. **周期性和 events 重复。**`schedule` 拖进来了 cycle 重开、Plan 复位、`## 上次结果`、`schedule` 票、`/tasks run`，以及 `nextCycleId` 等一整串机制。而"每周做一次 X"本质上是 *periodic event + skill*（可复用流程本来就该沉淀成 skill）。
4. **概念面偏重。**同样的意思有多个出口：`note` / `notify` / `summary` / `evidence` / `residualRisk` / `reason` 六个文本字段，`task_step_end done` 和 `task_close complete` 两个完成入口，`Manual`、`Verification` 和 `DoD` 三段内容相互重叠。`task-loop.md` 写了 90 行高密度规则来教模型怎么用。
5. **v3 迁移残留。**`runtime/task-migration.ts`（290 行）、frontmatter 中的 `legacy` 判定、driver 的 repair-only 分支，以及 doctor 的大部分检查。迁移已经上线一个月，可以退役。

---

## 5. 面向 leader 场景的字段取舍

目标形态：**一个 task 就是 leader 负责的一个一次性委派项目**。拆工作项 → 为每项富化上下文并派发 → 等结果 → 对照 DoD 检查（必要时派一个 reviewer）→ 返工或标记完成 → 汇报最终成果。

### Frontmatter

| 字段 | 处置 | 理由 |
|---|---|---|
| `state` | **保留** | open/parked/done 够用 |
| `paused` | **保留** | 用户的控制入口，也是运行时停止的落点 |
| `ticket` | **保留并收敛**为 `time` / `runs` / `job` / `ask` | 去掉 `schedule`（随周期性一起删）和 `signal`（与 events 解耦）；见 §6 P4 的 `runs` |
| `cycle` | **改为 `usage: {steps, usd, usdEstimated, expired}`** | 一次性任务里 cycle 就是任务本身，不再需要 id、startedAt、rounds |
| `budget` | **收敛为 `{usd, steps}`** | `rounds` 随验收门禁一起删；`wallMin` 包含停泊等待，难以理解，而活性已经由票据兜底保证；`until` 很少用到 |
| `schedule` | **删除** | 周期性交给 periodic event + skill |
| `verify` | **删除** | 验收改为 leader 的判断，见 §6 P2 |
| `outcome` / `closedAt` | 保留 | 归档用 |

### 正文段

| 段 | 处置 |
|---|---|
| Goal | **保留** |
| DoD | **保留**，同时吸收 `Verification` 段（DoD 项本身就该是可检查的） |
| Manual | **删除**：一次性任务的注意事项写进 Goal；可复用的流程沉淀为 skill |
| Plan | **改为 `## Work Items`**：每项 = id + 描述 + 当前 run + 状态 + 结论（见 P4） |
| 上次结果 | **删除**（没有周期，也就没有"上次"） |

### 工具参数

| 工具 | 现状 | 建议 |
|---|---|---|
| `task_create` | 10 个参数 | `id, title, goal, dod, items?, budget?` |
| `task_update` | 5 个参数 | `id, items?, budget?` |
| `task_step_end` | 9 个参数 | `outcome, note, items?, ticket?, report?`。`done` 时必须给 `report`，它既发给用户也写入日志；`blocked` 的问题放进 `ticket.asked`。`notify`、`summary`、`evidence`、`residualRisk`、`reason` 全部合并 |
| `task_close` | complete/skip/cancel + 5 个文本参数 | 只保留聊天侧的 `cancel` + `reason`（完成统一走 `task_step_end done`）；`skip` 随周期性一起删 |
| `/tasks run`、`/tasks doctor` | | 删除前者；后者只保留"frontmatter 不可读 / 停泊无票"两项 |

---

## 6. 迭代方向（分四步，前三步都是纯减法）

### P1 退役 v3 迁移（低风险）

删除 `task-migration.ts`、frontmatter 的 `legacy` 解析、driver 的 repair-only 分支、`.v3/` 相关逻辑，并精简 doctor。启动时如果发现 v3 文件，只记一条 warning，不再迁移。

### P2 验收从"门禁"降级为"工作项"（最大的一刀，需要你拍板）

- 删除关闭门禁（`completionVerificationBlockReason`）、attestation 文件、契约 hash 绑定、artifact subject 快照（`verification.ts`、`artifact-subject.ts`，以及 runs/tool/settlement 中的对应胶水）。
- 保留 `purpose: verify` 作为一个**派发提示**：只读工具集、注入 checker 指令、解析 `VERDICT:`。结算时把结论记进日志和对应工作项。是否采信由 leader 判断。
- **代价**：失去"运行时能证明 verifier 没改代码、PASS 之后契约没被改过"的结构性保证。缓解办法：reviewer 角色在配置里声明 `mutates: read`；leader 汇报时附上 reviewer 的 run 和结论，交给用户判断。按个人助手的定位，我认为值得。

### P3 周期性移出 tasks，与 events 彻底解耦

- 删除 `schedule` 字段、`schedule` 票、cycle 重开、Plan 复位、`## 上次结果`、`/tasks run`。task 只剩一次性任务，任务会话从"每 cycle 一份"改为每个任务一份。
- 删除 `signal` 票、`task-events.ts`、events 中的 `redeemTaskSignal` 和孤儿清理。events 不再 import tasks。
- 周期性工作改为：periodic event（触发文本指向一个 skill）→ 在聊天中判断：小事直接做，大事 `task_create` 本次的项目。
- 两个风险点需要在设计里写清楚：
  - 现存周期任务需要一次性转换为 event + skill（可以人工处理，因为数量只有个位数）；
  - spec 051 F1 里"周期任务连续 13 天没跑"的问题，在 events 侧由 durable dispatch 和 `history.jsonl` 覆盖。

### P4 唯一的加法：工作项 ↔ 委派 run 关联

- `## Work Items` 每行格式类似 `- [ ] W2 实现导出接口 · run_abc · running`。
- `subagent` / `subagent_inline` 增加可选参数 `item`（必须同时带 `taskId`）。派发时运行时把 run id 写到该项上；结算时写回状态（done / failed / verdict）和 output 路径。leader 下一步的 brief 里直接就是一张团队看板。
- 票据 `run` 改为 **`runs`**：无需指定 id，运行时校验"本任务至少有一个未结算的 run"，**任意一个结算即唤醒**，兜底时限取所有 run 中最晚的 deadline。模型不再需要挑"真正阻塞的那个"，并行派发的写法自然变成"全部派出 → park runs"。
- 上下文富化不加新机制：`agent-delegation.md` 已经把"本轮结果 → 证据 → 要求 → 入口 → 验收"写得很好。运行时只需在带 `taskId` 的派发中自动附上 Goal + DoD（目前只有 verify 会附验收协议）。

### 完成后的 playbook

`task-loop.md` 可以重写成 leader 的工作法，目标 40 行以内：什么时候建项目、怎么拆工作项、派发并 park runs、对照 DoD 检查每个结果、返工指令怎么写、何时 done 并给出 report。现有"先裁决反馈，再返工"一节可以原样保留。

---

## 7. 我需要你确认的两点

1. **P2 是否接受放弃结构性验收证明？**这是代码量最大的一刀，也是唯一真正损失能力的一项。
2. **P3 周期性移到 events 之后，"周期任务的跨周期经验积累"（Manual 的返工教训）由 skill 承接**，你是否认同？如果你更希望周期任务保留在 tasks 里，P3 就只做与 events 解耦（删除 signal），保留 `schedule`，减法幅度会明显变小。
