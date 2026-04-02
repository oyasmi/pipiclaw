# Pipiclaw

Pipiclaw 是一个 AI 助手运行时（AI assistant runtime），基于 [`@mariozechner/pi-coding-agent`](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) 构建，补齐了将 AI Agent 作为工作助手长期使用时最需要的几层能力：钉钉接入、AI Card 过程展示、子代理、分层记忆、定时事件，以及按会话通道持久化的工作区（workspace）。

如果你希望 AI 助手不只是聊天，而是能在钉钉里持续工作、保留上下文、执行任务，并且实时告知你它正在做什么，那么 Pipiclaw 就是你需要的。

npm package: [`@oyasmi/pipiclaw`](https://www.npmjs.com/package/@oyasmi/pipiclaw)

## 功能特性（Features）

- 原生支持钉钉 Stream Mode，不需要消息中转服务，不需要公网IP
- 支持 AI Card 过程展示，思考、工具执行和状态更新可以持续流式呈现
- 支持 `/help`、`/new`、`/compact`、`/session`、`/model`
- 忙碌时可继续接收 `/steer`、`/followup`、`/stop`
- 按工作区 / 会话通道（workspace / channel）分层管理 `SOUL.md`、`AGENTS.md`、`SESSION.md`、`MEMORY.md`、`HISTORY.md`
- 支持预定义子代理（sub-agent）和临时内联子代理（inline sub-agent）
- 支持立即、单次、周期三类事件调度
- 支持自定义模型提供方（provider）和模型（model）配置
- 支持主机和 Docker 两种工具执行环境

## 快速开始（Quickstart）

从零开始，让 Pipiclaw 在你的钉钉里成功回复第一条消息。

### 1. 环境要求（Requirements）

- Node.js `>= 22`
- 一个可用的钉钉企业内部应用
- 至少一种可用的模型接入方式
  - 直接使用 Anthropic 默认模型
  - 或在 `models.json` 中配置自定义模型提供方（provider）

### 2. 安装（Install）

```bash
npm install -g @oyasmi/pipiclaw
```

### 3. 初始化（Initialize）

第一次运行会自动初始化配置目录：

```bash
pipiclaw
```

程序会创建：

```text
~/.pi/pipiclaw/
├── channel.json
├── auth.json
├── models.json
├── settings.json
└── workspace/
    ├── SOUL.md
    ├── AGENTS.md
    ├── MEMORY.md
    ├── events/
    ├── skills/
    └── sub-agents/
```

如果 `channel.json` 仍然是初始化模板，程序会提示你补全配置后再启动。这是正常行为。

### 4. 创建钉钉应用（Create a DingTalk App）

在 [钉钉开放平台](https://open-dev.dingtalk.com/) 创建企业内部应用，并完成下面几项：

1. 创建应用，获取 `Client ID` 和 `Client Secret`
2. 开启机器人能力
3. 启用 Stream Mode
4. 如果希望使用 AI Card 过程展示，再创建 AI Card 模板并获取 `Card Template ID`

### 5. 填写 `channel.json`（Fill `channel.json`）

编辑 `~/.pi/pipiclaw/channel.json`：

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

最少只需要：

- `clientId`
- `clientSecret`

常见可选项：

- `robotCode`
  留空时会回退到 `clientId`
- `cardTemplateId`
  留空时表示暂不启用 AI Card
- `allowFrom`
  设为 `[]` 或删除时表示允许所有人

第一次接通时，建议先使用上面的最小配置，不要保留初始化生成的占位值。

### 6. 配置模型（Configure Models）

Pipiclaw 启动后要想真正生成回复，还需要有可用模型。这里通常有两种接入方式。

#### 方案 A：使用内置 Anthropic 默认模型（Option A: Use the Built-in Anthropic Default）

如果你直接使用 Anthropic，`models.json` 可以保持默认内容：

```json
{
  "providers": {}
}
```

然后提供 Anthropic 凭据即可。最简单的是环境变量：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

也可以写到 `~/.pi/pipiclaw/auth.json`：

```json
{
  "anthropic": {
    "type": "api_key",
    "key": "sk-ant-..."
  }
}
```

#### 方案 B：添加自定义模型提供方（Option B: Add a Custom Provider）

如果你使用的是 OpenAI-compatible 网关、代理、自建服务或聚合平台，可以在 `~/.pi/pipiclaw/models.json` 里添加一个自定义模型提供方（provider）。

一个可以直接改名替换后使用的最小示例：

```json
{
  "providers": {
    "my-gateway": {
      "baseUrl": "https://llm.example.com/v1",
      "api": "openai-completions",
      "apiKey": "your-api-key",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "gpt-4.1"
        }
      ]
    }
  }
}
```

这个例子里最关键的四项是：

- `baseUrl`
- `api`
- `apiKey`
- `models`

说明：

- `apiKey` 可以直接写真实 key
- 也可以写环境变量名，或 `!command`
- 很多 OpenAI-compatible 服务不支持 `developer` role / `reasoning_effort`
  如果遇到请求兼容性问题，先保留上面的 `compat`

如果你不想把凭据直接写进 `models.json`，也可以改成同名模型提供方（provider）的 `auth.json` 配置，例如：

```json
{
  "my-gateway": {
    "type": "api_key",
    "key": "your-api-key"
  }
}
```

同时把 `models.json` 中的 `apiKey` 改成同一个值，或者改成环境变量名。完整配置手册见 [docs/configuration.md](./docs/configuration.md)。

### 7. 可选：设置默认模型（Optional: Set a Default Model）

如果你希望固定默认模型，可以编辑 `~/.pi/pipiclaw/settings.json`：

```json
{
  "defaultProvider": "my-gateway",
  "defaultModel": "gpt-4.1"
}
```

如果不设置，Pipiclaw 会使用当前可用模型列表里的第一个。

### 8. 启动 Pipiclaw（Start Pipiclaw）

```bash
pipiclaw
```

如果希望工具运行在 Docker 容器里：

```bash
pipiclaw --sandbox=docker:your-container
```

### 9. 在钉钉中验证（Verify in DingTalk）

建议先给机器人发送：

```text
/model
```

确认当前可见模型和默认模型都符合预期后，再发送一条普通消息，例如：

```text
请介绍一下你自己，并说明你现在能做什么
```

如果一切正常：

- 你会在钉钉里看到 AI Card 的过程更新；如果没有配置 AI Card，机器人会直接发送普通消息
- Pipiclaw 会在本地创建对应的会话通道目录
- 后续会话会复用该会话通道的工作区（workspace）与记忆文件

## 配置（Configuration）

完整配置手册见 [docs/configuration.md](./docs/configuration.md)。

### 配置文件（Config Files）

| 文件 | 用途 |
|------|------|
| `~/.pi/pipiclaw/channel.json` | 钉钉应用配置 |
| `~/.pi/pipiclaw/auth.json` | 模型认证信息 |
| `~/.pi/pipiclaw/models.json` | 自定义模型提供方 / 模型，或覆盖内置模型提供方 |
| `~/.pi/pipiclaw/settings.json` | 默认模型提供方 / 模型和运行时设置 |

### 环境变量（Environment Variables）

| 变量 | 用途 |
|----------|------|
| `ANTHROPIC_API_KEY` | Anthropic API Key |
| `PIPICLAW_DEBUG` | 调试模式，会把上下文写到 `last_prompt.json` |
| `DINGTALK_FORCE_PROXY` | 设为 `true` 时保留 axios 代理设置 |

## 命令（Commands）

Pipiclaw 有两层命令。

### 传输层命令（Transport Commands）

这些命令由钉钉运行时（DingTalk runtime）直接处理：

| 命令 | 说明 |
|------|------|
| `/help` | 查看内置命令帮助 |
| `/stop` | 停止当前正在执行的任务 |
| `/steer <message>` | 在当前任务继续执行时追加新的引导信息 |
| `/followup <message>` | 把新的请求排队，等当前任务结束后再执行 |

忙碌时，普通消息默认等价于 `/steer <message>`。

### 会话层命令（Session Commands）

这些命令由 `AgentSession` 扩展命令（extension command）立即执行，不会作为普通 prompt 发给模型：

| 命令 | 说明 |
|------|------|
| `/new` | 开启一个新的会话 |
| `/compact [instructions]` | 手动压缩当前会话上下文，可附带额外说明 |
| `/session` | 查看当前会话状态、消息统计、token 使用量和当前模型 |
| `/model [provider/modelId|modelId]` | 查看当前模型，或切换到指定模型 |

`/model` 只支持精确匹配切换。

## 工作区结构（Workspace Layout）

Pipiclaw 的核心不是一个临时机器人实例，而是一组长期存在的工作区（workspace）文件。

```text
~/.pi/pipiclaw/
├── channel.json
├── auth.json
├── models.json
├── settings.json
└── workspace/
    ├── SOUL.md
    ├── AGENTS.md
    ├── MEMORY.md
    ├── events/
    ├── skills/
    ├── sub-agents/
    ├── dm_{userId}/
    │   ├── SESSION.md
    │   ├── MEMORY.md
    │   ├── HISTORY.md
    │   ├── .channel-meta.json
    │   ├── context.jsonl
    │   ├── log.jsonl
    │   ├── subagent-runs.jsonl
    │   └── skills/
    └── group_{conversationId}/
        └── ...
```

其中：

- `SOUL.md`
  定义助手身份、语气和回复风格
- `AGENTS.md`
  定义工作规则和行为约束
- `SESSION.md`
  当前工作态
- `MEMORY.md`
  稳定事实、决策和偏好
- `HISTORY.md`
  更早上下文的摘要

## 记忆模型（Memory Model）

Pipiclaw 不会把所有历史对话无上限地塞进 prompt，而是按层管理：

- `workspace/MEMORY.md`
  工作区级稳定背景
- `<channel>/SESSION.md`
  当前任务和短期上下文
- `<channel>/MEMORY.md`
  会话通道级 durable facts、decisions、preferences
- `<channel>/HISTORY.md`
  更早会话的摘要历史

运行时主要做两件事：

- relevant recall
  按当前请求从 `SESSION.md` / `MEMORY.md` / `HISTORY.md` 里挑少量相关片段注入当前 prompt
- consolidation
  在 compaction 或 session trimming 前刷新 `SESSION.md`，并把值得保留的信息沉淀到 `MEMORY.md` / `HISTORY.md`

## 子代理（Sub-Agents）

Pipiclaw 支持两种子代理（sub-agent）用法：

- 预定义子代理：放在 `~/.pi/pipiclaw/workspace/sub-agents/*.md`
- 临时内联子代理（inline sub-agent）：由主代理在一次 `subagent` 工具调用里直接构造

推荐优先使用预定义子代理，便于复用、审查和调试。

示例：`~/.pi/pipiclaw/workspace/sub-agents/reviewer.md`

```md
---
name: reviewer
description: Review code changes for correctness, regressions, and missing tests
model: anthropic/claude-sonnet-4-5
tools: read,bash
contextMode: contextual
memory: relevant
paths:
  - src/
  - test/
maxTurns: 24
maxToolCalls: 48
maxWallTimeSec: 300
bashTimeoutSec: 120
---

You are a focused code reviewer.

Review the code or task given to you.
Prioritize correctness issues, regressions, risky assumptions, and missing tests.
Keep findings concise and actionable.
```

一些关键规则：

- 子代理没有 `subagent` 工具，所以不能继续创建下一级代理
- 子代理隔离的是对话上下文，不隔离文件系统
- 运行摘要会记录到 `<channel>/subagent-runs.jsonl`

## 定时事件（Scheduled Events）

在 `~/.pi/pipiclaw/workspace/events/` 中放置 JSON 文件，可以创建三类事件：

- `immediate`
- `one-shot`
- `periodic`

示例：

```json
{
  "type": "periodic",
  "channelId": "dm_your-staff-id",
  "text": "Review your MEMORY.md files. Remove outdated entries, merge duplicates, ensure well-organized.",
  "schedule": "0 3 * * 0",
  "timezone": "Asia/Shanghai"
}
```

一个常见用法是让 Pipiclaw 定期回顾记忆文件，或执行固定时间的巡检和提醒。

## 故障排查（Troubleshooting）

### `pipiclaw` 首次启动即退出（`pipiclaw` Exits on First Run）

通常是因为 `channel.json` 仍然保留了初始化占位值。

优先检查这些字段：

- `clientId`
- `clientSecret`
- `robotCode`
- `cardTemplateId`
- `allowFrom`

第一次接通时，最省事的做法是：

- 把 `robotCode` 设为空字符串
- 把 `cardTemplateId` 设为空字符串
- 把 `allowFrom` 设为 `[]`

### 机器人已启动，但第一次模型调用失败（The Bot Starts but the First Model Call Fails）

优先检查：

- 如果 `models.json` 为空，是否已经提供可用的 Anthropic 凭据
- 如果使用自定义模型提供方，`models.json` 是否包含 `baseUrl`、`api`、`apiKey`、`models`
- `auth.json` 是否使用了对象格式，而不是直接写成字符串
- 如果是 OpenAI-compatible 服务，是否需要：
  - `"supportsDeveloperRole": false`
  - `"supportsReasoningEffort": false`
- 给机器人发送 `/model`，确认当前可见模型和默认模型是否正确

### 机器人能收到消息，但没有回复（The Bot Receives Messages but Does Not Reply）

优先检查：

- 模型认证是否可用
- `models.json` 是否声明了你要使用的模型提供方 / 模型
- `allowFrom` 是否把你的账号挡住了
- 钉钉机器人 Stream Mode 是否已开启
- 如果配置了 `cardTemplateId`，该模板是否有效

如果只是想先验证链路，建议先把 `cardTemplateId` 留空。

### 需要查看精确提示词（Need to Inspect the Exact Prompt）

设置：

```bash
export PIPICLAW_DEBUG=1
```

之后运行时会在对应的会话通道目录下写出 `last_prompt.json`。

## 开发（Development）

```bash
npm install
npm run build
npm run check
```

常用脚本：

- `npm run typecheck`
- `npm run test`
- `npm run check`

## 许可证（License）

Apache License 2.0. See [LICENSE](./LICENSE).
