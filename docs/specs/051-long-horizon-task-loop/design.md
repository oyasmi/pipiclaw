# 长程任务 v3：一条循环、一份契约、一张可兑现的等待票

| 字段 | 值 |
|------|------|
| 状态 | 已实施（2026-09-05）；实施期的偏离记录在 [plan.md](./plan.md) 的「实施记录」 |
| 日期 | 2026-09-05 |
| 触发 | 用户对任务管理的直接反馈：「勉强可用，不够好，不满意」；本 spec 是对 `tasks` / `events` / `sub-agents` 三者**及其协作面**的整体重设计，不是又一次局部治理调参 |
| 前置 | 019 任务台账、020 可见性与 driver、022 原生 driver、023/024 治理循环、027 原生周期、029 生命周期收敛、031 唤醒层加固、036 治理瘦身、037 Plan 与载体、038 自治状态 v2、040/042 异步委派、043 会话身份、046/047 工具切分、048 e2e、050 记忆 v2 |
| 取代 | 023/024 的治理循环形态；031 D7 的 effect ledger 与 fingerprint 治理；038 的 `waitingFor` 记录性语义；029 D5 的 futile/wake 计数；037 D2 的 Plan-in-body 之外的 `## History` 内联历史 |
| 关联实现 | `src/tasks/**`、`src/runtime/task-*.ts`、`src/runtime/events.ts`、`src/runtime/event-*.ts`、`src/tools/task-manage*`、`src/tools/event-manage.ts`、`src/agent/effect-ledger.ts`、`src/agent/channel-runner.ts`、`src/agent/runner-factory.ts`、`src/subagents/runs.ts`、`src/subagents/tool.ts`、`src/memory/task-digest.ts`、`src/playbooks/task-*.md`、`src/playbooks/event-scheduling.md`、`docs/events-and-tasks.md` |
| 明确不含 | **`events` 子系统的退役（本轮明确保留，见 D8）**、全自动 work↔check 循环机、任务依赖图 / DAG、跨频道任务、逐动作审批门、分布式或多进程执行、向量检索（见第 9 节） |

## 摘要

现在的任务子系统由**三个各自独立的调度器**（TaskDriver、EventsWatcher、SubAgentRunManager 的完成唤醒）、**一个十字段指纹治理器**、**一份进程内 effect 账本**和**五个任务工具 + 一个事件工具**组成，共 14,401 行源码、9,120 行测试。它把大部分工程投入放在一个问题上：**猜「这次唤醒到底干活了没有」**——指纹、effect 计数、futile 计数、wake 计数、三档 backoff。

而真实数据里，任务失败**从来不是因为空转**。本机两个最重要的任务都死于同一件事：**停泊之后没人再叫醒它**。`fix-tui-typecheck` 从 2026-08-27 起 `waiting` 且没有任何可兑现的恢复源，到今天（09-05）躺了 9 天；`daily-pipiclaw-dev-review` 在 2026-08-15 到 08-27 之间连续 13 天没有跑过任何一个 occurrence，运行时每天往日志里写 87–113 条 `missed recurring occurrence` 警告，**一次都没有告诉用户**。治理器盯着「转得太多」，而现实里发生的全是「不转了」。

同时，长程工作真正跑起来的那一次（2026-08-31，`pipiclaw-quality-optimization-20260831`）暴露了第二组问题：15 个委派、7 轮 builder↔reviewer、6 次 advisory FAIL 后 1 次 PASS、2.4 小时委派墙钟——**任务状态里对这 7 轮返工没有留下任何痕迹**（`control.verification` 始终是 `{"required":false,"status":"pending"}`），成本（当天 $25.17）也无法归到任务头上。而每一步都在一个已经长到 7.4 MB、被压缩过 6 次、同时装着闲聊和另外两个任务的频道会话里进行。

本 spec 的立场是：

> 个人运行时里同时活着的长程任务是 **1–5 个**，不是 1,000 个。在这个规模上值钱的不是更聪明的调度器和更严的治理器，而是三件事：**等待必须可兑现、每一步必须便宜、返工必须被看见。**

于是整个子系统收敛为：

| 物件 | 是什么 | 谁写 | 谁读 |
|---|---|---|---|
| **契约** `tasks/<id>.md` | frontmatter + Goal / DoD / Manual / Verification / Plan / 上次结果。4 KB 预算约束的是运行时写的那一段，人可直接编辑 | 用户、`task_create`、`task_update` | 每个 step 的 brief 全量注入 |
| **循环日志** `tasks/<id>.jsonl` | append-only：step / round / evidence / close，含成本 | 运行时 | brief 注入最近 K 条；其余走 `task_log` / `session_search` |
| **等待票** frontmatter 的 `ticket` | 「什么会把我叫醒，以及最迟什么时候」——由运行时校验、由运行时兑现 | `task_step_end` 写入，运行时校验 | 驱动器 |
| **任务会话** `tasks/.sessions/<id>-<cycle>.jsonl` | 一个 cycle 一份，与频道聊天会话完全分开，cycle 结束即封存 | 运行时 | 只有本任务的 step |

`effect-ledger.ts`、指纹、futile/wake 计数、三档 backoff、`[SILENT]` 协议、`task_verify` 工具、`## History` 内联历史全部退役。

`events` 子系统**本轮保留不动**（D8）：它的重叠是真的（F6），但它今天没有伤到任何人，而票据模型需要先在生产里站稳。本轮只补一条 `signal` 票，消除「事件能绕过票据叫醒任务」这唯一一个会破坏不变量的交叉点。

预期效果：任务侧源码从 5,338 行降到约 3,850 行（−28%，估算），委派与事件部分基本不动；任务文件从 30 KB 稳定在 4 KB 以内；一个 cycle 内的连续推进不再需要 5 分钟的 continuation 延迟；**「停泊的任务要么被叫醒、要么在兜底时限内告诉用户」成为一条可被单个 e2e 用例证明的不变量**。

## 1. 现状与证据

数字来自本机 `~/.pipiclaw`（2026-04 至 2026-09-05）与当前代码。

### F1 停泊等于失踪——这是本机观测到的**唯一**一类真实任务失败

`workspace/dm_manager3947/tasks/fix-tui-typecheck.md`，最后修改 2026-08-27，今天仍在原地：

```yaml
status: waiting
enabled: true
control: {"version":3,"nextAction":"在非并发敏感/稳定环境重新运行 npm run check，确认 subagent-phase1 全量运行不再超时；当前主分支发布已完成。","waitingFor":"external-signal","verification":{...}}
```

没有 `wake`，没有任何 `taskId` 指向它的在跑 run/job。按 `task-driving.md` 的规则，能让它恢复的只有「一个真实的 wake」或「一条已 settle 且 taskId 指向本任务的 run/job 记录」——两样都不存在。它已经**永久静默 9 天**。`nextAction` 说的其实是一次「过一阵子再试」，是 `time` 等待，模型却写了 `external-signal` 并忘了设 wake。

第二例更严重。`workspace/dm_015262473638858016/tasks/daily-pipiclaw-dev-review.md` 是用户每天真正在看的产出。运行时日志里：

| 日期 | `missed recurring occurrence` 警告条数 |
|---|---|
| 08-15 | 87 |
| 08-16 | 97 |
| 08-17 … 08-26 | 96–113 / 天 |
| 08-27 | 45（当天恢复） |

合计 1,243 条。`TaskDriver.runOnce` 检测到 occurrence 被错过之后只做一件事：

```ts
log.logWarning(`[${channelId}] Task ${entry.id} has a missed recurring occurrence; keeping the current cycle open`);
```

**没有升级、没有通知、没有自愈。** 一个 cycle 开着没关，下一个 cycle 就永远不会开；这个每日任务连续 13 天没有产出，用户是自己发现的。

根因在契约本身：`TaskWaitingFor` 的类型注释写着

