# 任务 v5：Pipiclaw 作为负责人——一次性项目、工作项与委派、事件模板承载周期

| 字段 | 值 |
|------|------|
| 状态 | 已实施（2026-10-04）；实施取舍见末尾「实施取舍」 |
| 日期 | 2026-10-04 |
| 触发 | 用户确定的产品方向：简化 tasks，强化任务委托，让 Pipiclaw 承担团队负责人（leader）的角色——拆分工作项、富化上下文、分派、检查结果、汇报成果。用户已拍板两项取舍：①验收从运行时门禁降级为负责人的判断；②周期性移出 tasks，由 events 承载，但周期工作的知识不沉淀成 skill |
| 前置 | 040/042 异步委派与一致性、046/047 工具切分、051 长程任务循环（本 spec 的直接前身） |
| 取代 | 051 的 D1 中的 cycle 概念与 `schedule` 票、D2 的 `run` / `job` / `signal` / `schedule` 票种、D5 的 `## 上次结果`、D6 的 `wallMin` / `rounds` / `until` 预算维度、D7 的 round 记账与关闭时的验收重核、D8 的 `signal` 交叉点、D14 的 v3 迁移；036 D6 的 attestation 防自证模型 |
| 关联实现 | `src/tasks/**`、`src/runtime/task-*.ts`、`src/tools/task-manage*`、`src/events/**`、`src/tools/event-manage.ts`、`src/subagents/{tool,runs,verification-outcome}.ts`、`src/subagents/external/{run,settlement}.ts`、`src/agent/job-manager.ts`、`src/runtime/bootstrap.ts`（任务步骤与唤醒路由）、`src/memory/task-digest.ts`、`src/agent/prompt/sections.ts`、`src/playbooks/*.md` |
| 明确不含 | 任务依赖图 / DAG、跨频道任务、workspace 级任务、全自动 work↔check 循环机、运行时可写的 playbook、新的知识载体、settings 新键 |

## 摘要

051 把任务修成了一个**可靠的自驱循环**：等待必须有一张运行时能兑现、带兜底时限的票，任务在自己的会话里一步一步推进。这部分被生产验证过，本 spec 原样保留。

但 051 的任务模型是"Pipiclaw 自己带着契约干活"，而产品方向是"Pipiclaw 带一个团队干活"。两者的差距落在三处：

1. **工作项和委派之间没有关系。**Plan 步骤只有 `id/status/text`；run 只通过 `taskId` 挂在任务上；一张 `run` 票只能指向一个 run；任务被 run 唤醒的那一步，brief 里**看不到这个 run 的结果**（唤醒文本在 `bootstrap.ts:913` 被 brief 整体替换）。负责人每次醒来都要先自己去查"团队现在怎么样了"。
2. **验收是平台级的防自证体系**：契约 hash、base-relative git 主题快照、untracked 基线、transient 目录白名单、enforced/advisory 证明强度、关闭时重核最后一条 round。约 930 行专用代码加散落在委派链路中的配套，防的是"模型骗自己"。在个人助手里，检查本该是负责人的判断，最终由用户裁决。
3. **周期性在两个子系统里各实现一遍**：两套 cron 调度、两份 30 分钟下限，task 侧为周期性背着 cycle、Plan 复位、`## 上次结果`、`schedule` 票、`skip`、`/tasks run`；events 和 tasks 之间还有 `signal` 票与孤儿清理两条反向耦合。

本 spec 的方案：

| 子系统 | 回答的问题 | v5 中的职责 |
|---|---|---|
| **events** | 什么时候 | 唯一的时间源。周期与定时工作由事件承载；事件可以投递一段聊天文本，也可以**按模板生成一个任务实例** |
| **tasks** | 做什么、做到哪 | 只有一次性项目：目标、验收清单、工作项，以及一份记录了每次派发和结算的循环日志 |
| **subagents / jobs** | 谁来做 | 派发时绑定到任务和工作项；结算时运行时把结果记进任务日志，并兑现任务的等待票 |

对象模型收敛为：frontmatter 5 个字段（`state` / `paused` / `ticket` / `usage` / `budget`，外加实例的 `origin`），正文 3 段（Goal / DoD / Work Items），3 种票（`time` / `work` / `ask`），2 维预算（`steps` / `usd`）。`task_step_end` 从 9 个参数降到 5 个，`task_create` 从 10 个降到 6 个。

**唯一的加法**是工作项与委派的关联：派发时带上 `item`，运行时在循环日志里记下派发与结算，step brief 渲染成一块团队看板。其余都是减法。按当前代码估算，任务、验收与事件耦合相关源码永久性净减少约 1,800 行（见第 6 节）。

---

## 1. 现状与证据

数字来自当前代码（master `ea3dc16`）。051 已记录的生产证据（F1 停泊即失踪、F3 会话污染）仍然成立，本 spec 不重复，只引用其约束。

### F1 任务是"自驱工人"，不是"带队项目"

负责人的核心动作是"派出去、等回来、看结果、决定下一步"。当前模型对这四步的支持：

| 动作 | 现状 | 证据 |
|---|---|---|
| 派出去 | `subagent` 需要模型手动传 `taskId`，漏传则后面的 `run` 票会被拒绝（"Dispatch with taskId=…"）。`bash` 在任务会话里会自动绑定 taskId，`subagent` 不会 | `src/tools/bash.ts:298-303`，`src/subagents/tool.ts:344-358` |
| 关联到工作项 | 无。Plan 步骤与 run 之间没有任何字段相连 | `src/tasks/ledger.ts:140` `TaskPlanStep` |
| 等回来 | `run` 票只能指向一个 run；并行派 N 个时，模型要挑"真正阻塞下一阶段的那个"，playbook 专门写了一段来解释 | `src/tasks/ticket.ts:159`，`src/playbooks/agent-delegation.md`「返回、等待与恢复」 |
| 看结果 | 被 run 唤醒的那一步，brief 替换掉了唤醒文本（结果尾部和 output 路径），brief 里只有契约和最近 8 行日志，而日志对 `purpose=work` 的 run **什么都不记** | `src/runtime/bootstrap.ts:910-913`，`src/subagents/runs.ts:916` 只记成本 |

另外，settled run 只保留一周（`runs.ts:310` `RUN_RETENTION_MS`），所以"团队看板"不能依赖 run 注册表，必须落在任务自己的日志里。

### F2 验收门禁是平台级的防自证体系

| 部分 | 行数 | 作用 |
|---|---|---|
| `src/tasks/verification.ts` | 380 | attestation 读写、契约 hash 绑定、关闭时重核 |
| `src/tasks/artifact-subject.ts` | 404 | base-relative 主题哈希、untracked 基线、transient 白名单 |
| `src/tasks/rounds.ts` | 96 | round 记账、rounds 预算 |
| `src/subagents/verification-outcome.ts` | 53 | PASS 判定（含"工作区是否被改"） |
| 散落配套 | 约 250（估） | `tool.ts:1017-1022, 1185-1256` 内置 verifier 的前后快照与 attestation；`external/run.ts:220-228`、`external/settlement.ts` 外部 verifier 的同一套逻辑；`runs.ts:879-929` 结算时的 round 记账；`task-manage/shared.ts` 的关闭门禁 |

