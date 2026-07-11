# Pipiclaw

Pipiclaw 是一个个人 AI 助手运行时（AI assistant runtime）。它以 [`pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 为核心，把一个编码代理变成可以长期使用的工作助手：接入钉钉、保留跨会话记忆、按计划自主推进任务，并实时告诉你它正在做什么。

如果你希望 AI 助手不只是聊天，而是能在钉钉里持续工作、记住上下文、到点自己干活，那么 Pipiclaw 就是为此设计的。

npm package: [`@oyasmi/pipiclaw`](https://www.npmjs.com/package/@oyasmi/pipiclaw)

## 能干什么（What It Does）

**在钉钉里工作。** 原生支持钉钉 Stream Mode，不需要消息中转服务和公网 IP。配合 AI Card，思考、工具执行和状态更新持续流式呈现（`responseMode` 支持完整过程、滚动摘要、只出结果三种形态）。助手忙碌时你随时可以介入：`/steer` 调整方向、`/followup` 排队新请求、`/stop` 中止，普通消息按配置默认插话或排队。

**也在终端里工作。** `pipiclaw tui` 直接在命令行对话，复用同一套配置、记忆与会话；`--channel` 可接管任意钉钉会话的上下文继续聊，`--print` 支持脚本化的一次性问答。

**记得住事。** 每个会话通道（channel）有自己的分层记忆：`SESSION.md`（当前工作态）、`MEMORY.md`（稳定事实与偏好）、`HISTORY.md`（更早摘要），工作区层还有 `SOUL.md`（身份语气）与 `AGENTS.md`（工作规则）。运行时按当前请求做相关召回（relevant recall），后台维护调度器在本地闸门通过后才做 LLM 整理，不烧无谓的 token。冷存储历史可用 `session_search` 按需检索，`memory_manage` 支持按需保存、检索、忘记。

**自己推进长程工作。** 定时事件支持立即、单次、周期三类，`preAction` 可用脚本做零 token 的触发前门控。语义更高一层的是任务台账（task ledger）：任务以 Markdown 文件持久存在，内建 task driver 到点自动恢复、有进展有界续跑、停滞自动退避；配套受预算约束的恢复、独立验收、外部副作用授权，以及 `/tasks` 系列零 LLM 成本的控制面命令。

**会用工具、能委派。** 内建 `bash`（支持 `async` 后台作业）、`read`（含目录树与 PDF）、`write` / `edit`、结构化 `grep`、`web_search` / `web_fetch`（结果缓存与分页续读）。预定义子代理把 reviewer、researcher 这类角色沉淀成可复用能力，支持 worktree 隔离与独立验收（verify）；workspace skills 沉淀你自己的流程知识。

**有安全护栏。** 所有文件、命令、网络工具都经过安全守卫：`bash` 命令拦截、统一路径检查、常见凭据与敏感位置默认拒绝、阻断写入审计日志；可通过 `security.json` 做实例级策略调整。详见 [docs/security.md](./docs/security.md)。

**知识不随升级漂移。** Runtime 机制知识以 playbooks 随 npm 包发布、按需加载，系统提示只保留小型索引；`AGENTS.md` 与 workspace skills 完全归你和团队所有，升级不会覆盖，也不需要抄录产品文档。详见 [docs/runtime-playbooks.md](./docs/runtime-playbooks.md)。

## 快速开始（Quickstart）

目标：从零开始，让 Pipiclaw 在你的钉钉里成功回复第一条消息。你也可以把这件事直接交给 AI Agent——见本节末尾的[安装说明模板](#让-ai-agent-帮你完成安装for-ai-agent)。

### 1. 环境要求（Requirements）

- Node.js `>= 22.19.0`
- 一个可用的钉钉企业内部应用
- 至少一种可用的模型接入方式：Anthropic 默认模型，或 `models.json` 中的自定义提供方（provider）

Pipiclaw 面向类 Unix 环境（Linux / macOS），工具执行层按 POSIX shell 语义工作，不支持 Windows；如需在 Windows 上运行，请使用 WSL2。

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
├── channel.json      # 钉钉应用配置
├── auth.json         # 模型凭据
├── models.json       # 自定义模型提供方
├── settings.json     # 默认模型与运行时设置
├── tools.json        # 内建工具配置
├── security.json     # 工具层安全策略
└── workspace/        # 长期工作区：SOUL.md、AGENTS.md、MEMORY.md、
                      # events/、skills/、sub-agents/ 及各会话通道目录
```

默认 app home 是 `~/.pi/pipiclaw/`；设置 `PIPICLAW_HOME=/your/path` 可整体迁移。如果 `channel.json` 仍是初始化模板，程序会提示补全配置后再启动，这是正常行为。

### 4. 创建钉钉应用（Create a DingTalk App）

在[钉钉开放平台](https://open-dev.dingtalk.com/)创建企业内部应用：

1. 创建应用，获取 `Client ID` 和 `Client Secret`
2. 开启机器人能力
3. 启用 Stream Mode
4. 建议一并创建 AI Card 模板并获取 `Card Template ID`

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

- 硬性必填只有 `clientId` 和 `clientSecret`。
- `robotCode` 留空时回退到 `clientId`。
- `cardTemplateId` 建议配置（正常使用推荐启用 AI Card）；示例先留空是为了让第一轮接入更稳，排查链路时也建议临时留空。
- `allowFrom` 为 `[]` 或省略时允许所有人；灰度期可填测试人员的 staff ID。
- 更多字段（`busyMessageDefault`、`responseMode`、`cardAutoLayout`）见[配置手册](./docs/configuration.md)。

### 6. 配置模型（Configure Models）

**方案 A：Anthropic 默认模型。** `models.json` 保持默认的 `{ "providers": {} }`，提供凭据即可：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

或写入 `~/.pi/pipiclaw/auth.json`：

```json
{
  "anthropic": { "type": "api_key", "key": "sk-ant-..." }
}
```

**方案 B：自定义模型提供方。** 适用于 OpenAI-compatible 网关、代理、自建或聚合服务，编辑 `~/.pi/pipiclaw/models.json`：

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
      "models": [{ "id": "gpt-4.1" }]
    }
  }
}
```

- `apiKey` 可以写真实 key、环境变量名，或 `!command`；不想把凭据写进 `models.json`，可在 `auth.json` 写同名 provider 的凭据。
- 很多 OpenAI-compatible 服务不支持 `developer` role / `reasoning_effort`，遇到兼容问题先保留上面的 `compat`。
- 完整字段与更多场景（Ollama、企业代理等）见[配置手册](./docs/configuration.md)。

### 7. 可选：设置默认模型（Optional: Set a Default Model）

编辑 `~/.pi/pipiclaw/settings.json`：

```json
{
  "defaultProvider": "my-gateway",
  "defaultModel": "gpt-4.1"
}
```

不设置时使用当前可用模型列表里的第一个。

### 8. 启动（Start）

```bash
pipiclaw
```

等价于 `pipiclaw run`（运行钉钉常驻进程）；`pipiclaw tui` 进入终端对话，`pipiclaw --help` 查看全部命令与选项。

### 9. 可选：启用内建 Web 工具（Optional: Enable Web Tools）

`web_search` / `web_fetch` 默认关闭。首次启动生成的 `~/.pi/pipiclaw/tools.json` 已带可直接改用的模板，通常只需三步：

1. 把 `tools.web.enable` 改成 `true`
2. 填入搜索 provider 的 `apiKey`（默认示例为 Brave）
3. 如需代理，设置 `tools.web.proxy`（未设置时回退到标准的 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`）

