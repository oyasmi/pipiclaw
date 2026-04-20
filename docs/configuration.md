# Pipiclaw 配置手册（Configuration Guide）

这是一份面向使用者和维护者的配置手册。

如果你的目标是先把 Pipiclaw 跑起来，请先看 [README](../README.md) 里的快速开始（Quickstart）。  
如果你已经能启动，想系统了解有哪些配置、每项配置在哪里写、什么情况下该怎么配，这份文档就是给你查阅的。

补充文档：

- 事件与子代理使用指南：[events-and-sub-agents.md](./events-and-sub-agents.md)
- 部署与运维指南：[deployment-and-operations.md](./deployment-and-operations.md)
- 安全文档：[security.md](./security.md)

## 设计原则（Design Principles）

Pipiclaw 的配置分成两层：

- Pipiclaw 自己的运行时配置
  - 例如 `channel.json`、工作区（workspace）目录、钉钉接入、记忆文件、事件目录
- 继承自 `@mariozechner/pi-coding-agent` 的模型与认证配置能力
  - 例如 `auth.json`、`models.json`、部分 `settings.json` 语义

这意味着：

- 有些配置格式是 Pipiclaw 自己定义的
- 有些配置格式和解析规则直接沿用 pi-mono 上游
- 还有一些上游 `settings.json` 字段在 Pipiclaw 里目前并不会生效

阅读时建议先看“配置总览”，再按需要跳到具体章节。

## 配置总览（Configuration At a Glance）

Pipiclaw 默认在下面这个目录初始化所有配置：

```text
~/.pi/pipiclaw/
├── channel.json
├── auth.json
├── models.json
├── settings.json
├── tools.json
└── workspace/
    ├── SOUL.md
    ├── AGENTS.md
    ├── MEMORY.md
    ├── ENVIRONMENT.md
    ├── events/
    ├── skills/
    └── sub-agents/
```

默认根目录是 `~/.pi/pipiclaw/`。如果你设置了：

```bash
export PIPICLAW_HOME=/your/custom/pipiclaw-home
```

那么 Pipiclaw 会改为从这个目录读取和写入所有全局配置与 `workspace/`。

### 主要文件（Main Files）

| 文件 | 范围 | 用途 | 自动创建 |
|------|------|------|----------|
| `~/.pi/pipiclaw/channel.json` | 全局 | 钉钉应用配置 | 是 |
| `~/.pi/pipiclaw/auth.json` | 全局 | 模型提供方凭据（provider credentials） | 是 |
| `~/.pi/pipiclaw/models.json` | 全局 | 自定义模型提供方 / 模型 | 是 |
| `~/.pi/pipiclaw/settings.json` | 全局 | Pipiclaw 运行时设置 | 是 |
| `~/.pi/pipiclaw/tools.json` | 全局 | 内建工具配置，例如 `tools.web` | 是 |
| `~/.pi/pipiclaw/workspace/SOUL.md` | 工作区 | 助手身份与回复风格 | 是 |
| `~/.pi/pipiclaw/workspace/AGENTS.md` | 工作区 | 工作规则与行为约束 | 是 |
| `~/.pi/pipiclaw/workspace/MEMORY.md` | 工作区 | 持久化共享记忆 | 是 |
| `~/.pi/pipiclaw/workspace/ENVIRONMENT.md` | 工作区 | 环境事实与重要环境变更记录 | 是 |
| `~/.pi/pipiclaw/workspace/events/` | 工作区 | 定时事件目录 | 是 |
| `~/.pi/pipiclaw/workspace/sub-agents/` | 工作区 | 预定义子代理目录 | 是 |
| `~/.pi/pipiclaw/workspace/skills/` | 工作区 | 工作区级技能目录 | 是 |

### 环境变量（Environment Variables）