```ts
/** Diagnostic display only (spec 043); it does not gate wake activation. */
export type TaskWaitingFor = "time" | "user" | "job" | "external-signal";
```

**唯一描述「我在等什么」的字段，被设计成与「这个等待能不能结束」无关。** 恢复权威分散在 `task-wake.ts` 的 `isVerifiedJobWake` / `isVerifiedDelegationWake` 和 driver 的 wake 比较里，而停泊那一刻**没有任何一处检查恢复源是否真的存在**。`/tasks doctor` 能查出来，但它需要用户先想到去跑。

### F2 任务文件 79% 是历史，而且永远卡在上限

| 文件 | 总字符 | `## History` | 占比 |
|---|---|---|---|
| `daily-pipiclaw-dev-review.md` | 30,293 | 23,811 | **78.6%** |
| `daily-news-briefing.md` | 28,830 | 22,905 | **79.5%** |

`MAX_INLINE_TASK_HISTORY_CHARS = 24 * 1024`、`MAX_INLINE_TASK_HISTORY_ENTRIES = 8`——两个文件都长期贴着上限，也就是说**这 24 KB 是稳态而不是峰值**。`task-driving.md` 要求每次唤醒「打开消息指定的 `tasks/<id>.md`，不要只依赖唤醒文本」，所以每一次唤醒都要把这 30 KB（≈ 12–15 K token）读进上下文，其中 79% 是过去八天的 cycle 记录，模型不会依据它做任何决定。

同一份历史还在别处存在：cycle 关闭时的 Completion Evidence、`log.jsonl`、以及（050 之后）`journal/YYYY-MM-DD.md`。这是第四份。

### F3 一个频道会话装着闲聊和所有任务

`workspace/dm_015262473638858016/2026-08-30T14-47-00-326Z_….jsonl`：**7.4 MB、1,200 条 entry、6 次 compaction**，覆盖 08-30 至 09-05，同时承载用户闲聊、`daily-news-briefing` 和 `daily-pipiclaw-dev-review`。

`state/usage/` 2026-08 + 2026-09：

| kind | 调用 | input | cacheRead | cost |
|---|---|---|---|---|
| turn | 443 | 143.7 M | 203.6 M | $33.93 |
| subagent | 166 | 173.2 M | 154.6 M | $80.55 |
| sidecar | 435 | 3.3 M | 0.01 M | $0.90 |

主回合平均每次 **~784 K units**（input + cacheRead）。这不是任务 brief 大，是**一个不断增长、被三种互不相关的工作共享的会话**：每次 compaction 同时损伤闲聊、A 任务和 B 任务的保真度，而任务 brief 又被迫每次从 30 KB 文件里重读（F2）。

这条还解释了 050 spec 的 F1：频道记忆里躺着「每日审查任务的阶段性发现」。任务态之所以能污染频道记忆，正是因为任务回合就发生在频道会话里，反思 pass 读的就是它。

### F4 返工循环每次手工重建，而且不留痕

`state/subagent-runs/dm_manager3947/` 里 `taskId=pipiclaw-quality-optimization-20260831` 的 15 条记录，按时间：

| # | run | purpose | 角色 / harness | 时长 | verdict |
|---|---|---|---|---|---|
| 1 | `run_d7s24t` | work | reviewer / codex-cli | 333 s | failed（进程） |
| 2 | `run_b5733c` | work | planner / claude-code | 666 s | — |
| 3 | `run_fbf8vv` | work | builder / claude-code | 671 s | — |
| 4 | `run_6k2mrd` | verify | reviewer / codex-cli | 683 s | **fail** (advisory) |
| 5 | `run_y4f7pj` | work | builder（follow-up） | 762 s | — |
| 6 | `run_dz5wxa` | verify | reviewer | 995 s | **fail** |
| 7 | `run_8t8q9w` | work | builder（follow-up） | 1192 s | — |
| 8 | `run_hsybdq` | verify | reviewer | 554 s | **fail** |
| 9–14 | … | work/verify ×3 轮 | | | **fail ×3** |
| 15 | `run_6gcezv` | verify | reviewer | 425 s | **pass** |

**7 轮返工、6 次 FAIL、2.4 小时委派墙钟。这次长程自主工作是成功的**——最终 PASS、提交、汇报都做到了。问题在于它在系统里留下的痕迹：

- 归档任务文件的 `control` 是 `{"version":3,"nextAction":"已完成…","verification":{"required":false,"status":"pending"}}`。**六次 FAIL 和一次 PASS 在任务状态里完全不存在。**
- `Current Cycle` 里堆了 **28 条**模型手写的段落，其中约一半是「已派发 X，等待」这类纯记账。
- 没有轮次预算。如果 reviewer 一直 FAIL，这个循环会一直转下去，直到 deadline 或用户发现。
- 每一轮的「主控核对 diff、筛掉 reviewer 的噪音、写下一轮 follow-up」都要模型在 F3 那个 7.4 MB 会话里重新组织一次。

### F5 治理器的信号是自证的，而且盯错了方向

`taskFingerprint` 用 10 个字段做指纹；`effect-ledger.ts` 数「外部可见效果」。后者的注释本身就是一份供词：

```
A synchronous command that exited 0 and returned output therefore counts too.
That is bypassable — `echo x` qualifies — but the alternative was a false negative on real work…
```

真实世界里的治理器动作：`Task driver disabled` 共 **2 次**，都在 2026-08-09；日志里 400 条「已停用任务 long-run」全部来自测试。也就是说，为了对付「空转」，我们维护了指纹 + effect 账本 + futile 计数 + wake 计数 + 三档 backoff（`continuationDelayMinutes: 5` / `stalledRetryMinutes: 60` / 0）+ `MAX_WAKES_PER_CYCLE = 500` + deadline，六套机制在生产里合计触发 2 次，而 F1 那类真实失败它一次都看不见。

`continuationDelayMinutes: 5` 还有直接代价：一个能立刻继续的任务，只要这一轮没让 effect 账本增长（例如「读完 reviewer 报告、决定下一轮做什么」），就要空等 5 分钟。

### F6 一整个事件子系统在为一条 cron 服务

| 组件 | 行数 |
|---|---|
| `src/runtime/events.ts` | 906 |
| `src/tools/event-manage.ts` | 286 |
| `src/runtime/event-commands.ts` | 229 |
| `src/runtime/event-validation.ts` | 125 |
| 合计 | **1,546** |

本机安装的事件：**1 个**。

```json
{"type":"periodic","channelId":"dm_015262473638858016",
 "text":"在 …/workspace 执行每日归档：…","schedule":"10 1 * * *"}
```

这是一个「周期性产出任务」——按 `event-scheduling.md` 自己的规则，它**本该是 task**。`state/events/history.jsonl` 两个月共 279 条记录、55 次触发。

与此同时，task 有自己的 cron（`schedule`）、自己的 30 分钟下限（`MIN_TASK_SCHEDULE_INTERVAL_MS`，与事件的下限逐条镜像）、自己的 dispatch 去重、自己的历史。两套调度器、两套校验、两套 `[SILENT]` 协议、两份 playbook（`event-scheduling.md` 与 `task-planning.md` 里各有一节专门教用户怎么在两者之间选）。

**本 spec 记录这条证据，但不在本轮退役 events（D8）。** 理由是优先级而不是分歧：events 今天没有伤到任何人（55 次触发全部正常），而 F1 那类故障正在伤人。合并两套调度器是一次纯收敛型改动，风险主要在迁移；等票据模型在生产里跑过一个版本周期之后再做，代价更小、回滚更容易。

### F7 成本不可归因

外部 run 记录里 `usage: null`、`usageKnown: false`、`turns: 0`、`toolCalls: 0`。2026-08-31 当天：subagent $23.68 + turn $1.49 = **$25.17**，全部落在频道维度。没有任何界面能回答「`daily-pipiclaw-dev-review` 这个月花了多少」或「刚才那 7 轮返工花了多少」。

