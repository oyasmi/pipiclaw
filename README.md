# Pipiclaw

**把钉钉变成一个能持续工作的 AI 工程入口。**

Pipiclaw 是一个面向个人和团队的 AI coding assistant runtime。它让 AI 助手不只回答一轮问题，而是能留在你的钉钉里理解上下文、操作工作区、记住长期约定、按计划继续任务，还能把重活委派给 Claude Code、Codex CLI 或你自己的执行器。

你看到的是一个助手，背后可以是一支分工明确的 AI 工程团队：主智能体负责理解目标和交付结果，轻量子智能体负责检索与整理，外部智能体负责跨文件实现、独立评审和运行验收。所有工作都有状态、有产物、有控制入口，而不是散落在几个终端窗口里的临时对话。

- npm：[`@oyasmi/pipiclaw`](https://www.npmjs.com/package/@oyasmi/pipiclaw)
- 运行环境：Node.js `>= 22.19.0`，Linux / macOS；Windows 请使用 WSL2
- 许可证：[GNU AGPL v3](./LICENSE)

## 为什么用 Pipiclaw

### 一个入口，协调多个智能体

Pipiclaw 同时支持两类委派：内置子智能体在进程内完成检索、日志筛查等轻量工作；外部智能体则启动真实的 Claude Code、Codex CLI 或任意脚本，处理需要长时间运行、跨多个文件和反复自测的重型任务。

在钉钉常驻模式中，外部任务派发后在后台继续执行，完成时自动唤醒原频道。你可以随时用 `/subagents` 查看运行状态、实际命令和产出，用 `/subagents cancel` 直接终止，也可以让主智能体在已结束的 Claude Code / Codex 会话上继续追问。仓库附带 planner、builder、reviewer、verifier、documenter 等可直接改造的角色模板。

### 工作不会随着一次对话结束

每个会话都有独立的当前状态、长期记忆和历史摘要。任务台账把目标、完成标准、进度、下一步和验收记录持久化到 Markdown 文件；内建 task driver 会在合适的时间恢复工作，有进展就继续，停滞则退避，超过边界就停止并告诉你。

### 原生工作在钉钉里

Pipiclaw 使用钉钉 Stream Mode，不需要自建消息中转服务或公网 IP。AI Card 可以持续显示思考、工具执行和状态更新；任务进行中仍可用 `/steer` 调整方向、`/followup` 排队下一件事、`/stop` 中止当前回合。生成的报表、截图和导出文件可以作为钉钉原生附件直接交付。

### 能自主，也能随时接管

定时事件适合提醒、周期检查和零 token 的条件传感器；任务台账适合跨小时、跨会话的长期工作。运行状态、模型用量、任务、记忆和委派 run 都有不经过 LLM 的控制命令，即使模型不可用或当前回合卡住，你仍能查看和干预。

### 配置、数据和工作方式归你所有

模型支持内置 provider、OpenAI-compatible 网关、API key 和订阅登录。记忆、任务、角色、事件与团队规则都保存在本机可阅读文件中。Pipiclaw 提供命令、路径和网络守卫以及审计记录；需要更强隔离时，可把整个进程放进独立账号或容器。

## 适合做什么

- 在钉钉中提供长期在线的研发助手、内部技术支持或运维协作入口
- 把需求分析、实现、评审、验证、文档整理交给不同 AI 智能体协作完成
- 跟进跨小时或跨天的编码、调查、迁移、报告和周期性工作
- 在多个群和私聊中保留彼此隔离的上下文与记忆
- 复用现有模型网关、Claude Code / Codex CLI 账号和团队工作规范

Pipiclaw 当前定位是个人与小团队、自托管、单实例运行。它不是强多租户 SaaS，也不提供 OS 级沙箱；外部智能体拥有的真实权限由目标 CLI 的 sandbox 参数、运行账号和宿主环境共同决定。

## 快速开始

下面提供三条递进路径：先在终端验证模型，再接入钉钉，最后启用外部智能体。已经有明确目标时可以直接跳到对应部分。

### 1. 安装并确认 CLI

```bash
npm install -g @oyasmi/pipiclaw
pipiclaw tui --help
```

首次实际启动 `pipiclaw` 或 `pipiclaw tui` 时会创建：

```text
~/.pipiclaw/
├── channel.json      # 钉钉应用
├── auth.json         # 模型凭据
├── models.json       # 自定义模型提供方
├── settings.json     # 默认模型与运行设置
├── tools.json        # Web 工具、任务等能力开关
├── security.json     # 命令、路径与网络守卫
└── workspace/        # 记忆、任务、事件、skills、智能体角色和频道数据
```

设置 `PIPICLAW_HOME=/your/path` 可以整体迁移这个目录。

### 2. 最快体验：先在终端跑通

终端模式不需要钉钉凭据，只需要一个可用模型。任选一种方式：

```bash
# 方式 A：使用 API key
export ANTHROPIC_API_KEY=sk-ant-...

# 方式 B：登录 SDK 支持的订阅 provider
pipiclaw auth login
```

然后启动：

```bash
pipiclaw tui
```

也可以用于脚本化的一次性请求：

```bash
pipiclaw tui --print "检查当前项目并给出三个最高优先级风险"
```

如需接入企业网关、本地模型或指定默认模型，请看[配置速查](https://github.com/oyasmi/pipiclaw/blob/main/docs/configuration.md)。

### 3. 接入钉钉

在[钉钉开放平台](https://open-dev.dingtalk.com/)创建企业内部应用：

1. 获取 `Client ID` 和 `Client Secret`
2. 开启机器人能力
3. 启用 Stream Mode
4. 推荐创建 AI Card 模板并取得 `Card Template ID`

编辑 `~/.pipiclaw/channel.json`：

```json
{
  "clientId": "your-dingtalk-client-id",
  "clientSecret": "your-dingtalk-client-secret",
  "robotCode": "",
  "cardTemplateId": "",
  "cardTemplateKey": "content",
  "allowFrom": []
}
```

- 硬性必填只有 `clientId` 和 `clientSecret`。
- `robotCode` 留空时回退到 `clientId`。
- `cardTemplateId` 可暂时留空；正式使用建议配置 AI Card。
- `allowFrom: []` 表示允许所有发送者，灰度期建议填测试人员 staff ID。
- 文件中不能保留任何 `your-*` 占位值。

启动常驻进程：

```bash
pipiclaw
```

先在钉钉里发送 `/model`，确认模型可用，再发送：

```text
请介绍一下你自己，并说明你现在能做什么
```

如果第一条消息没有成功，请从[部署与排障](https://github.com/oyasmi/pipiclaw/blob/main/docs/deployment-and-operations.md)开始检查。

### 4. 启用外部智能体委派

先在运行 Pipiclaw 的同一账号下安装并登录目标 CLI，然后复制需要的角色。下面的示例同时启用 Claude Code builder 和 Codex reviewer：

```bash
mkdir -p ~/.pipiclaw/workspace/sub-agents
PIPICLAW_PACKAGE_DIR="$(npm root -g)/@oyasmi/pipiclaw"
cp "$PIPICLAW_PACKAGE_DIR"/examples/sub-agents/{builder,reviewer}.md \
  ~/.pipiclaw/workspace/sub-agents/
```

角色文件变更会在运行时重新发现。发送：

```text
/subagents roles
```

确认角色显示为可用后，可以直接描述目标并指定角色：

```text
请把这个跨模块实现交给 builder 完成，完成后再让 reviewer 独立检查。
```

常用控制入口：

```text
/subagents                         # 运行中和最近完成的委派
/subagents show <runId>            # 状态、实际 argv、产物目录、stderr
/subagents output <runId>          # 查看文本产出
/subagents cancel <runId|all>      # 不经过模型，直接终止
/subagents roles [name]            # 查看角色目录和单个角色配置
```

外部智能体不会经过 Pipiclaw 的命令和路径守卫。使用示例角色前，请阅读[智能体委派指南](https://github.com/oyasmi/pipiclaw/blob/main/docs/sub-agents.md)中的授权、安全边界和 sandbox 说明。

长时间外部委派应运行在钉钉 daemon 中；TUI 当前不提供外部 run 的完成通知和退出后的重新认领。

### 5. 可选：启用 Web 工具

`web_search` / `web_fetch` 默认关闭。编辑 `~/.pipiclaw/tools.json`，设置 `tools.web.enable: true` 并配置搜索 provider。支持 DuckDuckGo、Brave、Tavily、Jina 和 SearXNG；完整字段见[配置速查](https://github.com/oyasmi/pipiclaw/blob/main/docs/configuration.md)。

<details>
<summary>让你常用的 AI Agent 帮忙安装</summary>

把下面的要求交给 Claude Code、Codex 或其他本机 AI Agent：

```text
请帮我安装并初始化 Pipiclaw：

1. 检查 Node.js >= 22.19.0，不满足就停止并说明。
2. 执行 npm install -g @oyasmi/pipiclaw；权限失败时不要自行 sudo。
3. 运行一次 pipiclaw 初始化 ~/.pipiclaw/；它因 channel.json 仍是模板而提示补全并退出是正常现象。
4. 询问我要使用 API key、自定义 provider，还是 pipiclaw auth login 支持的订阅登录；不要编造缺失值。
5. 如果我要接入钉钉，逐项收集 clientId、clientSecret、可选的 cardTemplateId 和 allowFrom，写入 channel.json，并清除所有 your-* 占位值。
6. 配置完成后先询问是否启动。终端模式用 pipiclaw tui；钉钉模式用 pipiclaw。
7. 如实列出做过的操作、修改的文件、验证结果和仍缺少的信息，不要假装成功。
```

</details>

## 常用命令

| 命令 | 作用 |
|---|---|
| `/help` | 查看当前版本的完整命令帮助 |
| `/stop` | 停止当前回合；任务驱动的回合会同时暂停对应任务 |
| `/steer <消息>` | 调整正在执行的回合 |
| `/followup <消息>` | 排队下一条请求 |
| `/status` | 查看执行状态、模型、上下文、运行时长和版本 |
| `/usage [7d\|month]` | 查看本频道与全局的模型用量和成本 |
| `/tasks ...` | 查看、诊断和控制长期任务 |
| `/subagents ...` | 查看、控制委派 run 和角色目录 |
| `/memory ...` | 查看当前频道的长期记忆 |
| `/model [引用]` | 查看或切换模型 |

`/help`、`/stop`、`/steer`、`/followup`、`/events`、`/tasks`、`/status`、`/usage`、`/context` 和 `/subagents` 由运行时直接处理，回合进行中也能使用。`/stop` 不会取消已经派发的委派 run；请使用 `/subagents cancel`。

完整交互说明见[交互与命令](https://github.com/oyasmi/pipiclaw/blob/main/docs/interaction-and-commands.md)。

## 文档

完整索引见 **[docs/README.md](https://github.com/oyasmi/pipiclaw/blob/main/docs/README.md)**。建议从这些入口开始：

| 我想了解 | 文档 |
|---|---|
| 钉钉、TUI、AI Card 和控制命令 | [交互与命令](https://github.com/oyasmi/pipiclaw/blob/main/docs/interaction-and-commands.md) |
| Claude Code / Codex / 内置子智能体委派 | [智能体委派](https://github.com/oyasmi/pipiclaw/blob/main/docs/sub-agents.md) |
| 配置模型、工具和工作区 | [配置速查](https://github.com/oyasmi/pipiclaw/blob/main/docs/configuration.md) |
| 记忆、定时事件和长期任务 | [记忆](https://github.com/oyasmi/pipiclaw/blob/main/docs/memory.md) · [事件与任务](https://github.com/oyasmi/pipiclaw/blob/main/docs/events-and-tasks.md) |
| 默认安全边界和外部智能体授权 | [安全指南](https://github.com/oyasmi/pipiclaw/blob/main/docs/security.md) |
| 部署、升级、备份和排障 | [部署与运维](https://github.com/oyasmi/pipiclaw/blob/main/docs/deployment-and-operations.md) |

## 开发

```bash
npm install
npm run build
npm run check    # lint + typecheck + deadcode + test
```

最小验证：`npm run typecheck` 和 `npm run test`。真实模型 E2E 使用 `npm run test:e2e`，不包含在日常单元测试中。

## 许可证

GNU Affero General Public License v3.0。见 [LICENSE](./LICENSE)。