| 变量 | 用途 |
|----------|------|
| `ANTHROPIC_API_KEY` | Anthropic 默认模型凭据 |
| `PIPICLAW_HOME` | 覆盖默认的 `~/.pi/pipiclaw/` 根目录 |
| `PIPICLAW_SHELL` | Windows host 模式下指定 POSIX shell，可指向 Git Bash 的 `bash.exe` |
| `PIPICLAW_DEBUG` | 在会话通道目录中写出 `last_prompt.json` |
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` | 标准代理环境变量；DingTalk runtime 和 web 工具默认都会尊重 |

### Windows Host 模式说明（Windows Host Mode Notes）

Pipiclaw 的工具执行层按 POSIX shell 语义工作。`bash`、`read`、`write`、`edit` 等工具内部都会调用 `sh`/`bash` 风格命令。

这意味着在 Windows 上：

- 如果使用默认的 host 模式，建议安装 Git Bash，并确保 `bash` 可在 PATH 中找到
- 如果 `bash` 不在 PATH 中，可以设置 `PIPICLAW_SHELL` 指向具体可执行文件，例如 `C:\Program Files\Git\bin\bash.exe`
- 如果机器上不方便准备 POSIX shell，推荐改用 Docker sandbox

示例：

```powershell
$env:PIPICLAW_SHELL = "C:\Program Files\Git\bin\bash.exe"
pipiclaw
```

## 配置优先级（Configuration Precedence）

不同类型的配置有不同的优先级。

### 钉钉配置（DingTalk Config）

Pipiclaw 只读取 app home 下的 `channel.json`，没有项目级覆盖。默认是 `~/.pi/pipiclaw/channel.json`；如果设置了 `PIPICLAW_HOME`，则会改为 `${PIPICLAW_HOME}/channel.json`。

### 模型凭据解析（Model Credential Resolution）

Pipiclaw 的模型提供方凭据（provider credential）解析主要继承自 pi-mono。对一个模型提供方（provider），常见顺序是：

1. `auth.json`
2. 环境变量
3. `models.json` 中对应 provider 的 `apiKey`

补充说明：

- 如果 `auth.json` 中存在同名模型提供方凭据，通常优先使用它
- `models.json` 的 `apiKey` 仍然是自定义模型提供方定义中的关键字段
- 对 Anthropic 默认模型，`ANTHROPIC_API_KEY` 仍然是最直接的接入方式

上游参考：

- [pi providers.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/providers.md)
- [pi models.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md)

### 运行时设置（Settings）

Pipiclaw 当前只使用 app home 下的 `settings.json`。默认是 `~/.pi/pipiclaw/settings.json`；如果设置了 `PIPICLAW_HOME`，则会改为 `${PIPICLAW_HOME}/settings.json`。

pi-mono 里的项目级 `.pi/settings.json` 覆盖机制，Pipiclaw 目前没有采用。不要假设把配置写到项目目录 `.pi/settings.json` 就会生效。

### 内建工具设置（Built-in Tool Settings）

Pipiclaw 当前把内建工具的实例级配置放在 app home 下的 `tools.json`。默认是 `~/.pi/pipiclaw/tools.json`；如果设置了 `PIPICLAW_HOME`，则会改为 `${PIPICLAW_HOME}/tools.json`。

当前最主要的是 `tools.web` 配置空间，用于控制：

1. 是否启用 `web_search` / `web_fetch`
2. 搜索 provider，例如 `duckduckgo`、`brave`、`tavily`、`jina`、`searxng`
3. web 请求代理
4. fetch 的默认超时、截断和 Jina fallback 行为

## 钉钉配置文件 `channel.json`（`channel.json`）

`channel.json` 用来配置 DingTalk 接入。

### 最小示例（Minimal Example）

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

### 字段说明（Field Reference）

| 字段 | 必填 | 默认值 / 行为 | 说明 |
|------|------|----------------|------|
| `clientId` | 是 | - | 钉钉应用 `Client ID` |
| `clientSecret` | 是 | - | 钉钉应用 `Client Secret` |
| `robotCode` | 否 | 留空时回退到 `clientId` | 钉钉机器人接口使用的 robot code |
| `cardTemplateId` | 否 | 留空时不启用 AI Card | AI Card 模板 ID，建议配置 |
| `cardTemplateKey` | 否 | `"content"` | 写入流式内容的模板字段名 |
| `allowFrom` | 否 | 留空或省略时允许所有人 | 允许访问的发送者 staff ID 列表 |
| `busyMessageDefault` | 否 | `"steer"` | Agent 忙碌时普通消息的默认处理模式。`"steer"` 表示插入当前任务，`"followUp"` / `"followup"` 表示排队等当前任务完成后处理 |

### 使用说明（Practical Notes）

- `clientId` 和 `clientSecret` 是唯一硬性必需字段
- `robotCode` 留空通常就够用
- `cardTemplateId` 建议配置；留空时 Pipiclaw 仍可工作，但不会使用 AI Card
- `allowFrom` 生效的是发送者 staff ID
- 当 `allowFrom` 非空时，不在列表中的发送者消息会被直接忽略
- `busyMessageDefault` 写成 `"followUp"` 或 `"followup"` 都会启用 follow-up 默认模式；其他显式值会在启动时报错

### 推荐配置（Recommended Configurations）

#### 1. 推荐方案：启用 AI Card（Recommended: Enable AI Card）

```json
{
  "clientId": "your-dingtalk-client-id",
  "clientSecret": "your-dingtalk-client-secret",
  "robotCode": "",
  "cardTemplateId": "your-card-template-id",
  "cardTemplateKey": "content",
  "allowFrom": []
}
```

适合：

- 日常正式使用
- 希望在钉钉里看到过程更新
- 需要更容易排查执行过程

#### 2. 首次接通，先排查链路（First Bring-up, Troubleshooting Path）

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

适合：

- 第一次验证接入链路
- 先确认机器人能收到并回复消息
- 先不排查 AI Card 模板问题
- 确认可用后尽快补上 AI Card

#### 3. 小范围灰度，限制访问（Internal Pilot, Restricted Access）

```json
{
  "clientId": "your-dingtalk-client-id",
  "clientSecret": "your-dingtalk-client-secret",
  "robotCode": "",
  "cardTemplateId": "your-card-template-id",
  "cardTemplateKey": "content",
  "allowFrom": ["staff_id_1", "staff_id_2"]
}
```

适合：

- 机器人还在灰度期
- 只允许少量测试人员使用
- 希望同时观察执行过程与 AI Card 展示效果

#### 4. 答疑机器人，普通消息排队（Q&A Bot, Queue Plain Messages）

```json
{
  "clientId": "your-dingtalk-client-id",
  "clientSecret": "your-dingtalk-client-secret",
  "robotCode": "",
  "cardTemplateId": "your-card-template-id",
  "cardTemplateKey": "content",
  "allowFrom": [],
  "busyMessageDefault": "followUp"
}
```

适合：

- 多个用户可能在同一群里连续提问
- 希望每个普通消息按新任务排队处理
- 仍允许用户通过 `/steer <message>` 主动插入当前任务

### 常见错误（Common Mistakes）

- 保留初始化模板中的 `your-*` 占位值
- 在没有 AI Card 模板时仍填写占位 `cardTemplateId`
- 把姓名、手机号或 unionId 写进 `allowFrom`，而不是 staff ID

## 模型认证文件 `auth.json`（`auth.json`）

`auth.json` 用来存放模型提供方凭据（provider credentials）。这个文件的格式和 key 解析规则主要继承自 pi-mono。

### 格式（Format）

```json
{
  "anthropic": {
    "type": "api_key",
    "key": "sk-ant-..."
  }
}
```

### 字段说明（Field Reference）

| 字段 | 必填 | 说明 |
|------|------|------|
| `type` | Yes | 当前常见值是 `api_key` |
| `key` | Yes | API key、环境变量名，或 `!command` |

### `key` 解析规则（`key` Resolution Rules）

`key` 支持三种写法：

#### 1. 直接写 API Key（Literal API Key）

```json
{
  "anthropic": {
    "type": "api_key",
    "key": "sk-ant-..."
  }
}
```

#### 2. 写环境变量名（Environment Variable Name）

```json
{
  "anthropic": {
    "type": "api_key",
    "key": "ANTHROPIC_API_KEY"
  }
}
```

#### 3. 写 Shell 命令（Shell Command）

```json
{
  "anthropic": {
    "type": "api_key",
    "key": "!op read 'op://vault/anthropic/api-key'"
  }
}
```

### 常见内置模型提供方（Common Built-in Providers）

下表列的是常见内置 provider。完整列表建议同时参考上游 providers 文档。

| 模型提供方 | 常用环境变量 | `auth.json` Key |
|------------|----------------|-----------------|
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic` |
| OpenAI | `OPENAI_API_KEY` | `openai` |
| Google Gemini | `GEMINI_API_KEY` | `google` |
| Mistral | `MISTRAL_API_KEY` | `mistral` |
| Groq | `GROQ_API_KEY` | `groq` |
| OpenRouter | `OPENROUTER_API_KEY` | `openrouter` |
| xAI | `XAI_API_KEY` | `xai` |
| Kimi For Coding | `KIMI_API_KEY` | `kimi-coding` |

