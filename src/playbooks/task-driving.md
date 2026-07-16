---
name: task-driving
description: Resuming a task on a TASK_DRIVER wake or event, checkpointing, or choosing the next action.
requires-tools: task_manage
priority: 41
---

# Task driver 推进与断点恢复

## 每次唤醒先恢复真相

1. 打开消息指定的 `tasks/<id>.md`，不要只依赖 wake 文本、旧对话或记忆。
2. 核对 status、最新 Current Cycle note、nextAction、wake、预算、依赖、sideEffects 和 verification。
3. 检查上一步产物是否已经存在。driver/dispatch 提供至少一次恢复，宕机或租约重放可能让同一步再次到达。
4. 只推进一个清晰的下一阶段；不要在未知状态下重复外部动作。

依赖未完成时 driver 跳过任务且不消耗 attempt；依赖缺失/cancelled/escalated、deadline 或累计预算耗尽会令任务 escalated。

## 回合结束必须留下确定性状态

仍开放且正文/进展发生变化时，用 `task_manage progress` 一次性记录：

- 发生了什么；
- 看到了什么证据；
- 下一步是什么；
- status 与 wake。

以下生命周期动作本身就是原子 checkpoint，不要再追加 progress：`candidate`、`done`、`cancel`、`start-cycle`。

`verify` 只更新 control、不改正文。若 PASS 后还要等待 external approval，使用 `task_manage set status=awaiting-user wake=<合理时间>`，并向用户请求 `/tasks approve <id>`；不要 progress，因为正文变化会使 PASS 失效。除此之外不要用 set 代替正常进度日志。

## 等待与继续

- 等用户：`awaiting-user` + 合理 wake。
- 等外部系统/委派：`blocked` + 合理 wake。
- 当前仍可继续：保持 `in-progress`，清空 wake。
- 明确停止：由用户 pause；不要用极远 wake 模拟暂停。

内建 driver 分钟级扫描 DingTalk `dm_*/group_*` channel。wake 到期后接续；无需 heartbeat、`.checkin` 或额外传感器。TUI 关闭后没有 daemon，不能自动唤醒。

有语义 checkpoint 时按较短 continuation delay 接续；只有用量变化、没有任务变化时按 stalled retry 退避。不要为了获得短退避伪造 progress。

## 汇报与静默

有用户需要知道的结果、风险、审批请求时正常汇报。纯内部周期检查且没有新结果时返回 `[SILENT]`。完成时走 `task-closeout.md`，异常或 escalated 走 `task-repair.md`。