`/tasks show` 显示的是任务文件全文——也就是 F2 里那 30 KB。

### F8 模型和用户都要背的概念面

任务状态：`status`(3) × `enabled` × `wake` × `schedule` × `control{deadline, nextAction, waitingFor(4), verification{required, status(3), runId}, cycleId, stop{by,reason,at}}`；正文 6 个标准小节 + 可选 Plan（4 态 checkbox）+ DoD checkbox。其中至少两对是**必须互相一致、否则要靠 doctor 查出来**的冗余：`enabled:false` ↔ `control.stop`，`status:active` ↔ future `wake`。

工具面：`task_list` / `task_create` / `task_update` / `task_close` / `task_verify` / `event_manage` / `subagent` / `subagent_inline` / `subagent_run` / `subagent_list` / `job` = **11 个**。

Playbook：`task-planning.md` + `task-driving.md` + `event-scheduling.md` + `background-jobs.md` + `agent-delegation.md`，其中前三份约 500 行专门解释这些状态之间怎么配合。

代码量：

| 域 | src | test |
|---|---|---|
| `src/tasks/` | 2,424 | |
| `src/runtime/task-*.ts` | 1,819 | |
| `src/tools/task-manage*` | 999 | |
| events（runtime + tool） | 1,546 | |
| `src/subagents/` | 5,775 | |
| `subagent-manage` / `job` / `job-manager` / `effect-ledger` | 1,838 | |
| **合计** | **14,401** | **9,120** |

## 2. 设计立场

1. **等待是一个可校验的断言，不是一段自然语言。** 任务说「我在等 X」时，运行时必须能当场判断 X 存在、X 会结束、以及 X 最迟什么时候结束。做不到就拒绝停泊。
2. **兜底时限是每一次等待的一部分。** 没有 `by` 的等待就是 F1。有了 `by`，「停泊的任务要么恢复、要么用户被通知」是一条可以写成一个测试的不变量。
3. **一个 cycle 一份上下文。** 长程工作的上下文生命周期应该与工作单元对齐，而不是与聊天窗口对齐。cycle 开始建、cycle 结束封存，中间自己压缩。
4. **步骤要便宜，判断才值钱。** 模型该在「reviewer 说了什么、下一轮改什么」这种地方花 token，不该在「重读 24 KB 历史」和「等 5 分钟 backoff」上花。能确定性完成的（导入验收结论、开下一个 cycle、记账）就不要开模型回合。
5. **可见性优先于自动化。** 不做全自动 work↔check 循环机——F4 里主控筛掉 reviewer 噪音的判断是真价值。要做的是把返工轮次、预算消耗和成本**变成用户看得见的数字**，并在到顶时停下来问人。
6. **一件事只有一个机制。** 一套调度、一套 cron 校验、一份历史、一处成本记账。

## 3. 目标对象模型

```
workspace/<channel>/tasks/
  <id>.md                     契约（人可读可编辑）
  <id>.jsonl                  循环日志（append-only）
  .sessions/<id>-<cycle>.jsonl  任务会话（一 cycle 一份）
  archive/<id>.md             已关闭的契约（+ 同名 .jsonl）
  .verifications/<hash>.json  验收 attestation（不变）
```

### 3.1 契约（`tasks/<id>.md`）

```yaml
---
state: open | parked | done
paused: {"by":"user","reason":"…","at":"…"}       # 可选；出现即暂停
schedule: 41 2 * * *                              # 可选；有则周期
ticket: {"kind":"run","id":"run_x","by":"…"}      # state=parked 时必需
cycle: {"id":"c-2026-09-05","startedAt":"…","steps":7,"rounds":2,"usd":3.21,"expired":0}
budget: {"steps":40,"wallMin":180,"usd":8,"rounds":4}   # 可选；缺省用代码常量
verify: required                                  # 可选，缺省 off
---
# 标题

## Goal / ## DoD / ## Manual / ## Verification / ## Plan

## 上次结果
（单段，覆盖写：结论、证据、剩余风险、成本）
```

变化点：

- `status` + `enabled` + `control.stop` + `control.cycleId` + `control.waitingFor` + `control.deadline` + `control.nextAction` + `control.verification`（4 字段） → `state` + `paused` + `ticket` + `cycle` + `verify`。**冗余对消失**：`paused` 存在即暂停（不再需要 `enabled` 与 `stop` 互相印证）；`state: parked` ⟺ `ticket` 存在（不再有 active + future wake 这种非法组合）。
- `nextAction` 退役：下一步属于日志最新一条 step，不属于契约。
- `deadline` 并入 `budget`（第 4 节 D6）。
- `## History` 退役 → `<id>.jsonl`。
- `## 上次结果` 是**唯一**留在契约里的历史，一段，覆盖写。周期任务下一轮开始时它就是「上次干了什么」。

### 3.2 三个时间尺度

| 尺度 | 定义 | 边界动作 |
|---|---|---|
| **cycle** | 一次性任务只有一个；周期任务每个 occurrence 一个 | 开：重置 `cycle` 计数、开新任务会话、Plan 复位（周期任务）。关：写 `## 上次结果`、封存会话、追加 journal、算总账 |
| **step** | cycle 里的一次模型回合，是频道队列里的一个普通条目 | 结束时必须调用 `task_step_end` |
| **round** | 一次「委派 → 验收」往返 | 由运行时在 `purpose=verify` run 结算时自动记账 |

## 4. 决策

### D1 三态 + 一张票

`state: open | parked | done`。`open` = 现在有活可干，驱动器会给它排 step；`parked` = 在等一张票；`done` = 已关闭并归档（文件移到 `archive/`）。周期任务两个 occurrence 之间不是第四种状态，就是 `parked` + `{"kind":"schedule"}` 的票——`sleeping` 概念退役。

模型不能直接写 `state`。它只有 `task_step_end` 的 `outcome`，运行时据此推导 `state`。这消除了今天 `SETTABLE_TASK_STATUSES` + `resolveTaskTransition` 的 13 个 action × 状态矩阵。

### D2 等待票：唯一的停泊方式，运行时校验，带兜底时限

```jsonc
{"kind":"time",     "at":"2026-09-06T09:00:00+08:00"}
{"kind":"schedule","at":"2026-09-06T03:00:00+08:00"}       // 它等的那次 occurrence
{"kind":"run",  "id":"run_zpy4mq", "by":"2026-09-05T12:40:00+08:00"}
{"kind":"job",  "id":"job_3",      "by":"…"}
{"kind":"ask",  "asked":"要不要合并到 master？", "by":"…"}
{"kind":"signal","event":"task.dm_1.weekly.checkin", "by":"…"}  // 见 D8
```

运行时在**写入时**强制的规则（违反 → `RecoverableToolError`，模型可自行改正）：

| 规则 | 拒绝理由文案（示意） |
|---|---|
| `parked` 必须带 `ticket`，`open`/`done` 不得带 | `outcome=park requires a ticket.` |
| `run`/`job` 的 id 必须存在于本频道 | `No run "run_x" in this channel. Use subagent_list to find the right id.` |
| `run`/`job` 必须**当前未结算** | `Run run_x already settled at …; read its result and continue instead of parking.` |
| `run`/`job` 的 `taskId` 必须等于本任务 | `Run run_x belongs to task Y; it will never wake this task.` |
| `time.at` 必须在未来；`schedule` 票要求任务有 `schedule` | |
| `signal` 的事件必须存在、是 `periodic`、属于本频道、名字指向本任务 | `Event "…" is one-shot; a sensor must be periodic. Use a time ticket instead.` |
| 每张票都必须有 `by` | 运行时**自动补**，模型不用写（见下） |

`by` 的默认值由运行时确定性推导，模型不需要（也不应该）自己拍：