它要回答的问题是"运行时能否**证明** verifier 没改代码、PASS 之后契约和产物也没变"。这对平台有意义；对个人助手来说，代价是一整套概念（证明强度、主题模式、可写 verifier 的 advisory 语义），而这些概念需要模型在 `task-loop.md` 里读懂才能不被门禁卡住。用户已确认放弃这层结构性保证。

### F3 周期性在两个子系统里各实现一遍

| 重复点 | tasks 侧 | events 侧 |
|---|---|---|
| cron 调度器 | `TaskDriver` + `task-schedule.ts`（croner） | `EventsWatcher`（croner） |
| 30 分钟下限 | `task-schedule.ts:11` | `event-validation.ts:23` |
| 未来时刻唤醒 | `time` 票 / 首个周期的 time 票 | `one-shot` 事件 |

为了支撑周期性，tasks 还背着：cycle id 与计数重置、周期任务的 Plan 复位（`cycle.ts:43`）、`## 上次结果` 与 4 KB 裁剪（`store.ts:46-107`）、`schedule` 票及其"错过一次"兜底、`task_close outcome=skip`、`/tasks run`、doctor 中的"有 schedule 却没有周期记录"。

反向耦合：`events.ts:27-29` import 了 `tasks/frontmatter`、`tasks/store`、`tasks/task-events`，用于 `signal` 票兑现（`events.ts:697`）和孤儿事件清理（`events.ts:671`）；`task-manage/shared.ts` 又反过来读 events 目录做票据校验和关闭清理。

### F4 概念面

| 维度 | 数量 |
|---|---|
| frontmatter 字段 | 7（`state` / `paused` / `schedule` / `ticket` / `cycle` / `budget` / `verify`），`cycle` 内 7 个子字段 |
| 票种 | 6 |
| 预算维度 | 5 |
| 正文标准段 | 6（Goal / DoD / Manual / Verification / Plan / 上次结果） |
| 时间尺度 | 3（cycle / step / round） |
| 结束方式 | `task_step_end` 4 种 outcome + `task_close` 3 种 outcome |
| 面向用户的文本字段 | `note` / `notify` / `summary` / `evidence` / `residualRisk` / `reason` |

`task-loop.md` 有 2,169 units，是最大的一份 playbook；"task + delegation"合计 4,244 units，已逼近 4,500 的审查线（`npm run playbooks:measure`）。

### F5 v3 迁移残留

`runtime/task-migration.ts`（290 行）、frontmatter 的 `legacy` 判定、driver 的 repair-only 分支、doctor 的"仍是 v3 契约"。这是原设计的背景判断，不构成升级覆盖证据；0.9.3 的实际支持范围见 D12。

### 约束：不能回退 051 F3

051 F3 的教训是**任务工作不能发生在频道聊天会话里**（7.4 MB 会话、6 次压缩，同时损伤闲聊和两个日常任务，还污染了频道记忆）。所以"周期性交给 events"不能退化为"事件往聊天里投一段文本，让模型在聊天会话里做完"。周期工作必须仍在独立的任务会话里执行。D2 的事件模板正是为此设计的。

---

## 2. 设计立场

1. **Pipiclaw 是负责人。**判断、拆分、富化、派发、检查、汇报是它的工作；执行交给团队，小的工作项也可以自己做。运行时只负责记账、唤醒和兜底，不替负责人做判断。
2. **一件事一个机制。**events 决定什么时候，tasks 记录做什么、做到哪，subagents/jobs 决定谁来做。任何一侧都不复制另一侧的职责。
3. **保留被生产验证过的部分。**等待票 + 运行时盖章的兜底时限、任务会话与聊天会话隔离、确定性停止回执、append-only 循环日志、幂等兑现——全部保留。
4. **检查是判断，不是证明。**运行时把 verifier 的结论记在看板上；采信与否由负责人决定，最终由用户裁决。
5. **减法优先。**唯一的新增是工作项与委派的关联，因为它是负责人角色的最小必要状态。
6. **知识放在它该在的地方。**"怎样当负责人、怎样跑周期工作"是开发时沉淀、随包发布的 runtime playbook；某项周期工作的具体要求写在它的事件模板里；运行时学到的流程照旧按 `memory-and-learning.md` 的 skill 规则处理。本 spec 不新增任何知识载体。

---

## 3. 目标对象模型

### 3.1 目录布局

```text
workspace/
├── events/
│   ├── weekly-report.json        事件：周期 + 任务模板（D2）
│   └── check-release.json        事件：一次性 + 聊天文本（不变）
└── <channelId>/tasks/
    ├── export-api.md             契约
    ├── export-api.jsonl          循环日志
    ├── weekly-report-20261005-0900.md     模板生成的实例
    ├── weekly-report-20261005-0900.jsonl
    ├── .sessions/<id>.jsonl      每个任务一份会话（不再按 cycle 分）
    ├── .steer/                   待处理的用户指示与待发送的通知（不变）
    ├── .v3/                      v3 → v5 转换前的原件（D12）
    └── archive/
```

`.verifications/` 不再写入；`.verifications/` 的存量文件保持原样。`.v3/` 的既有备份不删除、不覆盖：同名备份已存在且内容不同时保留旧备份，新副本另存为 `<id>.backup-<n>.md`；`tasks/.v3/events/` 里的事件备份同理（`<name>.backup-<n>.json`，先复制、再删除 `workspace/events/` 里的现役文件，不使用会覆盖的 rename）。

### 3.2 契约文件

```markdown
---
state: parked
ticket: {"kind":"work","refs":["run_k2x9","run_p7q1"],"by":"2026-10-04T18:40:00+08:00"}
usage: {"startedAt":"2026-10-04T14:02:11+08:00","steps":6,"usd":3.4,"usdEstimated":true,"expired":0}
budget: {"usd":30}
---

# 导出接口改造

## Goal
为订单服务新增 CSV 导出接口……（目标、范围、允许的外部动作、关键约束）

## DoD
- [ ] /export 接口返回符合字段规范的 CSV
- [ ] 新增单测覆盖空结果与超大结果
- [ ] npm run check 通过

## Work Items
- [x] W1 调研现有序列化与分页实现
- [ ] W2 实现导出接口与单测
- [ ] W3 独立审查 W2 的实现
```

### 3.3 Frontmatter

