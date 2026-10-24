# 一次性迁移说明：由 AI agent 将现有数据整理到渠道层（spec 061）布局

本文用于一次具体部署的离线迁移，不是产品运行协议，也不是可直接照抄执行的通用脚本。

**目标是 spec 061 的版本：`channel.json` 分成 `dingtalk` / `webapi` 两段，频道 id 带渠道前缀（`dingtalk:dm:<staffId>`、`dingtalk:group:<会话 id>`、`webapi:conv_<id>`），终端成为 Web API 的客户端。先确认实际安装的代码已实现这些（`pipiclaw tui --help` 里有 `--new`，源码里有 `src/webapi/`），再转换数据。运行时不读旧格式；旧版本也不能读转换后的数据——不要把转换后的 home 交给旧版本启动。**

可以直接让有服务器文件访问能力的 AI agent 阅读本文、目标版本源码与现有 home，完成迁移。迁移不改变任何工位划分、记忆、任务内容和会话历史。

## 1. 给执行 agent 的任务约定

先确认实际 app home、源版本、目标版本、当前进程和可用备份。读取目标版本的 `src/dingtalk/channel-ids.ts`、`src/channel/channel-id.ts`、`src/desk/types.ts`、`src/webapi/store.ts` 与 `src/channel/channel-event.ts`，以它们为准；本文的转换表是盘点提醒，字段细节以代码为准。

允许为本次明确的数据写临时命令、查询或小工具，但不要把它们加入产品源码、打包文件或长期测试，不重新建设一个通用迁移器。不修改用户的技能、人格或工作内容来迎合文件格式。不升级无关的数据。

## 2. 停机与备份

- 停止 daemon 和所有 `pipiclaw tui`，以及服务管理器的自动重启；确认没有进程再写这个 home。
- 后台 job 和外部委派：detached 进程在 daemon 停止后仍可能继续，它们的完成记录写在 `state/jobs/<desk>/`、`state/subagent-runs/<desk>/`，里面有 `channelId`，会在第 3 节一起改写。要么等需要保留的工作结束，要么按授权取消。
- 对整个 app home 做可恢复的完整备份，保留权限和时间，并记录源程序版本。workspace、state、配置和凭据必须对应同一个停机快照。备份放在工作区外，不在聊天或报告里输出密钥。
- 优先在备份的**独立副本**上整理和演练。副本不得连接钉钉、运行定时工作或产生真实外部委派：演练时把副本的 `channel.json` 里 `dingtalk.enabled` 设为 `false`。

## 3. 转换

频道 id 的映射（下文称"映射"）：

| 旧 | 新 |
|---|---|
| `dm_<staffId>` | `dingtalk:dm:<staffId>` |
| `group_<会话 id>`（会话 id 可含 `/`、`+`、`=`，原样保留） | `dingtalk:group:<会话 id>` |
| `tui`（每个工位至多一个） | `webapi:conv_<32 位十六进制，新生成>`，见下 |

| 数据 | 转换 |
|---|---|
| `channel.json` | 根级字段整体移进 `dingtalk`，加 `"enabled": true`；新增 `"webapi": { "enabled": false, "socket": true }`。文件权限保持 `0600`（里面有凭据） |
| `workspace/desk-bindings.json` | 键按映射改写，值不变。`tui` 原来没有绑定，不涉及；下面为每个新 webapi 会话补一条 |
| 每个工位的 `desk.json` 的 `conversations` | 键按映射改写，`dir` 不变（`dm-N`、`group-N` 目录不动）。`tui` 键换成 `webapi:conv_<新 id>`，`dir` 由 `tui-N` 改为 `webapi-N`，并把 `conversations/tui-N/` 目录和 `state/memory/<desk>/tui-N.json`（以及存在的话 `<desk>` 下记忆边界工作目录里的 `tui-N`）同步改名为 `webapi-N` |
| `state/webapi/conversations/<conv_id>/` | 为上一步生成的每个会话创建：`conversation.json`（`{ "id", "created_at"（秒）, "metadata": null, "owner": "local" }`）和空的 `responses.jsonl`。目录 `0700`。旧的终端历史不进会话 items；session 文件随目录保留，模型上下文延续 |
| `state/tui/conversations.json` | 新建：`{ "<工位名>": "<该工位的 conv_id>" }`，让终端接着用原来的会话 |
| 每个工位 `tasks/*.md` 的 frontmatter `channel:` | 按映射改写；`tui` 换成该工位新生成的 webapi 会话 |
| 每个工位 `events/*.json` 的 `channelId` | 同上 |
| `state/jobs/<desk>/*.json`、`state/subagent-runs/<desk>/*.json` 的 `channelId` | 同上 |
| `state/dispatch/*.json` 待投递记录 | 要么先让旧 daemon 投递完再停机；要么改写 `event`：加 `"source": "wake"`，`producer` 取旧的 `user`，`channelId` 按映射改写，删除 `type`、`conversationType`、`conversationId`、`user`、`userName`、`channelName`；`desk`、`text`、`ts`、`internalWake`、`presentation` 原样保留。没有 `desk` 的记录本来就会被拒绝，留着或删掉都可以 |
| `state/memory/<desk>/*.json` 的 `channelId` | 不必改，运行时下次写入时会覆盖；想保持一致就按映射改 |
| `state/dingtalk/conversations.json` | 键按映射改写 |
| `workspace/CHANNELS.md` | 不改，由新版本启动时重新生成 |
| 会话 `context.jsonl` / `log.jsonl`、`memory-review.jsonl`、模型写过的文本 | 不改。里面的旧频道 id 只是历史文字 |

`tui` 会话处理的几点：每个有 `tui` 键的工位各生成一个 webapi 会话；它在 `desk-bindings.json` 里绑定到同一个工位，所以工位的任务和事件继续按原样解析。原来投递到终端的任务和事件现在投递到这个 webapi 会话——有 daemon（或内嵌运行时）在运行时它们会被驱动，而不是像以前那样被拒绝。

## 4. 校验

在副本上（`dingtalk.enabled` 为 `false`）逐项确认：

1. `pipiclaw tui --desk <有终端会话的工位> --print "/desk"` 能启动内嵌运行时，列出每个工位和它的频道（钉钉频道在渠道关闭时显示为 `` `dingtalk:…` `` 的 id，这是预期的）。
2. `pipiclaw tui --desk <工位> --print "继续"`：会话延续——模型请求的历史里有转换前的对话（用 mock provider 或日志检查），而不是一个空会话。
3. `/tasks` 和 `/events` 列出转换前的任务和事件，投递频道是新 id。
4. `state/dispatch/` 里的记录没有被拒绝（日志里没有 `dispatch` 的错误）；渠道关闭时它们保持 `pending`。
5. 打开钉钉（`dingtalk.enabled: true`，仅在确认不会影响生产之后）：各频道沿用原来的工位和会话，`/status`、`/stop` 正常。

## 5. 回退

用第 2 节的完整备份还原整个 app home，并换回转换前的程序版本。不要只还原一部分文件：频道 id 同时出现在绑定、会话登记、任务、事件、作业和投递记录里，混用新旧格式会让其中一部分悄悄失效。

## 6. 演练记录

本版本的演练过程与结果见 [acceptance.md](./specs/061-channel-plane/acceptance.md)。