上游参考：

- [pi providers.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/providers.md)

### 自定义模型提供方凭据（Custom Provider Credentials）

如果你在 `models.json` 里定义了一个自定义模型提供方（provider），例如 `my-gateway`，也可以在 `auth.json` 里写同名 key：

```json
{
  "my-gateway": {
    "type": "api_key",
    "key": "your-api-key"
  }
}
```

这适合：

- 不希望把真实密钥直接写进 `models.json`
- 需要和模型提供方定义分开管理凭据

## 模型配置文件 `models.json`（`models.json`）

`models.json` 用来做两件事：

- 定义自定义模型提供方 / 模型
- 覆盖内置模型提供方的 endpoint、headers 或兼容性行为

这部分配置能力主要继承自 pi-mono。

### 最小结构（Minimal Shape）

```json
{
  "providers": {}
}
```

这只是一个空配置文件，不表示模型已经配置完成。

### 什么情况下不需要 `models.json`（When You Do Not Need `models.json`）

如果你直接使用 Anthropic 默认模型，并且只提供 Anthropic 凭据，那么 `models.json` 可以保持空对象。

### 什么情况下需要 `models.json`（When You Do Need `models.json`）

以下场景通常需要它：

- 使用 OpenAI-compatible 网关、代理或聚合层
- 使用 Ollama、LM Studio、vLLM 等本地 / 自建服务
- 想把内置模型提供方改走代理
- 想新增自定义模型列表

## `models.json`：模型提供方对象（Provider Object）

### 模型提供方级字段（Provider-Level Fields）

| 字段 | 必填 | 说明 |
|------|------|------|
| `baseUrl` | Usually yes | API endpoint |
| `api` | Required when defining models | API type |
| `apiKey` | Required when defining models | Literal key, env var name, or `!command` |
| `headers` | No | Custom request headers |
| `compat` | No | Compatibility overrides for OpenAI-compatible endpoints |
| `authHeader` | No | Add `Authorization: Bearer <apiKey>` automatically |
| `models` | No | Custom model list |
| `modelOverrides` | No | 覆盖该模型提供方上的内置模型定义 |

### 支持的 `api` 类型（Supported `api` Values）

常见值：

| `api` | 常见用途 |
|-------|----------|
| `openai-completions` | Most OpenAI-compatible services |
| `openai-responses` | OpenAI Responses API |
| `anthropic-messages` | Anthropic-compatible services |
| `google-generative-ai` | Google Generative AI |

更完整的 API 类型列表参考上游自定义模型提供方文档（custom-provider）：