| 字段 | v4 | v5 | 说明 |
|---|---|---|---|
| `state` | open / parked / done | **不变** | INV-1：`parked` ⟺ 存在 `ticket` |
| `paused` | `{by, reason, at}` | **不变** | 出现即暂停 |
| `ticket` | 6 种 | **3 种**：`time` / `work` / `ask` | D3 |
| `usage` | （原 `cycle`） | `{startedAt, steps, usd, usdEstimated, expired}` | 去掉 `id` 和 `rounds`；计数覆盖任务的整个生命周期 |
| `budget` | steps / wallMin / usd / rounds / until | **`{steps?, usd?}`** | D8 |
| `origin` | — | **新增**，仅模板实例才有 | 生成它的事件名（D2） |
| `schedule` | cron | **删除** | 周期性移到 events |
| `verify` | `required` | **删除** | D6 |
| `outcome` / `closedAt` | 仅归档文件 | **不变** | |

### 3.4 正文

| 段 | v5 | 说明 |
|---|---|---|
| `# 标题` | 保留 | |
| `## Goal`（目标） | 保留 | 结果、范围、允许的外部动作、关键约束；原 Manual 中属于本任务的约束写在这里 |
| `## DoD` | 保留 | checklist；把原 `## Verification` 中的检查要求直接写成 DoD 项 |
| `## Work Items`（工作项） | **取代 `## Plan`** | `- [ ] W<n> 文本`，四态 todo / done / blocked / dropped 与 `[ ]` / `[x]` / `[!]` / `[~]` 标记、`→ dod:1,2` 引用都沿用现有 Plan 解析；只由负责人维护，运行时不写 |
| `## Manual` / `## Verification` | 新任务不再生成 | 转换后的存量任务保留原文，作为普通段落注入 |
| `## 上次结果` | **删除** | 一次性任务没有"上次"；周期实例的延续见 D5 `<previous_occurrence>` |

运行时不再改写正文的任何部分（v4 里它会写 `## 上次结果`、复位 Plan）。正文只由负责人（通过工具或 `edit`）和用户编辑。INV-6 因此从"运行时写入的段受 4 KB 约束"简化为"超过 4 KB 时写入照常并告警"，`clipLastResult` 及其 UTF-8 截断逻辑随之删除。

### 3.5 循环日志记录

| kind | 写入者 | 字段 | 说明 |
|---|---|---|---|
| `step` | `task_step_end` | `seq, outcome, note, tools, usd?` | 不变（去掉 `cycle`） |
| `dispatch` | 委派注册 / 后台作业启动 | `ref, item?, agent?, purpose?, command?` | **新增**。`ref` 为 runId 或 jobId |
| `settle` | 委派结算 / 作业结算 | `ref, item?, status, verdict?, usd?, usdEstimated?, output?, exitCode?` | **新增**，取代 `round` |
| `expired` | driver | `ticket, action` | 不变 |
| `close` | `task_step_end done` / `task_close` | `outcome, note, steps, usd` | 字段收敛：`summary/evidence/residualRisk` 合并为 `note` |
| `round` | — | — | 不再写入；读取时作为旧记录渲染成一行，保证历史可见 |

所有记录去掉 `cycle` 字段；读取时忽略旧记录中的 `cycle`。

### 3.6 等待票

| kind | 模型提供 | 运行时校验 | 运行时盖章 `by` | 兑现者 |
|---|---|---|---|---|
| `time` | `at`（本地时间或 `+2h`） | 必须是未来时刻 | `= at` | driver 到点 |
| `work` | 无 | 本任务**至少有一个**未结算的 run 或运行中的 job | 所有待结算项各自截止时刻中**最晚**的一个 + 10 分钟 | **任一**被绑定的 run/job 结算时 |
| `ask` | `asked` | 非空 | now + 24h | `/tasks reply` |

`refs` 由运行时在停泊时填入，仅用于展示（`/tasks`、`<task_agenda>`），兑现不依赖它。

### 3.7 事件模板

```json
{
  "type": "periodic",
  "channelId": "dm_your-staff-id",
  "schedule": "0 9 * * 1",
  "task": {
    "title": "周报编写",
    "goal": "汇总上周 pipiclaw 仓库的合并、发布与未决问题，生成周报并发给我。只读仓库与 issue，不做任何写操作。",
    "dod": "- [ ] 覆盖上周全部合并的 PR\n- [ ] 列出未决问题及其负责人\n- [ ] 周报正文已在 report 中交付",
    "items": [{ "text": "收集上周合并与发布记录" }, { "text": "整理未决问题" }],
    "budget": { "usd": 5 }
  }
}
```

`text` 和 `task` **必须且只能出现一个**。`task` 的形状与 `task_create` 的参数完全一致（只是没有 `id`），用同一个纯函数校验。

---

## 4. 决策

### D1 任务只有一次性项目；cycle 退役

一个任务就是一个项目：创建后打开，`done` 或 `cancel` 后归档。cycle、`nextCycleId`、`openCycle`、`openCycleBody`、Plan 复位全部删除。

- `usage` 计数覆盖整个任务生命周期，`startedAt` 是创建时刻。
- 任务会话从 `.sessions/<id>-<cycle>.jsonl` 改为 `.sessions/<id>.jsonl`。`ChannelRunner.bindTaskSession(taskId)` 去掉 `cycleId` 参数；工具注册上下文中的 `taskLoop: {taskId, cycleId}` 改为 `{taskId}`。
- 长项目的会话由 SDK 的常规压缩管理；brief 每一步都重新注入契约、看板和最近日志，所以压缩不会丢失任务状态。

**为什么不保留"多周期任务"的形态：**周期工作的每次执行本质上就是一个新项目——新的目标时间段、新的工作项、新的验收。把它们塞进同一个文件，代价是每次都要复位 Plan 与 checklist，并维护"上次结果"。拆成一次一个实例之后，这些操作都不再需要（D2）。

### D2 周期与定时工作由事件模板生成任务实例

事件新增一种投递方式：按模板生成一个任务实例。

**触发流程**（`EventsWatcher.execute`，在 preAction 门控通过之后）：

1. 实例 id = `<事件名>-<YYYYMMDD>-<HHmm>`，取这一次触发的本地时刻。对同一次触发，id 是确定的。
2. 如果该 id 的文件已存在（活动区或归档区）：视为已生成，属于幂等重放，不做任何事。这一步必须在第 3 步之前：否则同一次触发的重放会把刚生成的实例当成"上一实例"，发出错误的跳过回执。
3. 如果本频道 `tasks/` 下已有 `origin == 事件名` 的**其他活动**任务：**不生成**，写一条事件历史 `skipped`（原因：上一实例仍在进行），并直接向频道发送一条零 LLM 的确定性回执：「周期任务 `<事件名>` 本次（时间）未启动：上一实例 `<id>` 仍在进行（状态…）。查看：/tasks show `<id>`」。
4. 否则按模板写入契约（`state: open`、`origin`、`usage.startedAt`、模板中的 `budget`），写事件历史 `enqueued`，然后 nudge driver。
5. 生成失败（磁盘错误等）：写事件历史 `error`。one-shot 事件保留源文件并标记错误（沿用现有 `queue_full` 的处理）；periodic 事件等下一次触发。

**依赖方向：**events 只 import tasks 侧的**纯函数** `validateTaskContractInput`（用于写入时校验模板）；生成任务这个副作用由 bootstrap 注入的 `spawnTask` 回调完成（内部调用与 `task_create` 共用的 `createTaskDocument`，然后 nudge driver）。events 不再读取任何任务文件。

