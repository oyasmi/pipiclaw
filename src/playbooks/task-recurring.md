---
name: task-recurring
description: Before creating, rescheduling, pausing, or retiring a recurring task.
requires-tools: task_manage
priority: 43
---

# 周期性任务

一个周期任务就是**一个文件**：`tasks/<id>.md`。节奏在 frontmatter 的 `schedule`（五段 cron，按主机时区解释），做法与跨周期经验在正文。没有配套事件，也没有 `.schedule` 命名约定。

`recurrence` 只是给人看的可选标注（如 `每周一`），没有机器语义。周期性 = `schedule` 是否存在。

## 创建

按 `task-planning.md` 创建 task，并给 `schedule`：

```
task_manage create id=weekly-report title=... goal=... dod=... schedule="30 9 * * 1"
```

cron 最密每 30 分钟一次，落盘前校验。纯提醒（无产出、无验收）不建 task，用普通 periodic event。

**首次执行遵循 cron 语义**：不显式传 `wake` 时，create 会用 croner 把 `wake` 预约到下一次 occurrence，任务 `active` + 未来 `wake`，到点才由 driver 派发普通驱动唤醒——像 crontab 一样，创建不等于立刻跑。需要立刻开跑就显式传一个当下/过去的 `wake`。

## 周期运行

done 的周期任务留在原地睡眠：`task_manage done` 后，"唯一时间规则"会用 croner 算出下一次 occurrence 写入 `wake`，状态是 `done` + 未来的 `wake`。

到点时 **runtime 直接开下一周期**（无需你做任何事，也没有 `start-cycle` 动作）：折叠上一周期日志入 History、清空本周期用量/验收/授权/worktree 元数据、置 `active`，然后派发一条普通驱动唤醒。你醒来面对的就是一个待推进的新周期，和其他唤醒无异。

- 上周期未完成：不要覆盖或虚勾 DoD。先完成、如实缩小本轮范围并验收，或与用户确认后 cancel 整项任务。

周期内继续、等待和恢复只用 task `wake`。

## 复盘、调整和退役

每轮闭环前把返工原因、预检步骤和格式偏好写回 Manual；跨任务才沉淀 workspace skill。

- 改节奏：`task_manage set schedule="<新 cron>"`；若任务当前 done，写盘时"唯一时间规则"会重算 `wake`。一处真相。
- 暂停：`/tasks pause <id>`；`/tasks resume` 恢复。
- 退役：`task_manage cancel`，归档任务并清理全部 task-owned events。

周期由 runtime 自动开启，不需要（也没有）手工开周期的动作。