- [pi custom-provider.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/custom-provider.md)

## `models.json`：模型对象（Model Object）

### 模型级字段（Model-Level Fields）

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `id` | Yes | - | Model ID passed to the API |
| `name` | No | `id` | Human-readable label |
| `api` | No | Inherits provider `api` | 按模型覆盖 API 类型 |
| `reasoning` | No | `false` | Whether the model supports extended thinking |
| `input` | No | `["text"]` | Input types |
| `contextWindow` | No | `128000` | Context window size |
| `maxTokens` | No | `16384` | Max output tokens |
| `cost` | No | All zeros | Token pricing metadata |
| `compat` | No | Inherits provider `compat` | 按模型覆盖兼容性设置 |

### 场景 1：OpenAI-Compatible 网关（Scenario 1: OpenAI-Compatible Gateway）

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
        { "id": "gpt-4.1" },
        { "id": "gpt-4.1-mini" }
      ]
    }
  }
}
```

适合：

- 公司统一 LLM 网关
- 第三方聚合平台
- 自建 OpenAI-compatible API

### 场景 2：通过代理覆盖内置 Anthropic（Scenario 2: Override Built-in Anthropic Through a Proxy）

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "https://proxy.example.com/v1"
    }
  }
}
```

适合：

- 要求所有 Anthropic 请求走企业代理
- 仍希望保留 Anthropic 的内置模型列表

