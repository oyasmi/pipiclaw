# 运行机制说明（Runtime Mechanisms）

这份文档解释配置背后的运行行为。字段取值本身见
[configuration-reference.md](./configuration-reference.md)，快速上手见
[configuration.md](./configuration.md)。

## 模型与 fallback

主模型从 `settings.json.defaultProvider` + `defaultModel` 解析；没有设置时使用当前可用模型列表里的第一个。模型引用优先写成 `provider/modelId`，避免同名 model id 造成歧义。

`settings.json.fallbackModel` 是单个备用模型引用。主模型回合失败时（上下文超限除外），runtime 会用备用模型重跑这一轮；随后 5 分钟内的新轮次直接走备用模型，冷却后自动试回主模型。手动 `/model` 切换会清除 fallback 状态。`/status` 会显示 fallback 是否生效，usage ledger 按实际调用模型记账。

## 输出模式

钉钉 `channel.json` 的 `dingtalk.responseMode` 和终端的 `settings.json.tui.responseMode` 使用同一组取值：

| 取值 | 行为 |
|---|---|
| `full_progress_then_plain_final` | 展示完整过程，最后另发纯文本结论 |
| `rolling_progress_then_plain_final` | 只保留最近进度，最后另发纯文本结论 |
| `final_card_only` | 隐藏过程，只投递最终结果 |

后台唤醒默认不展示过程。后台作业、委派完成和定时事件投递到聊天会话，没有新结果时可返回 `[SILENT]`；任务步骤在任务车道里于任务自己的会话运行（不进聊天），回合结束这一步就结束，面向用户的内容通过 `task_report` 交付。

## 记忆维护

记忆属于工位（spec 050、058），由工位目录下的文件分层：`memory/<name>.md` 一条事实一个文件，生成的 `MEMORY.md` 是索引；`journal/YYYY-MM-DD.md` 是按天的工作记录。会话在各频道自己的会话区 `conversations/<kind>-<n>/` 里：`log.jsonl` / `context.jsonl` 是冷存储；`active-session.json` 存在时指定当前聊天 session JSONL，缺失则使用 `context.jsonl`。绑定到同一工位的频道共享记忆、各自保留对话；工作区级 `workspace/MEMORY.md` 和 `ENVIRONMENT.md` 是管理员维护的共享背景。这里的隔离是应用状态隔离，不是 OS 文件权限边界。

后台 memory maintenance scheduler 不使用事件文件。它只在本地 gate 通过后才发起 LLM sidecar：

| 任务 | 内置间隔 | 作用 |
|---|---:|---|
| Reflect | 20 分钟 | 从新对话中同时提炼 journal 新增行和 durable memory 增/改/删 |

另有两条固定约束：频道静默满 10 分钟才允许后台 LLM work，每个 tick 只处理 1 个会话区（只看激活工位中已绑定频道的会话区）。`settings.json.memoryMaintenance.enabled: false` 只关闭空闲定时反思；压缩、`/new` 和正常退出等边界仍可能触发同一个反思 pass，显式记忆工具也不受影响。`sessionSearch.summarizeWithModel` 默认已关闭，曾主动开启时可关闭以节省额外总结调用。

## 定时事件

事件文件位于 `workspace/desk-<name>/events/*.json`，`channelId` 是投递频道，须绑定在该工位上，否则到点跳过。当前只支持：

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

任务是一个由 Pipiclaw 作为负责人推进的一次性项目，在工位级的**任务车道**里于后台独立执行：契约、任务记录和运行时写下的状态分离，聊天与任务互不占用。

任务文件位于 `workspace/desk-<name>/tasks/<id>.md`，frontmatter 的 `channel` 是汇报频道；它不在该工位上时任务冻结。`tools.tasks.enabled` 同时门控三件事：全部 task_* 工具、任务车道开新步骤、每回合任务摘要注入。

