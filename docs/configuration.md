# 配置速查（Configuration Quickstart）

> **适合谁**：已经装好 Pipiclaw，想快速查清**“我要达成某个目标，最少该改哪个配置文件”**的使用者与维护者。
> **读完你会得到**：一张表定位 `~/.pipiclaw/` 下 6 个配置文件的分工，以及渠道、模型、联网工具与网络代理的最简配置模板。逐字段完整字典请查 [配置字段参考](./configuration-reference.md)。

---

## 一眼看懂配置目录与分工

Pipiclaw 默认将全部配置与数据存放在 `~/.pipiclaw/`（设置环境变量 `PIPICLAW_HOME=/your/path` 可迁移到任意目录）：

```text
~/.pipiclaw/
├── channel.json      # 渠道开关与凭据：Web API（默认已开启）与钉钉（按需开启）
├── auth.json         # 模型凭据：通常由 pipiclaw auth login/logout 自动维护
├── models.json       # 自定义模型供应商（OpenAI 兼容网关、DeepSeek、本地 Ollama 等）
├── settings.json     # 产品偏好：默认模型、备用模型、压缩/记忆/日志开关
├── tools.json        # 内建工具开关：联网搜索/抓取（默认关）、长程任务开关（默认开）
├── security.json     # 安全策略：命令、路径与出站网络访问守卫
└── workspace/        # 个人与团队资产：
    ├── SOUL.md       # 助手身份、语气与回复风格（所有工位共用）
    ├── AGENTS.md     # 通用工作规则与红线约束（所有工位共用）
    ├── MEMORY.md     # 管理员维护的跨工位共享背景
    ├── ENVIRONMENT.md# 本机环境事实记录
    ├── skills/       # 可复用工作流技能（另支持读取 ~/.agents/skills/）
    ├── sub-agents/   # 已启用的内置/外部智能体角色文件（*.md）
    └── desk-default/ # 默认工位（含长期记忆 memory/、日记 journal/、任务 tasks/、事件 events/）
```

记住两条核心设计规则，就能省掉大量翻文档时间：

1. **六个 JSON 文件按“谁写它、多久改一次”切分，且创建即收紧为 `0600` 权限**（仅当前系统用户可读写，切勿直接提交到公开 Git 仓库）。
2. **`settings.json` 只放“产品意图”（模型选择、布尔开关、展示枚举）**，不放后台维护间隔、重试退避等内部算法阈值；已退役的旧键启动时会自动给出提示并忽略，不会静默失效。

### 你想做什么 → 改哪个文件

| 目标 | 所在文件 / 命令 | 最少要做什么 |
|---|---|---|
| 登录订阅模型（Claude / Codex / Copilot 等） | 终端命令 | 执行 `pipiclaw auth login`（无头服务器加 `--device-code`），按提示选默认模型 |
| 用环境变量快速配内置模型 | 环境变量 | 如 `export ANTHROPIC_API_KEY=sk-...` 或 `export OPENAI_API_KEY=sk-...` |
| 接入国内大模型 / OpenAI 兼容网关 / Ollama | `models.json` + `settings.json` | 在 `models.json` 定义 provider，在 `settings.json` 填 `defaultProvider` + `defaultModel` |
| 接入钉钉机器人 | `channel.json` 的 `dingtalk` 段 | `enabled` 设为 `true`，填 `clientId` 与 `clientSecret`（推荐补上 `cardTemplateId`） |
| 管理本机或远程 Web API 密钥 | 终端命令 | `pipiclaw webapi key add <名称>`（在线热生效，无需重启服务） |
| 开启联网搜索与网页读取 | `tools.json` | 将 `tools.web.enable` 设为 `true`（默认免 Key 用 DuckDuckGo） |
| 让大模型请求走代理（不影响钉钉直连） | 环境变量 `PIPICLAW_PROXY` | `export PIPICLAW_PROXY=http://127.0.0.1:7890` |
| 收紧或放宽文件/命令访问边界 | `security.json` | 调整 `pathGuard`、`commandGuard` 或 `networkGuard`（详见 [安全指南](./security.md)） |
| 定制助手说话语气或通用研发规矩 | `workspace/SOUL.md` / `AGENTS.md` | 直接编辑 Markdown，新建会话或发送 `/reload` 后生效 |
| 接入本机 Claude Code / Codex / Cursor / Antigravity | `workspace/sub-agents/*.md` | 从安装包 `examples/sub-agents/agents/` 复制所需角色文件（详见 [智能体委派](./sub-agents.md)） |

