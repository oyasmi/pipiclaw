# Pipiclaw 配置速查（Configuration Quickstart）

这份文档只回答一个问题：**现在该改哪个配置文件**。完整字段见
[configuration-reference.md](./configuration-reference.md)，运行机制解释见
[runtime-mechanisms.md](./runtime-mechanisms.md)。

## 配置目录

Pipiclaw 默认使用：

```text
~/.pipiclaw/
├── channel.json
├── auth.json
├── models.json
├── settings.json
├── tools.json
├── security.json
└── workspace/
    ├── SOUL.md
    ├── AGENTS.md
    ├── MEMORY.md
    ├── ENVIRONMENT.md
    ├── events/
    ├── skills/
    └── sub-agents/
```

设置 `PIPICLAW_HOME=/your/path` 后，以上文件都改到该目录下。Pipiclaw 面向 Linux/macOS 等
POSIX 环境；Windows 请使用 WSL2。

默认目录曾是 `~/.pi/pipiclaw/`。**自动迁移已在 0.9.0 移除**：仍在用旧目录的部署，要么手动把整个目录移到 `~/.pipiclaw/`，要么设 `PIPICLAW_HOME=~/.pi/pipiclaw` 继续用原位置。

## 为什么是六个文件

六个 app 级文件不是按主题切的，是按**所有权生命周期**切的——谁写它、多久变一次、改错了影响什么。
知道这条规则，就不必记住每个字段在哪：先问"这件事属于下面哪一类"。

| 文件 | 它是什么 | 谁写 / 多久变 |
|---|---|---|
| `channel.json` | 钉钉应用凭据，以及这个传输自己的投递行为（`responseMode`、`busyMessageDefault`、`allowFrom`） | 部署时填一次，之后基本不动 |
| `auth.json` | 模型凭据 | 由 `pipiclaw auth login/logout` 写；轮换密钥时变，不建议手改 |
| `models.json` | 模型与供应商定义（`baseUrl`、`api`、`models[]`） | 接入新网关或新模型时变 |
| `settings.json` | **产品意图**：默认模型、fallback、模块开关、日志级别 | 调口味时变 |
| `tools.json` | **能力**：哪些工具存在（web、tasks、rtk、bashInterceptor） | 决定"助手能做什么"时变 |
| `security.json` | **策略**：命令/路径/网络守卫与项目边界 | 收紧或放开权限时变 |

两条由此推出的规则，可以省掉很多翻文档的时间：

- **`settings.json` 只收布尔、枚举和模型引用。** 找不到某个数值阈值（间隔、预算、退避、置信度门槛）是正常的——它们一律是代码常量，不是配置。已退休的键列在 `RETIRED_SETTINGS_KEYS` 里，启动时会警告，不会静默失效。
- **六个文件创建即 `0600`**，启动时还会收紧已存在的宽权限文件。它们都可能含密钥或策略，不要进版本库。

workspace 下的文件是另一类：它们是给模型读的**内容**（身份、规则、记忆、角色、技能），不是运行时配置，改完下一轮就生效，见下表。

## 先改哪一个

| 目标 | 文件 | 最少要改什么 |
|---|---|---|
| 接入钉钉 | `channel.json` | `clientId`、`clientSecret`；`robotCode` 可留空；`cardTemplateId` 推荐配置 |
| 配模型凭据 | `auth.json` 或环境变量 | Anthropic 默认用 `ANTHROPIC_API_KEY` 或 `auth.json.anthropic.key` |
| 自定义模型 | `models.json` | provider 的 `baseUrl`、`api`、`apiKey`、`models[].id` |
| 选默认模型 | `settings.json` | `defaultProvider` + `defaultModel` |
| 开网页工具 | `tools.json` | `tools.web.enable: true`，再配置搜索 provider |
| 关/开长程任务 | `tools.json` | `tools.tasks.enabled` |
| 调安全策略 | `security.json` | `commandGuard`、`pathGuard`、`networkGuard`、`audit` |
| 改助手风格 | `workspace/SOUL.md` | 身份、语气、默认语言 |
| 改工作规则 | `workspace/AGENTS.md` | 团队规则、安全边界、项目工作流 |
| 加可复用角色 | `workspace/sub-agents/*.md` | `runtime: internal` 或 `external`、用途描述、权限声明与 system prompt |
| 加可复用流程 | `workspace/skills/` | 通过 `write`/`edit` 创建/维护 workspace skill，`skill` 工具只读列出/加载 |
| 让 LLM 请求走代理 | 环境变量 `PIPICLAW_PROXY` | 见下方「LLM 请求走代理」 |

## 钉钉最小配置

`channel.json`：

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

要点：

- 硬性必填只有 `clientId` 和 `clientSecret`。
- `robotCode` 留空时回退到 `clientId`。
- `cardTemplateId` 留空也能工作，但不会使用 AI Card；正式使用建议补上。
- `allowFrom: []` 或省略表示允许所有发送者；灰度时填 staff ID。
- `busyMessageDefault` 默认 `"steer"`，也可设 `"followUp"` / `"followup"`。
- `responseMode` 默认 `"full_progress_then_plain_final"`；另有 `"rolling_progress_then_plain_final"` 和 `"final_card_only"`。

