---
name: task-planning
description: 创建或重构长程任务（task）、在 task 与事件（event）之间取舍，或设定周期节奏（schedule）。
requires-tools: task_manage
priority: 40
---

# 长程任务（task）规划与建档

## 什么时候创建 task

只有工作需要**跨回合恢复**时才建：多步骤目标、等待人或外部系统、委派工作、周期性产出。当前回合能完成的简单请求不要建台账；纯提醒（无产出、无验收）用事件（event），见 `event-scheduling.md`。

## 创建内容

调用 `task_manage create`：

- `id`：稳定的 kebab-case。
- `title`：一句话标题。
- `goal`：最终要成立的**结果**，不写行动清单。
- `dod`：客观验收标准，每项必须是 `- [ ]` checkbox；纯 prose 或编号列表会被拒。
- `manual`：可复用的执行步骤、预检与返工教训。
- `verificationPlan`：验收者能独立执行的确定性检查。

默认独立验收（independent verification）加有限尝试预算。轻量记录性任务确实无需独立验收时，创建时设 `control.verificationMode: evidence`。

## control 决策

- `priority` / `deadline`：表达调度重要性和硬期限，不用 `wake` 冒充 deadline。
- `nextAction`：下一条可执行动作，避免写抽象愿望。
- `maxAttempts` / `maxTokens` / `maxCostUsd` / `maxWallTimeMinutes`：按风险和规模收紧；这些是**本周期、回合边界检查**的停止条件，不会中断正在运行的单个回合。模型没有价格元数据时不能使用 `maxCostUsd`，改用 `maxTokens`。
- `sideEffects`：`read-only`、`workspace` 或 `external`。发送、发布、部署、修改外部系统必须选 `external`。
- `isolation: worktree`：写密集型子任务需要隔离共享 checkout 时使用，见 `task-delegation.md`。
- `parent` / `dependsOn`：只用于真实分解；`parent` 表归属，`dependsOn` 表执行前置。

创建和 `set` 会拒绝不存在的关联、自指、parent 环和 dependency 环。父任务可以 `dependsOn` 自己的 child 表达 join；父任务有未闭环 child 时不能 done。

外部副作用与独立验收并存时，DoD/Verification 要验收"**待执行动作及其输入已准备正确**"（内容、目标、参数、预演、回滚方案），不要把尚未获批的外部动作本身写成 candidate 前必须勾选的项——否则会形成"先执行才能勾选"与"先验收批准才能执行"的死循环。实际执行结果由审批记录和 done evidence 收口。

DoD 描述最终可验收结果，不把未执行动作写成 `[x] skipped`。存在条件分支时，用一个结果项表达“完成 A，或在条件不成立时交付 B 并附理由”；执行哪条路径由 evidence 证明。

## 六个状态与时间

每个状态只对应一种 driver 行为：

- `active`：可推进（受 `wake` 门控）。
- `waiting`：等用户/外部条件/委派结果；等谁、等什么写进 `control.blockedReason`。
- `verifying`：只做独立验收，不继续实现。
- `paused`：driver 不运行。用户暂停记 `pausedBy=user`，治理器停止记 `pausedBy=governor`。
- `done`：完成；有 `schedule` 则原地睡到下次 occurrence，否则归档。
- `cancelled`：放弃并归档。

`wake` 是**最早重新检查时间**，不是截止时间。等待时设置现实的 `wake`；可继续时清空 `wake`，让 driver 按 cooldown 接续。

## 周期性任务（schedule）

一个周期任务就是**一个文件**：`tasks/<id>.md`。节奏写在 frontmatter 的 `schedule`（五段 cron，按主机时区解释；部署时用 `TZ` 固定所需 IANA 时区），做法与跨周期经验写在正文。没有配套事件，也没有 `.schedule` 命名约定。`recurrence` 只是给人看的可选标注（如 `每周一`），没有机器语义——**周期性 = `schedule` 是否存在**。

```
task_manage create id=weekly-report title=... goal=... dod=... schedule="30 9 * * 1"
```

cron 最密每 30 分钟一次，落盘前校验。纯提醒不建 task，用普通 periodic 事件。

**首次执行遵循 cron 语义**：不显式传 `wake` 时，create 会把 `wake` 预约到下一次 occurrence，任务处于 `active` + 未来 `wake`——像 crontab 一样，创建不等于立刻跑。需要立刻开跑就显式传一个当下或过去的 `wake`。

到点后 **runtime 直接开下一周期**，不需要（也没有）手工开周期的动作：折叠上一周期日志和 evidence 入 History、限制工作正文只保留最近周期、清空本周期用量与验收授权元数据、置 `active`，然后派发一条普通驱动唤醒。累计审计 usage 不会清零。你醒来面对的就是一个待推进的新周期，和其他唤醒无异。

- 改节奏：`task_manage set schedule="<新 cron>"`；任务当前是 done 时写盘会重算 `wake`。一处真相。
- 暂停 / 恢复：`/tasks pause <id>` / `/tasks resume <id>`。
- 退役：`task_manage cancel`，归档任务并清理全部 task-owned 事件。
- 上周期未完成：不要覆盖或虚勾 DoD。先完成、如实缩小本轮范围并验收，或与用户确认后 cancel 整项任务。

每轮闭环前把返工原因、预检步骤和格式偏好写回 Manual；跨任务可复用时才沉淀成 workspace skill。

## 建档后自检

创建后读取落盘文件，确认 Goal、DoD、Manual、Verification 和 control 与真实意图一致。后续每个驱动回合按 `task-driving.md` 推进。