| 票 | `by` |
|---|---|
| `run` | run 记录的 `deadlineAt` + 10 分钟；无 deadline 时取 `startedAt + maxWallTimeSec + 10min` |
| `job` | job 启动时间 + 24 小时 |
| `ask` | 现在 + 24 小时 |
| `time` | 就是 `at` |
| `schedule` | 下一次 occurrence + 一个 occurrence 间隔（即「错过一次就报警」） |
| `signal` | 该事件下一次 occurrence + 两个间隔 |

**兜底行为（这是 F1 的修复）：**

1. `by` 到点而票没兑现 → 运行时把任务置回 `open`，`cycle.expired++`，下一个 step 的 brief 以一句确定性的话开头：`你的等待票已过期：<摘要>。先确认真实状态，再决定继续还是重新停泊。`
2. **同一 cycle 内第二次过期** → 任务保持 `parked`、置 `paused{by:"runtime"}`，并向用户发一条**零 LLM 的确定性 receipt**：任务 id、标题、等的是什么、过期两次、`/tasks resume <id>` / `/tasks show <id>`。
3. `schedule` 票的过期就是今天那条只写日志的 `missed recurring occurrence`——现在它走同一条路径：第一次自愈（直接开下一个 cycle 并在 brief 里说明错过了一次），第二次通知用户。

**不变量（D2-INV）：** 任何 `parked` 的任务，要么在 `by` 之前被兑现，要么在 `by` 之后的一个 driver tick 内被重开或通知用户。没有第三种结局。这条不变量由一个确定性 e2e 用例证明（第 10 节 E1）。

`waitingFor`（4 个记录性枚举）退役。

### D3 任务会话：一个 cycle 一份上下文

每个 cycle 在自己的会话文件里跑：`tasks/.sessions/<id>-<cycleId>.jsonl`。频道的 `active-session.json` 指向的聊天会话**完全不参与**任务 step。

step 的 brief（系统提示 + 首轮消息）：

| 块 | 内容 | 预算 |
|---|---|---|
| 系统提示 | 任务循环专用的精简提示（身份、循环协议、可用工具、安全边界），**不是**频道聊天那份 | 目标 ≤ 1.2 K units |

> **实施偏离**：这一行**未落地**。任务 step 复用频道系统提示，循环协议由 brief（`src/tasks/brief.ts`）的收尾段承载。上下文隔离由任务会话本身拿到；再拆一套系统提示会牵动 `/context`、预算清单与 manifest，收益不抵风险。见 plan.md 的实施记录。
| `<task_contract>` | `tasks/<id>.md` 正文全文（≤ 4 KB，D5 保证） | ≤ 1.5 K |
| `<task_log>` | `<id>.jsonl` 最近 K 条（默认 8）渲染成行 | ≤ 1.0 K |
| `<memory_bootstrap>` | 050 的工作区 `MEMORY.md` + 频道记忆索引；**不含**当天 journal 尾部（那是聊天的上下文） | 按 050 预算 |
| 唤醒说明 | 为什么现在跑这一步：新 cycle / 票兑现（附结算摘要）/ 票过期 / 用户 steer / 上一步 continue | ≤ 0.3 K |

cycle 内的后续 step 复用同一会话（命中 prompt cache），只追加「上一步做了什么 + 本次唤醒说明」。会话自己压缩；**cycle 关闭 = 上下文重置**，所以周期任务不会跨天累积。

三个连带收益：

- 频道聊天会话不再被任务撑大（F3）。050 的反思 pass 读的是聊天会话，任务态因此不会再污染频道记忆（050 F1）。
- 任务不用每次重读 30 KB 文件——契约在会话里已经在了。
- `[SILENT]` 协议退役：**任务 step 默认不向频道发言**，只有 `task_step_end` 显式给了 `notify`、或 cycle 关闭 / 提问 / 预算耗尽 / 治理停止时才发。今天是「请你说 [SILENT]」，现在是「不说话是默认」。

**并发模型不变。** step 仍然是频道队列里的普通条目，占用频道的 turn slot、受 `beginTurn`/`endTurn` 管辖、可被 `/stop` 打断。**每个 step 结束就把频道让回去**，所以一个跑三小时的任务不会锁住聊天。变的只是三件事：step 在哪个会话里跑、`continue` 的排队延迟是 0、停止条件换成预算。

### D4 便宜的步：`task_step_end` 与零延迟续跑

任务会话里的模型只有一个收尾工具：

```ts
task_step_end({
  outcome: "continue" | "park" | "done" | "blocked",
  note: string,                 // 这一步做了什么、证据、下一步（进日志，不进契约）
  plan?: PlanStepPatch[],       // 同今天的 planSteps
  ticket?: Ticket,              // outcome=park 必填
  notify?: string,              // 要发给用户的话；缺省不发
  summary?: string,             // outcome=done 必填
  evidence?: string,            // outcome=done 必填
  residualRisk?: string,
  reason?: string,              // outcome=blocked 必填
})
```

- `continue` → 运行时**立刻**把下一个 step 排进频道队列，没有 backoff。`continuationDelayMinutes` / `stalledRetryMinutes` / `attemptDelayMs` 的三档 backoff 退役。
- `park` → 走 D2 的校验。
- `done` → 关 cycle。一次性任务归档；周期任务写 `## 上次结果`、封存会话、按 `schedule` 停泊。
- `blocked` → 等价于 `park` + `{"kind":"ask"}` + 必发 `notify`。

`task_update`（带 note 的 checkpoint 形态）与 `task_close` 在任务会话里不再需要，在聊天会话里保留（用户让 agent 建/改/取消任务时用）。

### D5 契约与日志分离

- `tasks/<id>.md` 只保留契约 + Plan + `## 上次结果`。4 KB 预算**只对 `## 上次结果` 生效**——它是运行时写的、且完整记录始终在循环日志里；超预算时先裁剪它、必要时整段丢弃。作者写的段落永不被删：只靠 Goal/DoD/Manual/Verification/Plan 就超预算时按原样写入并告警（真实迁移演练发现的修正，见 plan.md）。`## History` 及其 `MAX_INLINE_TASK_HISTORY_*` 折叠机制全部退役。
- `tasks/<id>.jsonl` 一行一条：

```jsonc
{"ts":"…","cycle":"c-2026-09-05","seq":7,"kind":"step","outcome":"park","note":"…",
 "tools":["subagent","read"],"usd":0.42,"units":38210}
{"ts":"…","cycle":"c-2026-09-05","kind":"round","n":3,"workRunId":"run_8t8q9w",
 "verifyRunId":"run_hsybdq","verdict":"fail","strength":"advisory"}
{"ts":"…","cycle":"c-2026-09-05","kind":"close","outcome":"done","usd":6.13,"steps":9,"rounds":7}
```

- cycle 关闭时向 050 的 `journal/YYYY-MM-DD.md` 追加一行（复用，不新建第四份历史）。
- 新增只读工具 `task_log({id, cycle?, limit?})`，供聊天会话回答「上次那个任务到底怎么了」。

### D6 预算取代治理器

每个任务可在 frontmatter 写 `budget`，缺省用代码常量：

| 键 | 默认 | 含义 |
|---|---|---|
| `steps` | 40 | 本 cycle 的 step 上限 |
| `wallMin` | 180 | 本 cycle 墙钟分钟（不含 parked 时间） |
| `usd` | 8 | 本 cycle 可归因成本上限（含未知成本 run 的按角色估值，见 D11） |
| `rounds` | 4 | 本 cycle 的返工轮次上限 |

任一项到顶 → `parked` + `paused{by:"runtime"}` + 确定性 receipt，附**具体下一步**：`/tasks resume <id> +steps 20`。用户的 `deadline` 需求写进 `budget` 的时间维度（`until` 绝对时间，可与 `wallMin` 并存）。

空转检测替换 futile 计数：**同一 cycle 内连续 2 个 step 没有产生任何工具调用** → 直接 `blocked` + 问用户。这是循环内部可以直接观察到的事实，不需要指纹、不需要 effect 账本、不可被 `echo x` 绕过。

