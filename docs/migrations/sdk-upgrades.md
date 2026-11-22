# SDK 与模型供应商升级说明

> **适合谁**：升级现有 Pipiclaw 部署，且使用了自定义网关或内置模型、供应商认证的维护者。新安装用户通常无需关注。

---

## Pi SDK 1.5.2 升级注意事项

四个直接 `@earendil-works/pi-*` 依赖统一锁定 `1.5.2`，无需迁移历史会话文件：

- **旧网关的空工具列表**：OpenAI Chat Completions 请求没有当前工具、但历史中含工具调用时，新版默认省略 `tools` 字段。若旧版 LiteLLM 等网关要求 `tools: []`，在 `models.json` 中为对应模型设置 `compat.requiresToolsWithToolHistory: true`。有当前工具的正常回合不受这个变化影响。
- **核对内置模型引用**：检查默认、备用、内部代理及角色配置。目录移除了部分旧模型，例如 `openrouter/inception/mercury-2`、`openrouter/inception/mercury-3`、`openrouter/minimax/minimax-m2` 和部分 Fireworks 条目。外部 Coding CLI 的模型名仍由对应 CLI 决定。
- **极长输出的预算**：共享 SDK 算法为输入计数误差预留更多空间，部分长上下文请求的单次输出上限会降低；影响范围不限 OpenRouter。经常生成极长代码时，用实际模型定向验证。
- **完整认证**：聊天、内部代理、记忆和摘要现已统一通过 SDK 解析请求认证，`models.json` 配置的额外请求头会实际传到网关。关闭时等待已开始的 OAuth 凭据写入；超时则记录错误并保留进程锁，直到进程退出。无需改写认证文件。实现与验证见[接入验收](../../dev-docs/reviews/pi-sdk-integration.md#完整认证与关闭)。
- **消息线程与缓存保温**：后续已接入会话身份，具体端点的消息线程行为仍待验证。空闲缓存保温需要单独接入。

上游详情见 [Pi 1.5.1 Release](https://github.com/earendil-works/pi/releases/tag/v1.5.1)、[Pi 1.5.2 Release](https://github.com/earendil-works/pi/releases/tag/v1.5.2) 与[升级评估](../../dev-docs/reviews/pi-sdk-integration.md#升级时查整条请求链)。

---

## Pi SDK 1.5.0 升级注意事项

四个直接 `@earendil-works/pi-*` 依赖统一锁定 `1.5.0`（无需改写历史会话文件）：

- **核对旧模型引用**：检查 `settings.json`（`defaultModel`、`fallbackModel`、`subagentModel`）及 `workspace/sub-agents/*.md` 中的内置模型引用。上游目录移除了部分旧、免费和 batch 模型（如 `openrouter/openai/o3-mini`、`openrouter/nvidia/nemotron-3-super-120b-a12b:free`），并将部分 realtime / image 模型移出聊天目录。外部 Coding CLI 的模型名由对应 CLI 自行决定。
- **OpenRouter Claude 别名协议变更**：OpenRouter 的 `~anthropic/claude-*-latest` 别名改走 Anthropic Messages 协议以保留工具调用间的 thinking。若你在 `models.json` 中覆盖了 `baseUrl` 或 `api`，请确认代理网关支持对应协议与路由。
- **OpenRouter 计费展示**：OpenRouter 返回完整计费信息时，总费用采用供应商实报金额；输入/输出/缓存分项仍可能来自目录估算，分项之和不一定严格等于合计。

上游详情见 [Pi 1.5.0 Release](https://github.com/earendil-works/pi/releases/tag/v1.5.0) 与[升级评估](../../dev-docs/reviews/pi-sdk-integration.md#升级时查整条请求链)。

---

## Pi SDK 1.4.0 升级注意事项

- **`kimi-coding` 协议变更**：内置 `kimi-coding` 从 Anthropic Messages 改为 OpenAI Chat Completions，默认地址为 `https://api.kimi.com/coding/v1`。若在 `models.json` 中覆盖了 `baseUrl`，请核对 `/v1` 路径后缀及代理支持的协议。
- **下架模型清理**：上游移除了 `openai-codex/gpt-5.5`、`openai-codex/gpt-5.3-codex-spark`、`github-copilot/gpt-5.4` 等旧模型，请改用供应商当前支持的模型 ID。
- **请求头 `User-Agent`**：默认 `User-Agent` 改为 `pi/<version> (…)`；按客户端身份做白名单过滤的自建网关请同步调整规则。

上游详情见 [Pi 1.3.0](https://github.com/earendil-works/pi/releases/tag/v1.3.0) 与 [Pi 1.4.0](https://github.com/earendil-works/pi/releases/tag/v1.4.0)。

---

## Pi SDK 1.2.0：Azure 字段迁移与 OpenAI OAuth 安装身份

### 1. OpenAI ChatGPT OAuth 安装身份（`state/auth/identity.json`）

执行 `pipiclaw auth login openai --oauth` 时，首次会在 `${PIPICLAW_HOME}/state/auth/identity.json` 创建安装身份文件（`{"version":1,"installationId":"UUID v4"}`，目录权限 `0700`，文件权限 `0600`），凭据本身仍写入 `auth.json`：

- 普通启动、API Key 登录与其他 OAuth 供应商不会创建此文件；`auth logout` 也不会删除它。
- **备份与搬迁同一实例时请一并保留该文件**；独立新实例应各自生成独立身份，切勿将生产环境的 `auth.json` + `identity.json` 直接复制到并行测试实例共用。

### 2. 旧内置 Azure 供应商改名（`azure-openai-responses` → `azure`）

无 Azure 配置的部署无需任何操作。仅使用过旧内置 `azure-openai-responses` provider 身份的部署，请在停机备份后按以下位置将 provider ID 改为 `azure`（API 协议标识 `"api": "azure-openai-responses"` 与 `AZURE_OPENAI_*` 环境变量名**保持不变**）：

| 位置 | 调整方式 |
|---|---|
| `auth.json` 顶层键 | 将原内置凭据键名改为 `azure`（若已有自定义 `azure` 键请先人工核对，切勿盲目覆盖） |
| `models.json` 中 `providers` 键 | 确认属于覆盖原内置 provider 时改为 `azure` |
| `settings.json` | `defaultProvider` 改为 `azure`；`fallbackModel`、`subagentModel` 中 `provider/model` 前缀改为 `azure/` |
| `workspace/sub-agents/*.md` | 内置角色的 `model` 前缀改为 `azure/` |
