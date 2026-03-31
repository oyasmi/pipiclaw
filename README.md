# Pipiclaw

Pipiclaw 是一个面向钉钉的 AI coding assistant runtime。它基于 [`@mariozechner/pi-coding-agent`](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) SDK，补上了实际团队环境里更关键的几层能力：钉钉渠道、过程性 AI Card、子代理、分层记忆、定时事件和可持续运行的 channel workspace。

如果你想要的是一个能在钉钉里长期工作的工程助手，而不是一个只能单轮问答的机器人，Pipiclaw 的设计目标就是这个。

## Why Pipiclaw

- 钉钉优先：原生支持 DingTalk Stream Mode，不需要自己再包一层消息桥
- 过程可见：思考、工具执行和状态更新可以持续流式展示到 AI Card
- 任务不中断：忙碌时支持 steer、follow-up 和 stop，而不是简单丢弃新消息
- 有记忆，但不过载：`MEMORY.md` / `HISTORY.md` 分层管理，避免上下文无限膨胀
- 支持子代理：主代理可以把 review、research、planning 等任务委派给独立上下文的 sub-agent
- 适合长期运行：每个私聊和群聊都有稳定的 channel workspace、日志和事件目录
- 保持可编排：模型、技能、workspace 文件和事件都可以通过普通文件管理

## Highlights

- DingTalk AI Card 流式过程输出，最终答复独立发送
- 内置 slash commands：`/help`、`/new`、`/compact`、`/session`、`/model`
- 忙碌时普通消息默认作为 steer 注入当前任务，也支持显式 `/steer`、`/followup`、`/stop`
- workspace 级 `SOUL.md`、`AGENTS.md`、`MEMORY.md`
- channel 级 `MEMORY.md`、`HISTORY.md`、`skills/`
- 预定义 sub-agent 和临时 inline sub-agent
- immediate / one-shot / periodic 事件调度
- 自定义 provider / model 配置
- host / docker 两种工具执行环境

## Quickstart

下面这套流程的目标是：从零开始，让 Pipiclaw 在你的钉钉里成功回复第一条消息。

### 1. Requirements

- Node.js `>= 20`
- 一个可用的钉钉企业内部应用
- 至少一个可用的模型认证方式
  - 环境变量，例如 `ANTHROPIC_API_KEY`
  - 或 `~/.pi/pipiclaw/auth.json`

### 2. Install

```bash
npm install -g @oyasmi/pipiclaw
```

### 3. First Run

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

如果 `channel.json` 还是占位模板，程序会提示你先填配置，然后退出。这是预期行为。

### 4. Create A DingTalk App

