# pipiclaw

Pipiclaw 是一个独立的 AI 助手工程，基于 [`@mariozechner/pi-coding-agent`](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) SDK 把类 claw 的 coding agent 能力带到钉钉对话里，支持过程性 AI 卡片、最终 Markdown 回复、内置 Slash 命令、技能扩展、子代理与定时事件。

## 功能

- 钉钉 Stream 模式接收消息，自动重连
- 过程性思考和执行信息通过 AI Card 展示，最终答复独立快速返回
- 内置 Slash 命令：`/help`、`/new`、`/compact`、`/session`、`/model`
- 忙碌时默认将普通新消息作为 steer 送入当前任务，也支持显式 `/steer`、`/followup`、`/stop`
- 每个 DM / 群聊独立工作空间
- 支持 workspace 级 `SOUL.md`、`AGENTS.md`、`MEMORY.md`
- 支持 workspace 级 `sub-agents/` 预定义子代理目录
- 支持全局和频道级技能目录
- 支持 runtime-managed 的频道级 `MEMORY.md` / `HISTORY.md`
- 支持 immediate / one-shot / periodic 定时事件
- 支持自定义模型配置和模型切换

## 安装

```bash
npm install -g @oyasmi/pipiclaw
```

## 首次运行

```bash
pipiclaw
```

首次运行时，Pipiclaw 会自动创建 `~/.pi/pipiclaw/`，并生成这些文件和目录：

- `channel.json`
- `auth.json`
- `models.json`
- `settings.json`
- `workspace/`
- `workspace/events/`
- `workspace/sub-agents/`
- `workspace/skills/`
- `workspace/SOUL.md`
- `workspace/AGENTS.md`
- `workspace/MEMORY.md`

如果 `channel.json` 还是示例占位符，程序会提示你先填写真实配置，然后退出。

## 钉钉应用配置

