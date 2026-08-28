# 交互与命令

> **适合谁**：日常在钉钉或终端中使用 Pipiclaw，希望知道消息发到哪里、忙碌时如何介入、哪些命令不消耗模型。
> **读完你能**：选择合适的入口和输出模式，理解频道隔离，并在任务运行中查看、纠偏、排队或终止工作。

## 两个入口，共用一套工作状态

Pipiclaw 有两个交互前端：

- **钉钉**是长期运行的主入口。daemon 通过 Stream Mode 收发消息，可使用 AI Card 展示进度并在后台工作完成时主动通知。
- **终端 TUI**适合本机调试、快速对话和脚本调用。它不需要钉钉凭据，但复用相同的模型配置、工具、记忆和频道文件。

```bash
pipiclaw                 # 钉钉常驻进程，等价于 pipiclaw run
pipiclaw tui             # 终端交互
pipiclaw tui --print "总结当前仓库"  # 一次性运行后退出
```

TUI 默认使用 `tui_local` 频道。`--channel <id>` 可以连接到已有频道的持久上下文；不要让 TUI 和钉钉 daemon 同时操作同一个频道。

TUI 适合前台对话和同步完成的内置委派，不是外部异步 run 的常驻宿主。当前只有 DingTalk daemon 配置了委派状态持久化、完成唤醒和重启对账；在 TUI 中启动外部角色后不会主动弹出完成通知，退出 TUI 也不会在下次启动时重新认领该 run。长时间外部委派请使用常驻 daemon。

## 频道如何隔离

Pipiclaw 把一次私聊或群聊称为一个**频道（channel）**：

| 场景 | 频道 ID | 隔离效果 |
|---|---|---|
| 钉钉私聊 | `dm_<staffId>` | 不同人的私聊互不可见 |
| 钉钉群聊 | `group_<conversationId>` | 每个群有独立上下文和记忆 |
| 默认 TUI | `tui_local` | 本机终端独立频道 |

每个频道拥有自己的会话、`SESSION.md`、`MEMORY.md`、`HISTORY.md`、任务台账、委派记录和冷存储历史。`workspace/MEMORY.md`、`ENVIRONMENT.md`、`AGENTS.md`、skills 和角色目录是工作区级共享配置。

同一个 daemon 可以并行推进多个频道：不同用户的私聊、不同群聊不会因为另一个频道正在等待模型而排成一条全局队列。同一频道内仍只有一个主回合；同一个群里的所有成员共享这条会话线。频道隔离也不等于项目文件隔离——多个频道指向同一个 checkout 时，主智能体的写操作仍可能冲突。部署和共享目录边界见[并发与容量](./scaling-and-concurrency.md)。

## 钉钉中的输出形态

`channel.json.responseMode` 控制钉钉如何展示一次回复：

| 值 | 体验 |
|---|---|
| `full_progress_then_plain_final` | 持续展示完整进度，结束后另发纯文本结论；默认值 |
| `rolling_progress_then_plain_final` | 只保留最近进度，结束后另发纯文本结论 |
| `final_card_only` | 隐藏过程，只在卡片中交付最终结果 |

没有配置 `cardTemplateId` 时仍可正常回复，只是不使用 AI Card。TUI 在 `settings.json.tui.responseMode` 使用同一组取值，但与钉钉设置彼此独立。

## 回合进行中如何介入

一个频道同一时刻只执行一个主回合。忙碌时可以使用：

- `/steer <消息>`：在当前工具步骤结束后调整方向。
- `/followup <消息>`：把新请求排到当前回合之后。
- `/stop`：停止当前回合；如果它由任务 driver 唤醒，还会暂停对应任务。

忙碌时发送普通消息，默认按 `channel.json.busyMessageDefault: "steer"` 处理；设置成 `"followUp"` 或 `"followup"` 后改为排队。

`/stop` 只停止主回合，不会杀掉已经派发并独立运行的委派 run。查看和终止委派请使用 `/subagents` 与 `/subagents cancel`。

## 运行时命令

下面的命令由运行时直接处理，不开启 LLM 回合，主回合进行中也能使用：

| 命令 | 作用 |
|---|---|
| `/help` | 列出所有命令（一行一个）；`/help <命令名>` 查看该命令的参数、子命令和示例；空闲时还会列出当前可用的 workspace skills 与 prompt templates |
| `/stop` | 停止当前回合；必要时暂停任务 |
| `/steer <消息>` | 调整当前回合 |
| `/followup <消息>` | 排队下一条请求 |
| `/events list\|show\|delete\|history` | 查看和管理定时事件 |
| `/tasks ...` | 查看、诊断和控制任务台账 |
| `/status` | 查看执行状态、模型、上下文、运行时长和版本 |
| `/usage [7d\|month]` | 查看频道与全局用量、成本和未知用量条目 |
| `/context [detail]` | 查看 system prompt 分段、工具 schema 和动态上下文体量 |
| `/subagents ...` | 查看、控制委派 run 和角色目录 |

常用任务命令：

```text
/tasks
/tasks show <id>
/tasks pause <id>
/tasks resume <id>
/tasks run <id>
/tasks set <id> <wake|next|deadline> <值>
/tasks doctor
```

常用委派命令：

```text
/subagents
/subagents list [running|failed|all]
/subagents show <runId>
/subagents output <runId>
/subagents cancel <runId|all>
/subagents roles [name]
```

## 会话命令

除 `/new` 外，下面的命令由 agent 会话层处理，需要在频道空闲时使用：

| 命令 | 作用 |
|---|---|
| `/memory [status\|list\|show <id>\|recent]` | 查看生效记忆、元数据、召回统计、墓碑和近期写入/删除活动 |
| `/session` | 查看当前会话、消息、token 和模型状态 |
| `/thinking [level\|cycle]` | 查看或切换当前模型的推理强度 |
| `/model [provider/modelId]` | 查看或切换模型；唯一子串也可匹配 |
| `/new` | 开启新会话，并在边界上固化必要记忆；忙碌时也可使用，会绕过旧队列立即建立新会话边界 |
| `/compact [要求]` | 手动压缩当前上下文 |

Workspace skill 还可以通过 `/skill:<名称>` 直接调用。未知斜杠命令会被拒绝并提示 `/help`，不会因为拼写错误开启一个模型回合。

## 附件交付

`send_media` 可以把本地图片和文件直接交付到当前会话。钉钉中图片以内联图片发送，其他文件作为可下载附件；TUI 会复制到终端下载目录并显示实际路径。目标频道由运行时绑定，模型不能自行指定另一个接收者。

## 常见问题

**为什么 `/model` 在忙碌时不能用？** 它会修改当前会话状态，因此只能在空闲时执行。`/status`、`/usage`、`/tasks` 和 `/subagents` 是只读或运行时控制面，忙碌时仍可用。

**为什么群里记得的事情，私聊里不知道？** 群聊与私聊是不同频道，默认隔离是为了避免信息泄漏。确实需要共享的稳定背景由管理员写入 `workspace/MEMORY.md`。

**如何继续上次 TUI 对话？** 重新使用相同的 `--channel`。没有 `/resume` 命令，频道本身就是持久身份。

## 相关文档

- 安装和首次接入：[项目 README](../README.md#快速开始)
- 频道记忆：[memory.md](./memory.md)
- 定时事件与任务命令：[events-and-tasks.md](./events-and-tasks.md)
- 委派命令与角色：[sub-agents.md](./sub-agents.md)
- 多频道并发与容量边界：[scaling-and-concurrency.md](./scaling-and-concurrency.md)
- 输出模式和字段：[configuration-reference.md](./configuration-reference.md)