在 [钉钉开放平台](https://open-dev.dingtalk.com/) 创建企业内部应用，并完成这些步骤：

1. 创建应用，拿到 `Client ID` 和 `Client Secret`
2. 开启机器人能力
3. 启用 Stream Mode
4. 如果你要过程性流式展示，再创建一个 AI Card 模板并拿到 `Card Template ID`

### 5. Fill `channel.json`

编辑 `~/.pi/pipiclaw/channel.json`：

```json
{
  "clientId": "your-dingtalk-client-id",
  "clientSecret": "your-dingtalk-client-secret",
  "robotCode": "your-robot-code",
  "cardTemplateId": "your-card-template-id",
  "cardTemplateKey": "content",
  "allowFrom": ["your-staff-id"]
}
```

最少只需要：

- `clientId`
- `clientSecret`

常见可选项：

- `robotCode`
  留空时会回退到 `clientId`
- `cardTemplateId`
  留空时不启用 AI Card 流式输出
- `allowFrom`
  设置为 `[]` 或删除时表示允许所有人

### 6. Provide Model Credentials

最简单的方式是直接用环境变量：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

也可以写到 `~/.pi/pipiclaw/auth.json`：

```json
{
  "anthropic": "your-anthropic-api-key"
}
```

如果你需要自定义 provider / model，可以编辑 `~/.pi/pipiclaw/models.json`。如果不需要，这个文件可以保持：

```json
{
  "providers": {}
}
```

### 7. Start Pipiclaw

```bash
pipiclaw
```

如果你希望工具运行在 Docker 容器里：

```bash
pipiclaw --sandbox=docker:your-container
```

### 8. Send The First Message

给机器人发一条普通消息，例如：

```text
请介绍一下你自己，并说明你现在能做什么
```

如果一切正常：

- 你会在钉钉里看到 AI Card 的过程更新，或普通文本回退
- Pipiclaw 会在本地创建对应 channel 目录
- 后续会话会复用该 channel 的工作空间与记忆文件

## Configuration

### Config Files

Pipiclaw 默认使用下面这些文件：

| File | Purpose |
|------|---------|
| `~/.pi/pipiclaw/channel.json` | 钉钉应用配置 |
| `~/.pi/pipiclaw/auth.json` | 模型认证信息 |
| `~/.pi/pipiclaw/models.json` | 自定义 provider 和 model |
| `~/.pi/pipiclaw/settings.json` | 默认模型和运行时设置 |

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `PIPICLAW_DEBUG` | 打开调试模式，把上下文写到 `last_prompt.json` |
| `DINGTALK_FORCE_PROXY` | 设为 `true` 时保留 axios 代理设置 |

## Commands

Pipiclaw 有两层命令。

### Transport Commands

这些命令由 DingTalk runtime 直接处理：

- `/help`
- `/stop`
- `/steer <message>`
- `/followup <message>`

忙碌时，普通消息默认等价于 `/steer <message>`。

### Session Commands

这些命令由 `AgentSession` extension command 立即执行，不作为普通 prompt 发给模型：

- `/new`
- `/compact [instructions]`
- `/session`
- `/model [provider/modelId|modelId]`

`/model` 只支持精确匹配切换。

## Workspace Model

Pipiclaw 的核心不是“一个机器人实例”，而是一组长期存在的 workspace 文件。

### Workspace Layout

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

### What Gets Loaded Into Context

默认直接进入 session 上下文的内容：

- pi 默认 system prompt
- workspace 级 `SOUL.md`
- workspace 级 `AGENTS.md`
- workspace 级 sub-agent 摘要
- 工具说明
- workspace 和 channel 两层 skills 摘要

默认不会直接注入上下文的内容：

- `workspace/MEMORY.md`
- `<channel>/MEMORY.md`
- `<channel>/HISTORY.md`
- `<channel>/log.jsonl`
- `<channel>/context.jsonl`

这意味着 Pipiclaw 的记忆策略是“按需读取”，而不是把所有历史永远塞进 prompt。

## Memory Model

Pipiclaw 把记忆分成三层：

- `workspace/MEMORY.md`
  稳定的全局背景，适合放团队长期约定和共享知识
- `<channel>/MEMORY.md`
  channel 级 durable facts、ongoing work、decisions、open loops
- `<channel>/HISTORY.md`
  更老上下文的摘要历史

运行时会在 compaction 或 session trimming 前自动做 consolidation：

- 从对话中提取值得保留的 memory entries
- 把旧对话块折叠进 `HISTORY.md`
- 在必要时压缩过长的 memory/history 文件

## Sub-Agents

Pipiclaw 支持两种 sub-agent 用法：

- 预定义 sub-agent：放到 `~/.pi/pipiclaw/workspace/sub-agents/*.md`
- 临时 inline sub-agent：由主代理在一次 `subagent` 工具调用里直接构造

推荐先使用预定义 sub-agent，因为更容易复用、审查和调试。

### Example

文件：`~/.pi/pipiclaw/workspace/sub-agents/reviewer.md`

```md
---
name: reviewer
description: Review code changes for correctness, regressions, and missing tests
model: anthropic/claude-sonnet-4-5
tools: read,bash
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

几个关键规则：

- sub-agent 没有 `subagent` 工具，所以不能继续创建孙代理
- sub-agent 隔离的是 LLM 对话上下文，不隔离文件系统
- 运行摘要会记录到 `<channel>/subagent-runs.jsonl`

## Scheduled Events

在 `~/.pi/pipiclaw/workspace/events/` 放置 JSON 文件，可以创建三类事件：

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

一个典型用法是让 Pipiclaw 每周回顾自己的记忆文件，或者做固定时间的巡检和提醒。

## Development

```bash
npm install
npm run build
npm run check
```

常用脚本：

- `npm run build`
- `npm run test`
- `npm run check`

## Troubleshooting

### First run exits immediately

通常是因为 `channel.json` 还停留在模板占位符状态。把真实的 `clientId` / `clientSecret` 填进去即可。

### Bot receives messages but does not answer

优先检查：

- 模型认证是否可用
- `allowFrom` 是否把你的账号挡住了
- 钉钉机器人 Stream Mode 是否已开启
- `cardTemplateId` 是否有效；如果无效，先留空验证普通文本回退链路

### Need to inspect the exact prompt

设置：

```bash
export PIPICLAW_DEBUG=1
```

之后运行时会在 channel 目录下写出 `last_prompt.json`。

## License

Apache License 2.0. See [LICENSE](./LICENSE).