### 场景 3：本地 Ollama（Scenario 3: Local Ollama）

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        { "id": "qwen2.5-coder:7b" },
        { "id": "llama3.1:8b" }
      ]
    }
  }
}
```

说明：

- Ollama 通常不需要真实 API key，但该字段仍需存在
- `compat` 对本地 OpenAI-compatible 服务通常很有帮助

### 场景 4：显式补充模型元信息（Scenario 4: Explicit Model Metadata）

```json
{
  "providers": {
    "my-gateway": {
      "baseUrl": "https://llm.example.com/v1",
      "api": "openai-completions",
      "apiKey": "your-api-key",
      "models": [
        {
          "id": "gpt-4.1",
          "name": "GPT-4.1 (Gateway)",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 128000,
          "maxTokens": 16384,
          "cost": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0
          }
        }
      ]
    }
  }
}
```

适合：

- 需要更清晰的模型标签
- 希望补充 reasoning / image / token window 元信息

### 常见 `compat` 配置（Common `compat` Settings）

很多 OpenAI-compatible 服务需要以下兼容项：

```json
{
  "compat": {
    "supportsDeveloperRole": false,
    "supportsReasoningEffort": false
  }
}
```

常见意义：

- `supportsDeveloperRole: false`
  - 把 system prompt 作为 `system` 而不是 `developer`
- `supportsReasoningEffort: false`
  - 避免向不支持该字段的服务发送 `reasoning_effort`

如果模型提供方有更多兼容性问题，例如 `max_tokens` 字段名、Qwen thinking format、tool result name 要求等，请参考上游模型文档：

- [pi models.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md)
- [pi custom-provider.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/custom-provider.md)

### 什么情况下 `models.json` 不够用（When `models.json` Is Not Enough）

以下场景通常不能只靠 `models.json`：

- 需要 OAuth / SSO 登录流程
- 目标模型提供方不是 OpenAI / Anthropic / Google 兼容 API
- 需要自定义 streaming implementation

这时应使用 pi-mono 的扩展 / 自定义模型提供方机制（extension / custom provider）。Pipiclaw 本身复用了这套能力，但不是通过简单 JSON 就能完成。

上游参考：

- [pi custom-provider.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/custom-provider.md)

## 运行时设置文件 `settings.json`（`settings.json`）

`settings.json` 用来控制 Pipiclaw 的默认模型和部分运行时行为。

### 兼容性说明（Important Compatibility Note）

虽然 `settings.json` 这个概念来自 pi-mono，但 Pipiclaw 目前并没有完整支持上游 `settings.md` 里的所有字段。

可以把它理解为：

- Pipiclaw 采用了同一个文件名
- 复用了少量模型、压缩（compaction）、重试（retry）相关语义
- 但没有实现完整的 UI、资源加载、project override、packages、themes 等设置体系

因此，下面这张表比上游 `settings.md` 更重要，因为它描述的是 Pipiclaw 当前真实支持的行为。

### Pipiclaw 当前支持的字段（Supported Fields in Pipiclaw）

| 字段 | 默认值 | 在 Pipiclaw 中生效 | 说明 |
|------|--------|----------------------|------|
| `defaultProvider` | unset | Yes | 默认模型提供方 |
| `defaultModel` | unset | Yes | 默认模型 |
| `defaultThinkingLevel` | `"off"` | Partially | 通过 settings manager 暴露的默认 thinking level |
| `compaction.enabled` | `true` | Yes | 启用自动上下文压缩 |
| `compaction.reserveTokens` | `16384` | Yes | 为压缩流程预留的 token 数 |
| `compaction.keepRecentTokens` | `20000` | Yes | 压缩前保留的近期 token 数 |
| `retry.enabled` | `true` | Yes | 启用自动重试 |
| `retry.maxRetries` | `3` | Yes | 最大重试次数 |
| `retry.baseDelayMs` | `2000` | Yes | 基础退避延迟 |
| `memoryRecall.enabled` | `true` | Yes | 启用相关记忆召回 |
| `memoryRecall.maxCandidates` | `12` | Yes | 排序前候选片段数量 |
| `memoryRecall.maxInjected` | `5` | Yes | 注入当前 prompt 的片段数量 |
| `memoryRecall.maxChars` | `5000` | Yes | 注入字符上限 |
| `memoryRecall.rerankWithModel` | `"auto"` | Yes | 是否用模型对召回结果再次排序；`"auto"` 只在本地排序不确定时触发 |
| `sessionMemory.enabled` | `true` | Yes | 启用 `SESSION.md` 刷新流程 |
| `sessionMemory.minTurnsBetweenUpdate` | `2` | Yes | scheduled session refresh 的 assistant turn 阈值 |
| `sessionMemory.minToolCallsBetweenUpdate` | `4` | Yes | scheduled session refresh 的工具调用阈值 |
| `sessionMemory.timeoutMs` | `30000` | Yes | 会话记忆刷新超时 |
| `sessionMemory.failureBackoffTurns` | `3` | Legacy | 边界外的 scheduled refresh 主要使用 `memoryMaintenance.failureBackoffMinutes` |
| `sessionMemory.forceRefreshBeforeCompact` | `true` | Yes | compaction 前强制刷新 |
| `sessionMemory.forceRefreshBeforeNewSession` | `true` | Yes | `/new` 前强制刷新 |
| `memoryGrowth.postTurnReviewEnabled` | `true` | Yes | 启用后台 growth review job |
| `memoryGrowth.autoWriteChannelMemory` | `true` | Yes | 高置信 durable fact 自动写入 channel `MEMORY.md` |
| `memoryGrowth.autoWriteWorkspaceSkills` | `true` | Yes | 高置信 reusable workflow 自动写入 workspace `skills/` |
| `memoryGrowth.minSkillAutoWriteConfidence` | `0.9` | Yes | workspace skill 自动写入阈值；可调高，但运行时最低为 `0.9` |
| `memoryGrowth.minMemoryAutoWriteConfidence` | `0.85` | Yes | channel memory 自动写入阈值 |
| `memoryGrowth.idleWritesHistory` | `false` | Reserved | idle consolidation 默认不写 `HISTORY.md` |
| `memoryGrowth.minTurnsBetweenReview` | `12` | Yes | growth review job 的 assistant turn 阈值 |
| `memoryGrowth.minToolCallsBetweenReview` | `24` | Yes | growth review job 的工具调用阈值 |
| `memoryMaintenance.enabled` | `true` | Yes | 启用内置后台 memory maintenance scheduler |
| `memoryMaintenance.minIdleMinutesBeforeLlmWork` | `10` | Yes | channel 最近活跃后至少等待多久才允许后台 LLM work |
| `memoryMaintenance.sessionRefreshIntervalMinutes` | `10` | Yes | scheduled session refresh 的最小间隔 |
| `memoryMaintenance.durableConsolidationIntervalMinutes` | `20` | Yes | durable consolidation job 的最小间隔 |
| `memoryMaintenance.growthReviewIntervalMinutes` | `60` | Yes | growth review job 的最小间隔 |
| `memoryMaintenance.structuralMaintenanceIntervalHours` | `6` | Yes | cleanup/folding structural job 的最小间隔 |
| `memoryMaintenance.maxConcurrentChannels` | `1` | Yes | 每个 tick 最多处理的 channel 数 |
| `memoryMaintenance.failureBackoffMinutes` | `30` | Yes | 后台任务失败后的回退分钟数 |
| `sessionSearch.enabled` | `true` | Yes | 启用当前 channel transcript 冷路径搜索 |
| `sessionSearch.maxFiles` | `12` | Yes | `session_search` 最多读取的当前 channel JSONL 文件数 |
| `sessionSearch.maxChunks` | `80` | Yes | `session_search` 最多评分片段数 |
| `sessionSearch.maxCharsPerChunk` | `1200` | Yes | 单个搜索片段字符上限 |
| `sessionSearch.summarizeWithModel` | `false` | Yes | 是否用模型对搜索命中做 focused summary |
| `sessionSearch.timeoutMs` | `12000` | Yes | 搜索摘要 sidecar 超时 |

### 在 Pipiclaw 中暂时不要依赖的 pi-mono 字段（Fields From pi-mono That You Should Not Rely On in Pipiclaw）

下列上游设置概念在 Pipiclaw 当前版本里不要依赖：

- project-level `.pi/settings.json` overrides
- `packages`
- `extensions`
- `skills`
- `prompts`
- `themes`
- `enableSkillCommands`
- `theme`
- `quietStartup`
- `collapseChangelog`
- `transport`
- `steeringMode`
- `followUpMode`
- `enabledModels`
- terminal / image UI settings
- shell / npm command settings
- `sessionDir`
- most UI-only settings

说明：

- 其中一些字段会被读取为 no-op
- 一些字段在 Pipiclaw 的 settings manager 中直接返回固定值
- 如果你照着 pi CLI 的 `settings.md` 配这些项，Pipiclaw 不一定会表现出相同效果

上游参考：

- [pi settings.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/settings.md)

### 推荐的 `settings.json` 示例（Recommended `settings.json` Examples）

#### 1. 固定默认模型（Pin a Default Model）

```json
{
  "defaultProvider": "my-gateway",
  "defaultModel": "gpt-4.1"
}
```

#### 2. 降低记忆召回噪声（Reduce Recall Noise）

```json
{
  "memoryRecall": {
    "enabled": true,
    "maxCandidates": 8,
    "maxInjected": 3,
    "maxChars": 3000,
    "rerankWithModel": "auto"
  }
}
```

适合：

- 提示词预算紧张
- 希望 recall 更克制

#### 3. 更积极地刷新会话记忆（More Aggressive Session Memory Refresh）

```json
{
  "sessionMemory": {
    "enabled": true,
    "minTurnsBetweenUpdate": 1,
    "minToolCallsBetweenUpdate": 2,
    "timeoutMs": 30000,
    "failureBackoffTurns": 2,
    "forceRefreshBeforeCompact": true,
    "forceRefreshBeforeNewSession": true
  }
}
```

适合：

- 长任务、多工具调用
- 希望 `SESSION.md` 更新更频繁

#### 4. 更保守的上下文压缩（More Conservative Compaction）

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 30000
  }
}
```

