# 周期任务原生化：schedule 收进 task frontmatter

| 字段 | 值 |
|------|------|
| 状态 | DRAFT |
| 日期 | 2026-07-17 |
| 前置 | 022 native task driver、024 task loop v2 |
| 关联实现 | `src/shared/task-ledger.ts`、`src/runtime/task-driver.ts`、`src/tools/task-manage.ts`、`src/runtime/task-commands.ts`、`src/runtime/events.ts`、`src/tools/event-manage.ts` |

## 问题

周期任务目前是"一个 task 文件 + 一个 canonical `.schedule` periodic 事件"的双载体：task 文件持有手艺（DoD、手册、返工教训），`task.<channelId>.<id>.schedule` 事件持有节奏（cron），两者用文件名约定和事件文本里的任务 id 缝合。frontmatter 的 `recurrence` 只是给人看的自由文本，没有机器语义。

这条缝上有三类靠纪律和 doctor 压住的漂移故障：

1. 建任务时忘建配套事件（任务永远睡着）；
2. 退役/取消时忘删事件（孤儿事件继续唤醒一整个 LLM 回合）；
3. 事件文本里的任务 id 写错（唤醒后 agent 找不到对应任务）。

病根是历史分层：events 先有（带着能用的 croner），native driver 后到；022 的"后续边界"有意把周期语义排除在那轮低风险落地之外，`.schedule` 于是成了兼容遗留。periodic 事件对周期任务做的唯一一件事——"到 cron 点时叫醒 channel 开新周期"——driver 自己完全干得了。

本 spec 把节奏收回 task 文件，让周期任务变成**单文件**：创建 = 写一个文件，退役 = 归档一个文件，三类漂移在构造上消失。这也顺带收干净了 event 层与 task 层的接缝：`.schedule` 命名约定退役后，task 派生事件只剩临时 sensor 一种真正响应式的场景，events 回归本分——非 task 提醒 + 外部传感器。

同轮一并收敛两件相邻的时间语义问题：**全系统去掉 `timezone` 配置**（cron 一律按主机时区解释，tasks 与 events 同语义），以及 **driver 的唤醒机制从固定 60 秒轮询改为单自适应 timer + nudge**（各见下方专节）。

## 非目标

- 不给 task schedule 加 `preAction` 式条件门控。需要条件开新周期的罕见场景，继续用临时 sensor 事件覆盖。
- 不补跑错过的多个 occurrence（与 periodic 事件同语义，只单次 catch-up，见下）。
- 不动 events 层的其他语义：除去掉 `timezone` 外，periodic 事件对非 task 场景照旧工作，per-item cron 定时器形态不变。
- 不做 per-task timer 表（理由见 driver 唤醒机制一节）。
- 不加 "过点即跳过" 的策略字段（需要时再说）。

## 设计

### frontmatter 契约扩展

平铺键从 4 个变 5 个，解析规则不变（逐行 `key: value`，第一个 `:` 切分）：

| 字段 | 必填 | 取值 | 说明 |
|------|------|------|------|
| `schedule` | 否 | 五段 cron | 周期节奏的唯一真相。存在 = 周期任务 |

**cron 一律按主机时区解释，不提供 `timezone` 字段或任何配置。** 个人助手跟着人走，任务节奏以主机时区为准；改时区的需求几乎不存在，不值得为它付一个必填字段和一类校验。periodic 事件同步去掉 `timezone`，全系统统一主机时区语义（见下方 events 一节）。

`recurrence` 保留为可选的人读标注（如 `每周一`），机器语义彻底移除；doctor 不再用它与事件配对。周期性判定统一改为 **`schedule` 是否存在**。

选平铺键而不是塞进 `control` JSON：task Markdown 有意保持 human-repairable（024 非目标），节奏是人最常想一眼看到、顺手修的字段，且与事件 JSON 的 `schedule` 词汇对齐。

### done 即预约下一轮

`task_manage done` 对有 `schedule` 的任务，在既有的那次原子写里追加一步：用 croner 计算下一次 occurrence，写成 `wake`。任务收尾后的状态是 `status: done` + `wake: <下一次开始时间>` ——"done 的周期任务 = 睡到下一轮"这个既有心智模型不变，只是睡醒时间从事件层挪进了文件本身。

`task_manage set` 允许修改 `schedule`（经校验）；若任务当前 `status: done`，同一次原子写里重算 `wake`。改节奏从"改事件文件"变成"改任务文件"，一处真相。

### driver 判定扩展

`actionable` 谓词本身不动。在其旁边加一条 **cycle-start ready** 判定：

```text
status == done AND schedule 存在 AND wake ≤ now
```

命中时 driver 派发一条 cycle-start 唤醒（文本变体：`Start a new cycle for task <id>`，引导读 `task-recurring.md` playbook、用 `task_manage start-cycle` 开新周期）。这是对"driver 不唤醒 done"规则的唯一放宽，且**没有引入新的双入口竞争，反而消灭了旧的**：原来 periodic 事件和 driver 就是两个唤醒入口，现在只剩 driver 一个。

