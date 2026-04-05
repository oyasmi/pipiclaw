# Pipiclaw

Pipiclaw 是一个 AI 助手运行时（AI assistant runtime），以 [`pi-coding-agent`](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) 为核心，补齐了作为工作助手长期使用时最需要的几层能力：钉钉接入、AI Card 过程展示、子代理、分层记忆、定时事件，以及按会话通道持久化的工作区（workspace）。

如果你希望 AI 助手不只是聊天，而是能在钉钉里持续工作、保留上下文、执行任务，并且实时告知你它正在做什么，那么 Pipiclaw 就是你需要的。

npm package: [`@oyasmi/pipiclaw`](https://www.npmjs.com/package/@oyasmi/pipiclaw)

文档入口：

- 配置手册：[docs/configuration.md](./docs/configuration.md)
- 事件与子代理使用指南：[docs/events-and-sub-agents.md](./docs/events-and-sub-agents.md)
- 部署与运维指南：[docs/deployment-and-operations.md](./docs/deployment-and-operations.md)

## 功能特性（Features）

- 原生支持钉钉 Stream Mode，不需要消息中转服务，不需要公网IP
- 支持 AI Card 过程展示，思考、工具执行和状态更新可以持续流式呈现
- 支持 `/help`、`/new`、`/compact`、`/session`、`/model`
- 忙碌时可继续接收 `/steer`、`/followup`、`/stop`
- 按工作区 / 会话通道（workspace / channel）分层管理 `SOUL.md`、`AGENTS.md`、`SESSION.md`、`MEMORY.md`、`HISTORY.md`
- 支持预定义子代理（sub-agent）和临时内联子代理（inline sub-agent）
- 支持立即、单次、周期三类事件调度
- 支持自定义模型提供方（provider）和模型（model）配置

## 快速开始（Quickstart）

从零开始，让 Pipiclaw 在你的钉钉里成功回复第一条消息。可以直接让Agent帮你完成。如果你希望自己逐步操作，再看后面的“自己动手安装”。

### 给 AI Agent 的安装说明（For AI Agent）

可以让 AI Agent 直接帮你完成安装、初始化、配置和启动，把下面整段文字复制给你常用的 AI Agent （如 Claude Code、Codex、OpenCode 等）：

```text
请帮我在这台机器上安装并初始化 Pipiclaw，并尽量把它配置到“可以开始使用”的状态。按下面要求执行：

1. 先检查 Node.js 是否可用，版本必须 >= 22。
   - 如果未安装，或版本低于 22，不要继续安装 Pipiclaw，直接告诉我需要先安装或切换到 Node.js 22+。

2. 安装 Pipiclaw：
   - 优先执行：npm install -g @oyasmi/pipiclaw
   - 如果全局安装因为权限失败，不要默认使用 sudo。
   - 先把报错告诉我，再询问我希望怎么处理。

3. 安装完成后，执行一次 pipiclaw，让它初始化默认目录：
   - ~/.pi/pipiclaw/
   - ~/.pi/pipiclaw/workspace/

4. 继续帮我完成基础配置，但先逐项询问我是否愿意现在提供这些信息：
   - 钉钉应用的 clientId
   - 钉钉应用的 clientSecret
   - AI Card 的 cardTemplateId
   - 模型接入方式：Anthropic，或自定义 provider

5. 关于钉钉配置：
   - AI Card 是推荐配置，不是可有可无的装饰。正常使用时建议配上。
   - 如果我愿意提供 clientId、clientSecret、cardTemplateId，就直接帮我写入 ~/.pi/pipiclaw/channel.json
   - robotCode 可以先留空
   - allowFrom 可以先设为 []
   - 如果我暂时不提供 cardTemplateId，也可以先留空，但最后要明确提醒我后续补上
   - 不要把 any your-* placeholder 保留在最终文件里

6. 关于模型配置：
   - 先问我使用哪种方式：
     - Anthropic 默认模型
     - 自定义 provider
   - 如果我选择 Anthropic，再询问我是否愿意现在提供 ANTHROPIC_API_KEY
     - 如果我提供，就按我当前环境和你的能力，帮我配置到可用
     - 如果我不提供，就不要编造值；保留默认空 models.json，并在最后告诉我需要自己补 ~/.pi/pipiclaw/auth.json 或环境变量
   - 如果我选择自定义 provider，至少询问这些信息：
     - provider 名称
     - baseUrl
     - api 类型
     - apiKey
     - 至少一个 model id
   - 如果我提供了这些值，就帮我写好 ~/.pi/pipiclaw/models.json
   - 如果我不提供，就不要编造值；最后明确告诉我需要自己补 ~/.pi/pipiclaw/models.json
   - 如果服务是 OpenAI-compatible，优先使用 openai-completions，并默认加上 compat：
     - supportsDeveloperRole: false
     - supportsReasoningEffort: false

7. 配置完成后，分两种情况处理：
   - 如果还缺关键配置，就不要假装已经可用：
     - 明确列出还缺什么
     - 明确指出应该修改哪个文件
     - 提醒我补完后再运行 pipiclaw
   - 如果关键参数已经齐全，不要只告诉我如何启动；先询问我是否需要你现在直接帮我启动 Pipiclaw
     - 如果我同意，你就直接启动 pipiclaw
     - 启动后要检查输出，告诉我是启动成功，还是遇到了问题
     - 如果遇到问题，要把问题类型、关键信息和下一步解决建议说清楚
     - 如果启动成功，要提醒我去钉钉里先发送 /model 验证模型是否可见，再发送一条普通消息做首次验证
     - 如果我不同意立即启动，就告诉我后续该如何手动启动

8. 如果我选择“先安装，稍后自己改配置”，你就完成安装和初始化即可，但最后必须明确告诉我下一步至少要改这些文件中的哪些：
   - ~/.pi/pipiclaw/channel.json
   - ~/.pi/pipiclaw/auth.json
   - ~/.pi/pipiclaw/models.json
   - ~/.pi/pipiclaw/settings.json（如果需要固定默认模型）

9. 整个过程中不要假装已经成功。
   - 做过的操作和写过的文件要明确告诉我
   - 如果某一步无法继续，要直接说明卡在哪里
```

### 自己动手安装（For Human）

如果你希望自己逐步完成安装和配置，可以按下面步骤操作。

#### 1. 环境要求（Requirements）

- Node.js `>= 22`
- 一个可用的钉钉企业内部应用
- 至少一种可用的模型接入方式
  - 直接使用 Anthropic 默认模型
  - 或在 `models.json` 中配置自定义模型提供方（provider）

#### 2. 安装（Install）

```bash
npm install -g @oyasmi/pipiclaw
```

#### 3. 初始化（Initialize）

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
    ├── ENVIRONMENT.md
    ├── events/
    ├── skills/
    └── sub-agents/
```

如果 `channel.json` 仍然是初始化模板，程序会提示你补全配置后再启动。这是正常行为。

#### 4. 创建钉钉应用（Create a DingTalk App）

在 [钉钉开放平台](https://open-dev.dingtalk.com/) 创建企业内部应用，并完成下面几项：

1. 创建应用，获取 `Client ID` 和 `Client Secret`
2. 开启机器人能力
3. 启用 Stream Mode
4. 建议一并创建 AI Card 模板并获取 `Card Template ID`

#### 5. 填写 `channel.json`（Fill `channel.json`）

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

为了让第一轮接入更稳，上面的示例先把 `cardTemplateId` 留空；如果你已经准备好 AI Card 模板，推荐直接填入真实值。

最少只需要：

- `clientId`
- `clientSecret`

常见可选项：

- `robotCode`
  留空时会回退到 `clientId`
- `cardTemplateId`
  建议配置；留空时表示暂不启用 AI Card
- `allowFrom`
  设为 `[]` 或删除时表示允许所有人

推荐把 AI Card 一起配上，这样在钉钉里能直接看到过程更新。只有在排查接入链路时，才建议临时把 `cardTemplateId` 留空。

#### 6. 配置模型（Configure Models）

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

#### 7. 可选：设置默认模型（Optional: Set a Default Model）

如果你希望固定默认模型，可以编辑 `~/.pi/pipiclaw/settings.json`：

```json
{
  "defaultProvider": "my-gateway",
  "defaultModel": "gpt-4.1"
}
```

如果不设置，Pipiclaw 会使用当前可用模型列表里的第一个。

#### 8. 启动 Pipiclaw（Start Pipiclaw）

```bash
pipiclaw
```

#### 9. 在钉钉中验证（Verify in DingTalk）

建议先给机器人发送：

```text
/model
```

确认当前可见模型和默认模型都符合预期后，再发送一条普通消息，例如：

```text
请介绍一下你自己，并说明你现在能做什么
```

如果一切正常：

- 如果已经配置 AI Card，你会在钉钉里看到过程更新；这也是推荐的使用方式
- 如果暂时没有配置 AI Card，机器人会直接发送普通消息
- Pipiclaw 会在本地创建对应的会话通道目录
- 后续会话会复用该会话通道的工作区（workspace）与记忆文件

## 配置（Configuration）

配置与使用相关的文档建议按下面顺序阅读：

| 文档 | 适合什么场景 |
|------|--------------|
| [docs/configuration.md](./docs/configuration.md) | 查配置项、字段含义、模型与钉钉配置 |
| [docs/events-and-sub-agents.md](./docs/events-and-sub-agents.md) | 配置并使用定时事件、预定义子代理 |
| [docs/deployment-and-operations.md](./docs/deployment-and-operations.md) | 长期运行、升级、日志、备份与排障 |

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
    ├── ENVIRONMENT.md
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
    │   └── subagent-runs.jsonl
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

## 事件与子代理（Events and Sub-Agents）

`workspace/events/` 和 `workspace/sub-agents/` 是 Pipiclaw 非常重要的两类长期能力：

- 定时事件适合做提醒、巡检、定期回顾和固定流程触发
- 预定义子代理适合把 reviewer、researcher、planner 这类角色沉淀为可复用能力

这两部分更接近“日常使用”而不是基础配置，单独整理在 [docs/events-and-sub-agents.md](./docs/events-and-sub-agents.md)。

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

确认链路正常后，建议尽快把 AI Card 配上。

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

如果只是想先验证链路，可以临时把 `cardTemplateId` 留空；正常使用时仍然建议启用 AI Card。

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
