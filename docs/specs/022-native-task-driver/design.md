# Native Task Driver 与原子进展 checkpoint

| 字段 | 值 |
|------|------|
| 状态 | IMPLEMENTED |
| 日期 | 2026-07-10 |
| 前置 | 019 task ledger、020 visibility/drivers |
| 关联实现 | `src/runtime/task-driver.ts`、`src/tools/task-manage.ts`、`src/shared/task-ledger.ts`、`src/agent/prompt-builder.ts` |

## 问题

019/020 已建立 task 持久状态、event 自调度、摘要和 doctor，但正常恢复仍要求管理员手工安装 heartbeat event、复制 `tasks-pending.mjs`、把 SOP 合入 workspace `AGENTS.md`，并要求 agent 双写 task `wake` 与 `.checkin` one-shot。能力存在却不是开箱即用，两个调度真相也容易漂移。

本轮目标不是增加用户概念，而是让已有 `wake` 兑现为 runtime 能直接执行的控制面：

1. `wake` 到期或缺省时，daemon 原生恢复任务；
2. 普通任务不再创建 `.checkin`；
3. 回合进展日志与 status/wake 在一次原子写中提交；
4. 坏任务不会形成高频 token 循环；
5. 旧 `.checkin` 在升级窗口内不会与 driver 重复唤醒。

## 控制循环

```text
cheap scan
  → select one actionable task per idle channel
  → legacy checkin handoff guard
  → cooldown / stalled backoff
  → bounded round-robin enqueue
  → agent reads task and advances DoD
  → task_manage progress atomically writes note + status + wake
  → next scan observes changed ledger or future wake
```

扫描每分钟执行一次，只读文件且不调用模型。actionable 继续沿用共享契约：

```text
status != done AND (wake missing/invalid OR wake <= now)
```

driver、摘要、`/tasks` 和 `task_manage list` 全部调用 `readActiveTasks`，不再存在仓库外的镜像解析器。

## 节流与公平性

- channel 正在运行：跳过，不向同一回合后面堆重复任务；
- task 文件自上次派发后有变化：`continuationDelayMinutes`，默认 5 分钟；
- task 文件无变化：`stalledRetryMinutes`，默认 60 分钟；
- queue 拒绝：按 continuation delay 重试；
- 每 tick 最多 `maxDispatchesPerTick` 个成功派发，默认 4；
- channel 扫描起点在最后一次成功派发后轮转，避免字典序靠后的 channel 饥饿；
- daemon 重启清空内存退避，遗留 actionable task fail-open 恢复。

退避状态刻意不持久化：它不是任务真相。重启后多一次恢复尝试比把卡死状态持久化更安全。

## 原子 progress

`task_manage progress` 接收 `id`、必填 `note`，以及可选 status/wake/recurrence。工具先读并校验现有文档，在内存中同时完成：

1. 向 Current Cycle 末尾追加一条 note；
2. 应用 frontmatter 变化；
3. 通过 `writeFileAtomically` 一次替换文件。

因此日常 checkpoint 不再出现“日志已写但 wake 未写”或“状态已改但下一步丢失”的半提交。`set` 保留用于只修 metadata，Goal/DoD/Manual 的大改仍走 edit/write。

## 兼容性

- 既有 task 文件无需迁移；frontmatter 契约不变。
- 既有 `.schedule` 继续负责开启周期任务的新一轮。
- 对既有 `.checkin`：当它的 one-shot 尚未触发或刚到点不超过 2 分钟，driver 暂时让它负责交接；被消费或过期超过 2 分钟后，driver 接管恢复。
- `/tasks doctor` 把 task-owned `.checkin` 标为 legacy，并指导删除、只保留 wake。
- TUI-only channel 没有常驻 transport，关闭 TUI 后不能被 native driver 唤醒；绑定 `dm_*/group_*` 的 TUI 台账可由同时运行的 DingTalk daemon 驱动。

## 系统提示

当 `task_manage` 实际注册时，runtime 才注入精简的 Persistent Tasks SOP：何时建 task、driver 唤醒时先读文件、回合结束必须 progress、等待只设 wake、done 必须有证据、周期任务只保留 `.schedule`。工具关闭时不宣传不存在的能力。

## 测试重点

- actionable/future/done 选择；
- active channel 跳过；
- changed continuation 与 unchanged stalled retry；
- legacy checkin 交接和过期恢复；
- timer start/stop 幂等；
- progress 原子写与标准章节校验；
- latest Current Cycle note 真正取最后一条；
- runtime service 启停接线；
- settings 默认值与安全范围 clamp；
- prompt/tool gating 与 doctor 升级诊断。

## 后续边界

本 spec 让“该醒时醒、醒后可可靠 checkpoint”成为默认能力，但不把 queue acceptance 提升为 work acknowledgement，也没有实现 occurrence lease、持久重试、独立 verifier 或 task dependency graph。这些属于下一层完成语义，不应与本轮低风险 driver 落地混在一起。