适合：

- 当前模型上下文较大

#### 5. 调整后台记忆维护与冷路径检索

```json
{
  "memoryMaintenance": {
    "enabled": true,
    "minIdleMinutesBeforeLlmWork": 10,
    "sessionRefreshIntervalMinutes": 10,
    "durableConsolidationIntervalMinutes": 20,
    "growthReviewIntervalMinutes": 60,
    "structuralMaintenanceIntervalHours": 6,
    "maxConcurrentChannels": 1,
    "failureBackoffMinutes": 30
  },
  "memoryGrowth": {
    "postTurnReviewEnabled": true,
    "autoWriteChannelMemory": true,
    "autoWriteWorkspaceSkills": true,
    "minMemoryAutoWriteConfidence": 0.85,
    "minSkillAutoWriteConfidence": 0.9
  },
  "sessionSearch": {
    "enabled": true,
    "maxFiles": 12,
    "maxChunks": 80,
    "maxCharsPerChunk": 1200,
    "summarizeWithModel": false,
    "timeoutMs": 12000
  }
}
```

说明：

- 普通用户 turn 结束后只记录 dirty/counter，不直接触发 memory LLM sidecar。
- `memoryMaintenance` 是内置后台 scheduler，不依赖也不会写入 `workspace/events/`。
- 四类后台任务在调用 LLM 前都有本地 gate；无新内容、channel 仍活跃、未到阈值或未到间隔时不会调用 LLM。
- `postTurnReview` 已迁移为后台 growth review job，触发频率由 `memoryGrowth.minTurnsBetweenReview` / `memoryGrowth.minToolCallsBetweenReview` 和 `memoryMaintenance.growthReviewIntervalMinutes` 共同控制。
- `session_search` 只搜索当前 channel 的 `context.jsonl`、session JSONL、`log.jsonl` 和存在时的 `log.jsonl.1`。
- `minSkillAutoWriteConfidence` 可以调高以进一步收紧 workspace skill 自动写入，但低于 `0.9` 的配置会按 `0.9` 执行，避免低置信 workflow 污染 workspace skills。

## 内建工具配置文件 `tools.json`（`tools.json`）

`tools.json` 用来配置 Pipiclaw 的内建工具能力，包括 `web_search` / `web_fetch`、当前 channel 冷路径搜索，以及 workspace skill 管理工具。

### 启动后默认生成的模板（Bootstrap Template）

```json
{
  "tools": {
    "web": {
      "enable": false,
      "proxy": null,
      "search": {
        "provider": "brave",
        "apiKey": ""
      }
    },
    "memory": {
      "sessionSearch": {
        "enabled": true
      }
    },
    "skills": {
      "manage": {
        "enabled": true
      }
    }
  },
  "_examples": {
    "proxy": "http://127.0.0.1:7890",
    "apiKey": "BSA..."
  }
}
```

这份模板的意图是：

1. 默认不注册 `web_search` / `web_fetch`
2. 默认注册当前 channel 的 `session_search`
3. 默认注册 workspace skill 管理工具
4. 给出一个可直接改造的 Brave 示例
5. 给出可选代理示例，但默认不强行启用代理

如果你要启用它，通常只需要：

1. 把 `tools.web.enable` 改成 `true`
2. 把 `tools.web.search.apiKey` 填成真实 Brave key
3. 如需代理，再把 `_examples.proxy` 复制到 `tools.web.proxy`

### 字段说明（Field Reference）

#### `tools.web`

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `enable` | `false` | 是否启用所有内建 web 工具；设为 `false` 时，`web_search` 和 `web_fetch` 都不会注册 |
| `proxy` | `null` | web 请求专用代理；设置后优先于环境变量 |