**一次性的未来项目**也走这条路：「明天 9 点开始做 X」= `one-shot` 事件 + 任务模板。`time` 票只用于任务内部的等待。

**为什么"上一实例仍在进行"时要跳过并回执，而不是并行生成：**两个实例同时跑同一类周期工作，几乎总是重复劳动或互相冲突。跳过而不回执，就重演了 051 F1 中"日报 13 天没有产出，用户自己发现"的问题。上一实例本身也受预算、空转检测与票据兜底约束，最终一定会结束或停下来告诉用户，所以跳过不会无限持续。

**模板的改进路径：**任务会话没有 `event_manage`（不变）。实例负责人在 `report` 里提出改进建议；用户确认后，由聊天侧用 `event_manage update` 修改模板。持久性的改进因此始终可见、经过用户确认，而不是悄悄写进某个文件。

### D3 票据收敛为 `time` / `work` / `ask`

**`work` 取代 `run` / `job`。**负责人只剩"等我的团队"这一种等待，不必再挑"哪一个 run 是真正阻塞的"。

- 校验（`resolveTicket`）：本任务至少有一个 `settledAt` 未设置、且 `taskId` 等于本任务的 run，或者一个 `status === "running"`、且 `taskId` 等于本任务的 job。一个都没有时，拒绝并提示：「本任务没有在途的委派或作业；结果已在看板上，读完继续」。
- 兜底时限 `by`：对每个待结算项取截止时刻——run 用 `deadlineAt ?? startedAt + maxWallTimeSec ?? startedAt + 24h`，job 用 `startedAt + timeoutSeconds`——取其中**最晚**的一个，再加 10 分钟。job 改用它自己的 timeout，而不是 v4 中固定的 24 小时。
- 兑现：`claimVerifiedDelegationWake` / `claimVerifiedJobWake` 的匹配条件从 `ticket.kind === "run" && ticket.id === resourceId` 改为 `ticket.kind === "work"`（加上已有的 taskId 与来源校验）。可信唤醒的校验（`isTrustedInternalWake`、`beginWakeConsumption`）不变。
- 任务处于 `open` 时到达的结算唤醒：照旧丢弃，不开模型回合（`taskStillDriven`）。结果已由 `settle` 记录写进日志，下一步的看板能看到。任务已归档或已暂停时：照旧路由到聊天回合（P3-1 行为不变）。

**`signal` 退役，外部条件等待改用 job 传感器。**等待外部条件（CI 结束、文件出现）时，负责人启动一个带超时的后台作业作为传感器，并停泊到 `work` 票：

```json
{"command":"until test -f /abs/path/ready.flag; do sleep 60; done","async":true,"timeout":21600}
```

在任务会话中，作业的 taskId 会自动绑定（现有行为）。条件成立时作业结束，唤醒任务；超时则以失败结束，同样唤醒任务。整个等待过程零 token，能挺过重启（job-manager 会恢复跟踪），也不需要任何 events ↔ tasks 耦合。这完全覆盖了 `signal` 的用途，而且少一种票、少一种命名约定（`task.<ch>.<id>.<use>`）、少一条反向依赖。

**过期计数改为"连续"。**`usage.expired` 在票被其来源正常兑现时归零（在 `redeemTicket` 中处理）；连续第二次过期时暂停并发出回执（规则不变）。v4 按 cycle 累计，而回执文案写的却是"连续"，两者不一致；长项目中两次相隔很远的、各自已恢复的过期，不应该叠加成一次停止。

### D4 工作项与委派绑定

- **Work Items 段**取代 Plan 段；`TaskPlanStep` 与 `applyTaskPlanPatch` 改名后复用，标题识别 `Work Items` / `工作项`。新项的 id 前缀从 `P` 改为 `W`，不带 id 时自动编号；解析同时接受 `P<n>` 和 `W<n>`，这样转换后的存量任务不必改写 id（日志中的旧 note 仍引用 P 编号）。
- **`subagent` / `subagent_inline` 新增 `item?: string`。**在任务会话中，`taskId` 自动绑定为当前任务（与 `bash` 一致）；显式传入其他任务的 id 会被拒绝，提示文案沿用 `bash.ts:300` 的写法。在聊天中，`item` 必须与 `taskId` 一起出现。`item` 必须是该任务 Work Items 中存在的 id，否则返回可恢复错误并列出现有 id。
- `RunRecord` 新增 `item?: string`，在注册时持久化。
- **日志写入点：**
  - `SubAgentRunManager.register`：带 taskId 时追加 `dispatch`。
  - `SubAgentRunManager` 结算，在原 `creditOwningTask` 处，复用 `taskAccounted` 幂等标记：追加 `settle`（`status`、`verdict`、成本、`output.md` 路径），并把成本累加进 `usage.usd`。
  - `ChannelJobManager` 启动和结算带 taskId 的作业：追加 `dispatch` / `settle`（`exitCode`、输出路径）。作业记录目前只有 `notified` 这一个与唤醒相关的标记，因此新增一个持久化的 `taskLogged` 标记，作用与 run 的 `taskAccounted` 相同，保证重启后的重复结算不会写第二条 `settle`。
- 工作项的完成状态**只由负责人标记**（通过 `items` 参数或 `edit`）。运行时不会因为 run 成功就把工作项打勾——"派出去的人说做完了"和"负责人检查过、认可了"是两件事，这正是负责人的职责。

**为什么看板的来源是日志，而不是 run 注册表：**settled run 一周后被回收，而项目可能更长。日志是 append-only 的，任务归档时随契约一起移动，是唯一在任务整个生命周期内都完整的来源。

### D5 Step brief：契约 + 团队看板

被兑现的结算唤醒的文本会被 brief 替换（这是任务会话隔离的必然结果，保留）。所以 brief 必须自己说清楚团队现在的状态：

```text
[TASK_STEP:export-api]
<task_recovery>（仅票过期后）
<user_guidance>（仅有 /tasks steer 或 reply 时）
<previous_occurrence id="weekly-report-20260928-0900" outcome="completed" closedAt="…">（仅模板实例的首步）
上一实例的 close note，截断到 1,200 字符
</previous_occurrence>
契约文件：<abs path>；首次执行前读取 <PLAYBOOKS_DIR>/task-lead.md
<task_contract id="export-api">…正文…</task_contract>
<task_board>
- [x] W1 调研现有序列化与分页实现 — run_a1b2 explorer completed 4m · output: …/output.md
- [ ] W2 实现导出接口与单测 — run_k2x9 claude-code completed 38m ★新 · output: …/output.md
- [ ] W3 独立审查 W2 — run_p7q1 reviewer(verify) running 6m
- （未关联工作项）job_c3 completed exit 0 ★新 · output: …
</task_board>
<task_log recent="8">…仅 step / expired / close 记录…</task_log>
<task_state>usage 6/60 步 · $3.40/$30（含估算） · ticket …</task_state>
推进下一步，然后用 task_step_end 收尾……
```