保留任何 `your-*` 占位值都会让启动检查失败。

## 模型配置

### Anthropic 默认模型

`models.json` 保持默认空 provider：

```json
{
  "providers": {}
}
```

凭据用环境变量：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

或写入 `auth.json`：

```json
{
  "anthropic": { "type": "api_key", "key": "sk-ant-..." }
}
```

### OpenAI-compatible 网关

`models.json`：

```json
{
  "providers": {
    "my-gateway": {
      "baseUrl": "https://llm.example.com/v1",
      "api": "openai-completions",
      "apiKey": "MY_GATEWAY_API_KEY",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [{ "id": "gpt-4.1" }]
    }
  }
}
```

`apiKey` 可以是真实 key、环境变量名，或 `!command`。不想把 key 放进 `models.json` 时，在 `auth.json` 写同名 provider 凭据。

设置默认模型：

```json
{
  "defaultProvider": "my-gateway",
  "defaultModel": "gpt-4.1",
  "defaultThinkingLevel": "medium"
}
```

### 订阅登录（OAuth provider）

部分 provider 用订阅账号登录而不是 API key（`openai-codex` = ChatGPT Plus/Pro、`anthropic` = Claude
Pro/Max，以及 `github-copilot`、`kimi-coding`、`xai`、`openrouter` 等，取决于 SDK 内置的 provider
目录）。这类登录只在独立命令 `pipiclaw auth` 里做——钉钉端不提供登录入口，TUI 也不内嵌登录流程。

```bash
pipiclaw auth status                 # 列出每个 provider 的配置状态、凭据类型、来源
pipiclaw auth login                  # 交互式：先选认证方式，再选 provider
pipiclaw auth login openai-codex     # 直接指定 provider（id 或名字，大小写不敏感）
pipiclaw auth logout openai-codex    # 删除已存凭据（会二次确认，--yes 跳过）
```

凭据落在 `auth.json`（`~/.pipiclaw/auth.json`，`PIPICLAW_HOME` 会跟随），与手填的 API key 同文件同权限
（0600）。

无头服务器（SSH 上去，没有本地浏览器）：优先 `pipiclaw auth login --device-code`，在手机或本地浏览器上
打开打印出的 URL 输入用户码，服务器端轮询即可，不需要占用回调端口；一定要走浏览器流的话，用
`ssh -L 1455:127.0.0.1:1455 …` 转发再打开打印出的 URL。

**其它进程不会自动看到新凭据**：一次 `pipiclaw auth login` 之后，正在运行的钉钉守护进程或 TUI 会话
仍然用登录前读到的那份 auth.json 快照，必须重启才能用上新凭据；`pipiclaw auth status` 也会复述这一点。

Codex 对话流量的代理注意事项：`openai-codex-responses` 默认走 WebSocket transport，只认标准
`HTTP_PROXY`/`HTTPS_PROXY`（不认 `PIPICLAW_PROXY`，见下方「已知不覆盖」），登录本身走 `fetch`、受
`PIPICLAW_PROXY` 管辖，但登录成功不等于对话请求也走了代理——只设了 `PIPICLAW_PROXY` 时,
`pipiclaw auth login` 结束时会给出告警。

## 内建工具

`tools.json` 的当前 bootstrap 模板等价于：

```json
{
  "tools": {
    "web": {
      "enable": false,
      "proxy": null,
      "search": {
        "provider": "brave",
        "apiKey": "",
        "maxResults": 5
      }
    },
    "tasks": {
      "enabled": true
    }
  },
  "_examples": {
    "proxy": "http://127.0.0.1:7890",
    "apiKey": "BSA..."
  }
}
```

恒开、无 `tools.json` 开关的核心工具包括：`read`、`write`、`edit`、`grep`、`glob`、`bash`、`job`、`session_search`、`memory_save`、`memory_search`、`memory_forget`、`skill`、`event_manage`。`send_media` 由传输层能力决定。

`subagent`、`subagent_list` 和 `subagent_run` 也恒开，只提供给主智能体。角色是否存在、能否使用由 `workspace/sub-agents/*.md` 决定；外部角色还要求目标 CLI 在 daemon 的 `PATH` 中可用。角色字段、推荐模板和安全边界见 [sub-agents.md](./sub-agents.md)。

启用 web 工具：

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

SearXNG 也必须打开总开关：

```json
{
  "tools": {
    "web": {
      "enable": true,
      "search": {
        "provider": "searxng",
        "baseUrl": "https://searx.example"
      }
    }
  }
}
```

## LLM 请求走代理

`tools.json` 里的 `tools.web.proxy` 只管 `web_search`/`web_fetch` 这两个工具的出站请求。**主智能体、内置子智能体和记忆维护 sidecar 发往模型 API 的请求（含 OAuth 刷新、模型目录拉取）默认直连，不受 `tools.web.proxy` 影响**——Node 内置的 `fetch` 不读任何 `*_PROXY` 环境变量，Anthropic/OpenAI/Mistral 等 SDK 也都基于它。要让这部分请求走代理，用环境变量：