#### `tools.web.search`

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `provider` | `"brave"` | 搜索后端：`duckduckgo`、`brave`、`tavily`、`jina`、`searxng` |
| `apiKey` | `""` | `brave`、`tavily`、`jina` 的 API key |
| `baseUrl` | `""` | `searxng` 的 base URL |
| `maxResults` | `5` | 每次搜索返回结果数，范围 `1-10` |
| `timeoutMs` | `30000` | 搜索请求超时 |

#### `tools.web.fetch`

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `maxChars` | `50000` | 抓取文本的最大返回字符数 |
| `timeoutMs` | `30000` | 抓取请求超时 |
| `maxImageBytes` | `10485760` | 抓取图片的最大字节数 |
| `preferJina` | `false` | 是否优先使用 Jina Reader |
| `enableJinaFallback` | `false` | 本地提取失败后是否允许回退到 Jina Reader |
| `defaultExtractMode` | `"markdown"` | HTML 默认提取格式 |

#### `tools.memory.sessionSearch`

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `enabled` | `true` | 是否注册 `session_search` 工具。该工具只搜索当前 channel 的冷存储，不跨 channel |

#### `tools.skills.manage`

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `enabled` | `true` | 是否注册 `skill_list`、`skill_view`、`skill_manage`。这些工具只管理 workspace 级 skills |

### 常见示例（Common Examples）

#### 1. 禁用所有内建 web 工具

```json
{
  "tools": {
    "web": {
      "enable": false
    }
  }
}
```

#### 2. 使用 Brave

```json
{
  "tools": {
    "web": {
      "enable": true,
      "search": {
        "provider": "brave",
        "apiKey": "BSA..."
      }
    }
  }
}
```

#### 3. 使用 SearXNG

```json
{
  "tools": {
    "web": {
      "search": {
        "provider": "searxng",
        "baseUrl": "https://searx.example"
      }
    }
  }
}
```

### 代理优先级（Proxy Precedence）

web 工具的代理顺序是：

1. `tools.web.proxy`
2. `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`
3. 直连

补充说明：

- DingTalk runtime 也会尊重同一套标准代理环境变量
- 当前不再支持 `DINGTALK_FORCE_PROXY`
- 希望在 compaction 前保留更多近期消息

## 工作区级配置（Workspace-Level Configuration）

除了 JSON 配置文件，Pipiclaw 还高度依赖工作区（workspace）文件。

## 助手身份文件 `SOUL.md`（`SOUL.md`）

定义助手是谁、说话风格如何、默认语言和回复偏好是什么。

适合放：

- 默认用中文回复
- 语气偏简洁 / 偏正式
- Markdown 输出偏好
- 团队内部的助手身份定位

## 助手规则文件 `AGENTS.md`（`AGENTS.md`）

定义助手应该如何工作，而不是它“是什么”。

适合放：

- 工具使用规则
- 安全边界
- 是否允许执行写操作
- 项目级工作流
- 哪些事必须先确认，哪些事不要做

## 工作区记忆文件 `workspace/MEMORY.md`（`workspace/MEMORY.md`）

这是工作区级持久背景，适合放长期有效的信息：

- 团队约定
- 稳定的架构信息
- 共享环境规则
- 长期项目背景

## 子代理目录 `workspace/sub-agents/`（`workspace/sub-agents/`）

放预定义子代理（sub-agent）。适合把 reviewer、researcher、planner 之类角色固化下来。

详细字段、示例和推荐写法见 [events-and-sub-agents.md](./events-and-sub-agents.md)。

## 事件目录 `workspace/events/`（`workspace/events/`）

放定时事件 JSON。可用于：

- 周期性检查
- 提醒
- 固定时间回顾记忆文件

详细事件类型、字段说明和使用建议见 [events-and-sub-agents.md](./events-and-sub-agents.md)。

## 技能目录 `workspace/skills/`（`workspace/skills/`）

放工作区级技能资源。Pipiclaw 只支持 workspace 级技能，不支持 channel 级 skills。

相关工具：

- `skill_list`：列出 workspace skills
- `skill_view`：查看 `SKILL.md` 或允许的支持文件
- `skill_manage`：创建、patch 或写入允许的支持文件

`skill_manage` 会限制路径只能落在 `workspace/skills/<name>/` 下，支持文件只能在 `references/`、`templates/`、`scripts/`、`assets/` 内。高置信 post-turn review 也可能直接创建或更新 workspace skill；直接写入后会发送 DingTalk 轻提示，并写入 channel 的 `memory-review.jsonl`。

## 会话通道级运行时文件（Channel-Level Runtime Files）

运行后，Pipiclaw 会按私聊或群聊创建会话通道目录，例如：

```text
~/.pi/pipiclaw/workspace/dm_<staffId>/
~/.pi/pipiclaw/workspace/group_<conversationId>/
```

常见文件：

| 文件 | 用途 |
|------|------|
| `SESSION.md` | 当前工作态 |
| `MEMORY.md` | 会话通道级持久记忆 |
| `HISTORY.md` | 更早上下文的摘要 |
| `context.jsonl` | 会话事件冷存储 |
| `log.jsonl` | 原始运行日志 |
| `log.jsonl.1` | 原始运行日志的轮转备份，存在时可被 `session_search` 检索 |
| `memory-review.jsonl` | 自动写回、suggestion、skipped 决策的审计文件 |
| `subagent-runs.jsonl` | 子代理运行摘要 |