退役：`src/agent/effect-ledger.ts`、`taskFingerprint`、`futileCount`、`wakeCount`、`MAX_WAKES_PER_CYCLE`、`FUTILE_WAKE_LIMIT`、`taskBudgetViolation` 的治理器角色、`isEligible`/`attemptDelayMs` 的三档表。

### D7 返工账本 + 验收自动导入

`purpose=verify` 且带 `taskId` 的 run 结算时，**运行时**（`SubAgentRunManager` 的结算路径，它已经是唯一 owner）：

1. 按现有机制校验 attestation（contract hash + artifact subject + 新鲜度，`src/tasks/verification.ts` / `artifact-subject.ts` 不变）；
2. 向 `<id>.jsonl` 追加一条 `kind:"round"`，含 `workRunId`（该 verify run 之前最近一个同任务 `purpose=work` run）、`verdict`、`strength`；
3. `cycle.rounds++`，并更新契约 frontmatter；
4. 兑现该任务的 `run` 票，唤起下一个 step，把 verdict 摘要放进唤醒说明。

**`task_verify` 工具退役。** 「导入 attestation」不是判断，是记账，不该占一个工具位和一次模型决策。模型仍然要做的判断没变：读 FAIL 的具体理由、决定哪几条真要返工、写下一轮 follow-up——这正是 F4 里有价值的部分，不自动化。

`verify: required` 时 `outcome: done` 仍然要求当前 cycle 存在一条新鲜的 `verdict: pass` round（校验逻辑复用今天 `complete` 前的重校验）。

`rounds` 到顶时的 receipt 直接给出最近三轮的 verdict 与一句话理由——这是 F4 里「6 次 FAIL 无痕」的正面修复。

### D8 events 保留；用一张 `signal` 票消除唯一的交叉点

F6 的重叠是真的，但**本轮不动 events**：`EventsWatcher`、`event_manage`、`/events`、`workspace/events/`、`state/events/history.jsonl` 全部原样保留，行为不变。

保留会留下**一个必须处理的交叉点**。今天一个 task-owned 传感器事件（`task.<channelId>.<taskId>.<use>`，`src/tasks/task-events.ts` 已经解析这个命名）触发时，做的是「往频道会话投一条唤醒文本，让模型自己想起来去推进那个任务」。D3 之后任务工作不在聊天会话里发生了，所以这条路要么失效，要么变成一条**绕过票据的恢复路径**——而 D2-INV 的全部价值就在于「停泊的恢复源只有一种，且可校验」。

修法是一张票，不是一个新机制：

```jsonc
{"kind":"signal", "event":"task.dm_1.weekly.checkin", "by":"…"}
```

- 只有 `signal` 票能被事件兑现，且**只能被名字里点名本任务的那个事件**兑现（复用 `parseTaskEventName`，不做前缀猜测）。
- 写票时校验：该事件文件必须存在、`channelId` 必须是本频道、必须是 `periodic`（`one-shot` 即使 gate 不通过也会被消费掉，做不了传感器）。不满足就拒绝，并提示改用 `time` 票轮询。
- `by` = 下一次 occurrence + 两个间隔（错过两次就报警），与 `schedule` 票同族。
- 兑现点在 `EventsWatcher.execute` 里、`orphanedOwnerReason` 之后：如果这是一个 task-owned 事件、且该任务正停在**指向本事件**的 `signal` 票上，就兑现票（唤起任务 step）而**不**向频道投递唤醒文本；否则走今天的原路径，一字不改。
- 事件的 `preAction` 语义完全不变——它仍然是那个「exit 0 才算触发」的门控，只是触发之后的收件人从聊天会话变成了任务循环。

这样 events 保留原样，任务的恢复源仍然只有票据一种，两者的边界是一行命名约定和一个已有的解析函数。

**下一轮的合并条件**（写在这里是为了不丢）：票据模型在生产里跑满一个版本周期、迁移器已有 v3→v4 的实战记录之后，再把 one-shot/periodic/preAction 分别映射到提醒任务与任务 `gate`，退役 1,546 行。本 spec 不为此预留任何字段或分支——真要做时它是一次独立的、纯收敛的改动。

### D9 驱动器瘦身

`TaskDriver` 只剩四件事：

1. **扫描**每个频道的任务，收集：到期的票、过期的票、`open` 且没有在排队的 step。
2. **兑现**：`time`/`schedule` 到点 → 开 cycle 或续 step。`run`/`job`/`ask`/`signal` 不由驱动器轮询——它们由各自的所有者推过来（见下）。
3. **兜底**：`by` 过期 → D2 的重开或通知。
4. **排队**：per-channel 轮转 + 每 tick 上限（沿用今天的 `maxDispatchesPerTick` 与 `nextChannelIndex` 公平性）。

四条推送边，各自由已有的 owner 负责，驱动器只做兜底：`SubAgentRunManager` 的结算（`run`）、`JobManager` 的结算（`job`）、`/tasks reply`（`ask`）、`EventsWatcher.execute`（`signal`，D8）。前两条的 `internalWake` 信任链（spec 040 D7/T9）原样保留，只是消费者从「频道会话的一个回合」换成「任务循环的下一个 step」。

预计 650 行 → ~260 行。`activateWaitingTask` / `rollbackWaitingTask` 的竞态处理简化为一次幂等的票据兑现（票只能被兑现一次，按 `dispatchId` 去重，沿用 `wake-claim.ts`）。

### D10 sub-agents：只动三处

委派本身是这套系统里最健康的部分（28 条 run 记录里 27 条 completed，角色目录设计good）。只改协作面：

1. **结算进任务循环**：`taskId` 存在时唤醒的是任务会话的下一个 step，不是频道聊天回合。
2. **验收自动记账**（D7）。
3. **成本必记**：`usageKnown:false` 时，按 harness 报告的可用信息落账；仍然拿不到就写 `costKnown:false` 并按角色的 `model` × 墙钟做一个**明确标注为估算**的下界，让 `budget.usd` 有东西可算。`/tasks show` 与 cycle close 报告显示「本周期 9 步 / 7 轮 / $6.13（其中 3 个外部 run 成本为估算）」。

外加一处便利（不改语义）：任务会话里调用 `subagent` / `subagent_inline` 时，`taskId` 由运行时自动填充，且契约摘要（Goal + 相关 DoD 条目）可由运行时拼进 `task` 的前言，模型少写一遍。`workingDirectory`、`mutates`、lease 规则完全不变——那些是 spec 040/042 的结论，本 spec 不碰。

### D11 用户面

命令：

| 命令 | 行为 |
|---|---|
| `/tasks` | 每行：id、标题、state、票据摘要 + 兜底时间、Plan 进度、本 cycle 预算消耗 |
| `/tasks show <id>` | 契约 + 最近 8 条日志 + 返工轮次表 + 成本；**不再**打印整个文件 |
| `/tasks log <id> [cycle]` | 更长的日志翻页 |
| `/tasks steer <id> <text>` | 注入下一个 step 的 brief（不打断当前 step），与聊天的 `/steer` 对称 |
| `/tasks reply <id> <text>` | 回答 `ask` 票 |
| `/tasks resume <id> [+steps N\|+rounds N\|+usd X]` | 解除 `paused` 并按需加预算 |
| `/tasks run <id>` / `pause` / `cancel` / `archive` | 同今天 |
| `/tasks doctor` | 保留但**降级**：D2 的写入时校验让今天 doctor 查的大部分病症不可能再产生，doctor 只查手工编辑造成的问题 |

`ask` 票的路由：提问 receipt 里明确写 `/tasks reply <id> …`；此外**当频道里恰好只有一个 `ask` 票在等、且用户的这条消息紧跟在那条提问之后**时，普通消息也路由过去，并在回执第一行点名是回给哪个任务。歧义时不猜。

