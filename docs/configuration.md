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

从旧版本升级时，默认目录曾是 `~/.pi/pipiclaw/`。未设置 `PIPICLAW_HOME`、新目录尚不存在且旧目录存在时，当前版本会自动迁移到 `~/.pipiclaw/`；这条兼容计划在 0.9.0 移除。

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
| 加可复用角色 | `workspace/sub-agents/*.md` | 子代理 frontmatter + system prompt |
| 加可复用流程 | `workspace/skills/` | 通过 `skill_manage` 创建/维护 workspace skill |

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

恒开、无 `tools.json` 开关的核心工具包括：`read`、`write`、`edit`、`grep`、`bash`、`job`、`session_search`、`memory_manage`、`skill_manage`、`event_manage`。`send_media` 由传输层能力决定。

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

## 相关文档

- 完整字段：[configuration-reference.md](./configuration-reference.md)
- 运行机制：[runtime-mechanisms.md](./runtime-mechanisms.md)
- 工具清单：[tools.md](./tools.md)
- 安全策略：[security.md](./security.md)
- 部署运维：[deployment-and-operations.md](./deployment-and-operations.md)