---

## 1. 渠道配置（`channel.json`）

首次初始化时，**`webapi` 默认已开启**（本机 Unix Socket + `127.0.0.1:8787` + 自动生成一把 `default` 密钥），`dingtalk` 默认关闭：

```json
{
  "dingtalk": {
    "enabled": false,
    "clientId": "your-dingtalk-client-id",
    "clientSecret": "your-dingtalk-client-secret",
    "robotCode": "",
    "cardTemplateId": "",
    "cardTemplateKey": "content",
    "allowFrom": [],
    "busyMessageDefault": "steer",
    "responseMode": "full_progress_then_plain_final",
    "cardAutoLayout": true
  },
  "webapi": {
    "enabled": true,
    "socket": true,
    "tcp": "127.0.0.1:8787",
    "tls": null,
    "keys": [
      { "name": "default", "sha256": "<自动生成的 SHA-256>", "desks": ["default"] }
    ]
  }
}
```

- **两段至少开启一个**；`enabled: false` 的段既不校验内部字段，也不加载任何代码或监听端口。
- **开启钉钉**：将 `dingtalk.enabled` 设为 `true`，填入真实的 `clientId` 与 `clientSecret`（保留任何 `your-*` 占位值都会拒绝启动并提示具体字段）。`robotCode` 留空自动复用 `clientId`；`cardTemplateId` 留空可先用普通消息跑通，正式使用推荐配置 AI Card 模板；`allowFrom: []` 允许应用可见范围成员对话，灰度或自用可填钉钉 `staffId`。
- **调整 Web API**：只用终端 `pipiclaw tui`、不需要 HTTP 端口时，可将 `webapi.tcp` 设为 `null`；暴露到内网/公网及 SDK 调用方式见 [Web API 手册](./webapi.md)。

---

## 2. 模型配置（`auth.json` / `models.json` / `settings.json`）

### 场景 A：订阅账号登录或官方 API Key

```bash
pipiclaw auth status                 # 查看所有内置供应商配置状态
pipiclaw auth login                  # 交互式选择 OAuth 订阅或 API Key，登录后可直接设为默认模型
pipiclaw auth login --device-code    # SSH 远程无浏览器环境：打印授权链接与验证码
pipiclaw auth logout openai-codex    # 移除已保存凭据
```