当前任务模型没有 `parent`、`dependsOn`、`child` 或 worktree 隔离字段。先后关系写进后继工作项的文字，等待由运行时按事实推导；每个任务按自己的 Goal、DoD、Work Items 和预算收口。手工编辑造成的旧契约或损坏元数据用 `/tasks doctor` 检查；更早的任务格式见[事件与任务](./events-and-tasks.md#从更早的任务格式升级)。

任务车道是自适应 timer + 通知的扫描：最长每 15 分钟扫描一次，最近的约定时刻到来或收到通知（结果结算、你的消息、新任务）就提前醒；只扫描激活的工位。维护（到时的等待、有新输入的等待、超预算的暂停）零 token。执行槽每个工位最多 3 个、整个运行时最多 5 个，"执行中"与"等结果"占槽；每个执行中的任务有自己的 runner 和任务会话，单步 20 分钟后请求中止，未响应则暂停并通知部署者重启。绑定任务的委派与作业结算时直接把结果写进任务记录并通知车道，不再经过聊天。预算耗尽、连续两步没有工具调用、连续两次单步超时或连续三次出错时，运行时写 `paused{by:"runtime"}` 并直接通知用户，不再花一个模型回合去诊断。重启后车道对账每个活动任务（补写被打断步骤的结束记录），再继续。

周期与定时的工作不在任务里：事件带 `task` 模板，每次触发由 runtime 生成一个独立的任务实例，上一实例没结束就跳过并通知。任务本身没有 `schedule`，也没有单独的开周期动作。

## 智能体委派与验收

`workspace/sub-agents/*.md` 只加载实际存在的配置，不自动注入默认角色。角色分为两种 runtime：

- `internal` 在 Pipiclaw 进程内创建隔离上下文，使用 Pipiclaw 模型、工具白名单和安全守卫。没有角色文件时仍可通过 inline `systemPrompt` 临时创建内置角色。
- `external` 启动一次性的 Claude Code、Codex CLI 或任意脚本进程，使用目标 CLI 自己的认证、模型、工具和 sandbox。外部角色必须通过工作区角色文件配置，不能临时内联命令。

两者共用 `SubAgentRunManager`：注册 run、保存产出、结算状态、记录用量、释放工作区写锁，并通过 durable dispatch 唤醒所属频道。内置 run 最多同步等待 `min(maxWallTimeSec, 120s)`；没有在窗口内完成就转为后台工作。外部 run 的同步宽限恒为 0，派发后立即返回 `runId`。

`/stop` 只停止主回合，不影响独立 run。模型使用 `subagent_list` 查看、`subagent_run` 取消或续接，用户使用 `/subagents` 直接控制。DingTalk daemon 会持久化 run 并投递完成唤醒；外部 detached 进程在 daemon 重启时通过 pid 和产物协议重新对账，内置 run 无法跨进程存活，重启后标为 `lost` 并通知频道。没有 daemon 时终端内嵌的运行时在打开期间同样装配这套持久化与唤醒，但随终端退出而关闭，不能作为长时间外部 run 的可靠宿主。

检查使用 `purpose: verify`，要求最后一行是 `VERDICT: PASS` 或 `VERDICT: FAIL`。运行时只记录这个结论（run 记录与所属任务的看板），**不**把它当作关闭任务的门禁，也不做工作区快照或 attestation：

- 内置 verifier 会被结构性移除 write/edit，但默认工具集仍含 `bash`，仍可能写宿主机；只有声明 `mutates: read` 且不含 `bash` 的角色配置才是结构性只读。
- 声明 `mutates: write` 的 verifier 可以运行测试和构建，但验证期间会取得目标工作区（含父子目录冲突）的独占 lease；lease 只负责委派间互斥，不是只读沙箱。
- `exec` harness 仍不能承担检查，因为它没有协议终态；运行失败或没有 VERDICT 行一律记为 FAIL。

是否采信检查者的结论由负责人判断：对照真实产物、diff 和检查输出，并在汇报里写明谁检查了什么、结论如何；方法见 `task-lead.md`。带 `taskId` 的委派（任务会话里自动绑定）在派发和结算时写进任务日志。

## 日志与账本

结构化运行日志写到 `state/logs/runtime.jsonl`，用量账本按月写到 `state/usage/usage-YYYY-MM.jsonl`。`/usage` 聚合 turn、subagent、sidecar 三类 LLM 消耗。缺价格元数据时 token 仍记账、成本标为 unknown；Codex CLI 不报告成本，`exec` 连 token 也无法报告，不能把 unknown 当成 0 或免费。

`PIPICLAW_DEBUG=1` 会在对应 channel 目录写出 `last_prompt.json`，用于检查实际发送给模型的 prompt。
