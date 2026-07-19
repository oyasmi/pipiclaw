---
name: task-planning
description: Before creating or restructuring a persistent task, or choosing task versus event.
requires-tools: task_manage
priority: 40
---

# 长程任务规划与建档

## 什么时候创建 task

只有工作需要跨回合恢复时才建：多步骤目标、等待人或外部系统、委派工作、周期性产出。当前回合能完成的简单请求不要建台账；纯提醒用 event。

## 创建内容

调用 `task_manage create`：

- `id`：稳定的 kebab-case。
- `title`：一句话标题。
- `goal`：最终要成立的结果，不写行动清单。
- `dod`：客观验收标准，每项必须是 `- [ ]` checkbox；纯 prose/编号列表会被拒。
- `manual`：可复用的执行步骤、预检与返工教训。
- `verificationPlan`：验收者能独立执行的确定性检查。

默认 independent verification 和有限 attempt budget。轻量记录性任务确实无需独立验收时，创建时设 `control.verificationMode: evidence`。

## control 决策

- `priority` / `deadline`：表达调度重要性和硬期限，不用 wake 冒充 deadline。
- `nextAction`：下一条可执行动作，避免写抽象愿望。
- `maxAttempts` / `maxTokens` / `maxCostUsd` / `maxWallTimeMinutes`：按风险和规模收紧；预算是停止条件，不是目标。
- `sideEffects`：`read-only`、`workspace` 或 `external`。发送、发布、部署、修改外部系统必须选 external。若同时使用 independent verification，DoD/Verification 要验收“待执行动作及其输入已准备正确”，不要把尚未获批的外部动作本身写成 candidate 前必须勾选的项；实际执行结果由 approval gate 和 done evidence 收口。
- `isolation: worktree`：写密集型子任务需要隔离共享 checkout 时使用。
- `parent` / `dependsOn`：只用于真实分解；parent 表归属，dependsOn 表执行前置。

创建和 set 会拒绝不存在的关联、自指、parent 环和 dependency 环。父任务可以 dependsOn 自己的 child，表达 join；父任务有未闭环 child 时不能 done。

## 状态与时间

六个状态，每个只对应一种 driver 行为：

- `active`：可推进（受 wake 门控）。
- `waiting`：等用户/外部条件/委派结果；等谁、等什么写进 `control.blockedReason`。
- `verifying`：只做独立验收，不继续实现。
- `paused`：明确暂停，driver 不运行。用户暂停 `pausedBy=user`；治理器停止（预算耗尽等）记 `pausedBy=governor`，先诊断再修 control。
- `done`：完成；有 schedule 则原地睡到下次 occurrence，否则归档。
- `cancelled`：放弃并归档。

`wake` 是最早重新检查时间，不代表截止时间。等待时设置现实的 wake；可继续时清空 wake，让 driver 按 cooldown 接续。

创建后读取落盘文件确认 Goal、DoD、Manual、Verification 和 control 与真实意图一致。后续每个驱动回合按 `task-driving.md` 推进。
