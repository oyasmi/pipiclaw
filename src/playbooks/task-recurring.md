# 周期性任务操作手册

> Pipiclaw 内置手册，随版本发布，只读。这里写的是 runtime 的硬约束与标准做法；个人化的偏好和团队策略写进 workspace `AGENTS.md`，或沉淀成 workspace skill。

一个周期性任务 = 一个 task 文件 + 一个 canonical periodic 事件：

- `tasks/<id>.md` 积累手艺：目标、DoD、手册、每轮返工教训，跨周期不清零；
- 事件 `task.<channelId>.<id>.schedule` 只管节奏（cron）。

**改节奏改事件，改做法改 task 文件，互不牵连。** 节奏的真相在事件里，`recurrence` 字段只是给人读的标注。

## 第一步：判断要不要建 task

- 只是定点提醒、无产出、无验收（“每天 9 点提醒我开例会”）→ 只建一个普通 periodic 事件（名字不用 `task.` 前缀），事件文本写清提醒内容即可，不建 task。
- 每轮有产出、有验收标准、值得积累做法（周报、巡检、数据核对、回访）→ task + `.schedule` 成对创建。

## 创建（成对、一次完成）

1. `task_manage create`：
   - `id` 用 kebab-case（即文件名），`title` 是一句话标题；
   - `goal` 写这项工作每轮要达成的结果；
   - `dod` 必须是 Markdown checkbox 列表（每行 `- [ ] 标准`），纯文字或数字列表会被拒——candidate/done 只认可勾选的项；
   - `manual` 写可复用的操作步骤（每轮复盘后回来改进它）；
   - `verificationPlan` 写验收者可执行的确定性检查；
   - `recurrence` 必填（如 `每周一`）——没有它，之后 `start-cycle` 会被拒；
   - 需要时在 `control` 里设 `priority`、`deadline`、预算（`maxAttempts` 等）、`sideEffects`。
2. `event_manage create`：
   - `name` 必须是 `task.<channelId>.<id>.schedule`（channelId 是当前 channel；events 目录全局共享，前缀防跨 channel 撞名）；
   - `definition` 是完整事件 JSON，例：

   ```json
   {"type": "periodic", "channelId": "<当前channel>", "text": "推进任务 weekly-report：读取任务文件，若上一周期已 done 则开启新周期", "schedule": "30 9 * * 1", "timezone": "Asia/Shanghai"}
   ```

   - 闸门：periodic 最小间隔 30 分钟（带 `preAction` 传感器时 5 分钟）；immediate 一律被拒；事件总数上限 50。

## 周期如何运转

- **done = 睡眠**。周期任务 done 后文件留在原地，driver 不会唤醒 status: done 的任务；新一轮只由 `.schedule` 事件开启，两个入口不竞争。
- `.schedule` 触发后，先读完整 task 文件，再分情况：
  - 上一周期已 done → `task_manage start-cycle`（`cycleId` 用稳定命名，如 `2026-W29`）。它在一次原子写里：开启具名新周期、把上一周期日志折叠进 History、清零本周期的 attempts/token/cost/wall-time 用量、独立验收状态、外部授权和 worktree 元数据，status 置 in-progress。**不要手工编辑状态来开新周期。**
  - 上一周期还没 done（逾期）→ `start-cycle` 会被拒。先处置旧周期：能补完就按手册补完走正常闭环；确实不做了，与用户确认后如实调整正文和 DoD（标注本轮实际范围与原因），再闭环。**不要为了开新周期而虚勾 DoD。**
- 周期内的继续、等待、恢复全部由内建 task driver 依据 `wake` 处理（见系统提示的 Persistent Tasks 规则），不需要额外事件。

## 每轮结束前的复盘（这是周期任务的核心价值）

闭环一轮时，把本轮学到的写回 **Manual**：返工原因、预检步骤、格式偏好。事件无记忆，task 会积累手艺——下一轮的自己直接受益。只有当教训跨任务可复用时，才提炼成 workspace skill。

## 调整与退役

- **改节奏**：`event_manage update` 该 `.schedule` 事件（整体替换 definition）。task 文件里顺手把 `recurrence` 标注改一致（`task_manage set`）。
- **暂停一段时间**：让用户 `/tasks pause <id>`，或 `task_manage set status=paused`；`.schedule` 可留着（driver 不会动 paused 任务，但事件仍会触发回合，若要彻底安静就把事件也删了，恢复时再建）。
- **退役**：`task_manage cancel`（带 `reason`）——它会归档任务文件并清掉**全部** `task.<channelId>.<id>.*` 事件（含 `.schedule`）。不要只删事件不动任务，那会留下一个永远不再被唤醒的活任务。

## 常见错误

- 事件名漏了 `task.<channelId>.<id>.` 前缀 → 收尾时清不到、跨 channel 可能撞名。
- 用 `done` 之外的方式“完成”周期（比如手工把 status 改成 done）→ 绕过门禁，用量与验收状态不会被正确结算。
- 给周期任务再建 `.checkin` one-shot → 多余，`wake` 本身就是恢复条件。