- **看板**：对每个工作项，取其关联的派发；每个 `ref` 只显示最新状态（有 `settle` 就用 settle，否则是 running）。`★新` 标记在上一条 `step` 记录之后才结算的项——也就是把这一步唤醒的那些结果。没有关联工作项的派发单独列出。上限 12 行，超出部分折叠成「另有 N 项已结算，见 task_log」。
- **日志块**只渲染 `step` / `expired` / `close`，派发与结算由看板承载，不重复显示。
- 结算项的完整输出仍然通过 `read output.md` 获取；看板只给状态和路径，不内联结果正文，以控制每一步的固定成本。

### D6 验收从门禁降级为负责人的判断

**保留：**

- `purpose: "verify"` 作为派发提示：内置 verifier 在结构上移除 `write` / `edit`（现有行为）；任务文本中注入检查者协议；从最终文本解析 `VERDICT: PASS|FAIL`，写入 `RunRecord.verificationVerdict` 和 `settle.verdict`，看板上可见。
- `assertVerifyAdmissible`：拒绝 `exec` harness（它没有可信的终态文本），拒绝对持有写 lease 的目录做检查（检查一个还在变化的目标没有意义）。
- DoD checklist 门禁：`done` 和 `task_close complete` 时仍要求 DoD 全部勾选。这是负责人的显式确认，成本几乎为零。

**删除：**

- attestation 文件与 `.verifications/` 写入、契约 hash 绑定、关闭时重核（`verification.ts` 全部，`completionVerificationBlockReason`、`assertVerificationHoldsForClose`）。
- 工作区主题快照：`artifact-subject.ts` 中除 `changedPathsSummary` 以外的全部内容（`changedPathsSummary` 仍被外部写 run 的 `workspaceSummary` 使用，迁到 `src/subagents/workspace-summary.ts`）；内置与外部 verifier 的前后快照、`verifySubject*` / `verifyBase*` 等 RunRecord 字段。
- `verificationStrength`（enforced / advisory）这个概念，以及 `verification-outcome.ts` 中"工作区是否被改"的判定。判定简化为：运行失败或没有 VERDICT 记为 fail，否则采用声明的 verdict。
- 任务的 `verify: required`、`rounds` 预算、`round` 日志记录。
- `purpose=verify` 必须带 `taskId` 的要求：聊天中的一次性审查也可以使用检查者协议。

**代价（已由用户确认接受）：**运行时不再能证明 verifier 没有改动产物，也不再能证明 PASS 之后契约和产物没有变化。缓解办法：只读 verifier 由 `mutates: read` 的角色配置保证（这是部署者的配置，不是运行时的推断）；playbook 要求负责人对照真实 diff 与检查输出采信结论，并在 `report` 中写明谁检查了什么、结论是什么，交给用户裁决。

### D7 工具面收敛

```text
task_create   {id, title, goal, dod, items?: [{text}], budget?: {steps?, usd?}}
task_update   {id, items?: [{id, status?, text?}], budget?}
task_close    {id, outcome: complete|cancel, note}
task_list     {}
task_log      {id, limit?}
task_step_end {outcome: continue|park|done, note, items?, ticket?: {kind: time|work|ask, at?, asked?}, report?}
subagent / subagent_inline  + item?
```

| 工具 | v4 参数数 | v5 参数数 | 变化 |
|---|---|---|---|
| `task_create` | 10 | 6 | 删除 `manual`、`verificationPlan`、`verificationRequired`、`schedule`；`plan` 改名为 `items`，形状与 update 一致 |
| `task_update` | 5 | 3 | 删除 `schedule`、`verificationRequired` |
| `task_close` | 6 | 3 | 删除 `skip`；`summary` / `evidence` / `residualRisk` / `reason` 合并为 `note` |
| `task_step_end` | 9 | 5 | 删除 `blocked`（= 停泊到 `ask` 票）；`summary` / `evidence` / `residualRisk` / `reason` 合并进 `note`；`notify` 改名为 `report` |
| `task_log` | 3 | 2 | 删除 `cycle` |

各 outcome 的语义：

| outcome | 运行时动作 |
|---|---|
| `continue` | 立即排下一步 |
| `park` | 校验票据、盖章 `by`，转为 parked；`ask` 票会自动通知用户（`asked` 文本 + `/tasks reply` 用法） |
| `done` | DoD 全部勾选，且**没有在途的绑定 run/job**（否则拒绝，并列出 ref，要求等待或取消）；写 `close`，归档 |

done 时检查在途委派是新增的门禁：它能防止项目已归档、结果却回落到聊天里的情况（P3-1 路径）。`task_close cancel` 不做此检查，但会在回执中列出仍在运行的 ref，并提醒"关闭不会取消委派"。

### D8 预算：`steps` 与 `usd`，按任务计

| 键 | 默认 | 说明 |
|---|---|---|
| `steps` | 60 | 任务生命周期内的模型步数 |
| `usd` | 20 | 可归因成本，**包含绑定委派的成本** |

- 删除 `wallMin`：活性已由票据兜底保证；它把停泊等待也计入时长，playbook 不得不专门解释。
- 删除 `rounds`：返工轮次没有了运行时语义，`steps` 和 `usd` 已经能约束无限返工。
- 删除 `until`：截止时间是项目目标的一部分，写进 Goal，由负责人掌握。
- 默认值上调的理由：v4 按 cycle 计，v5 按项目计，而负责人模式下大部分成本来自委派。051 F4 中一个真实项目一天花了 $23.68 的委派成本、15 个 run；按"每个结算唤醒一步"计算，同等规模的项目需要 25–35 步。默认值的目标是让常规项目不撞线，让失控项目在可接受的花费内停下。默认值是代码常量（遵守 settings 只接受产品意图的约定），可按任务覆盖，`/tasks resume <id> +steps N | +usd X` 可以加码。
- 空转检测（连续两步没有工具调用）保留。

### D9 汇报

- `report`（任意 outcome 都可以带）是**唯一**发给用户的文本，在步骤结束后由运行时投递；`note` 只进日志。名字直接表达用途，取代容易被误解的 `notify`，同时去掉"note 不会发给用户"这条额外规则的必要性。
- `done` 不强制要求 `report`：静默的周期巡检（"没有新情况"）是合法的。playbook 规定：凡是 Goal 或 DoD 要求交付、告知、汇报的项目，`report` 必须包含实际内容。
- 确定性回执（零 LLM）：预算耗尽、空转、连续两次票据过期、`ask` 提问、周期实例被跳过。

### D10 events ↔ tasks 边界

| 方向 | v4 | v5 |
|---|---|---|
| events → tasks | 读任务 frontmatter、兑现 `signal` 票、清理孤儿事件 | 只 import 纯函数 `validateTaskContractInput`；生成任务通过注入的回调 |
| tasks → events | 票据校验读 events 目录；关闭时删除 task-owned 事件 | **无** |