配套语义：

- **不 claim attempt**。开新周期是 cycle 的第 0 步，`start-cycle` 随即会清空上一周期 usage；在这之前 claim 的 attempt 会被立即抹掉，没有意义。cycle-start 派发不计 attempt（与旧事件流一致——事件触发的回合本来也不计），后续正常唤醒照常 claim。
- **防热循环靠既有机制**。成功的 cycle-start 回合会执行 `start-cycle`（改 `cycleId`，已在 fingerprint 里）；失败的回合不改文件，unchanged fingerprint 走 `stalledRetryMinutes`（默认 60 分钟）退避重试。driver 不在派发时预写 wake——wake 只由 `task_manage`（done/set/start-cycle）和下述自愈路径写入，保持单写者。
- **自愈**：`status: done` + 有 `schedule` 但 `wake` 缺失/不可解析时，driver 不唤醒模型，而是确定性地重算并原子写入 `wake`（零 token，与 `escalateTask`/`claimTaskAttempt` 同类的 runtime 写行为），并记日志。避免 fail-open 直接开一轮意外周期。
- **paused 的收益**：periodic 事件不感知 `paused`，今天暂停一个周期任务后事件仍会每周唤醒一整个 LLM 回合去发现"哦它暂停了"。原生判定在扫描层就排除 `paused`，零 token。`/tasks resume` 后由下一次扫描接手。

唤醒的时间精度由下一节的 driver 机制保证：扫描时已知的 wake 到点即触发，不再受固定轮询间隔限制。

### driver 唤醒机制：单自适应 timer + nudge

固定 60 秒轮询改为按需睡眠。正确性原则：**timer 是提示，文件是真相**——每次醒来都从文件全量重算（`runOnce` 语义不变：治理 → 公平性 → 派发），扫描本身就是对齐，不存在需要与文件核对的 timer 集合。

```text
循环：全量扫描
  → 扫描顺手收集"下一个感兴趣时刻"：
      next = min(未到点的 wake、退避到期时刻、deadline)
  → setTimeout(min(next, maxSleepMinutes)) 睡眠
  → 醒来回到第一步

nudge()：进程内写路径唤醒 —— task store 写路径与回合 endTurn 调用；
  取消当前 timer，短去抖后立即重扫。/tasks run 保持既有的直接入队。
```

**为什么不是 per-task timer 表。** 治理检查（预算/截止/终态依赖）、忙碌 channel 跳过、5/60 分钟退避、跨 channel 轮转和每 tick 派发上限都需要全局视野；per-task timer 的触发回调要么重复这套逻辑，要么退化为"触发即全量扫描"——后者等价于单 timer，还多出一个需要对齐、可能与文件漂移的 timer 表。events watcher 的 per-item cron 定时器不受影响：事件彼此独立，没有这层耦合，per-item 形态在那一层是合身的。

**语义与收益：**

- 扫描时已知的 wake 秒级准点触发；空闲 workspace 里 daemon 彻底安静。
- 回合结束（endTurn）nudge 立即接续——今天 agent 写完 wake 后最坏干等 60 秒，改后连续推进的任务链即时衔接。
- 重启/休眠语义不变：启动即扫一次；休眠导致 timer 迟到，醒来的那次全量扫描自我修正。退避状态仍不持久化。
- 唯一退化：绕过 runtime 的手工编辑（不经 task_manage、不在回合内）最坏等一个封顶周期才被发现；`/tasks run <id>` 兜底。
- 设置：`taskDriver.maxSleepMinutes`（默认 15）替代固定扫描间隔，是空闲重扫的封顶，也是手工编辑延迟的上界。

### 校验前移

`task_manage create/set` 在落盘前校验（对应 `event_manage` 既有闸门的迁移）：

1. `schedule` 必须能被 croner 解析（不传 timezone 选项，即主机时区），推荐五段 cron；
2. 最密每 30 分钟一次（防自激励闸门原样搬来；task schedule 没有 preAction 放宽路径）。

### events 层去掉 `timezone`

事件契约与 tasks 统一为主机时区语义：

- `parseScheduledEventContent` 不再要求也不再读取 `timezone`；periodic 的 cron 交给 croner 时不传 timezone 选项（即主机时区）。`one-shot` 的 `at` 本就自带 ISO 8601 偏移，不涉及时区配置，不受影响。
- `event_manage` 的写入时校验同步删掉 timezone 要求；`/events list`/`show` 不再展示该列。
- **legacy 容错**：既有事件文件里的 `timezone` 字段被忽略，不作为解析错误——绝不能让旧文件被 watcher 当坏文件删除。装载时若该字段存在且与主机时区（`Intl.DateTimeFormat().resolvedOptions().timeZone`）不一致，向 `history.jsonl` 写一条 warning，提醒触发时刻会随主机时区偏移。
- `events-and-tasks.md` 全部示例与字段表删去 `timezone`。