零 LLM 的确定性 receipt 用于：票据二次过期、预算耗尽、返工到顶、`paused{by:"runtime"}`。它们不开模型回合（今天的治理 receipt 已经是这个形态，沿用）。

### D12 提示词与 playbook

- 任务循环用**独立的系统提示**，不复用频道聊天那份（后者含大量与长程执行无关的交互约定）。
- `task-planning.md` + `task-driving.md` 合并为一份 `task-loop.md`：循环协议（outcome 四选一、票怎么选、预算到顶怎么办）进**每一步的 brief**（原计划是独立系统提示，见 D3 的实施偏离）；playbook 只留**判断**——什么时候该建任务、契约怎么写、外部动作的幂等闭环、验收纪律。两份合计 ~330 行 → ~150 行。
- `event-scheduling.md` **保留**，只改两处：删掉与 task `waitingFor` / 回访事件相关的过时说明；加一段 task-owned 传感器改用 `signal` 票的写法。
- `agent-delegation.md` / `background-jobs.md` 保留，删掉其中与 `waitingFor`、`[SILENT]`、回访事件相关的段落。

### D13 配置

`settings.json` 依旧只收产品意图，本 spec 不新增任何数值键（`taskDriver.*` / `taskDigest.*` 早已在 `RETIRED_SETTINGS_KEYS` 里，保持）。预算默认值是代码常量；**单个任务的 `budget` 写在自己的 frontmatter 里**——那是任务级意图，不是全局调参。`tools.tasks.enabled` 保留为总开关，语义不变（不含 events，后者本轮未并入）。

### D14 迁移

一次性、确定性、无 LLM，启动时按频道执行（沿用 050 的迁移形态）：

1. `tasks/*.md` 的 v3 frontmatter → v4：`status`+`enabled`+`control` 映射到 `state`/`paused`/`ticket`/`cycle`/`verify`。`waiting` 且能推出恢复源的（有 wake → `time` 票；有在跑的 run/job → 对应票）照实转；**推不出来的直接转成 `open`**，并在第一个 step 的 brief 里说明「迁移时你的等待没有可兑现的来源，请重新确认状态」——`fix-tui-typecheck` 这类任务在升级瞬间就被救活。
2. `## History` 各条目 → `<id>.jsonl` 的 `kind:"step"` 记录（保留原文与 cycle 归属）；契约里只留最后一条作为 `## 上次结果`。
3. 原任务文件备份到 `tasks/.v3/`，不删。
4. 迁移标记 `state/task-migration-v4.done`。
5. `workspace/events/` **不迁移、不改动**（D8）；只有 task-owned 传感器事件所属的任务需要人工确认是否改用 `signal` 票，迁移器为这类任务在第一个 step 的 brief 里加一句提示，不自动改写事件文件。

## 5. 三者的协作面

这一节把 D1–D14 按「谁在什么时候叫醒谁」重新组织一遍，因为这才是用户抱怨的地方。

```
   EventsWatcher ─(仅 task-owned + preAction 通过)─┐
     └─ 其余事件：照旧投递到聊天会话              │ 兑现 signal 票
                                                  ▼
                       ┌──────────────── TaskDriver（票据调度）
                       │  扫票 → 兑现 / 兜底 / 排队
                       ▼
   ChannelQueue ──► step（任务会话，非聊天会话）
                       │
        ┌──────────────┼───────────────┬──────────────┐
        ▼              ▼               ▼              ▼
   subagent(taskId) bash async(taskId)  ask 用户      直接干活
        │              │               │
        │ 结算          │ 结算           │ /tasks reply
        ▼              ▼               ▼
   兑现 run 票      兑现 job 票      兑现 ask 票  ──►  下一个 step
        │
        └─ purpose=verify：自动校验 attestation → 写 round → 兑现票
```

**task × sub-agent.** 唯一的绑定是 `taskId`。派发即停泊（`run` 票），结算即续跑，验收结论自动进账本。三条今天靠 playbook 反复叮嘱的纪律（「不要轮询」「立即结束回合」「用 task_verify 导入」）里，前两条变成结构上做不到别的，第三条消失。

**task × job.** 与 sub-agent 完全同构（`job` 票）。`notify:false` 的 fire-and-forget 作业不产生票——如果任务要等它，运行时在写票时就拒绝：`Job job_3 was launched with notify:false and will not wake this task.` 这是今天 `background-jobs.md` 里一句用户需要自己记住的话，现在是一条拒绝理由。

**task × event.** 保持两个子系统，但只有一条边相连：task-owned 传感器事件兑现 `signal` 票（D8）。其余事件——包括本机那条 `daily-workspace-git-save`——行为一字不变，仍然投递到聊天会话。**任务的恢复源仍然只有票据一种**，这是 D2-INV 不被绕过的前提。纯提醒继续用 event，需要积累状态和验收的继续用 task；这条选择题本轮还在（`event-scheduling.md` 保留），是已知的、被接受的认知成本。

**task × memory（050）.** 三条边界：
- 任务 step 注入记忆索引（用于「我以前学到过什么」），**不注入当天 journal**；
- 反思 pass 只读聊天会话，任务噪音不再进频道记忆（修 050 F1）；
- 任务自己的经验沉淀在 `## Manual`（模型可用 `task_update` 改）与 cycle 关闭写进 journal 的那一行。**任务不写 `memory_save`**——这是今天最主要的记忆污染源。

**task × 聊天.** `<task_agenda>` 保留（`task-digest.ts`），但每行改成 D11 的形态（含票据摘要与预算）。用户在聊天里问进度 → agent 用 `task_log` 读，不需要打开任务会话。

## 6. 前后对照（用真实数据）

| | 今天 | 之后 |
|---|---|---|
| `daily-pipiclaw-dev-review.md` 大小 | 30,293 字符，79% 是历史，每次唤醒全读 | ≤ 4 KB 契约，日志按需读 8 条 |
| 08-15 → 08-27 的 13 天静默 | 1,243 条日志警告，用户自己发现 | 第一次错过 → 自愈并在 brief 里说明；第二次 → 确定性 receipt |
| `fix-tui-typecheck` | `waiting` + `external-signal`，永久静默 9 天 | 停泊时就被拒（无 id 的 `external-signal` 不存在）；迁移时直接转 `open` |
| 08-31 的 7 轮返工 | 状态里零痕迹，无轮次上限 | 7 条 `kind:"round"`，`rounds` 到 4 就停下问人 |
| 一步能立刻继续 | 至少等 `continuationDelayMinutes = 5` 分钟 | 0（直接排下一个 step） |
| 每步上下文 | 7.4 MB 共享会话 + 30 KB 文件重读 | cycle 私有会话 + 4 KB 契约 + 8 条日志 |
| 任务成本 | 不可归因（当天 $25.17 只落在频道） | `cycle.usd`，`/tasks show` 可见，超预算即停 |
| 调度器 | 3 个（TaskDriver / EventsWatcher / 结算唤醒） | 2 个（events 保留）+ 三条推送边（run / job / signal） |
| 任务的恢复源 | wake、已结算 run/job、事件唤醒文本、用户随口一说 —— 四条，都不校验 | 票据一种，写入时校验，带兜底时限 |
| 模型面 | 聊天会话 11 个工具，任务推进也在同一面上 | 聊天会话 11 个（`task_verify` → `task_log`）；任务会话是**独立的 8 个工具的小面**，不含 `event_manage` / `memory_save` / `task_create` |

## 7. 代码量估算