- `task-events.ts`、`cleanupTaskEvents`、`readChannelEvents`、`orphanedOwnerReason`、`redeemTaskSignal` 删除。
- `event_manage`：`definition.text` 改为可选，新增可选的 `task`（复用 `task_create` 的 schema 片段，去掉 `id`）；`name` 描述中去掉 task-owned 命名的说明。`/events list` 对模板事件显示 `task: <title>`，而不是文本预览。
- 模板事件的准入规则沿用现有规则（30 分钟 / 有 preAction 时 5 分钟的下限、50 个文件上限、command guard、one-shot 至少提前 2 分钟），并增加模板校验。watcher 仍是最终的信任边界。
- `[SILENT]` 只适用于文本事件（不变）；模板事件没有聊天回合。

### D11 `/tasks` 与可见性

```text
/tasks                     列表：状态、票据与兜底时间、工作项进度、用量；实例显示 origin
/tasks show <id>           契约 + 看板 + 最近日志 + 用量
/tasks log <id>            循环日志
/tasks steer <id> <内容>
/tasks reply <id> <内容>
/tasks pause <id> / resume <id> [+steps N|+usd X]
/tasks archive
/tasks doctor
```

- 删除 `/tasks run`（它的作用是"立即开一个周期"）。立即跑一次周期工作的替代：让 Agent 用同一模板 `task_create` 一个项目。
- doctor 只保留 3 项：frontmatter 不可读；仍含已识别的旧字段（不代表能识别所有 v4 文件）；停泊的兜底时限已过去 1 小时以上（driver 可能没有运行）。
- `<task_agenda>` 每行：`id — 标题 · state · 票据摘要 · 兜底 · items 2/3 · 6 步 · $3.40`。

### D12 一次性转换 v3 → v5；v4 需人工重建

**0.9.3 实施范围（以 `src/runtime/task-migration.ts` 为准）：**daemon 首次启动 v5 时执行一次确定性转换，不调用 LLM，完成扫描后写入 `state/task-migration-v5.done`。仅转换有 `status:` 且没有 `state:` 的 v3 文件；任何带 `state:` 的文件均跳过，因此 **beta 的 v4 不会自动转换**。不能从安装版本推断任务格式，也不能假定所有用户已经完成 v4 迁移。

| 输入 | 处理 |
|---|---|
| v3 `status` / `enabled` / `control.stop` | 改为 `open`；原先停用或停止的任务转为 `paused` |
| v3 等待 | 不保留 `wake` / `waitingFor`；`waiting` 改为 `open` 并留 note，升级前须核对外部动作，避免重复执行 |
| `## Plan` / `## 计划` | 改名为 `## Work Items`；条目原样保留 |
| `## Current Cycle` / `## History`（含中文名） | 从新契约删除；原文仍在备份中；Manual / Verification 保留 |
| v3 周期任务（有 `schedule`） | 生成同 cron 的 `periodic` 任务模板事件；Manual / Verification 并入 Goal，DoD 取消勾选，Plan 生成 items。事件名冲突加 `-task`，再次冲突或模板不可表达则暂停并留 note。`sleeping` 原任务以 `cancelled` 归档，其余作为 `origin` 指向该事件的实例继续；已停用（`enabled: false` / `control.stop`）的周期任务仍暂停，**不生成事件模板**（事件没有停用标志，生成即会运行），只留 note 记录原周期；仍会生成的模板无法在 watcher 启动前人工拦截，升级前须在隔离副本盘点，并在停 daemon 时对不应运行的 v3 任务先设 `enabled: false` |
| task-owned 事件 `task.<ch>.<id>.*` | 移到频道 `tasks/.v3/events/`，活动所属任务记 note |
| 原件 / 归档区 | 原件复制到 `tasks/.v3/`；不扫描归档区，不删除存量原件 |
| v4（有 `state:`，常见 `cycle` / `verify` / 旧票种） | 原样跳过，不转换预算、用量、等待票或正文；不能视为兼容 v5，必须先隔离，再人工重建 |

