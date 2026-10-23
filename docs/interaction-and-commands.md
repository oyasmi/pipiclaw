# 交互与命令

> **适合谁**：日常在钉钉或终端中使用 Pipiclaw，希望知道消息发到哪里、忙碌时如何介入、哪些命令不消耗模型。
> **读完你能**：选择合适的入口和输出模式，按需隔离工作区，并在任务运行中查看、纠偏、排队或终止工作。

## 两个入口，共用一套工作状态

Pipiclaw 有两个交互前端：

- **钉钉**是长期运行的主入口。daemon 通过 Stream Mode 收发消息，可使用 AI Card 展示进度并在后台工作完成时主动通知。
- **终端 TUI**适合本机调试、快速对话和脚本调用。它不需要钉钉凭据，默认打开同一个个人助手，复用模型配置、工具、记忆、任务和工作文件。

```bash
pipiclaw                 # 钉钉常驻进程，等价于 pipiclaw run
pipiclaw tui                      # 直接打开个人助手
pipiclaw tui --desk lab --create    # 工位不存在时先创建
pipiclaw tui --print "总结当前仓库"  # 一次性运行后退出
```

省略 `--desk` 时固定打开 `default`，即使已有多个工位也不变；需要选择隔离工作区时才用 `--desk <名字>`。TUI 打开的工位可以已经绑定了钉钉频道，也可以正由 daemon 服务：两边共享这个工位的记忆、任务、事件和文件，记忆与任务的写入有跨进程锁。TUI 有自己的会话区（`conversations/tui-N/`），不会接着某个钉钉频道的对话往下聊；同一个工位同一时间只能开一个 TUI。TUI 里能用 `/desk` 查看和创建工位，但不能绑定：绑定只在钉钉频道里做。

TUI 适合前台对话和同步完成的内置委派，不是外部异步 run 的常驻宿主。当前只有 DingTalk daemon 配置了委派状态持久化、完成唤醒和重启对账；在 TUI 中启动外部角色后不会主动弹出完成通知，退出 TUI 也不会在下次启动时重新认领该 run。长时间外部委派请使用常驻 daemon。

## 工位与频道

Pipiclaw 是同一个助手，**工位（desk）**划分不同工作的状态：每个工位拥有自己的记忆（`memory/*.md`，生成 `MEMORY.md` 索引）、`journal/`、任务、定时事件、委派记录和工作文件，放在 `workspace/desk-<名字>/` 下，也是 agent 的工作目录。**频道（channel）**是消息的地址：一次私聊或一个群。

| 场景 | 频道 ID |
|---|---|
| 钉钉私聊 | `dm_<staffId>` |
| 钉钉群聊 | `group_<conversationId>` |
| 终端 TUI | `tui`（默认打开 `default`，可用 `--desk` 选择） |

- 首次运行自动创建 `default`。新私聊和新群在第一条获准消息到来时自动绑定到它，直接聊天即可；已有绑定不会被覆盖。需要独立记忆和文件时才用 `/desk new <名字>`、`/desk bind <名字>`。
- 一个频道同时只绑定一个工位；一个工位可以绑定多个频道。绑定到同一个工位的频道**共享**记忆、任务、事件和文件，**对话各自独立**：每个频道在工位里有自己的会话区（`conversations/dm-1/`、`group-1/`…），`/new` 只重置当前频道的会话。别的频道说过的原话，agent 用 `session_search` 去查。
- 任务和定时事件记着自己的**投递频道**，结果只发到那里。投递频道换绑到别的工位后，它们暂停；绑回来自动恢复。一个工位失去所有绑定后整体休眠：事件不触发，任务不推进，正在跑的委派照常结束但不再通知。
- `workspace/MEMORY.md`、`ENVIRONMENT.md`、`AGENTS.md`、skills 和角色目录是所有工位共享的工作区级配置。

同一个 daemon 可以并行推进多个频道：不同用户的私聊、不同群聊不会因为另一个频道正在等待模型而排成一条全局队列。同一频道内仍只有一个主回合；同一个群里的所有成员共享这条会话线。工位之间的隔离也不等于项目文件隔离——多个频道指向同一个 checkout 时，主智能体的写操作仍可能冲突。部署和共享目录边界见[并发与容量](./scaling-and-concurrency.md)。