搜索后端支持 `duckduckgo`、`brave`、`tavily`、`jina`、`searxng`，完整字段见[配置手册](./docs/configuration.md)。

### 10. 在钉钉中验证（Verify in DingTalk）

先给机器人发送 `/model`，确认当前可见模型和默认模型符合预期，再发送一条普通消息：

```text
请介绍一下你自己，并说明你现在能做什么
```

如果一切正常，配置了 AI Card 时你会看到过程更新，否则机器人直接发普通消息回复；Pipiclaw 会在本地创建对应的会话通道目录，后续会话复用该通道的工作区与记忆。

**第一次没跑通？** 最常见的三类原因：`channel.json` 残留 `your-*` 占位值（进程启动即退出）；模型凭据或 `models.json` 配置不可用（能收消息但首次调用失败）；`allowFrom` 挡住了你的账号或 Stream Mode 未开启（收到消息但不回复）。系统化排查见[部署与运维指南](./docs/deployment-and-operations.md)；设置 `PIPICLAW_DEBUG=1` 可在会话通道目录写出 `last_prompt.json` 检查精确提示词。

### 让 AI Agent 帮你完成安装（For AI Agent）

把下面整段文字复制给你常用的 AI Agent（如 Claude Code、Codex、OpenCode 等），让它替你完成安装、初始化、配置和启动：

```text
请帮我在这台机器上安装并初始化 Pipiclaw，尽量配置到"可以开始使用"的状态。要求：

1. 先检查 Node.js 版本，必须 >= 22.19.0；不满足就停下来告诉我，不要继续安装。
2. 执行 npm install -g @oyasmi/pipiclaw。权限失败时不要自行 sudo，把报错给我并询问怎么处理。
3. 运行一次 pipiclaw，让它初始化 ~/.pi/pipiclaw/ 和 workspace/。
4. 逐项询问我是否现在提供：钉钉应用的 clientId 和 clientSecret、AI Card 的
   cardTemplateId、模型接入方式（Anthropic 或自定义 provider）。
5. 钉钉配置写入 ~/.pi/pipiclaw/channel.json：robotCode 可留空，allowFrom 先设 []。
   AI Card 是推荐配置；我暂不提供 cardTemplateId 时可先留空，但最后要提醒我补上。
   最终文件里不要保留任何 your-* 占位值。
6. 模型配置：
   - 我选 Anthropic：询问我是否提供 ANTHROPIC_API_KEY；提供就配置到可用，
     不提供就保留默认空 models.json，并告诉我之后要补 auth.json 或环境变量。
   - 我选自定义 provider：至少收集 provider 名称、baseUrl、api 类型、apiKey、
     一个 model id，写入 ~/.pi/pipiclaw/models.json；OpenAI-compatible 服务优先用
     openai-completions，并默认加 compat：supportsDeveloperRole: false、
     supportsReasoningEffort: false。
   - 我不提供的值不要编造。收尾时明确列出还缺什么、该改哪个文件。
7. 关键配置齐全时，先询问我是否现在启动 pipiclaw。同意则启动并检查输出，把成功
   或问题如实告诉我；成功后提醒我在钉钉里先发 /model 验证模型，再发一条普通消息。
   不同意则告诉我之后如何手动启动。
8. 全程不要假装成功：做过的操作、写过的文件、卡住的步骤都要明确说明。
```

