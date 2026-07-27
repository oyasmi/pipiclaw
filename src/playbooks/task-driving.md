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

以下生命周期动作本身就是原子 checkpoint，不要再追加 progress：`candidate`、`done`、`skip`、`cancel`。

`verify` 只更新 control、不改正文。验收与外部审批的全部门禁规则（PASS/approval 的绑定与失效、两个门并存时的顺序）以 `task-closeout.md` 为准，需要时读它，不要凭记忆推断。除此之外不要用 `set` 代替正常进度日志。

## 等待与继续

- 等一个会自己叫醒你的信号（后台作业结束、用户回话）：`waiting` **且不设 `wake`** —— 这是停泊，driver 不会来打扰；等待形态的完整选择见 `task-delegation.md`。
- 等一个没人会通知的外部状态：`waiting` + 合理 `wake`，到点回访。
- 两者都把等谁、等什么写进 `blockedReason`。
- 当前仍可继续：保持 `active`，清空 `wake`。
- 明确停止：由用户 pause；不要用极远的 `wake` 模拟暂停。

内建 driver 分钟级扫描 DingTalk `dm_*/group_*` channel，`wake` 到期后接续；无需 heartbeat、`.checkin` 或额外传感器。TUI 关闭后没有 daemon，不能自动唤醒。

接续节奏由这一轮**实际做了什么**决定，不需要你去操纵：产生了可见 effect（write/edit/subagent/后台 job/给用户的回复，或一条跑通并有输出的同步 bash）就立即接续；只改了台账按 continuation delay；什么都没变按 stalled retry 退避。**不要为了拿到短退避而伪造 progress 或跑无意义命令**——真做事自然就快。

## 汇报与静默

有用户需要知道的结果、风险、审批请求时正常汇报。周期 occurrence 因去重或产物已存在而明确不执行时，调用 `task_manage skip` 写入简短原因、让任务重新休眠，然后返回 `[SILENT]`；不能只静默而把周期留在 active。除此之外，确实不需要改变任务状态且没有新结果时直接返回 `[SILENT]`。完成时走 `task-closeout.md`。

---

# 诊断与修复

先用 `task_manage list` 看结构化状态；让用户用 `/tasks doctor` 看带 Next step 的一致性检查，用 `/tasks stats <id>` 看本周期与累计 attempts/token/cost/wall time、最近结果和 verifier 状态。`cost: unavailable` 表示参与运行的模型缺少价格元数据，不表示免费。

## 被治理器暂停（paused + pausedBy=governor）

治理器在 deadline、累计预算耗尽、终态依赖，或**连续 3 次唤醒都没有可见进展**（fingerprint 未变，含 silent）时暂停任务（旧称 escalated）。先读 Current Cycle 和 stats，判断是空转、范围错误、预算过小还是依赖终止：

- 方向错：修 Manual/`nextAction`、重新拆解或 cancel。
- 预算确实不足：向用户说明后用 `task_manage set` 调整 budget/deadline，并把 status 设回 `active`。

被暂停的任务不能 progress/candidate；`set`（或 `/tasks resume`）是审查原因后的修复入口，**不要反射性加预算**。

## 不唤醒或频繁唤醒

driver 可推进状态包括 `active`、`waiting` 和 `verifying`：其中 `verifying` 会进入只读 checker 回合；三者还必须非停泊（`waiting` 且无 `wake`），且 `wake` 缺失、无效或已到期。`done` 周期任务只在下一次 `wake` 到期时由 runtime 打开新周期，`cancelled`/`paused` 不推进。

- 停泊中：这是有意的，等外部信号即可；确认没人会来叫时用 `/tasks run <id>` 或改回 `active`。
- `paused`：用户 `/tasks resume <id>`；若是治理器因预算耗尽暂停，得先 `/tasks set <id> attempts <n>` 放宽，否则 resume 会被拒绝。
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
