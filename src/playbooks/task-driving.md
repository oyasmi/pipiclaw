---
name: task-driving
description: 被 TASK_DRIVER 唤醒推进任务、留检查点，或任务停滞、被治理器暂停、元数据损坏时。
requires-tools: task_manage
priority: 41
---

# 任务（task）推进、断点恢复与修复

## 每次唤醒先恢复真相

1. 打开消息指定的 `tasks/<id>.md`，不要只依赖唤醒文本、旧对话或记忆。
2. 核对 status、最新 Current Cycle note、`nextAction`、`wake`、预算、依赖、`sideEffects` 和 verification。
3. 检查上一步产物**是否已经存在**。派发语义是 at-least-once，宕机或租约重放可能让同一步再次到达。
4. 只推进一个清晰的下一阶段；不要在未知状态下重复外部动作。

依赖未完成时 driver 跳过任务且不消耗 attempt；依赖缺失/cancelled/被治理器暂停、deadline 或累计预算耗尽会令任务被治理器暂停（`paused` + `pausedBy=governor`）。

## 回合结束必须留下确定性状态

仍开放且正文或进展发生变化时，用 `task_manage progress` 一次性记录：发生了什么、看到了什么证据、下一步是什么、status 与 `wake`。

以下生命周期动作本身就是原子 checkpoint，不要再追加 progress：`candidate`、`done`、`cancel`。

`verify` 只更新 control、不改正文。PASS 后若还要等外部审批（approval），用 `task_manage set wake=<合理时间>` 停留在 `verifying` 车道——**只改 wake、不换状态**，离开 verifying 会作废 PASS——并请用户 `/tasks approve <id>`。门禁的绑定规则见 `task-closeout.md`。除此之外不要用 `set` 代替正常进度日志。

## 等待与继续

- 等用户/外部系统/委派：`waiting` + 合理 `wake`，把等谁、等什么写进 `blockedReason`。
- 当前仍可继续：保持 `active`，清空 `wake`。
- 明确停止：由用户 pause；不要用极远的 `wake` 模拟暂停。

内建 driver 分钟级扫描 DingTalk `dm_*/group_*` channel，`wake` 到期后接续；无需 heartbeat、`.checkin` 或额外传感器。TUI 关闭后没有 daemon，不能自动唤醒。

有语义 checkpoint 时按较短 continuation delay 接续；只有用量变化、没有任务变化时按 stalled retry 退避。**不要为了拿到短退避而伪造 progress。**

## 汇报与静默

有用户需要知道的结果、风险、审批请求时正常汇报。纯内部周期检查且没有新结果时返回 `[SILENT]`，避免发空状态卡。完成时走 `task-closeout.md`。

---

# 诊断与修复

先用 `task_manage list` 看结构化状态；让用户用 `/tasks doctor` 看带 Next step 的一致性检查，用 `/tasks stats <id>` 看 attempts/token/cost/wall time、最近结果和 verifier 状态。

## 被治理器暂停（paused + pausedBy=governor）

治理器在 deadline、累计预算耗尽、终态依赖，或**连续 3 次唤醒都没有可见进展**（fingerprint 未变，含 silent）时暂停任务（旧称 escalated）。先读 Current Cycle 和 stats，判断是空转、范围错误、预算过小还是依赖终止：

- 方向错：修 Manual/`nextAction`、重新拆解或 cancel。
- 预算确实不足：向用户说明后用 `task_manage set` 调整 budget/deadline，并把 status 设回 `active`。
- 依赖终止：恢复或重建依赖，或 `set` 更新 `dependsOn`。

被暂停的任务不能 progress/candidate；`set`（或 `/tasks resume`）是审查原因后的修复入口，**不要反射性加预算**。

## 不唤醒或频繁唤醒

可推进 = 非 done/cancelled/paused，且 `wake` 缺失、无效或已到期。

- `paused`：用户 `/tasks resume <id>`。
- `wake` 太远：纠正 `wake`；急催用 `/tasks run <id>`。
- TUI 已关闭：没有 daemon，不能自动唤醒。
- 反复空转：查最新 note 和 `nextAction`，修 Manual。

## 坏 frontmatter / control

frontmatter 只认开头 `---` 块中的 status/wake/schedule/recurrence/control；`control` 必须是单行 JSON。driver 对不可读 frontmatter fail-open 以便唤醒修复，`task_manage` 对坏 control fail-closed 防止覆盖。

先 `read`，**只有此场景**才用 `edit` 修合法 frontmatter；随后用 `task_manage set` 让后续更新回到工具轨道。control 不确定时删除坏行，再用 `set` 重建默认结构。

## 失效的门禁与孤儿事件

改动契约段或产物后 done 被拒绝：重跑 verifier 或请用户重新 approve，不绕过。完整绑定规则和无失效顺序见 `task-closeout.md`。

done/cancel 会清理 `task.<channelId>.<id>.*` 事件；孤儿事件用 `event_manage` 删除。旧的 `.checkin` / `.schedule` 事件是 legacy——把 cron 折进 frontmatter 的 `schedule` 后删除事件，以 `wake` 为单一恢复条件（`/tasks doctor` 会给出迁移提示）。

daemon 重启会清空内存 cooldown，可推进任务可能很快重放。任务文件是恢复真相：每次先核对已完成产物，避免重复外部动作。