在 [钉钉开放平台](https://open-dev.dingtalk.com/) 创建企业内部应用：

1. 创建应用并获取 `Client ID` 和 `Client Secret`
2. 开启机器人能力并启用 Stream 模式
3. 如需 AI Card 流式输出，创建 AI 卡片模板并获取 `Card Template ID`

## 配置文件

### channel.json

`~/.pi/pipiclaw/channel.json`

程序会自动生成一个模板文件。你需要至少填写：

- `clientId`
- `clientSecret`

通常还会填写：

- `robotCode`
- `cardTemplateId`
- `allowFrom`

模板示例：

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

说明：

- `robotCode` 留空时默认回退到 `clientId`
- `cardTemplateId` 留空时不使用 AI Card 流式输出
- `allowFrom` 设为 `[]` 或删除时允许所有人

### auth.json

`~/.pi/pipiclaw/auth.json`

首次运行会自动生成空对象：

```json
{}
```

如果你使用环境变量提供模型密钥，可以一直保持为空。也可以手工写成：

```json
{
  "anthropic": "your-anthropic-api-key"
}
```

### models.json

`~/.pi/pipiclaw/models.json`

首次运行会自动生成最小合法空配置。你需要在 `providers` 下面自己添加自定义 provider 和模型定义：

```json
{
  "providers": {}
}
```

如果你不需要自定义模型，可以一直保持这个空配置。

### settings.json

`~/.pi/pipiclaw/settings.json`

首次运行会自动生成：

```json
{}
```

`/model` 等命令写入的默认模型会保存在这里，并在重启后继续生效。

## 运行

填写好 `channel.json` 和模型认证信息后，再次启动：

```bash
pipiclaw
```

如需 Docker sandbox，可以显式指定：

```bash
pipiclaw --sandbox=docker:your-container
```

## 内置 Slash 命令

Pipiclaw 暴露两层命令：

- transport 层命令：由 DingTalk runtime 直接处理
- session 层命令：由 `AgentSession` extension command 立即执行，不作为普通 prompt 发给模型

### 空闲时可用

- `/help`
  显示帮助
- `/new`
  开启新会话
- `/compact [instructions]`
  手动压缩当前会话上下文
- `/session`
  查看当前会话状态、消息统计、token 使用和模型信息
- `/model [provider/modelId|modelId]`
  查看当前模型，或用精确匹配切换模型

说明：

- `/model` 无参数时返回当前模型和可用模型列表
- `/model <ref>` 只支持精确匹配

### 忙碌时可用

- 普通消息
  默认按 `steer` 处理，在当前工具步骤结束后尽快转向
- `/help`
  显示帮助
- `/stop`
  停止当前任务
- `/steer <message>`
  显式指定一次 steer，改变当前任务方向
- `/followup <message>`
  将一条新请求排到当前任务完成之后再执行

说明：

- busy 时普通消息默认等价于 `/steer <message>`
- `/steer` 更适合纠偏、补充限制条件、修改当前任务方向
- `/followup` 更适合“等这件事做完，再继续做下一件事”
- busy 时，其他 slash 输入不会执行；只允许 `/help`、`/stop`、`/steer`、`/followup`

## Workspace Files

Pipiclaw 只会自动识别并使用下面这些 workspace 文件或目录：

- `SOUL.md`
- `AGENTS.md`
- `MEMORY.md`
- `sub-agents/`
- `skills/`
- `events/`

`TOOLS.md` 当前不受支持。即使你手工创建了它，也不会被自动加载或生效。

### Global And Channel Scope

Pipiclaw 同时支持：

- 全局 workspace 文件：`~/.pi/pipiclaw/workspace/`
- 渠道级文件：`~/.pi/pipiclaw/workspace/dm_xxxx/` 或 `group_xxxx/`

它们的关系如下：

| 名称 | 全局位置 | 渠道级位置 | 生效方式 |
|------|----------|------------|----------|
| `SOUL.md` | `workspace/SOUL.md` | 不支持 | 仅在 session 开始时加载全局文件。渠道级 `SOUL.md` 不会被读取。 |
| `AGENTS.md` | `workspace/AGENTS.md` | 不支持 | 仅在 session 开始时加载全局文件。渠道级 `AGENTS.md` 不会被读取。 |
| `MEMORY.md` | `workspace/MEMORY.md` | `<channel>/MEMORY.md` | 默认都不会直接加载进上下文。workspace 文件稳定且由管理员维护；channel 文件由 runtime consolidation 自动更新，也允许 agent 主动读写。 |
| `sub-agents/` | `workspace/sub-agents/` | 不支持 | 预定义 sub-agent 目录。主 Agent 可按需调用其中的定义，也可以在单次任务里临时内联定义一个 sub-agent。 |
| `HISTORY.md` | 不支持 | `<channel>/HISTORY.md` | 默认不会直接加载进上下文。由 runtime consolidation 自动维护，用于按需读取旧摘要。 |
| `skills/` | `workspace/skills/` | `<channel>/skills/` | 两边的 skill 摘要会在 session 开始时进入上下文；如果同名，渠道级覆盖全局。具体 skill 内容仍由 agent 按需读取。 |
| `events/` | `workspace/events/` | 不支持 | 仅支持全局事件目录。 |
| `.channel-meta.json` | 不支持 | `<channel>/.channel-meta.json` | 运行时自动维护，用于主动发送和重启恢复，不建议手工编辑。 |
| `context.jsonl` | 不支持 | `<channel>/context.jsonl` | 原始 session 存储，冷文件，不主动加载或扫描。 |
| `log.jsonl` | 不支持 | `<channel>/log.jsonl` | 原始消息存储，冷文件，不主动加载或扫描。 |
| `subagent-runs.jsonl` | 不支持 | `<channel>/subagent-runs.jsonl` | sub-agent 运行摘要日志。记录其输出摘要、预算停止原因和 usage，便于事后审查。 |

### File Intent

- `SOUL.md`
  定义 Pipiclaw 的身份、语气、默认语言和回复风格。它会追加到 pi 默认底座 prompt 之后。首次运行生成的只是说明模板，你需要替换成真实内容。
- `AGENTS.md`
  定义行为规则、工具使用策略、安全约束和项目工作流。只读取 workspace 级文件。不要把 runtime 内建的记忆系统细节完整复制到这里。
- `MEMORY.md`
  定义持久记忆。workspace 级文件适合存稳定共享背景，由管理员维护；channel 级文件适合存 durable facts、ongoing work、decisions、open loops，并由 runtime consolidation 自动维护。
- `sub-agents/`
  存放预定义 sub-agent Markdown 文件。适合放 reviewer、researcher、planner 之类可复用的专项角色。主 Agent 在需要时也可以不依赖该目录，直接临时内联定义一个 sub-agent。
- `HISTORY.md`
  仅存在于 channel 目录。保存旧上下文的摘要历史，由 runtime consolidation 自动维护。
- `skills/`
  存放自定义技能。适合放可复用的 CLI 工具、脚本和 skill 说明。
- `events/`
  存放定时事件定义。只支持全局目录，不支持放到单个 channel 目录里。

## 工作空间布局

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
    ├── sub-agents/
    ├── skills/
    ├── events/
    └── dm_{userId}/
        ├── MEMORY.md
        ├── HISTORY.md
        ├── .channel-meta.json
        ├── context.jsonl
        ├── log.jsonl
        └── skills/
```

## 记忆模型

Pipiclaw 的默认 session 上下文只直接加载这些内容：

- pi 默认底座 system prompt
- workspace 级 `SOUL.md`
- workspace 级 `AGENTS.md`
- workspace 级 `sub-agents/` 中可用 sub-agent 的摘要
- 内置工具说明
- workspace 和 channel 两层 skills 的摘要

这些文件不会默认直接进入上下文：

- `workspace/MEMORY.md`
- `<channel>/MEMORY.md`
- `<channel>/HISTORY.md`
- `<channel>/log.jsonl`
- `<channel>/context.jsonl`

说明：

- `workspace/MEMORY.md` 是稳定共享背景，由管理员维护，runtime 不会自动改写。
- `<channel>/MEMORY.md` 和 `<channel>/HISTORY.md` 由 runtime 在 compaction 或 session trimming 前自动 consolidation。
- agent 被鼓励在需要时主动读取 channel memory/history。
- `log.jsonl` 和 `context.jsonl` 是冷存储，只做原始归档，不承担记忆角色。
- channel 目录首次初始化时会立即创建 `MEMORY.md` 和 `HISTORY.md`，而不是等到首次 consolidation 再懒创建。

## 定时事件

在 `~/.pi/pipiclaw/workspace/events/` 中创建 JSON 文件来触发定时任务：

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

## Sub-Agents

Pipiclaw 支持两种 sub-agent 用法：

- 预定义 sub-agent：放在 `~/.pi/pipiclaw/workspace/sub-agents/*.md`
- 临时内联 sub-agent：主 Agent 在一次 `subagent` 工具调用里直接组织参数定义

推荐先从预定义 sub-agent 开始，因为更容易复用，也更容易调试。

### 定义文件示例

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

说明：

- `model` 可省略；省略时默认使用主 Agent 当前模型
- `tools` 可省略；省略时默认使用 `read,bash`
- 各预算字段都可省略；省略时会使用 runtime 默认值
- 默认预算值的设计目标是优先防止失控和成本失真，而不是追求“一个 sub-agent 包办整件大任务”；如果任务明显更重，应该显式调大预算
- sub-agent 不会拿到 `subagent` 工具，因此不能再创建孙 agent
- sub-agent 只隔离 LLM 对话上下文，不隔离文件系统和 executor；它读写的 workspace 文件对主 Agent 后续同样可见
- runtime 会自动给 sub-agent 注入一小段固定运行上下文，例如 workspace 根目录、channel id 和 sandbox 类型；主 Agent 仍然需要把任务本身所需的业务上下文写进 `task`
- 如果 sub-agent 已经产出可用结果，但因预算耗尽或中途停止未完整完成，runtime 会保留这部分结果返回给主 Agent，并在 channel 目录的 `subagent-runs.jsonl` 中记录执行摘要

### 使用建议

- `reviewer`：代码审查、回归风险检查、测试缺口检查
- `researcher`：大范围读文件、查日志、收集事实
- `planner`：先整理范围、再给主 Agent 输出执行计划

主 Agent 会在 prompt 指导下自行决定何时调用 sub-agent；不需要用户每次手工指定。

## 环境变量

| 变量 | 说明 |
|------|------|
| `ANTHROPIC_API_KEY` | Anthropic API 密钥 |
| `PIPICLAW_DEBUG` | 设为任意值启用调试模式，将完整上下文写入 `last_prompt.json` |
| `DINGTALK_FORCE_PROXY` | 设为 `true` 保留 axios 代理设置 |

## 开发

```bash
npm install
npm run build
npm run check
```
