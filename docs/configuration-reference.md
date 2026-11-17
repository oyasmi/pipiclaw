# 配置字段参考（Configuration Reference）

> **适合谁**：需要精确查阅某个配置文件字段名、类型、默认值、取值范围或环境变量优先级的开发者与运维人员。
> **怎么用**：本页是按文件组织的**字段字典**，无需从头通读——直接从目录跳到你要查的文件即可。常见场景最少改什么请看 [配置速查](./configuration.md)。

---

## 目录

1. [目录结构与环境变量](#1-目录结构与环境变量)
2. [`channel.json`：渠道开关、Web API 与钉钉参数](#2-channeljson渠道开关web-api-与钉钉参数)
3. [`auth.json`：模型供应商凭据](#3-authjson模型供应商凭据)
4. [`models.json`：自定义模型与网关定义](#4-modelsjson自定义模型与网关定义)
5. [`settings.json`：运行时产品设置](#5-settingsjson运行时产品设置)
6. [`tools.json`：内建工具与任务开关](#6-toolsjson内建工具与任务开关)
7. [`security.json`：安全守卫策略](#7-securityjson安全守卫策略)
8. [工作区与状态目录文件说明](#8-工作区与状态目录文件说明)

---

## 1. 目录结构与环境变量

默认应用根目录为 `~/.pipiclaw/`，可通过 `PIPICLAW_HOME` 覆盖。Pipiclaw 只读取应用根目录下的全局配置，**不使用**项目目录内的 `.pi/settings.json` 覆盖。所有六个应用级 JSON 配置文件在创建及启动时均自动收紧权限为 `0600`。

### 环境变量全表

| 变量名 | 作用与优先级 |
|---|---|
| `PIPICLAW_HOME` | 覆盖默认的 `~/.pipiclaw/` 应用根目录（配置、`workspace/` 与 `state/` 均随之移动） |
| `ANTHROPIC_API_KEY` | Anthropic 模型 API Key（低于 `auth.json` 中的同名凭据） |
| `OPENAI_API_KEY` / `GEMINI_API_KEY` / `OPENROUTER_API_KEY` 等 | 对应内置模型供应商的环境变量凭据 |
| `PIPICLAW_PROXY` | 仅代理大模型 API 请求（主智能体、内置子智能体、记忆整理），支持 `http://` 或 `https://`，优先于 `HTTP_PROXY`/`HTTPS_PROXY`，不影响钉钉与网页工具 |
| `PIPICLAW_NO_PROXY` | `PIPICLAW_PROXY` 的直连白名单（逗号分隔域名、IP、`host:port` 或 CIDR）；未设置时回落到 `NO_PROXY` |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` / `ALL_PROXY` | 标准网络代理变量。钉钉 HTTP 与网页工具识别全部四个变量；大模型底层 `undici` 仅在未设 `PIPICLAW_PROXY` 时识别 `HTTP_PROXY`/`HTTPS_PROXY`（不识别 `ALL_PROXY`） |
| `PIPICLAW_LOG_LEVEL` | 覆盖日志级别（`debug` \| `info` \| `warn` \| `error`），优先于 `settings.json` |
| `PIPICLAW_LOG_FILE` | `0`/`false` 关闭文件日志，`1`/`true` 开启文件日志，优先于 `settings.json` |
| `PIPICLAW_DEBUG` | 设为 `1` 时在当前频道的会话区（`conversations/<kind>-<n>/`）写出完整组装提示词快照 `last_prompt.json` |

---

## 2. `channel.json`：渠道开关、Web API 与钉钉参数

顶层仅允许 `dingtalk` 与 `webapi` 两个对象分段，未知顶层键会在启动时直接报错（旧版根级字段迁移见 [渠道层迁移说明](./migrations/channel-migration.md)）。**至少需将一个分段的 `enabled` 设为 `true`**；关闭的分段不校验其余字段、不加载模块、不监听端口。

### 2.1 `webapi` 段

| 字段 | 类型 | 初始模板值 | 解析缺省值 | 说明 |
|---|---|---|---|---|
| `enabled` | `boolean` | `true` | `false`（段缺失时） | 是否启用 Web API 渠道 |
| `socket` | `boolean` | `true` | `true` | 是否监听本机 Unix Socket（`state/webapi/api.sock`，权限 `0600`，目录 `0700`）。本机同账号进程（如 `pipiclaw tui`）访问无需 Key |
| `tcp` | `string \| null` | `"127.0.0.1:8787"` | 不监听 | TCP 监听地址 `host:port`（IPv6 加方括号如 `"[::1]:8787"`）；设为 `null` 或 `""` 关闭 TCP 监听。TCP 请求强制校验 Bearer Key |
| `tls` | `{ cert, key } \| null` | `null` | 无（明文 HTTP） | 可选 HTTPS 证书与私钥**绝对路径**（`{ "cert": "/abs/cert.pem", "key": "/abs/key.pem" }`）；设为 `null` 不启用 TLS。非回环地址未配 TLS 时每次启动会输出明文传输警告 |
| `keys` | `Array<{ name, sha256, desks }>` | 含 1 把自动生成的 `default` 密钥 | `[]` | TCP 访问密钥列表：`name` 匹配 `^[a-z0-9][a-z0-9-]{0,31}$`（不可为保留名 `local`），`sha256` 为 64 位小写十六进制哈希，`desks` 为至少含一项的合法工位名数组。通过 `pipiclaw webapi key add\|list\|remove` 管理，修改后运行中服务自动热加载 |

`socket: false` 且未配置有效 `tcp` 时拒绝启动。协议细节与限流常量见 [Web API 手册](./webapi.md)。

### 2.2 `dingtalk` 段

| 字段 | 必填 | 默认值 / 缺省行为 | 说明 |
|---|---|---|---|
| `enabled` | 是 | 初始模板为 `false` | 是否启用钉钉 Stream 长连接渠道 |
| `clientId` | 启用时必填 | — | 钉钉企业内部应用 `Client ID`（保留 `your-*` 占位值会拒绝启动） |
| `clientSecret` | 启用时必填 | — | 钉钉应用 `Client Secret`（保留 `your-*` 占位值会拒绝启动） |
| `robotCode` | 否 | 留空时自动复用 `clientId` | 钉钉机器人接口编码 |
| `cardTemplateId` | 否 | `""`（不启用流式卡片，使用普通消息） | 钉钉 AI Card 卡片模板 ID，强烈推荐配置 |
| `cardTemplateKey` | 否 | `"content"` | AI Card 模板中承载流式 Markdown 内容的变量名 |
| `allowFrom` | 否 | `[]`（允许应用可见范围内所有成员） | 允许交互的发送者钉钉 `staffId` 白名单（注意不是姓名或手机号） |
| `busyMessageDefault` | 否 | `"steer"` | 聊天忙碌时收到普通消息的默认策略：`"steer"`（中途插入当前回合）或 `"followUp"` / `"followup"`（排到当前回合结束后执行） |
| `responseMode` | 否 | `"full_progress_then_plain_final"` | 回复展示形态，见下方行为矩阵 |
| `cardAutoLayout` | 否 | `true` | 透传给钉钉 AI Card 的 `autoLayout` 参数 |

#### `responseMode` 行为矩阵

| 取值 | 思考与工具进度展示 | 最终回复投递 |
|---|---|---|
| `full_progress_then_plain_final`（默认） | 立即创建等待卡并累积进度；正文达约 2.9KB 预算时收短为最新思考与最近两条活动后继续增长（帧间隔 ≥ 800ms） | 产生过进度时最终结论另发一条 Markdown 消息，原进度卡收成一行摘要；无中间进度时直接写入等待卡 |
| `rolling_progress_then_plain_final` | 固定滚动展示最近 5 条思考与工具活动 | 同上 |
| `final_card_only` | 不展示等待卡与中间过程 | 最终回复直接生成一张 AI Card |

> 后台主动唤醒（长程任务汇报、委派/作业完成通知、定时事件）均不创建过程进度卡，仅在有结论或需你决策时推送最终消息。

---

## 3. `auth.json`：模型供应商凭据

推荐使用 `pipiclaw auth login` / `pipiclaw auth logout` 管理，也可手动编辑。对同一供应商，凭据解析优先级为：**`auth.json` > 环境变量 > `models.json` 中对应 provider 的 `apiKey`**。

### 文件结构与 `key` 三种写法

```json
{
  "anthropic": { "type": "api_key", "key": "sk-ant-..." },
  "my-gateway": { "type": "api_key", "key": "MY_GATEWAY_API_KEY" },
  "vault-provider": { "type": "api_key", "key": "!op read 'op://vault/llm/api-key'" }
}
```

- `key` 支持：**字面量密钥**、**环境变量名**、或以 `!` 开头的 **Shell 命令输出**；OAuth 订阅登录凭据由 `pipiclaw auth login` 自动写入与刷新。
- 若不想在 `models.json` 里放密钥，可在 `auth.json` 中写与自定义 provider 同名的键。

### 常见内置供应商对照

| 供应商名称 | `auth.json` 键名 / 登录 ID | 对应环境变量 |
|---|---|---|
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` |
| OpenAI | `openai` | `OPENAI_API_KEY` |
| OpenAI Codex（ChatGPT 订阅） | `openai-codex` | 通过 `pipiclaw auth login` 授权 |
| Google Gemini | `google` | `GEMINI_API_KEY` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` |
| GitHub Copilot | `github-copilot` | 通过 `pipiclaw auth login` 授权 |
| Kimi For Coding | `kimi-coding` | `KIMI_API_KEY` |
| xAI | `xai` | `XAI_API_KEY` |
| Mistral / Groq | `mistral` / `groq` | `MISTRAL_API_KEY` / `GROQ_API_KEY` |

---

## 4. `models.json`：自定义模型与网关定义

用于新增自定义供应商/模型（如 OpenAI 兼容网关、DeepSeek、通义、本地 Ollama/vLLM），或覆盖内置供应商的 `baseUrl` / `headers` / 模型参数。底层解析继承自 [`@earendil-works/pi`](https://github.com/earendil-works/pi)。

### Provider 对象字段（`providers.<id>`）

| 字段 | 必填 | 说明 |
|---|---|---|
| `baseUrl` | 通常必填 | 接口基础地址（如 `https://api.deepseek.com/v1`、`http://127.0.0.1:11434/v1`） |
| `api` | 定义新模型时必填 | 协议类型：最常用 `"openai-completions"`；另支持 `"openai-responses"`、`"anthropic-messages"`、`"google-generative-ai"` |
| `apiKey` | 定义新模型时必填（除非已在 `auth.json` 配置同名键） | 字面量密钥、环境变量名，或 `!command`（Ollama 等无需鉴权的本地服务填任意非空字符串如 `"ollama"`） |
| `headers` | 否 | 自定义附加 HTTP 请求头（`Record<string, string>`） |
| `authHeader` | 否 | 是否自动附加 `Authorization: Bearer <apiKey>` |
| `compat` | 否 | OpenAI 兼容接口适配项（如 `{ "supportsDeveloperRole": false, "supportsReasoningEffort": false }`） |
| `models` | 否 | 自定义模型定义数组，见下表 |
| `modelOverrides` | 否 | 按模型 ID 覆盖内置供应商已有模型的元数据（`contextWindow`、`cost`、`compat` 等） |

### Model 对象字段（`providers.<id>.models[]`）

| 字段 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `id` | 是 | — | 请求接口时实际传给服务端的模型 ID |
| `name` | 否 | 同 `id` | 展示名称 |
| `api` | 否 | 继承 provider 的 `api` | 单个模型单独覆盖协议类型 |
| `reasoning` | 否 | `false` | 是否支持推理思考档位（`/thinking`） |
| `input` | 否 | `["text"]` | 支持的输入模态：模型支持看图时请显式声明 `["text", "image"]`，否则入站图片不会送入该模型 |
| `contextWindow` | 否 | `128000` | 上下文窗口大小（影响自动压缩触发水位与 `/status` 百分比计算） |
| `maxTokens` | 否 | `16384` | 单次回复最大输出 token 数 |
| `cost` | 否 | 全 `0` | 单价元数据（`{ input, output, cacheRead, cacheWrite }`），用于 `/usage` 费用估算 |
| `compat` | 否 | 继承 provider 的 `compat` | 单个模型单独覆盖兼容项 |

---

## 5. `settings.json`：运行时产品设置

`settings.json` 仅包含布尔开关、枚举与模型引用（代码层面通过 `SETTINGS_TOP_LEVEL_KEYS` 严格对齐）：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `defaultProvider` | `string` | 未设置 | 默认模型供应商 ID（需与 `defaultModel` 同时配置；未设置时取首个可用模型） |
| `defaultModel` | `string` | 未设置 | 默认模型 ID |
| `defaultThinkingLevel` | `string` | `"medium"` | 主智能体默认推理档位：`off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max`（超出模型能力时自动夹取到最近可用档） |
| `fallbackModel` | `string \| null` | `null` | 备用模型引用（格式 `provider/model`）。主模型回合经重试仍失败（不含用户 `/stop` 与上下文超限）时自动切到备用模型重跑，并冷却主模型 5 分钟；内置子智能体重试耗尽后同样生效 |
| `subagentModel` | `string \| null` | `null` | 未显式指定 `model` 的**内置**子智能体默认模型（格式 `provider/model`）；未设置时继承主智能体当前模型 |
| `compaction.enabled` | `boolean` | `true` | 是否开启自动后台上下文压缩（关闭后手动 `/compact` 仍可用） |
| `retry.enabled` | `boolean` | `true` | 遇到供应商瞬态错误（429 / 5xx）时是否自动退避重试（默认最多 3 次） |
| `memoryMaintenance.enabled` | `boolean` | `true` | 是否开启频道空闲时的定时记忆反思（关闭后压缩、`/new`、关机边界反思及显式 `memory_save` 仍正常工作） |
| `sessionSearch.summarizeWithModel` | `boolean` | `false` | `session_search` 命中历史冷存储时是否额外调用一次模型生成聚焦摘要 |
| `delegation.notices` | `"off" \| "settled" \| "live"` | `"live"` | 委派与后台作业的旁路进度播报量：`off` 不播报；`settled` 仅播报完成回执与 10 分钟无输出卡顿告警；`live` 额外播报长耗时运行中的稀疏步骤提示 |
| `logging.level` | `"debug" \| "info" \| "warn" \| "error"` | `"info"` | 控制台与文件日志级别（低于环境变量 `PIPICLAW_LOG_LEVEL`） |
| `logging.file.enabled` | `boolean` | `true` | 是否将结构化日志落盘至 `state/logs/runtime.jsonl`（5MB × 3 自动轮转） |
| `tui.responseMode` | 同钉钉 `responseMode` 三值 | `"full_progress_then_plain_final"` | 终端 TUI 的进度展示模式，独立于 `channel.json`：前两项展示完整流式过程，`final_card_only` 仅展示最终答复 |

- **枚举容错**：`logging.level`、`tui.responseMode`、`delegation.notices` 若填了非法字符串，启动时输出一条警告并自动回落到默认值，不会导致全部日志静默或异常分支。
- **已退役字段提示**：早期版本的内部阈值（如 `compaction.reserveTokens`、`memoryRecall.*`、`sessionMemory.*`、`memoryMaintenance.*Interval*`、`taskDriver.*`、`taskDigest.*`）已固化为代码常量；留在文件中不会报错，仅在启动时提示清理。

---

## 6. `tools.json`：内建工具与任务开关

核心工具（`read`/`write`/`edit`/`grep`/`glob`/`bash`/`job`/`memory_*`/`session_search`/`skill`/`event_manage`/`subagent`/`subagent_list`/`subagent_run`）恒开，无配置开关；`send_media` 随渠道附件能力（钉钉支持）自动注册。`tools.json` 控制以下 5 个分段：

| 字段路径 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `tools.web.enable` | `boolean` | `false` | 联网工具总开关（同时控制 `web_search` 与 `web_fetch` 是否注册） |
| `tools.web.proxy` | `string \| null` | `null` | 网页工具专用代理 URL；未设置时依次回落到 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`、直连 |
| `tools.web.search.provider` | `"duckduckgo" \| "tavily" \| "jina" \| "searxng"` | `"duckduckgo"` | 搜索引擎后端（`duckduckgo` 免 API Key） |
| `tools.web.search.apiKey` | `string` | `""` | `tavily` 或 `jina` 的 API Key |
| `tools.web.search.baseUrl` | `string` | `""` | `searxng` 实例地址 |
| `tools.web.search.maxResults` | `number` | `5` | 每次搜索返回条数（整数 `1–10`） |
| `tools.web.search.timeoutMs` | `number` | `30000` | 搜索超时毫秒数 |
| `tools.web.fetch.maxChars` | `number` | `50000` | 单次网页正文提取最大字符数（长页面自动缓存于工位 `web-cache/` 并支持 `offset` 翻页） |
| `tools.web.fetch.timeoutMs` | `number` | `30000` | 网页抓取超时毫秒数 |
| `tools.web.fetch.maxImageBytes` | `number` | `10485760` | 抓取图片最大字节数（10 MiB） |
| `tools.web.fetch.maxResponseBytes` | `number` | `5242880` | 抓取响应体最大字节数（5 MiB） |
| `tools.web.fetch.preferJina` | `boolean` | `false` | 是否优先使用 Jina Reader 提取正文 |
| `tools.web.fetch.enableJinaFallback` | `boolean` | `false` | 本地提取失败时是否允许回退到 Jina Reader |
| `tools.web.fetch.defaultExtractMode` | `"markdown" \| "text"` | `"markdown"` | HTML 默认提取格式 |
| `tools.tasks.enabled` | `boolean` | `true` | 后台长程任务总开关（同时控制 `task_*` 工具、后台任务车道执行与每回合 `<task_agenda>` 注入） |
| `tools.bashInterceptor.enabled` | `boolean` | `true` | 拦截裸 `cat`、递归 `grep`、`find -name`、`sed -i` 等低效命令，引导模型改用结构化 `read`/`grep`/`glob`/`edit` |
| `tools.rtk.enabled` | `boolean` | `false` | 若宿主机 `PATH` 已安装 [`rtk`](https://github.com/rtk-ai/rtk)，自动在安全校验后精简常见只读命令输出以节省 Token；未安装时静默跳过 |
| `tools.subagentInline.enabled` | `boolean` | `true` | 是否允许 `subagent_inline`（无预设角色时的一次性内置子智能体）；当 `workspace/sub-agents/` 已覆盖全部需求时可关闭以收紧调用面 |

---

## 7. `security.json`：安全守卫策略

作用于主智能体与**内置**子智能体的工具调用（外部 Coding Agent 进程不经过此守卫，其权限由目标 CLI 参数与系统账号决定）。完整拦截清单与配置范式见 [安全指南](./security.md)。

| 字段路径 | 类型 | 默认值（代码内置 / 首次模板） | 说明 |
|---|---|---|---|
| `enabled` | `boolean` | `true` | 安全守卫总开关 |
| `commandGuard.enabled` | `boolean` | `true` | 拦截 `bash` 与事件 `preAction` 中的破坏性文件操作、提权、系统关停、反弹 shell 等高危命令 |
| `commandGuard.additionalDenyPatterns` | `string[]` | `[]` | 追加拦截的不区分大小写正则表达式列表 |
| `commandGuard.allowPatterns` | `string[]` | `[]` | 放行特定命令子串（仅作用于 `bash`，不影响路径守卫） |
| `commandGuard.blockObfuscation` | `boolean` | `true` | 是否拦截 `base64 -d \| bash`、`eval $(...)` 等混淆执行 |
| `pathGuard.enabled` | `boolean` | `true` | 限制 `read`/`write`/`edit`/`send_media` 的文件访问范围（默认放行工作区、主目录普通文件与临时目录，硬性拒绝 `~/.ssh`、云凭据、浏览器目录、私钥及应用自身配置文件） |
| `pathGuard.readAllow` / `readDeny` | `string[]` | `[]` | 额外允许或拒绝读取的路径前缀（支持 `~/`） |
| `pathGuard.writeAllow` / `writeDeny` | `string[]` | `[]` | 额外允许或拒绝写入的路径前缀（`workspace/sub-agents/` 恒受写保护） |
| `pathGuard.resolveSymlinks` | `boolean` | `true` | 校验前是否解析真实符号链接目标 |
| `networkGuard.enabled` | `boolean` | 内置 `true` / **首次模板 `false`** | 拦截网页工具访问 `localhost`、云厂商 Metadata 与私网 IP（包含每次 HTTP 重定向重检） |
| `networkGuard.allowedHosts` | `string[]` | `[]` | 网络守卫开启时精确放行的主机名列表 |
| `networkGuard.allowedCidrs` | `string[]` | `[]` | 网络守卫开启时放行的内网 CIDR 网段（如 `"10.0.0.0/8"`） |
| `networkGuard.maxRedirects` | `number` | `5` | `web_fetch` 最多跟随的重定向次数 |
| `audit.logBlocked` | `boolean` | `true` | 是否将拦截事件与 Web API 鉴权审计写入日志 |
| `audit.logFile` | `string` | `"~/.pipiclaw/workspace/.pipiclaw/security.log"` | 自定义安全审计日志路径 |

---

## 8. 工作区与状态目录文件说明

### 8.1 工作区共享层（`${PIPICLAW_HOME}/workspace/`，所有工位共用）

| 路径 | 谁维护 | 说明 |
|---|---|---|
| `SOUL.md` | 用户 | 助手身份定位、语气与回复语言偏好（全局唯一人格，工位内同名文件不会覆盖它） |
| `AGENTS.md` | 用户 | 跨项目通用工作守则与红线要求（无需复制 Pipiclaw 自身机制，内置 Playbook 会随版本自动提供） |
| `MEMORY.md` | 用户 | 跨所有工位共享的长期团队背景与术语，会话首轮按预算注入 |
| `ENVIRONMENT.md` | 用户 / 获准工具 | 宿主机已装工具与环境事实记录，按需读取 |
| `skills/`（及 `~/.agents/skills/`） | 用户 / 助手 | 可复用 SOP 技能目录，工作区同名有效技能优先；详见 [Skills 指南](./skills.md) |
| `sub-agents/*.md` | 用户 | 平铺存放内置与外部智能体角色定义（实时发现，无需重启）；详见 [智能体委派](./sub-agents.md) |
| `desk-bindings.json` | 运行时 | 频道 ID → 工位名称的唯一权威绑定表 |
| `CHANNELS.md` | 运行时 + 用户 | 自动生成的频道可读索引（ID / 名称 / 所属工位 / 最近活跃 / 主题；「主题」列支持手工备注并会被保留） |

### 8.2 工位层（`workspace/desk-<name>/`）与运行状态层（`state/`）

| 路径 | 说明 |
|---|---|
| `desk-<name>/desk.json` | 工位元数据、各频道分配的会话区目录（`dm-1`、`group-1`、`webapi-1`…）及可选自定义工作目录 `cwd`（通过 `/desk cwd` 或 `pipiclaw tui --cwd` 在线更新） |
| `desk-<name>/memory/*.md` + `MEMORY.md` | 一条长期记忆一个 Markdown 文件；`MEMORY.md` 为自动生成的只读索引（切勿手改），`memory/.tombstones.jsonl` 为防复活遗忘记录 |
| `desk-<name>/journal/YYYY-MM-DD.md` | 由后台反思自动按天追加的工作日记；`memory-review.jsonl` 记录反思决策审计 |
| `desk-<name>/tasks/` | 后台长程任务说明（`<id>.md`）、任务记录（`<id>.jsonl`）、独立任务会话（`.sessions/`）与已归档任务（`archive/`） |
| `desk-<name>/events/*.json` | 该工位的单次提醒与 Cron 周期事件定义；调度审计位于 `state/events/history.jsonl` |
| `desk-<name>/subagent-artifacts/<runId>/` | 委派完整产出、协议事件流与 `stderr` 日志；`subagent-runs.jsonl` 为可读摘要 |
| `desk-<name>/conversations/<kind>-<n>/` | 单个频道在该工位内的独立对话历史（`active-session.json`、session JSONL、`context.jsonl`、`log.jsonl`） |
| `state/daemon.lock` | 单实例进程排他锁（保证同一 `PIPICLAW_HOME` 同时只有一个运行时写入） |
| `state/logs/runtime.jsonl` | 结构化运行日志（`0600`，5MB × 3 轮转） |
| `state/usage/usage-YYYY-MM.jsonl` | 按月分片的 Token 与费用账本（供 `/usage` 聚合查询） |
| `state/webapi/` · `state/tui/` · `state/dingtalk/` | Web API 会话与响应存储、终端上次工位会话映射、钉钉主动推送路由元数据 |
| `state/jobs/` · `state/subagent-runs/` · `state/dispatch/` | 后台作业、外部/内置委派与持久化唤醒的崩溃恢复状态 |