### `/desk` 命令

| 命令 | 作用 | 回合进行中 |
|---|---|---|
| `/desk` 或 `/desk list` | 列出所有工位、各自绑定的频道（显示名称）、本频道当前的工位，以及休眠或不可用的工位 | 可用 |
| `/desk new <名字>` | 创建一个空工位，不绑定任何频道。名字只能用 1–32 个小写字母、数字和连字符 | 可用 |
| `/desk bind <名字>` | 把本频道绑定到这个工位，同时解除原来的绑定。回复会说明原工位是否进入休眠、有几个任务和定时事件因此暂停 | 拒绝，等本回合结束后再发 |

绑回一个以前绑定过的工位时，沿用本频道在那里的会话区，接着之前的对话；想重新开始就 `/new`。绑定关系也写在服务器上的 `workspace/CHANNELS.md`（「工位」一列）和 `workspace/desk-bindings.json` 里。

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

- `/steer <消息>`：在当前工具调用结束后调整方向。
- `/followup <消息>`：把新请求排到当前回合之后。
- `/stop`：停止当前回合；如果它由任务 driver 唤醒，还会暂停对应任务。

忙碌时发送普通消息，默认按 `channel.json.busyMessageDefault: "steer"` 处理（这条说明也在 `/help steer` 里）；设置成 `"followUp"` 或 `"followup"` 后改为排队。正在跑的是后台任务的一步时，普通消息和 `/steer` 都不会进入任务会话，而是排到这一步之后作为普通聊天处理；要给任务补充指示，用 `/tasks steer <id> <内容>`。

`/stop` 只停止主回合，不会杀掉已经派发并独立运行的委派 run。查看和终止委派请使用 `/subagents` 与 `/subagents cancel`。

回合进行中发送一个需要空闲的命令，会收到一条忙碌提示，列出"运行中可用"和"需要等空闲"的两组命令。两组都由命令目录的 `availableWhileBusy` 派生，所以和 `/help` 的分组永远一致。

## 运行时命令

下面的命令由运行时直接处理，不开启 LLM 回合，主回合进行中也能使用：

| 命令 | 作用 |
|---|---|
| `/help` | 按"随时可用 / 空闲时可用"两组列出所有命令；`/help <命令名>` 查看该命令的用法、子命令和示例；空闲时还会列出当前可用的提示模板 |
| `/stop` | 停止当前回合；必要时暂停任务 |
| `/steer <消息>` | 调整当前回合 |
| `/followup <消息>` | 排队下一条请求 |
| `/desk [list\|new <名字>\|bind <名字>]` | 查看、创建工位，把本频道绑定到一个工位；未绑定的频道也能用 |
| `/events list\|show\|delete\|history` | 查看和管理定时事件 |
| `/tasks ...` | 查看、诊断和控制任务台账 |
| `/status` | 查看执行状态、模型、上下文、运行时长和版本 |
| `/usage [7d\|month]` | 查看本工位（以及其中本频道）与全局的用量、成本和未知用量条目 |
| `/context [detail]` | 查看系统提示词、工具定义和每回合自动附加内容的体量；`detail` 列出各分段来源和工具、skill 清单 |
| `/subagents ...` | 查看、控制委派 run 和角色目录 |
| `/skills [list\|show <name>]` | 列出工作区 skills（含未通过内容扫描而未加载的，附原因），或查看单个 skill 的完整正文 |

常用任务命令：

