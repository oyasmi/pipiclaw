# 运行机制说明（Runtime Mechanisms）

这份文档解释配置背后的运行行为。字段取值本身见
[configuration-reference.md](./configuration-reference.md)，快速上手见
[configuration.md](./configuration.md)。

## 模型与 fallback

主模型从 `settings.json.defaultProvider` + `defaultModel` 解析；没有设置时使用当前可用模型列表里的第一个。模型引用优先写成 `provider/modelId`，避免同名 model id 造成歧义。

`settings.json.fallbackModel` 是单个备用模型引用。主模型回合失败时（上下文超限除外），runtime 会用备用模型重跑这一轮；随后 5 分钟内的新轮次直接走备用模型，冷却后自动试回主模型。手动 `/model` 切换会清除 fallback 状态。`/status` 会显示 fallback 是否生效，usage ledger 按实际调用模型记账。

## 输出模式

钉钉 `channel.json.responseMode` 和 TUI 的 `settings.json.tui.responseMode` 使用同一组取值：

| 取值 | 行为 |
|---|---|
| `full_progress_then_plain_final` | 展示完整过程，最后另发纯文本结论 |
| `rolling_progress_then_plain_final` | 只保留最近进度，最后另发纯文本结论 |
| `final_card_only` | 隐藏过程，只投递最终结果 |

后台唤醒（任务 driver、后台作业、定时事件）默认不展示过程；没有新结果时可返回 `[SILENT]`。

## 记忆维护

记忆由频道文件分层：`SESSION.md` 是当前工作态，`MEMORY.md` 是稳定事实与偏好，`HISTORY.md` 是折叠后的旧摘要，`log.jsonl` / `context.jsonl` 是冷存储。频道之间隔离；工作区级 `workspace/MEMORY.md` 和 `ENVIRONMENT.md` 是管理员维护的共享背景。

后台 memory maintenance scheduler 不使用 `workspace/events/`。它只在本地 gate 通过后才发起 LLM sidecar：

| 任务 | 内置间隔 | 作用 |
|---|---:|---|
| Session refresh | 10 分钟 | 刷新 `SESSION.md` |
| Memory checkpoint | 20 分钟 | 从新对话中提炼 durable memory |
| Structural maintenance | 6 小时 | 清理/折叠过大的 `MEMORY.md` / `HISTORY.md` |

另有两条固定约束：频道静默满 10 分钟才允许后台 LLM work，每个 tick 只处理 1 个频道。`settings.json.memoryMaintenance.enabled: false` 会关闭整套后台维护；更常见的省 token 做法是只关闭 `memoryRecall.rerankWithModel` 和 `sessionSearch.summarizeWithModel`。

## 定时事件

事件文件位于 `workspace/events/*.json`，当前只支持：

- `one-shot`：未来某个时间触发一次。
- `periodic`：按五段 cron 触发，按主机时区解释。

`immediate` 已退役；当前要做的事应在当前回合直接完成，未来回访用至少 2 分钟后的 one-shot。

`preAction` 是触发前传感器：bash 命令退出 0 才唤醒 agent，非 0 静默跳过。无 `preAction` 的 periodic 最密 30 分钟；带 `preAction` 的 periodic 最密 5 分钟。事件触发采用 durable dispatch，语义是 at-least-once，所以事件处理必须可重试，外部动作要自己做幂等保护。

## 后台作业

`bash async: true` 会把长命令交给 per-channel job manager，立即返回 job id。`job` 工具负责 `list` / `poll` / `cancel`。

当前保证：

- 每个 channel 最多 5 个运行中 job。
- `poll` 单次最多等约 30 秒。
- 运行中 job 由 sweeper 定期探活；结束后自动释放运行名额。
- 默认会在 job 结束时唤醒当前 channel，唤醒文本包含退出码、耗时、输出尾部和完整输出路径。
- job 记录持久化在 app state 下，daemon 重启后会重新认领仍在运行或刚结束的 job。
- 终态 job 的记录和输出保留 24 小时后清理。

因此，等待后台作业时不要再创建 event check-in；启动 job 后结束当前回合即可。重要产物仍应由命令自己写入 workspace 文件，而不是只依赖 stdout。

## 长程任务

任务文件位于 `workspace/<channelId>/tasks/<id>.md`。`tools.tasks.enabled` 同时门控三件事：`task_manage` 工具、内建 TaskDriver、每回合任务摘要注入。

当前任务模型没有 `parent`、`dependsOn`、`child` 或 worktree 隔离字段。先后关系写进任务正文或用 `wake` 错开；每个任务只按自己的 Goal、DoD、Manual、Verification 和 control 收口。旧任务里残留的 retired control keys 会被读取层忽略，并由 `/tasks doctor` 报告。

TaskDriver 是自适应 timer + nudge，不固定每分钟轮询。它会根据最近的 `wake`、deadline、退避到期和回合结束 nudge 决定下一次扫描；单次最多派发 4 个 channel，同一 channel 每 tick 至多一个任务。连续 3 次 active wake 都没有可见进展时，治理器写 `enabled: false`、`status: active` 和 `control.stop.by: "governor"`，再直接通知用户。

周期任务只靠 task frontmatter 的 `schedule`。complete 后文件留在原地并进入 `sleeping`，到点后 runtime 确定性打开新周期，不需要 `.schedule` event，也没有单独的开周期工具动作。

## 子代理与验收

`workspace/sub-agents/*.md` 只加载实际存在的配置。没有配置文件也能通过 `subagent` 工具传 inline `systemPrompt` 委派。子代理不能再创建子代理；文件系统与主代理共享，`bash` 工具不是结构性只读沙箱。

独立验收使用 `purpose: verify` + `taskId`。verifier 无 write/edit，必须以 `VERDICT: PASS` 或 `VERDICT: FAIL` 结束。`task_manage verify` 导入 attestation；`complete` 会重新校验任务契约 hash 和 Git artifact subject，防止验收后内容变化。

## 日志与账本

结构化运行日志写到 `state/logs/runtime.jsonl`，用量账本按月写到 `state/usage/usage-YYYY-MM.jsonl`。`/usage` 聚合 turn、subagent、sidecar 三类 LLM 消耗；缺价格元数据时成本显示为 unavailable/0，但 token 仍记账。

`PIPICLAW_DEBUG=1` 会在对应 channel 目录写出 `last_prompt.json`，用于检查实际发送给模型的 prompt。