写入时报错，而不是靠 doctor 事后发现。`start-cycle` 的门禁从"有 `recurrence` + canonical `.schedule` 事件"改为"有 `schedule` frontmatter（过渡期兼容 legacy `.schedule` 事件，见下）"。

### 删除的东西

- doctor 的两条配对检查整节删除：`recurrence` 无配套 `.schedule`、done 周期任务缺 `.schedule`；
- `.schedule` 命名约定与其文档；`taskScheduleEventName`/`isTaskScheduleEvent` 在迁移窗口结束后随 legacy 路径一起移除；
- `event-scheduling.md` / `task-recurring.md` playbook 与 `events-and-tasks.md` 中"周期任务 = task + periodic 事件成对"的全部内容，简化为"一个文件"；
- `timezone` 字段从事件契约、`event_manage` 校验与全部文档示例中删除；
- `taskDriver` 的固定扫描间隔设置由 `maxSleepMinutes` 取代；
- 退役周期任务 = `task_manage cancel`（或 done 后手工归档），不再有"记得删事件"这一步。`done`/`cancel` 按 `task.<channelId>.<id>.*` 前缀清理事件的逻辑保留（sensor 等临时事件仍需要它）。

## 兼容性与迁移

复用 022 处理 legacy `.checkin` 的交接先例：

- **双读窗口**：任务存在可解析的 canonical `.schedule` 事件时，该事件仍是节奏真相，driver 不对它做原生 cycle-start（避免双触发）；`schedule` frontmatter 与 `.schedule` 事件并存时，frontmatter 优先，doctor 提示删除事件。
- **doctor**：把 legacy `.schedule` 标为 migration 项，`Next step` 指导"把 cron 折进 frontmatter、删除事件文件"；若 legacy 事件的 `timezone` 与主机时区不一致，doctor 额外提示确认折入后的节奏语义。可选提供 `task_manage set` 一步完成折入。
- 既有 task 文件无需迁移；无 `schedule` 的任务行为完全不变。
- **legacy 事件的 `timezone`**：忽略字段照常装载（见 events 一节）；与主机时区不一致时在 `history.jsonl` 记 warning。不一致的场景理应罕见——个人助手与人同机同时区。
- `recurrence` 标注继续可读可写，只是不再有任何机器后果。

## 语义细节

- **错过的周期**：daemon 宕机跨过 wake 后，下一次扫描单次补触发（与 one-shot 补执行同语义）。这比 periodic 事件的"错过不补"更符合周期任务的期望——周一宕机，周二补写周报。不补跑多个 occurrence：补触发的那轮 `start-cycle` 后重新 done 时，wake 直接算到未来的下一次。
- **fail-open 层级**：frontmatter 整体不可读 → 维持既有 fail-open（视为 actionable，唤醒 agent 走 repair）；仅 `wake` 坏而 `schedule` 好 → 走零 token 自愈，不惊动模型。
- **cancelled/escalated/paused** 的周期任务不产生 cycle-start（terminal/暂停语义优先于节奏）。

## 测试重点

- 解析：新平铺键提取；`schedule` 存在性作为周期判定；`recurrence` 无机器效果。
- `done`：周期任务原子写入下一 occurrence 的 `wake`；一次性任务行为不变；`set` 改 schedule 后对 done 任务重算 wake。
- driver：cycle-start ready 判定；done 无 schedule 不唤醒；paused/cancelled/escalated 不唤醒；cycle-start 不 claim attempt；失败回合走 stalled 退避；wake 缺失自愈写入且不派发。
- 校验：cron 不可解析/密于 30 分钟被 create/set 拒绝。
- driver 唤醒机制：睡眠时长 = min(最近 wake、退避到期、deadline、封顶)；空闲时睡满封顶；nudge 取消 timer 并重扫（含去抖）；endTurn 触发 nudge；手工编辑最坏在封顶周期内被接起；start/stop 幂等不变。
- events：无 `timezone` 的 periodic 正常装载并按主机时区触发；legacy `timezone` 被忽略、不删文件，不一致时写 history warning。
- 迁移：legacy `.schedule` 存在时不双触发；frontmatter 优先；doctor migration 诊断；`start-cycle` 双门禁。
- 端到端：done → 睡眠 → 到点 cycle-start → `start-cycle` → 推进 → done，两轮跑通且 usage 按周期清零。

## 后续边界

本 spec 只搬节奏真相，不扩展周期语义。条件周期（schedule 级门控）、错过策略（skip-if-stale）、occurrence 级审计留待有真实需求时单独立项；`workspace/events/` 是否按 channel 分目录的问题，在 `.schedule` 退役后压力已基本蒸发，不值得迁移。