记忆分层：

- `SESSION.md`：当前工作态，由 runtime 在边界保存和后台 session refresh job 中维护。
- `MEMORY.md`：durable channel facts、决策、偏好、约束和中期 open loops。
- `HISTORY.md`：compaction、`/new`、shutdown 等边界上的旧阶段摘要；后台 durable consolidation 默认不写它。
- `context.jsonl` / `log.jsonl` / `log.jsonl.1`：冷存储，只通过 `session_search` 显式检索，不进入普通 turn-time recall。
- `${PIPICLAW_HOME}/state/memory/<channelId>.json`：内置 scheduler 的 hidden state，只记录 dirty、阈值计数、上次运行时间和 backoff，不作为 recall 来源。

## 按场景推荐的配置路径（Recommended Configuration Paths by Scenario）

### 场景 A：先跑通第一条消息（Scenario A: First Successful Bring-up）

目标：

- 先让机器人回第一条消息

建议：

1. `channel.json` 只保留最小字段
2. 最好一并准备 AI Card；如果只是排查链路，才临时把 `cardTemplateId` 留空
3. 直接使用 Anthropic 默认模型
4. 设置 `ANTHROPIC_API_KEY`
5. 启动后先发送 `/model`，确认当前模型和可见模型列表；切换时可使用精确的 `provider/modelId`、精确的 `modelId`，或能唯一命中的片段字符串

### 场景 B：已有 OpenAI-Compatible 网关（Scenario B: Existing OpenAI-Compatible Gateway）

目标：

- 接入已有公司网关或第三方聚合层

建议：

1. 在 `models.json` 里创建自定义模型提供方
2. 优先使用 `openai-completions`
3. 先加上常见 `compat` 配置
4. 用 `settings.json` 固定默认模型
5. 用 `/model` 验证模型列表；如果要切换模型，可以直接尝试唯一片段，例如 `/model qwen` 或 `/model turbo`

### 场景 C：Anthropic 通过企业代理接入（Scenario C: Anthropic Through Enterprise Proxy）

目标：

- 保留 Anthropic 模型列表，但统一改走公司代理

建议：

1. 在 `models.json` 覆盖 `anthropic.baseUrl`
2. 凭据仍使用 Anthropic 方式提供
3. 如果出现额外 header 需求，再考虑上游 custom provider 机制

### 场景 D：本地模型（Scenario D: Local Models）

目标：

- 用 Ollama 或其他本地 OpenAI-compatible 服务跑 Pipiclaw

建议：

1. 在 `models.json` 新建本地模型提供方
2. `api` 设为 `openai-completions`
3. `apiKey` 可以填占位值，例如 `ollama`
4. 打开常见 `compat`
5. 先选一个文本模型验证，再逐步补 image / reasoning 元信息

### 场景 E：小范围严格灰度（Scenario E: Strict Pilot in a Small Group）

目标：

- 只让少量同事使用

建议：

1. `allowFrom` 只写测试人员 staff ID
2. 建议同时配置 AI Card，方便灰度期间观察执行过程
3. 固定一个稳定默认模型
4. 打开 `PIPICLAW_DEBUG` 排查问题

### 场景 F：OAuth / SSO / 非标准模型提供方（Scenario F: OAuth / SSO / Non-Standard Provider）

目标：

- 接入需要登录流程或非标准 API 的模型提供方

建议：

1. 不要只靠 `models.json`
2. 直接评估 pi-mono extension / custom provider 方案
3. 先参考上游 custom-provider 文档和示例

## 常见问题（Frequently Asked Questions）

### 为什么初始化后 `models.json` 是空的？（Why Is `models.json` Empty After Initialization?）

因为初始化只会生成一个占位文件，不会替你决定应该连哪个模型提供方。

### 为什么进程能启动，但机器人第一条消息仍然失败？（Why Can the Process Start but the Bot Still Fail on First Message?）

因为进程启动成功只说明 DingTalk 接入和本地初始化通过，不代表模型凭据或模型提供方配置已经可用。

### API Key 应该放在 `auth.json` 还是 `models.json`？（Should I Put API Keys in `auth.json` or `models.json`?）

两种都可以，但推荐：

- 模型提供方定义放 `models.json`
- 凭据放 `auth.json` 或环境变量

这样更容易维护和替换。

### 可以使用 pi-mono 的 `.pi/settings.json` 项目级覆盖吗？（Can I Use pi-mono's `.pi/settings.json` Project Overrides?）

当前不要依赖。Pipiclaw 目前只使用 `~/.pi/pipiclaw/settings.json`。

### pi-mono 的 `settings.md` 能完整套用到这里吗？（Is `settings.md` From pi-mono Fully Applicable Here?）

不是。Pipiclaw 只采用了其中一部分设置语义。

## 上游参考资料（Upstream References）

这份文档整理和对齐了下面几份上游资料：

- [pi providers.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/providers.md)
- [pi models.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md)
- [pi custom-provider.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/custom-provider.md)
- [pi settings.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/settings.md)

如果你要做的是：

- 新的 OAuth provider
- 自定义 stream implementation
- 更复杂的 provider extension

建议直接阅读上游文档和示例代码。