```bash
export PIPICLAW_PROXY=http://127.0.0.1:7890
# 可选：这个代理不代理的目标（逗号分隔，支持 host、host:port、*.suffix）
export PIPICLAW_NO_PROXY=internal.example.com,10.0.0.0/8
```

只支持 `http://`/`https://` 代理 URL，**不支持 `socks5://`**：配了 SOCKS 地址会在启动日志里警告，并保持直连，不会静默失败。

外部 Claude Code / Codex / exec 进程不走 Pipiclaw 的模型客户端。它们继承 daemon 环境，但是否识别 `PIPICLAW_PROXY`、标准代理变量或自己的配置文件由目标 CLI 决定；不要因为主智能体已能联网就假设外部角色也已配置完成。

### 和标准 `HTTP_PROXY`/`HTTPS_PROXY` 的关系

| 设置 | LLM 请求（主智能体、内置子智能体、记忆 sidecar） | 钉钉 HTTP API（发消息、卡片流式） | 钉钉 WebSocket 长连接 |
|---|---|---|---|
| 只设 `PIPICLAW_PROXY` | 走代理 | 直连 | 直连 |
| 只设标准 `HTTP_PROXY`/`HTTPS_PROXY` | 走代理 | 走代理（axios 自己也读这两个变量） | 直连（`ws` 不读代理变量） |
| 两者都设 | `PIPICLAW_PROXY` 生效，标准变量被忽略 | 走代理 | 直连 |

`PIPICLAW_PROXY` 是独立变量，不是巧合：钉钉的 axios 客户端会自己读标准 `HTTP_PROXY`/`HTTPS_PROXY`，如果只想让模型请求走代理、钉钉直连，就必须用 `PIPICLAW_PROXY`，否则设标准变量会把钉钉的 HTTP 调用也捎带代理（而它的 WebSocket 连接依然直连，变成一半走一半不走）。bash 工具里的子进程（`curl`、`npm` 等）会继承进程环境，因此仍然遵循标准 `HTTP_PROXY`/`HTTPS_PROXY`。

标准变量按惯例大小写皆可（`HTTPS_PROXY`/`https_proxy`），但**不识别 `ALL_PROXY`**——只认 `HTTP_PROXY`/`HTTPS_PROXY`。`PIPICLAW_NO_PROXY` 未设置时会回落到标准 `NO_PROXY`/`no_proxy`。

### 已知不覆盖

- Bedrock 和 OpenAI Codex 的 WebSocket transport 走独立的 HTTP 客户端，只认标准 `HTTP_PROXY`/`HTTPS_PROXY`（也不支持 SOCKS），不认 `PIPICLAW_PROXY`。
- `tools.web.proxy` 反过来也不受 `PIPICLAW_PROXY` 影响，两者互不联动，按各自的意图独立配置。

## 安全策略

`security.json` 的首次初始化模板会开启 command/path guard，并关闭 network guard：

```json
{
  "pathGuard": { "enabled": true },
  "commandGuard": { "enabled": true },
  "networkGuard": { "enabled": false }
}
```

没有配置文件时，代码默认会开启 network guard；但正常用户首次启动会生成上面的模板，所以**新初始化实例的实际 web 请求网络守卫默认关闭**。需要拦截 localhost、metadata service、私网地址和重定向目标时，显式设置：

```json
{
  "networkGuard": {
    "enabled": true,
    "allowedHosts": [],
    "allowedCidrs": [],
    "maxRedirects": 5
  }
}
```

完整安全字段和边界见 [security.md](./security.md)。

## 常见场景

| 场景 | 建议路径 |
|---|---|
| 先跑通第一条消息 | 只补 `channel.json` 的钉钉字段和一个可用模型凭据；AI Card 可先留空 |
| 已有企业 LLM 网关 | 在 `models.json` 定义 provider，在 `settings.json` 固定默认模型 |
| 本地 Ollama | `models.json` 定义本地 provider；如启用 `networkGuard`，把本地地址加入 allow |
| 控制后台记忆成本 | 保留 `memoryMaintenance.enabled: true`，优先关闭 `memoryRecall.rerankWithModel` 与 `sessionSearch.summarizeWithModel` |
| 多用户灰度 | `channel.json.allowFrom` 填 staff ID 列表 |
| 长期 daemon | 用 systemd/pm2/supervisor；日志和账本默认落在 `state/` |
| 部署环境无法直连模型 API | 设环境变量 `PIPICLAW_PROXY`（只代理 LLM 请求，钉钉不受影响），见「LLM 请求走代理」 |

## 相关文档

- 完整字段：[configuration-reference.md](./configuration-reference.md)
- 运行机制：[runtime-mechanisms.md](./runtime-mechanisms.md)
- 工具清单：[tools.md](./tools.md)
- 交互入口与命令：[interaction-and-commands.md](./interaction-and-commands.md)
- 智能体角色与外部 CLI：[sub-agents.md](./sub-agents.md)
- Workspace skills：[skills.md](./skills.md)
- 安全策略：[security.md](./security.md)
- 部署运维：[deployment-and-operations.md](./deployment-and-operations.md)