**失败与恢复：**单任务转换抛错先回滚（恢复 v3 原文件，删除本次写出的模板事件/新建日志；`archiveTask` 自身拒绝覆盖既有归档条目，并在中途失败时撤销已移动的日志分片与归档契约，因此转换前就存在的归档不会被改动，回滚报告的 `ok` 仅指这些步骤）。任务目录或事件目录无法读取（除“不存在”外的任何 `readdir` 错误，如 EACCES/EIO）按 `scan`/`events` 失败处理，不当作“没有任务”；归档日志 rename 失败同样使该任务失败。任一任务或事件移动失败则不写 marker，写 `state/task-migration-v5.failed.json`（含阶段与回滚结果），迁移函数抛错，bootstrap 不捕获，因此 watcher / driver / 钉钉均不启动；修复后重启重试失败项，已转换项带 `state:` 被跳过。报告含回滚失败时持续拒绝启动，直至人工核对恢复并删除报告。不要删除标记来全量重跑，也不要只删旧字段或直接改写 ticket。保留任务、日志、会话、事件与委派记录，按[升级及人工重建步骤](../../events-and-tasks.md#beta-用户升级与不可转换任务)处理；doctor 不能证明 v4 已全部识别。

**上线前演练：**停止服务前先结算或显式取消外部 run，再停 daemon、备份整个 app home。用 `scripts/rehearse-task-migration.mjs`（需先 build）在临时只读副本上直接调用迁移函数，不经 bootstrap，不启动任何服务；检查每个周期模板、等待的真实来源及授权。不要拿生产数据直接试启动。

**转换代码寿命：**计划在下一个 minor 删除；删除前须公布可用的中间升级版本与支持范围，目前不承诺尚未验证的升级跳板。

### D13 知识放置：playbook、system prompt、文档

按用户要求，负责人的工作方法与周期工作的做法是开发时沉淀的知识，全部写进随包 playbook。运行时不新增任何可写的知识载体。

| Playbook | 变化 |
|---|---|
| `task-loop.md` → **`task-lead.md`** | 重写为负责人工作法：何时立项（相对于自己做或一次性委派）→ Goal / DoD / Work Items 怎么写（每项可独立派发、可独立检查）→ 派发（选角色、富化上下文，指向 `agent-delegation.md`；并行与隔离；`item` 绑定）→ 等待（`work` 票、job 传感器、`time` 复查）→ 检查（读看板与 output、对照 DoD、必要时派 verify）→ 裁决反馈与返工（保留现有"先裁决反馈，再返工"一节）→ 收尾与 `report`（成果、证据、谁检查了什么、未决风险、成本）→ 周期实例（`<previous_occurrence>` 的用法、在 report 中提出模板改进）。改名是为了让目录里的触发描述直接说明角色 |
| `agent-delegation.md` | 删除 attestation、证明强度、"verify 必须带 taskId"等内容；加入 `item` 绑定、任务会话中的自动绑定、`work` 票。保留"任务指令：执行者看不到本会话"一节——它就是"上下文富化"的方法 |
| `event-scheduling.md` | 新增"文本还是任务模板"的选择；删除 signal / task-owned 传感器一节；"任务内的外部条件等待"改为指向 `task-lead.md` 的 job 传感器 |
| `background-jobs.md` | `job` 票改为 `work` 票；补充作为条件传感器的用法 |
| `memory-and-learning.md` | 删除 Manual / PASS 失效相关内容；改为"任务内的教训写 note；周期工作的持久改进由聊天侧更新事件模板" |
| `runtime-orientation.md` | 任务会话改为每任务一份；文件地图中的 tasks 行去掉 cycle |

审查目标：`task-lead.md` + `agent-delegation.md` 合计控制在 4,500 units 的审查线内（实施后实测约 4,040，实施前 4,244）。机制变少，正文应当更短。

System prompt：

- `runtime.tasks` 一节改为：「需要分派多个工作项或跨回合等待的工作立项为 task，由你作为负责人推进；周期或定时工作用事件模板。不要扩大任务范围。」（去掉 "bypassing verification"）
- 委派目录一节末尾的 "task-loop.md before independent verification" 改为 "task-lead.md before leading a multi-item task"。

文档：重写 `docs/events-and-tasks.md` 第二部分，并在第一部分补充模板事件；同步更新 `sub-agents.md`（verify 一节）、`runtime-playbooks.md`（目录表）、`architecture.md`、`interaction-and-commands.md`（删除 `/tasks run`）、`CLAUDE.md` 与 `AGENTS.md` 中 tasks 的架构描述。

---

## 5. 不变量

| 编号 | 不变量 | 强制位置 |
|---|---|---|
| INV-1 | `state: parked` ⟺ 存在 `ticket` | `normalizeTaskFrontmatter`（不变） |
| INV-2 | 每张票都带运行时盖章的 `by`；连续第二次过期时暂停并回执 | `resolveTicket`、`expireTicket` |
| INV-3 | `work` 票只在本任务有在途绑定项时才能成立；任一绑定项结算都会兑现它 | `resolveTicket`、两个 wake claim |
| INV-4 | `Ticket` 只能由 `resolveTicket` 生成（转换器也必须经过它） | 代码审查约定（同 051） |
| INV-5 | 每个绑定到任务的 run/job，在该任务日志中都有 `dispatch` 和 `settle` 两条记录，且与 run 的保留期无关 | run manager / job manager 的注册与结算点 |
| INV-6 | 运行时不改写契约正文 | 删除 `writeLastResult` / `openCycleBody` 之后的结构性事实 |
| INV-7 | 一个模板事件同时最多有一个活动实例；因此被跳过的触发一定伴随一条回执 | `spawnTask` |
| INV-8 | events 不读取任务文件；tasks 不读取 events 目录 | import 方向（可写进 knip / lint 规则，或用一个测试断言） |
| INV-9 | 任务工作只在任务会话中执行，不进入频道聊天会话 | 不变（051 D3） |

---

## 6. 影响面与规模估算

| 区域 | 动作 | 估算 |
|---|---|---|
| `tasks/verification.ts` | 删除 | −380 |
| `tasks/artifact-subject.ts` | 删除，只把 `changedPathsSummary` 迁到 subagents | −370 |
| `tasks/rounds.ts`、`cycle.ts`、`task-schedule.ts`、`task-events.ts` | 删除 | −278 |
| `subagents/tool.ts`、`external/run.ts`、`external/settlement.ts`、`verification-outcome.ts` 中的主题快照与强度 | 删除 | −200 |
| `runs.ts` round 记账 | 改为写 `settle` | −40 |
| `task-manage/shared.ts`（事件读取与清理、验收门禁、schedule） | 删除 | −150 |
| `step-end.ts` / `lifecycle.ts`（周期分支、skip、blocked、上次结果） | 简化 | −120 |
| `store.ts`（openCycle、clipLastResult） | 简化 | −80 |
| `ticket.ts`（schedule / run / job / signal 四个分支） | 改为 `work` 一个分支 | −60 |
| `events.ts`（signal、孤儿清理） | 删除 | −90 |
| `task-driver.ts`（schedule 兑现、开周期、repair-only） | 简化 | −40 |
| `task-migration.ts`（v3） | 保留临时转换器（D12） | 以实施为准 |
| `task-commands.ts`（run、doctor） | 简化 | −60 |
| 新增：模板生成、契约输入校验 | 新增 | +130 |
| 新增：`dispatch` / `settle` 写入点、看板渲染 | 新增 | +150 |
| 新增：`work` 票、自动绑定、`item` 校验 | 新增 | +70 |
| 临时：v3 → v5 转换（v4 人工重建） | 临时 | +180 |

删除约 2,160 行，永久新增约 350 行，永久性净变化约 **−1,800 行**；算上下一个 minor 才删除的转换代码，本版本净变化约 −1,630 行。测试：`task-completion-verification.test.ts`、`verification-outcome.test.ts` 的大部分、`e2e/deterministic/verify-chain.test.ts`、`task-migration.test.ts` 删除或重写；新增的测试见第 7 节。

---

## 7. 测试策略

遵守 CLAUDE.md 的测试原则：每个测试都必须在真实回归时失败，不固定文案。

**单元测试（必须覆盖）：**

- 票据：没有在途绑定项时拒绝 `work`；`by` 取最晚截止时刻；其他任务的 run 结算不会兑现本任务的票；重放的结算唤醒不会重复兑现；连续过期计数在正常兑现后归零，连续第二次过期时暂停。
- 生成实例：同一次触发的 id 确定，重放幂等且不发跳过回执；存在活动实例时跳过并回执（断言回执被投递，而不是断言文案）；preAction 不通过时不生成；非法模板在 `event_manage` 写入时和 watcher 加载时都被拒绝。
- 看板：`dispatch` / `settle` 的关联；run 记录被回收（`forget`）后看板不变；`★新` 只标记上一条 step 之后的结算；超过 12 行时折叠。
- 关闭：DoD 有未勾选项时拒绝；有在途绑定项时拒绝 `done`；`cancel` 不受此限制。
- 绑定：任务会话中 `subagent` 自动绑定 taskId；传入其他任务的 id 被拒绝；不存在的 `item` 被拒绝。
- 转换：停泊中的周期任务 → 生成事件并归档；执行中的周期任务 → 变成实例；v3 `waiting` → `open`；task-owned 事件被移走；标记文件存在时不重复执行；原件有备份。

**确定性 e2e（`test/e2e/deterministic/`）：**

- 重写 `tasks.test.ts`：创建带 2 个工作项的任务 → 真实 driver 跑一步，派出 2 个 run（任务会话中自动绑定）→ 停泊到 `work` → 其中一个结算后兑现并跑一步，brief 的看板中出现它的结果 → 第二个结算 → 勾选 DoD，`done` 并带 `report` → `report` 被投递到频道，任务被归档。
- 新增 `task-template.test.ts`：模板事件触发 → 生成实例并在任务会话中执行（断言频道聊天会话没有增长）→ 实例还没结束时再次触发 → 收到回执，没有第二个实例。
- `verify-chain.test.ts` 改为：verify run 的 VERDICT 出现在看板和 `settle` 记录中。
- `wake-auth.test.ts` 保留，并改为 `work` 票语义：伪造的唤醒文本不能兑现票。

**行为 eval（`evals/cases/`）：**删除 `TL-signal-01`；把 `TL-ticket-01` 改为 `work` 票；新增 3 个负责人用例——并行派发后停泊到 `work`（而不是轮询，或停泊到某一个 run）；Goal 要求汇报时，`done` 的 `report` 包含实际成果；用户说"每周一帮我做 X"时，聊天侧创建模板事件，而不是带 schedule 的任务或文本事件。

---

## 8. 实施顺序

在一个分支上分四个阶段完成，**合并为一个版本发布**（转换代码只针对最终格式编写一次）。每个阶段结束时 `npm run check` 和 `npm run test:e2e` 都要通过。

1. **验收降级（D6）。**保留 D12 的临时 v3 转换器与旧字段判定。
2. **周期性移到事件（D1、D2、D10）。**cycle 退役、模板事件与生成实例、events ↔ tasks 解耦、删除 `/tasks run` 和 `skip`。
3. **负责人能力（D3、D4、D5、D7、D8、D9）。**`work` 票、自动绑定、`item`、`dispatch` / `settle`、看板、工具面收敛、预算、`report`。
4. **转换与知识（D12 前半、D13）。**v3 → v5 转换并在隔离数据副本演练；v4 按 D12 人工重建；重写 playbook；更新 system prompt、文档与 eval。

---

## 9. 风险与取舍

| 风险 | 影响 | 缓解 |
|---|---|---|
| 失去结构性验收证明 | verifier 改了代码或 PASS 之后产物又变化时，运行时不再察觉 | 用户已接受；`mutates: read` 角色；playbook 要求对照 diff 采信结论，并在 report 中写明检查过程 |
| 生产中周期任务的转换出错 | 日常产出中断（重演 051 F1） | 备份；生产数据副本演练；执行中的周期任务就地变成实例，不打断本次执行；人工清单核对 v4；doctor 只检查已识别的旧字段 |
| 预算按项目计后默认值不合适 | 常规项目撞线，或失控项目花费过多 | 默认值有依据（D8），可按任务覆盖、可加码；回执中带命令 |
| 跳过回执过于频繁 | 卡住的周期实例每次触发都回执一次 | 这是有意为之的可见性——卡住本身就是需要用户处理的问题；上一实例的预算与兜底保证它最终结束 |
| 负责人仍然全部自己做 | 委派能力用不上 | playbook 给出立项与派发的判断条件；eval 覆盖 |
| 看板增加每一步的固定成本 | 每步多几百 units | 只显示状态和路径，不内联结果；12 行上限；日志块不重复显示派发与结算 |
| job 传感器占用作业名额 | 每频道最多 5 个运行中作业 | playbook 规定传感器必须带 timeout，且一个任务同时最多一个传感器 |

---

## 10. 已确认的取舍

1. **默认预算 60 步 / $20（按项目计）**——确认合适。
2. **周期实例被跳过时每次都回执**——确认（INV-7）。
3. **`task-loop.md` 改名为 `task-lead.md`**——确认。
4. **P2 放弃结构性验收证明、P3 周期性移到 events**——确认；周期工作的知识不沉淀成 skill：开发时沉淀的机制知识（负责人工作法、周期实例的做法）写进随包 playbook，运行时不可改写；某项周期工作的具体要求写在它自己的事件模板里；模型在运行中自己学到的流程仍按 `memory-and-learning.md` 沉淀为 workspace skill。

## 11. 实施取舍

实施与设计的差异与补充，按出现位置：

- **`items` 的形状**：`task_create` 与事件模板的 `items` 是 `[{text}]`，id 由运行时按 `W1…Wn` 编号；`task_update` / `task_step_end` 的 `items` 是 `[{id, status?, text?}]`，**id 必填**（新 id 追加一项，此时 `text` 必填）。这样没有"某字段因另一字段而必填"的参数组合（spec 046）。解析接受 `P<n>` 与 `W<n>` 两种前缀，转换后的存量任务不必改写 id。
- **`ask` 的通知**：`park` 到 `ask` 票时，运行时自动发送「任务 X 需要你的决定：… 用 /tasks reply X <内容> 回答」，并拼在 `report`（如有）之后。
- **`done` 的写入顺序**：`task_step_end done` 在所有检查通过之后、写 close 记录之前追加自己的 step 记录（`closeTaskDocument` 的 `afterChecks` 钩子）——归档会把日志移走，step 记录必须落在随任务归档的那份里，而被拒绝的 `done` 不能留下任何记录。
- **`/tasks resume` 与死票**：恢复一个因"连续第二次过期"被暂停、且票的兜底时限已过的任务时，`resume` 把它重开并清零过期计数；否则恢复后会立刻在同一张死票上再次过期并再次暂停。
- **转换器的范围**：v3 → v5 转换在服务启动之前 `await`，支持范围与失败处理见 D12。v4 带 `state:` 的文件原样跳过，不读取持久化 run/job 来转换旧票。无法表达为模板的 v3 周期任务转换为 `paused{by:"runtime"}` 并留说明；beta/v4 用户须先隔离原件再人工重建。
- **作业的 `timeoutSeconds`**：为让 `work` 票的兜底时限取作业自己的 timeout，`JobSnapshot` 新增 `timeoutSeconds`；作业记录新增持久化的 `taskLogged` 标记，作用同 run 的 `taskAccounted`。作业只在带 `channelDir` 的 manager 上写任务日志（生产路径经 `createJobRuntime` 传入）。
- **看板的"新"**：以日志里最后一条 `step` 记录为界。同步返回的委派在步骤中途结算，早于该步的 step 记录，所以不会被标为"新"——负责人当场已经读到了结果。
- **预算文案**：`budget.ts` 的 `createUsage` 取代 `accrueStep`；步数由 `task_step_end` 自增，成本由结算时的 `logTaskSettlement` 累加。

## 12. 验证

单元与 e2e 覆盖：票据校验矩阵与兜底、重开/连续过期/resume、看板（分组、新标记、run 记录回收后仍在、折叠）、关闭门禁（DoD、在途项、cancel 不受限）、任务会话中的自动绑定与 `item` 校验、模板事件（`text` xor `task`、重放幂等、跳过回执、一次性模板的 `at` 键、失败保留标记）、v3 → v5 转换的各分支及 v4 原样跳过、作业的 `dispatch`/`settle` 先于唤醒；确定性 e2e：A13/A13b（任务步骤）、A15（唤醒真伪与 `work` 票）、A17（任务内委派绑定工作项）、A18（模板生成实例并在任务会话里执行、第二次触发被跳过）。上线前仍需在生产数据副本上演练一次转换（D12）。