| 域 | 今天 | 之后（估算） | 变化 |
|---|---|---|---|
| `src/tasks/`（契约 / 票 / 日志 / cycle / 预算） | 2,424 | ~1,450 | −40% |
| `src/runtime/task-*.ts`（driver / commands / 迁移） | 1,819 | ~1,150 | −37% |
| `src/tools/task-manage*` + `task_log` + `task_step_end` | 999 | ~850 | −15% |
| `src/agent/effect-ledger.ts` | 96 | **0** | −100% |
| 任务会话 runner + 任务系统提示（新增） | 0 | ~400 | 新增 |
| **任务侧小计** | **5,338** | **~3,850** | **−28%** |
| events（4 个文件，本轮保留） | 1,546 | 1,546 + ~60（`signal` 兑现分支） | 持平 |
| `src/subagents/` + `job` / `job-manager` / `subagent-manage` | 7,517 | ~7,450 | 微调 |
| **合计** | **14,401** | **~12,900** | **−10%** |

减的全在任务侧，这是对的：委派本身没有病（F4），病在它和任务的协作面上；events 本轮按决定保留（D8），它的 1,546 行是已知的、被推迟的欠账。

测试同步收缩（`task-driver.test.ts` 的指纹/backoff/futile 用例、`events.test.ts`、`event-manage.test.ts`、`task-control.test.ts` 的 v1/v2 兼容用例），新增票据不变量、预算、返工账本、迁移四组用例。

## 8. 退役清单

代码：`src/agent/effect-ledger.ts`、`src/tools/task-manage/verification.ts`（工具部分；校验逻辑并入结算路径）、`src/tasks/transitions.ts` 的 action×status 矩阵、`src/tasks/control.ts` 的 v1/v2/v3 解析器（只留一份迁移专用读取器）、`task-driver.ts` 的 `taskFingerprint`/`attemptDelayMs`/`isEligible`/futile/wake 计数、`ledger.ts` 的 `MAX_INLINE_TASK_HISTORY_*` 与折叠。

契约字段：`status`、`enabled`、`control.waitingFor`、`control.nextAction`、`control.deadline`、`control.stop`、`control.verification.{status,runId}`、`control.cycleId`、`## History`。

工具：`task_verify`。

协议：`[SILENT]`（任务 step 侧；事件唤醒里的 `[SILENT]` 指令**保留**，因为事件仍投递到聊天会话）。

Playbook：`task-planning.md` + `task-driving.md` 合并为 `task-loop.md`；`event-scheduling.md` **保留**，只加一段说明 task-owned 传感器改用 `signal` 票。

**本轮不退役**（D8 的决定）：`src/runtime/events.ts`、`event-validation.ts`、`event-commands.ts`、`src/tools/event-manage.ts`、`/events` 命令、`workspace/events/`、`state/events/history.jsonl`。

## 9. 非目标

1. **`events` 子系统的退役**。F6 的证据成立，但本轮保留（D8）：它没有在伤人，而合并是一次纯收敛改动，等票据模型跑满一个版本周期再做更便宜。本 spec 不为将来的合并预留字段或分支。
2. **全自动 work↔check 循环机**（`subagent_review({work, check, maxRounds})`）。F4 证明主控在两轮之间的筛选是真价值；自动化会把 reviewer 的噪音直接变成 builder 的返工。本 spec 只把轮次**变成可见的、有预算的记录**。
3. **任务依赖图 / DAG**。今天「任务之间没有依赖字段，先后条件写进后继任务的 Goal」的结论保持不变——个人规模上，DAG 的运维成本远大于收益。
4. **逐动作审批门**。「task scope 就是 authority」保持不变；预算耗尽与返工到顶是新的、更诚实的刹车。
5. **跨频道任务、多租户、分布式执行、向量检索**。
6. **改动委派本身的语义**：`workingDirectory`、`mutates` 与 lease、外部 harness 契约、attestation 强度分级（enforced/advisory）全部保持 spec 040/042 的结论。
7. **任务会话的并发执行**。step 仍然占频道的 turn slot，串行，`/stop` 语义不变。

## 10. 验收

按 `AGENTS.md` 的三层分工，每条都要能指出它拦住的是哪一类回归。

### 单元

- 票据校验矩阵：每条 D2 规则一个用例（含「run 已结算」「run 属于别的任务」「run 不存在」三种拒绝文案）。
- `by` 推导表：五种票的默认兜底时限。
- 预算：四个维度各自到顶；`until` 与 `wallMin` 并存时取先到的。
- 空转检测：连续 2 个零工具 step → `blocked`。
- 契约渲染：`## 上次结果` 超长截断；文件恒 ≤ 4 KB。
- 迁移：v3 → v4 的五条映射；**特别是「waiting 且推不出恢复源 → open」**，fixture 用 `fix-tui-typecheck.md` 的脱敏副本。
- `signal` 票的写入校验：事件不存在 / 不是 periodic / 属于别的频道 / 名字不指向本任务，四种拒绝。

### 确定性 e2e（`test/e2e/deterministic/`）

| 用例 | 证明 | 它拦住的回归 |
|---|---|---|
| **E1（核心）** | 任务停在 `run` 票上，run 永不结算；时钟推过 `by` → 任务被重开；再停一次、再过期 → 用户收到 receipt 且模型请求数为 0 | F1：`fix-tui-typecheck` / 13 天静默那一类 |
| E2 | `schedule` 票错过一次 occurrence → 自愈开新 cycle；错过两次 → receipt | 今天只写日志的 `missed recurring occurrence` |
| E3 | `outcome: continue` 后下一个 step 在同一 tick 排队，且跑在**同一个任务会话文件**里；期间用户消息能插进频道 | D3/D4：backoff 复活、任务锁住频道 |
| E4 | `purpose=verify` run 结算 → jsonl 出现 `kind:"round"`，`cycle.rounds` 自增，票被兑现；模型没有调用任何导入工具 | D7：验收记账退回手工 |
| E5 | `rounds` 到顶 → `paused{by:"runtime"}` + receipt；`/tasks resume +rounds 2` 后可继续 | 无上限返工 |
| E6 | task-owned 传感器事件 preAction 通过 → 兑现 `signal` 票并唤起任务 step，**频道会话条目数不变**；同一事件在任务不持 `signal` 票时仍照旧投递聊天唤醒 | D8：事件绕过票据恢复任务，或反过来把普通事件也吞掉 |
| E7 | 一个 cycle 的 step 全部写进 `tasks/.sessions/…`，频道 `context.jsonl` 条目数不变 | D3：任务回流聊天会话 |
| E8 | 升级路径：v3 fixture 目录 → 启动后 v4 契约、`.jsonl` 历史、`.v3/` 备份齐全；`workspace/events/` 逐字节未变 | D14；以及「迁移顺手改了事件」这类越界 |

每条按 `AGENTS.md` 的规则：合并前先把它守的代码打破一次，确认用例变红，并把这一点写进用例注释。断言只看副作用（磁盘状态、发往 provider 的请求体、投递次数、run 记录），不看模型措辞。

### evals

新增 `task-loop-quality` 集（`evals/cases/task-loop-quality.ts`，三个用例）：票选得对不对（等后台作业时是停在 `job` 票上还是拍一个定时器）、`note` 是否写了证据而非愿望、预算到顶时是否给出可执行的下一步。不是门禁，实施时尚未跑过。

## 11. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 任务会话是本 spec 最大的实现面，可能牵动投递、AI 卡片、`/stop`、恢复 | step 仍是频道队列条目、仍走 `beginTurn/endTurn`、仍用同一个 `ChannelContext`；变的只有 SessionManager 指向哪个文件。P3 单独一个阶段，E3/E7 是它的门禁 |
| 零延迟续跑可能让一个任务连着占用频道 | step 之间让出 turn slot；`budget.steps` 默认 40；空转检测 2 步即停 |
| 成本估算（D10）不准会让 `budget.usd` 误停任务 | 估算值明确标注，且只在**没有真实用量**时使用；receipt 里写明「含估算」；用户可 `+usd` |
| 两套调度器并存，将来仍要合并 | 边界收窄到一条：只有 `signal` 票这一个兑现点（D8）。events 的代码路径本轮零改动，除了 `execute` 里那一个分支；E6 同时守住「该兑现时兑现」和「不该吞时不吞」 |
| 用户/模型仍要在 event 与 task 之间做选择题 | 本轮接受这个成本并写进 `event-scheduling.md`：纯提醒用 event，要积累状态和验收用 task；task-owned 传感器用 `signal` 票 |
| 迁移把 `waiting` 转 `open` 会让一批老任务同时醒来 | 迁移后首个 tick 每频道只放一个 step（沿用 `maxDispatchesPerTick`），且 brief 明确要求先确认真实状态再动作 |
| 任务不再写 `memory_save`，可能丢失跨任务经验 | 经验的正确归宿是 `## Manual` 与 journal；确实属于「频道长期事实」的，由聊天会话在用户确认后写入 |