内置供应商也支持直接读环境变量（如 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY`、`OPENROUTER_API_KEY`）。在已有会话运行时更新了凭据，发送 `/reload` 或重启服务即可生效。

### 场景 B：OpenAI 兼容网关 / 国内大模型 / 本地 Ollama

1. 在 `models.json` 的 `providers` 中添加供应商（初始化文件内已自带 `_examples` 参考）：

```json
{
  "providers": {
    "my-gateway": {
      "baseUrl": "https://api.deepseek.com/v1",
      "api": "openai-completions",
      "apiKey": "DEEPSEEK_API_KEY",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        { "id": "deepseek-chat" },
        { "id": "deepseek-reasoner", "reasoning": true }
      ]
    }
  }
}
```

> `apiKey` 支持三种写法：**环境变量名**（推荐，如 `"DEEPSEEK_API_KEY"`）、**字面量密钥**（如 `"sk-..."`）或 **命令输出**（如 `"!op read ..."`）。本地 Ollama 可写 `"baseUrl": "http://127.0.0.1:11434/v1"`、`"apiKey": "ollama"`。

2. 在 `settings.json` 中指定默认模型（及可选的故障自动回退备用模型）：

```json
{
  "defaultProvider": "my-gateway",
  "defaultModel": "deepseek-chat",
  "defaultThinkingLevel": "medium",
  "fallbackModel": null
}
```

---

## 3. 联网搜索与内建工具（`tools.json`）

文件读写（`read`/`write`/`edit`/`grep`/`glob`）、命令与后台作业（`bash`/`job`）、记忆、技能、定时事件与智能体委派工具均为**核心恒开能力**。`tools.json` 主要控制**联网工具**与**后台长程任务总开关**：

```json
{
  "tools": {
    "web": {
      "enable": true,
      "proxy": null,
      "search": {
        "provider": "duckduckgo",
        "apiKey": "",
        "maxResults": 5
      }
    },
    "tasks": {
      "enabled": true
    }
  }
}
```

- 将 `tools.web.enable` 改为 `true` 即可启用 `web_search` 与 `web_fetch`。
- 搜索 `provider` 支持 `duckduckgo`（默认免 Key）、`tavily`（填 `apiKey`）、`jina`（填 `apiKey`）与 `searxng`（填 `baseUrl`）。

---

## 4. 让大模型请求走代理（`PIPICLAW_PROXY`）

Node.js 内置 `fetch` 默认不读系统代理变量；而如果直接设全局 `HTTP_PROXY` / `HTTPS_PROXY`，又会把钉钉的国内 HTTP 请求一并代理。因此**推荐用专用变量 `PIPICLAW_PROXY` 只代理大模型请求**：

```bash
export PIPICLAW_PROXY=http://127.0.0.1:7890
# 可选：跳过内网或国内直连域名
export PIPICLAW_NO_PROXY=localhost,127.0.0.1,internal.example.com,10.0.0.0/8
```

| 环境变量组合 | 大模型 API 请求 | 钉钉 HTTP 接口 | 网页工具（`web_search`/`web_fetch`） |
|---|---|---|---|
| 只设 `PIPICLAW_PROXY`（推荐） | 走 `PIPICLAW_PROXY` | 国内直连 | 直连（除非另设 `tools.web.proxy`） |
| 只设 `HTTP_PROXY` / `HTTPS_PROXY` | 走该代理 | 走该代理（WebSocket 仍直连） | 走该代理 |
| 两者都设 | `PIPICLAW_PROXY` 优先 | 走 `HTTP_PROXY`/`HTTPS_PROXY` | `tools.web.proxy` 优先，否则走标准代理 |

注意：
- `PIPICLAW_PROXY` 仅支持 `http://` 与 `https://` 代理地址（不支持 `socks5://`，配错会在启动时给出警告）。
- **OpenAI Codex 订阅登录与 Bedrock 例外**：Codex 对话底层使用独立 WebSocket 客户端，仅识别标准 `HTTPS_PROXY` / `HTTP_PROXY`（若只设了 `PIPICLAW_PROXY`，`pipiclaw auth login` 结束时会主动提醒）。
- 外部 Claude Code / Codex / Cursor / Antigravity 进程作为独立 CLI 运行，是否走代理遵循各 CLI 自身的环境变量与配置。

---

## 5. 安全守卫默认策略（`security.json`）

首次初始化生成的 `security.json` 默认开启命令守卫（拦截破坏性命令与提权）和路径守卫（拦截 `~/.ssh`、系统敏感文件与云凭据目录），并关闭出站网络守卫（便于本地开发访问内网或本地模型）：

```json
{
  "pathGuard": { "enabled": true },
  "commandGuard": { "enabled": true },
  "networkGuard": { "enabled": false }
}
```

在多服务共用的云主机上开启联网工具时，建议将 `networkGuard.enabled` 设为 `true` 以拦截对本机回环、云厂商 Metadata 与私网地址的 SSRF 请求。完整规则与放行模板见 [安全指南](./security.md)。

---

## 相关文档

- 全量配置项与默认值字典：[配置字段参考](./configuration-reference.md)
- 新手端到端跑通教程：[快速上手指南](./quickstart.md)
- 常驻托管、备份与排障：[部署与运维指南](./deployment-and-operations.md)
- 旧版本存储结构或上游 SDK 升级迁移：[升级与迁移说明](./migrations/README.md)