```text
/tasks
/tasks show <id>
/tasks pause <id>
/tasks resume <id> [+steps N|+usd X]
/tasks steer <id> <内容>
/tasks reply <id> <内容>
/tasks log <id>
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
| `/memory [status\|list [type]\|show <name>\|journal [date]\|forget <name>]` | 查看或删除本工位的记忆，并查看工作日记 |
| `/session` | 查看当前会话、消息、token 和模型状态 |
| `/thinking [level\|cycle]` | 查看或切换当前模型的推理强度 |
| `/model [provider/modelId]` | 查看或切换模型；唯一子串也可匹配 |
| `/new` | 开启新会话，并在边界上固化必要记忆；忙碌时也可使用，会绕过旧队列立即建立新会话边界 |
| `/compact [要求]` | 手动压缩当前上下文；先保存待整理的记忆范围，再生成摘要，不等待长期记忆整理完成 |

自动压缩会提前在后台准备摘要，主会话有空间时可继续处理消息和工具调用；只在安全边界采用结果，接近上下文上限时仍可能等待。压缩期间可用 `/stop` 停止当前回合；若执行未能及时退出，系统会隔离旧执行并恢复原会话。`/new` 在钉钉和终端忙碌时均可用，会开始新会话。自动压缩失败或被打断后会短暂冷却，手动 `/compact` 可以立即重试。

回复一律是中文；只有你会输入或会在文件里看到的标识符（命令名、id、模型名、路径、frontmatter 键）保留英文。轮次失败时，错误气泡先说明是哪一类问题（模型凭据、限流或额度、上下文已满、网络、其他）和你能做的下一步，最后一行才是原始错误。

## 界面用语对照

界面上的用语和设计文档、spec、架构文档里的术语不同。读过设计文档的话，可以按下表对应（完整表见 [spec 053 §D4](specs/053-user-facing-copy/design.md)）：

| 界面用语 | 设计文档中的词 |
|---|---|
| 回合 | turn |
| 等待条件 | 等待票（ticket） |
| 最晚检查时间 | 兜底时限（ticket `by`） |
| 任务说明 | 契约（contract） |
| 工作项 | 团队看板（team board） |
| 任务记录 | 循环日志（loop log） |
| 开始 / 结束（委派、后台作业） | 派发 / 结算（dispatch / settle） |
| 进行中 / 等待中 / 已结束 | `open` / `parked` / `done` |
| 步 | 任务步（只指任务的一步） |
| 工具调用 | 卡片上的工具调用次数 |
| 观察期 | probation（`expires`） |
| 已记入忽略名单 | 墓碑化（tombstone） |
| 工作日记 | journal |
| 后台整理 | reflect |
| 随时可用 / 空闲时可用 | 传输层 / 会话层命令 |
| 绑定 / 换绑 | binding（`desk-bindings.json`） |
| 投递频道 | 事件的 `channelId`、任务的 `channel` |
| 后台工作已暂停（工位） | 休眠的工位（dormant） |

Workspace skill 用 `/skills` 查看目录、用 `/skills show <name>` 查看正文，用 `/skill:<名称>` 直接调用。未知斜杠命令会被拒绝并提示 `/help`，不会因为拼写错误开启一个模型回合。

## 附件交付

`send_media` 可以把本地图片和文件直接交付到当前会话。钉钉中图片以内联图片发送，其他文件作为可下载附件；TUI 会复制到终端下载目录并显示实际路径。目标频道由运行时绑定，模型不能自行指定另一个接收者。

钉钉也支持接收单张图片和富文本中的图片：每条消息最多 9 张、每张最多 5 MiB，识别 JPEG、PNG、GIF 和 WebP。图片会按原顺序进入本轮上下文；实际理解能力仍取决于当前模型是否支持图片。下载失败、格式不识别或超限时，回复会说明该图片未加入上下文。

## 常见问题

**为什么 `/model` 在忙碌时不能用？** 它会修改当前会话状态，因此只能在空闲时执行。`/status`、`/usage`、`/tasks` 和 `/subagents` 是只读或运行时控制面，忙碌时仍可用。

**为什么群里记得的事情，私聊里不知道？** 这两个频道绑定在不同的工位上，记忆各自独立——这是为了避免私聊内容进群。想让它们共享记忆，在其中一个频道里 `/desk bind <另一个的工位>`；只需要共享稳定背景时，由管理员写入 `workspace/MEMORY.md`。用 `/desk` 可以看到每个频道绑在哪里。

**如何继续上次 TUI 对话？** 用同一个 `--desk` 重新打开。没有 `/resume` 命令，每个工位的终端会话区会自动续上。

## 相关文档

- 安装和首次接入：[项目 README](../README.md#快速开始)
- 工位记忆：[memory.md](./memory.md)
- 定时事件与任务命令：[events-and-tasks.md](./events-and-tasks.md)
- 委派命令与角色：[sub-agents.md](./sub-agents.md)
- 多频道并发与容量边界：[scaling-and-concurrency.md](./scaling-and-concurrency.md)
- 输出模式和字段：[configuration-reference.md](./configuration-reference.md)