## 12. 实施契约（交给实施 agent 的类型与不变量）

本节是**规范性**的：实施时以这里的类型和不变量为准，design 正文的散文解释与它冲突时以本节为准。类型放在指定文件里，不要再拆。

### 12.1 `src/tasks/ticket.ts`

```ts
export type TicketKind = "time" | "schedule" | "run" | "job" | "ask" | "signal";

export type Ticket =
  | { kind: "time";     at: string;  by: string }
  | { kind: "schedule"; at: string;  by: string }
  | { kind: "run";      id: string;  by: string }
  | { kind: "job";      id: string;  by: string }
  | { kind: "ask";      asked: string; by: string }
  | { kind: "signal";   event: string; by: string };

/** 校验一张模型提交的票并补全 `by`。纯函数 + 注入式查询，方便单测。 */
export interface TicketContext {
  now: Date;
  taskId: string;
  channelId: string;
  schedule?: string;                       // 任务自己的 cron
  findRun(id: string): RunRecord | undefined;
  findJob(id: string): JobSnapshot | undefined;
  findEvent(name: string): ScheduledEvent | undefined;
}
export function resolveTicket(input: unknown, ctx: TicketContext): Ticket;   // 失败抛 RecoverableToolError
export function ticketExpired(t: Ticket, now: Date): boolean;
export function describeTicket(t: Ticket): string;                          // 给 /tasks 与 receipt 用的一行摘要
```

`resolveTicket` 是**唯一**产生 `Ticket` 的入口。迁移器、`task_step_end`、`/tasks` 命令都走它；任何绕过它直接写 `ticket` 字段的代码都是缺陷。

### 12.2 `src/tasks/frontmatter.ts`

```ts
export interface TaskCycle {
  id: string;            // "c-2026-09-05" 或 "c-2026-09-05-2"
  startedAt: string;
  steps: number;
  rounds: number;
  usd: number;
  usdEstimated: boolean; // 有任何一笔是估算 → true（D10）
  expired: number;       // 本 cycle 票据过期次数；>= 2 触发 receipt
}
export interface TaskBudget { steps: number; wallMin: number; usd: number; rounds: number; until?: string }
export interface TaskPaused { by: "user" | "runtime"; reason: string; at: string }

export interface TaskFrontmatterV4 {
  state: "open" | "parked" | "done";
  paused?: TaskPaused;
  schedule?: string;
  ticket?: Ticket;                 // state === "parked" ⟺ ticket !== undefined
  cycle?: TaskCycle;
  budget?: Partial<TaskBudget>;    // 缺省合并 DEFAULT_TASK_BUDGET
  verify?: "required";             // 缺省 = off
  outcome?: "completed" | "cancelled";   // 仅归档文件
  closedAt?: string;
}
```

渲染顺序固定为 `state, paused, schedule, ticket, cycle, budget, verify`，每个字段一行；对象值是一行 JSON（沿用今天 `control:` 的写法，diff 友好、可手改）。

### 12.3 `src/tasks/log.ts`

```ts
export type TaskLogRecord =
  | { ts: string; cycle: string; kind: "step"; seq: number; outcome: StepOutcome;
      note: string; tools: string[]; usd?: number; usdEstimated?: boolean; units?: number }
  | { ts: string; cycle: string; kind: "round"; n: number; workRunId?: string; verifyRunId: string;
      verdict: "pass" | "fail"; strength: "enforced" | "advisory"; reason?: string }
  | { ts: string; cycle: string; kind: "expired"; ticket: string; action: "reopened" | "paused" }
  | { ts: string; cycle: string; kind: "close"; outcome: "done" | "cancelled";
      summary: string; evidence?: string; residualRisk?: string; steps: number; rounds: number; usd: number };
```

追加用 `shared/jsonl-appender.ts`；轮转沿用 `log.jsonl` 的策略。**日志只追加，永不重写**——`## 上次结果` 是它的投影，不是它的替代。

### 12.4 `task_step_end` 参数与推导表

```ts
type StepOutcome = "continue" | "park" | "done" | "blocked";
```

| `outcome` | 必填 | 运行时动作 |
|---|---|---|
| `continue` | `note` | 追加 `kind:"step"`；`cycle.steps++`；立即把下一个 step 排进频道队列；`state` 保持 `open` |
| `park` | `note`, `ticket` | `resolveTicket` 校验并补 `by`；`state="parked"`；写 `ticket` |
| `done` | `note`, `summary`, `evidence` | `verify: required` 时要求本 cycle **存在一条真实 PASS round**（不是轮次计数）；写 `## 上次结果`；追加 `kind:"close"`；封存会话；追加 journal；一次性任务归档，周期任务停到 `{"kind":"schedule"}` |
| `blocked` | `note`, `reason` | 等价 `park` + `{"kind":"ask"}` + 必发 `notify` |

`notify?: string` 缺省不投递。`plan?` 沿用今天 `planSteps` 的形状。

### 12.5 必须成立的不变量

实施 agent 要把这七条当作验收标准，每条至少有一个测试：

| # | 不变量 | 守它的测试 |
|---|---|---|
| INV-1 | `state === "parked"` ⟺ `ticket !== undefined` | 单元（frontmatter 往返） |
| INV-2 | 每张持久化的票都有合法的 `by`；`ticket` 只能由 `resolveTicket` 产生 | 单元（校验矩阵） |
| INV-3 | 任何 `parked` 任务，要么在 `by` 前被兑现，要么在 `by` 后一个 tick 内被重开或通知用户 | **e2e E1**（D2-INV） |
| INV-4 | 票据兑现幂等：同一 `dispatchId` 重放是 no-op | 单元 + e2e E4 |
| INV-5 | 任务 step 的会话条目只进 `tasks/.sessions/`，频道会话条目数不变 | e2e E7 |
| INV-6 | 运行时写的历史不会把契约撑大：`## 上次结果` 在写入时按 4 KB 预算裁剪，必要时整段丢弃（完整记录在循环日志里）。**作者写的段落（Goal/DoD/Manual/Verification/Plan）永不被删**——只靠它们就超预算时按原样写入并告警 | 单元 |
| INV-7 | 只有 `signal` 票能被事件兑现，且只能被名字指向本任务的那个事件兑现 | e2e E6 |

### 12.6 保持不动的东西（越界即缺陷）

- `src/runtime/events.ts` 除 `execute` 里新增的一个 `signal` 分支外，**零改动**；`event-validation.ts` / `event-commands.ts` / `event-manage.ts` 完全不动。
- `SubAgentRunManager` 仍是 settlement / usage / lease / 完成唤醒的唯一 owner，其幂等标记不得被新的记账逻辑破坏。
- `internalWake` 的信任链（spec 040 D7/T9）只换消费者，不换校验。
- `workingDirectory` / `mutates` / lease、外部 harness 契约、attestation 强度分级（spec 040/042）不动。
- `src/tasks/verification.ts`、`artifact-subject.ts` 的算法不动，只换调用点（从工具换到结算路径）。
- `settings.json` 不新增任何数值键。
- 迁移永不删除原件（`tasks/.v3/`）。