## 命令（Commands）

| 命令 | 说明 |
|------|------|
| `/help` | 查看内置命令帮助 |
| `/stop` | 停止当前正在执行的任务 |
| `/steer <message>` | 当前任务继续执行时追加引导信息 |
| `/followup <message>` | 排队新请求，等当前任务结束后执行 |
| `/events list\|show\|delete\|history` | 查看与管理 `workspace/events/` 中的定时事件 |
| `/tasks [show\|archive\|approve\|pause\|resume\|run\|stats\|doctor]` | 查看与治理任务台账，`approve` 是外部副作用的唯一授权入口 |
| `/status` | 运行时状态：执行状态、当前模型、上下文用量、运行时长、版本 |
| `/usage [7d\|month]` | 本通道与全局的 LLM 成本，按类型和 Top 模型拆分 |
| `/new` | 开启新会话 |
| `/compact [instructions]` | 手动压缩当前会话上下文 |
| `/session` | 当前会话状态、消息统计、token 使用量 |
| `/model [引用]` | 查看或切换模型 |

说明：

- 前八条由传输层直接处理，**忙碌时也可用**；后四条是会话命令，仅空闲时可用（忙碌时会收到提示）。
- 忙碌时的普通消息默认等价于 `/steer`，可通过 `channel.json` 的 `busyMessageDefault` 改为排队（`followUp`）。
- 未知的斜杠命令会被直接拒绝并提示 `/help`，不会作为普通消息发给模型（避免 `/modle` 这类笔误变成一整轮 LLM 调用）。workspace skill 也可作为命令调用（`/skill:<名称>`）。
- `/model` 依次尝试精确 `provider/modelId`、精确 `modelId`、对完整引用的子串匹配，只有唯一命中时才切换，例如 `/model turbo`。

事件与任务的详细用法见 [docs/events-and-sub-agents.md](./docs/events-and-sub-agents.md) 与 [docs/tasks.md](./docs/tasks.md)。

## 文档地图（Documentation）

| 文档 | 内容 |
|------|------|
| [docs/configuration.md](./docs/configuration.md) | 全部配置项：钉钉、模型、settings、tools、TUI、记忆与工作区文件 |
| [docs/events-and-sub-agents.md](./docs/events-and-sub-agents.md) | 定时事件（含 `preAction` 门控、`event_manage`）与预定义子代理 |
| [docs/tasks.md](./docs/tasks.md) | 任务台账、内建 task driver、`/tasks` 控制面与 `task_manage` 工具 |
| [docs/runtime-playbooks.md](./docs/runtime-playbooks.md) | Runtime playbooks 与知识分层模型 |
| [docs/deployment-and-operations.md](./docs/deployment-and-operations.md) | 长期运行、日志、可观测性、升级、备份与排障 |
| [docs/scaling-and-concurrency.md](./docs/scaling-and-concurrency.md) | 并发模型与容量边界 |
| [docs/security.md](./docs/security.md) | 默认安全策略、`security.json` 配置与已知边界 |

## 开发（Development）

```bash
npm install
npm run build
npm run check    # lint + typecheck + deadcode + test
```

常用脚本：`npm run typecheck`、`npm run test`、`npm run test:e2e`。

端到端测试说明：

- `npm run test:e2e` 运行"除钉钉渠道外"的完整 E2E：真实 runtime、真实工具/记忆/Sidecar/LLM，只 mock 钉钉传输层。
- 需要可用模型凭据：优先读取 `${PIPICLAW_HOME:-~/.pi/pipiclaw}/auth.json`，否则回退到 `ANTHROPIC_API_KEY`。
- 默认模型是 `anthropic/claude-sonnet-4-5`；使用其他 provider 时用 `PIPICLAW_E2E_PROVIDER` / `PIPICLAW_E2E_MODEL` 覆盖，例如 `PIPICLAW_E2E_PROVIDER=zpai PIPICLAW_E2E_MODEL=glm-5-turbo npm run test:e2e`。
- E2E 不包含在 `npm run test` 中，避免日常测试被真实 LLM 依赖和调用成本影响。

## 许可证（License）

GNU Affero General Public License v3.0. See [LICENSE](./LICENSE).
