# 任务台账诊断与修复手册

> Pipiclaw 内置手册，随版本发布，只读。这里写的是 runtime 的硬约束与标准做法；个人化的偏好和团队策略写进 workspace `AGENTS.md`，或沉淀成 workspace skill。

先跑零成本诊断，再动手：让用户看 `/tasks doctor`（每条发现都附 Next step）和 `/tasks stats <id>`（attempts、token、cost、wall time、最近结果、verifier 状态），agent 侧用 `task_manage list` 拿结构化现状。修复动作永远走 `task_manage`，只有 frontmatter 本身坏到工具拒绝时才手工编辑。

## escalated：任务被升级了

driver 在以下情形把任务转为 `escalated` 并停止消耗 token：超过 `deadline`、任一累计预算耗尽（attempts/tokens/costUsd/wallTimeMinutes）、或某个 dependsOn 处于终态（缺失/cancelled/escalated）。

处置顺序（**先查原因，再放行**，不要反射性加预算）：

1. 看 Current Cycle 日志和 `/tasks stats`：是任务本身卡死空转，还是预算给小了？
2. 空转/方向错了 → 修正 Manual 或拆解方式，必要时 `cancel` 重建。
3. 预算确实不够 → `task_manage set` 调 `control.maxAttempts`/`maxTokens` 等或推后 `deadline`，同时把 `status` 置回 `in-progress`（escalated 状态下 progress/candidate 会被拒，set 是唯一放行入口）。
4. 依赖终态导致 → 先修依赖：恢复/重建被依赖任务，或 `set` 更新 `dependsOn` 列表移除已放弃的依赖。
5. 涉及预算追加或范围变更时，先向用户说明原因再动手。

## driver 不唤醒 / 唤醒太频繁

可推进判定 = `status` 未关闭（非 done/cancelled/escalated/paused）**且**（无 wake 或 wake ≤ now）。逐项排查：

- **不醒**：status 是不是 paused（让用户 `/tasks resume <id>`）？wake 是不是设到了远期？TUI-only channel 没有常驻 daemon，关掉 TUI 后 driver 无法唤醒——绑定 dm_/group_ 的台账才能被 DingTalk daemon 驱动。急催一次用 `/tasks run <id>`（清 wake 并立即入队）。
- **醒得慢**：这是节流，不是故障——上一轮改过 task 文件后最早 5 分钟继续；上一轮**没有留下任何台账变化**则退避 60 分钟。所以每个任务回合结束前必须诚实 `progress` 一次：runtime 的用量记账不算进展，没有语义性 checkpoint 就会吃 60 分钟退避。
- **空转烧 token**：查 Current Cycle 是否每轮都在重复同一步。停下来修 Manual 或 nextAction，而不是让它继续转。

## 孤儿事件

任务闭环走 `task_manage done/cancel` 会自动清理 `task.<channelId>.<id>.*` 事件；孤儿通常来自绕过闭环的手工操作。发现事件指向的任务已不存在（或已归档）→ `event_manage delete` 逐个清掉。反向孤儿：周期任务（有 recurrence）却没有 `.schedule` 事件 → 永远不会开新周期，用 `event_manage create` 补建。

## 坏 frontmatter / 坏 control

- 解析规则极简：文件以 `---` 开头、到下一个 `---` 为止；块内逐行 `key: value`；只认 status/wake/recurrence/control 四个平铺键；control 必须是**单行 JSON**。
- 判定是 fail-open 的：frontmatter 读不懂 → 任务视为可推进，driver 会唤醒你来修（这就是你现在在这里的原因之一）；而 `task_manage` 对坏 control 是 fail-closed 的——拒绝操作以免覆盖坏数据。
- 修法：read 该文件 → 用 edit 把 frontmatter 恢复成合法形态（这是唯一应该手工编辑 frontmatter 的场景；control 拿不准就整行删掉）→ 立即用 `task_manage set` 补齐 status/wake/control，让后续修改回到工具轨道。多行格式化过的 control JSON 也按此处理：压回单行或删除重建。

## 验收 PASS 失效（stale verification）

`verify` 导入的 PASS 绑定 task 正文 hash 和（Git checkout 上的）artifact subject。之后任何 progress、正文编辑、或代码/产物改动都会让它失效，`done` 会拒绝。这是防“验完再改”的门禁——处置永远是**重跑 verifier**（重新 candidate 或直接再委派 `purpose=verify` 子代理），不要寻找绕过的办法。外部授权同理：approve 后正文一变就 stale，需用户重新 `/tasks approve <id>`。

## 中断与恢复语义（宕机后不用慌）

- task 文件是唯一真相；事件可丢弃。回合中途失败，任务停在原状态，driver 按 wake 和退避把它接回来。
- daemon 重启清空内存退避状态，遗留的可推进任务会在下一次分钟级扫描被重新接起（有意的 fail-open）。
- dispatch 记录（`state/dispatch/`）带租约，过期会在重启后重放——同一份工作可能被至少一次地重新派发，所以推进前先读任务文件确认当前进度，别重复已完成的步骤。
- 升级窗口内的旧 `.checkin` one-shot：doctor 会标为 legacy，删掉即可，恢复交给 wake。
