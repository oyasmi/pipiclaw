---
name: task-repair
description: When a task is escalated, stalled, not waking, or has broken control metadata.
requires-tools: task_manage
priority: 44
---

# 任务诊断与修复

先用 `task_manage list` 看结构化状态；让用户用 `/tasks doctor` 看带 Next step 的一致性检查，用 `/tasks stats <id>` 看 attempts/token/cost/wall time、最近结果和 verifier 状态。

## escalated

driver 在 deadline、累计预算耗尽或 terminal dependency 时停止任务。先读 Current Cycle 和 stats，判断空转、范围错误、预算过小还是依赖终止。

- 方向错：修 Manual/nextAction、重新拆解或 cancel。
- 预算确实不足：向用户说明后用 `task_manage set` 调整 budget/deadline，并把 status 设回 in-progress。
- 依赖终止：恢复/重建依赖，或 set 更新 dependsOn。

escalated 不能 progress/candidate；set 是审查原因后的修复入口，不要反射性加预算。

## 不唤醒或频繁唤醒

可推进 = 非 done/cancelled/escalated/paused，且 wake 缺失、无效或已到期。

- paused：用户 `/tasks resume <id>`。
- wake 太远：纠正 wake；急催用 `/tasks run <id>`。
- TUI 已关闭：没有 daemon，不能自动唤醒。
- 反复空转：查最新 note/nextAction，修 Manual；不要伪造 progress 换短 cooldown。

## 坏 frontmatter/control

frontmatter 只认开头 `---` 块中的 status/wake/recurrence/control；control 必须是单行 JSON。driver 对不可读 frontmatter fail-open 以便唤醒修复，task_manage 对坏 control fail-closed 防止覆盖。

先 read，只有此场景才用 edit 修合法 frontmatter；随后用 task_manage set 让后续更新回到工具轨道。control 不确定时删除坏行，再用 set 重建默认结构。

## stale gate

PASS 和 external approval 都绑定 task body；PASS 还可能绑定 Git artifact subject。progress、正文编辑或产物变化后 done 会拒绝：重跑 verifier或请用户重新 approve，不绕过。组合流程见 `task-closeout.md`。

## 事件与重启

done/cancel 会清理 `task.<channelId>.<id>.*`；孤儿事件用 event_manage 删除。recurring task 没有 canonical `.schedule` 则补建。旧 `.checkin` 是 legacy，删除并以 wake 为单一恢复条件。

task 文件是恢复真相。daemon 重启会清空内存 cooldown，可推进任务可能很快重放；durable dispatch 租约也提供至少一次派发。每次先核对已完成产物，避免重复外部动作。
