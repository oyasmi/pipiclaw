# Pipiclaw 配置字段参考（Configuration Reference）

> **读者**：已经能启动 Pipiclaw、想逐项查阅配置字段的使用者与维护者。
> **前置**：已完成 [README](../README.md) 的快速开始（Quickstart）。
> **读完你能**：知道每项配置写在哪个文件、优先级如何、字段含义是什么。

这是一份**字段参考**，不必通读——用目录定位到你要查的文件或字段即可。常见配置路径见 [configuration.md](./configuration.md)，运行机制说明见 [runtime-mechanisms.md](./runtime-mechanisms.md)。

补充文档：

- 交互方式与命令：[interaction-and-commands.md](./interaction-and-commands.md)
- 事件与任务使用指南：[events-and-tasks.md](./events-and-tasks.md)
- 智能体委派指南：[sub-agents.md](./sub-agents.md)
- Workspace skills：[skills.md](./skills.md)
- 部署与运维指南：[deployment-and-operations.md](./deployment-and-operations.md)
- 安全文档：[security.md](./security.md)

## 设计原则（Design Principles）

Pipiclaw 的配置分成两层：

- Pipiclaw 自己的运行时配置
  - 例如 `channel.json`、工作区（workspace）目录、钉钉接入、记忆文件、事件目录
- 继承自 `@earendil-works/pi-coding-agent`（`@mariozechner/pi-coding-agent` 的 fork）的模型与认证配置能力
  - 例如 `auth.json`、`models.json`、部分 `settings.json` 语义

这意味着：

- 有些配置格式是 Pipiclaw 自己定义的
- 有些配置格式和解析规则直接沿用 pi-mono 上游
- 还有一些上游 `settings.json` 字段在 Pipiclaw 里目前并不会生效

阅读时建议先看“配置总览”，再按需要跳到具体章节。

## 配置总览（Configuration At a Glance）

Pipiclaw 默认在下面这个目录初始化所有配置：

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
    ├── CHANNELS.md
    ├── desk-bindings.json
    ├── desk-default/       # desk.json；memory/tasks/events 等按需创建
    ├── skills/
    └── sub-agents/
```

默认根目录是 `~/.pipiclaw/`。如果你设置了：

```bash
export PIPICLAW_HOME=/your/custom/pipiclaw-home
```

那么 Pipiclaw 会改为从这个目录读取和写入所有全局配置与 `workspace/`。

> **从旧版本升级：** 默认根目录已从 `~/.pi/pipiclaw/` 迁移到 `~/.pipiclaw/`。启动时的自动迁移是临时兼容，**已在 0.9.0 移除**：当前版本只解析 `PIPICLAW_HOME ?? ~/.pipiclaw`，不再探测旧目录。仍在用旧目录的部署，手动把整个目录移到 `~/.pipiclaw/`，或设 `PIPICLAW_HOME=~/.pi/pipiclaw` 继续用原位置。

### 主要文件（Main Files）

| 文件 | 范围 | 用途 | 自动创建 |
|------|------|------|----------|
| `~/.pipiclaw/channel.json` | 全局 | 渠道开关与钉钉 / Web API 配置 | 是 |
| `~/.pipiclaw/auth.json` | 全局 | 模型提供方凭据（provider credentials） | 是 |
| `~/.pipiclaw/models.json` | 全局 | 自定义模型提供方 / 模型 | 是 |
| `~/.pipiclaw/settings.json` | 全局 | Pipiclaw 运行时设置 | 是 |
| `~/.pipiclaw/tools.json` | 全局 | 内建工具配置，例如 `tools.web` | 是 |
| `~/.pipiclaw/security.json` | 全局 | 工具层安全策略（路径/命令守卫） | 是 |
| `~/.pipiclaw/workspace/SOUL.md` | 工作区 | 助手身份与回复风格 | 是 |
| `~/.pipiclaw/workspace/AGENTS.md` | 工作区 | 工作规则与行为约束 | 是 |
| `~/.pipiclaw/workspace/MEMORY.md` | 工作区 | 持久化共享记忆 | 是 |
| `~/.pipiclaw/workspace/ENVIRONMENT.md` | 工作区 | 环境事实与重要环境变更记录 | 是 |
| `~/.pipiclaw/workspace/CHANNELS.md` | 工作区 | 频道索引：ID / 名称 / 工位 / 最近消息 / 主题。前四列 runtime 自动维护，「主题」列可手工编辑并会被保留 | 首次维护频道索引时 |
| `~/.pipiclaw/workspace/desk-<name>/` | 工作区 | 默认工位位于 `desk-default/`；`desk-bindings.json` 记录频道 id → 工位的绑定。其他工位通过 `/desk new`、`pipiclaw tui --desk <名字> --create` 创建 | 自动创建 `default`；新频道自动绑定 |
| `~/.pipiclaw/workspace/desk-<name>/events/` | 工位 | 该工位的定时事件目录 | 首次写入事件时 |
| `~/.pipiclaw/workspace/sub-agents/` | 工作区 | 工作区配置子代理目录 | 是 |
| `~/.pipiclaw/workspace/skills/` | 工作区 | 工作区级技能目录 | 是 |

### 环境变量（Environment Variables）

| 变量 | 用途 |
|----------|------|
| `ANTHROPIC_API_KEY` | Anthropic 默认模型凭据 |
| `PIPICLAW_HOME` | 覆盖默认的 `~/.pipiclaw/` 根目录 |
| `PIPICLAW_DEBUG` | 在频道的会话区（`desk-<name>/conversations/<kind>-<n>/`）中写出 `last_prompt.json` |
| `PIPICLAW_LOG_LEVEL` | 覆盖日志级别（`debug` \| `info` \| `warn` \| `error`），优先于 `settings.json` |
| `PIPICLAW_LOG_FILE` | `0`/`1` 关闭或开启文件落盘，优先于 `settings.json` |
| `PIPICLAW_PROXY` | 仅让 LLM 请求（主/子 Agent、记忆 sidecar）走这个 `http://`/`https://` 代理；DingTalk 和 web 工具不受影响。优先于标准 `HTTP_PROXY`/`HTTPS_PROXY`。不支持 SOCKS，详见 [configuration.md](./configuration.md#llm-请求走代理) |
| `PIPICLAW_NO_PROXY` | `PIPICLAW_PROXY` 的例外目标列表（逗号分隔）；未设置时回落到标准 `NO_PROXY` |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | 标准代理环境变量。DingTalk runtime 和 web 工具通过 `proxy-from-env`，额外识别 `ALL_PROXY`；LLM 请求路径（undici）**不识别 `ALL_PROXY`**，只认 `HTTP_PROXY`/`HTTPS_PROXY`（大小写皆可），且只在未设置 `PIPICLAW_PROXY` 时对 LLM 请求生效 |

> Pipiclaw 面向 Linux / macOS；Windows 请使用 WSL2。`bash`、`grep` 等命令工具依赖 POSIX 环境；文件内容工具通过 `FileStore` 直接使用 `node:fs`，PDF 文本提取另需 `pdftotext`。

## 配置优先级（Configuration Precedence）

不同类型的配置有不同的优先级。

### 钉钉配置（DingTalk Config）

Pipiclaw 只读取 app home 下的 `channel.json`，没有项目级覆盖。默认是 `~/.pipiclaw/channel.json`；如果设置了 `PIPICLAW_HOME`，则会改为 `${PIPICLAW_HOME}/channel.json`。

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

Pipiclaw 当前只使用 app home 下的 `settings.json`。默认是 `~/.pipiclaw/settings.json`；如果设置了 `PIPICLAW_HOME`，则会改为 `${PIPICLAW_HOME}/settings.json`。

pi-mono 里的项目级 `.pi/settings.json` 覆盖机制，Pipiclaw 目前没有采用。不要假设把配置写到项目目录 `.pi/settings.json` 就会生效。

## 备用模型（Fallback Model，`settings.json`）

主模型这一轮失败了（不是用户 `/stop`、也不是上下文超限），就自动换成配置的备用模型把这一轮重跑一次；之后 5 分钟内的新轮次直接用备用模型，5 分钟后自动试回主模型。`settings.json` 里一个键即可开启：

```json
"fallbackModel": "openai/gpt-4o-mini"
```

- 不配置（或填空串）＝功能关闭，行为与不带 fallback 时完全一致。
- 值是 `provider/model` 引用，须能在已有的 `auth.json` / `models.json` 里解析到并具备 API key；解析失败、有歧义或缺 key 时会 warn 并跳过 fallback（不影响主流程）。
- **429 说明**（实际最常见的失败）：429 / 5xx / overloaded 这类瞬态错误先由 SDK 在**主模型上**退避重试（默认 3 次，约 2+4+8 秒）；仍失败才切备用。短暂限流由重试消化，持续限流才换模型。触发条件是「除上下文超限外的任何错误」——429、配额耗尽、401、甚至 400 都会触发（换取规则可一句话说清）。
- 冷却时长（5 分钟）是内部常量；fallback **不修改**你用 `/model` 选定的首选模型，进程重启后回到主模型。手动 `/model` 切换会立即清除 fallback 状态。
- fallback 生效期间 `/status` 会多出一行 `Fallback: active（primary <主模型> 冷却至 HH:MM）`；每次切换都会给用户一条提示，并写入结构化日志的 `model_fallback` 事件，成本账本按实际成交模型归因。

## 内置子智能体默认模型（Sub-Agent Model，`settings.json`）

给没有指定模型的**内置**子智能体一个默认模型，避免默认继承主智能体当前模型去跑可以由较轻模型完成的窄任务：

```json
"subagentModel": "openai/gpt-4o-mini"
```

- 不配置或填空串时不指定默认值。
- 值是 `provider/model` 引用，须能在 `auth.json` / `models.json` 中解析；解析失败会返回明确错误，不会静默回退。
- 命名角色使用角色 frontmatter 的 `model`；未填写时依次使用 `subagentModel`、主智能体当前模型。只有 `subagent_inline` 调用可以按次传 `model` 覆盖。
- 外部角色的 `model` 是目标 harness 自己的模型字符串，只能写在角色文件中，由 Pipiclaw 原样透传；不经过这里，也不由 `models.json` 校验。

## 可观测性：结构化日志与成本账本（Observability: Structured Logging & Cost Ledger）

作为长期运行的守护进程，Pipiclaw 除了彩色 console 输出外，还会把结构化日志与 LLM 成本落盘到 `STATE_DIR`（默认 `~/.pipiclaw/state`，随 `PIPICLAW_HOME` 变化）。console 输出保持不变；这些文件是额外产物。

- **结构化日志**：`state/logs/runtime.jsonl`，每行一条 JSON 记录（`ts`/`level`/`event`/`channelId`/`message`/`fields` 等），按大小轮转（默认 5MB × 3）。文件权限 `0600`（含用户消息片段，与 `log.jsonl` 同威胁模型）。
- **成本账本**：`state/usage/usage-YYYY-MM.jsonl`，按月分文件。记录分三类 `kind`：`turn`（主轮 assistant）、`subagent`（内置与外部委派）、`sidecar`（记忆后台任务），结算和记账具有幂等保护。条目用 `usageKnown` / `costKnown` 区分真实的 0 与未知：本地或缺价格元数据的模型仍记录 token；Codex CLI 不报告成本，`exec` 不报告 token 或成本，`/usage` 会披露 unknown，而不是把它算成免费。
- **查询**：在任意频道发送 `/usage`（今日 + 本月）、`/usage 7d`、`/usage month`，按本频道与全局聚合展示成本、`kind` 分解与 top 模型；busy/idle 均可用，不占用运行队列。

`settings.json` 中的 `logging` 段（均可选，缺省即默认）：

```json
"logging": {
  "level": "info",
  "file": { "enabled": true }
}
```

- `level`：`debug` | `info` | `warn` | `error`，同时控制 console 与文件日志；低于该级别的记录不会输出。默认 `info` 只保留运行生命周期、请求处理、投递、降级和失败等关键事件；工具参数/结果、模型 thinking 和完整回复仅在 `debug` 输出。
- `file.enabled`：默认 **true**（守护进程默认落盘的价值大于新文件的意外感）。设为 `false` 则退回纯 console。
- 轮转参数固定为 5MB × 3，不可配。
- 环境变量优先于 settings，且在启动最早期即生效：`PIPICLAW_LOG_LEVEL`（同上四级）、`PIPICLAW_LOG_FILE=0|1`（关闭/开启文件落盘）。
- 控制台每条日志使用统一的 `时间 级别 事件名 消息 key=value` 格式。用户正文、模型回复和常见敏感字段（如 token、cookie、authorization、secret、环境变量值）不会原样输出；长诊断字符串会被截断。

## 内建工具与任务开关（Built-in Tool and Task Settings）

Pipiclaw 当前把内建工具的实例级配置放在 app home 下的 `tools.json`。默认是 `~/.pipiclaw/tools.json`；如果设置了 `PIPICLAW_HOME`，则会改为 `${PIPICLAW_HOME}/tools.json`。

当前最主要的是 `tools.web` 配置空间，用于控制：

1. 是否启用 `web_search` / `web_fetch`
2. 搜索 provider，例如 `duckduckgo`、`brave`、`tavily`、`jina`、`searxng`
3. web 请求代理
4. fetch 的默认超时、截断和 Jina fallback 行为

### rtk 命令优化（`tools.rtk`）

[rtk（Rust Token Killer）](https://github.com/rtk-ai/rtk) 是一个把常见只读命令改写成 token 精简形式的 CLI 代理（例如 `git status` → `rtk git status`）。开启后，`bash` 工具在**安全校验之后、实际执行之前**把命令交给 `rtk rewrite` 处理，从而压缩返回给模型的输出。

```jsonc
{
  "tools": {
    "rtk": { "enabled": true }
  }
}
```

- 只有一个开关 `enabled`（默认 `false`）；二进制名、超时等实现细节内建，无需配置。
- **尽力而为**：pipiclaw 会在 host 的 PATH 上探测一次 `rtk` 是否可用。装了就用，没装则静默跳过——开启 rtk 永远不会让 `bash` 命令失败。
- rtk 只重塑语义等价的只读命令，安全校验始终针对**原始命令**执行，改写不会绕过 `command-guard`。

### 内联委派开关（`tools.subagentInline`）

`subagent_inline`（没有配置角色时的一次性执行者，见 [sub-agents.md](./sub-agents.md)）由 `tools.subagentInline.enabled` 单独门控，默认开：

```jsonc
{
  "tools": {
    "subagentInline": { "enabled": true }
  }
}
```

关掉后工具集里不再出现 `subagent_inline`——不是调用被拒绝，而是这次调用没有工具可用。`subagent`（选一个已配置角色）不受这个开关影响。角色目录已经覆盖到日常委派后，可以关掉这个开关收紧调用面。

### 事件自调度工具（`event_manage`，恒开）

`event_manage` 工具让主 agent 能自己创建、修改、删除定时事件。任务的普通继续/等待由内建 task driver 根据等待票驱动；event 用于独立提醒、外部条件传感器，以及带 `task` 模板的周期/定时工作（每次触发生成一个任务实例）。核心能力，无开关、始终注册。

- 该工具只发给主 agent，不进子代理工具集。
- 写入时会做完整校验（复用与 watcher 相同的 `parseScheduledEventContent`）、路径 traversal 拦截、`command-guard` 检查 `preAction`，以及一组防自激励闸门（禁 `immediate`、one-shot 至少提前 2 分钟、periodic 最密每 30 分钟、**带 `preAction` 门控时放宽到 5 分钟**、事件文件总数上限 50）。细节见 [events-and-tasks.md](./events-and-tasks.md)。

### 自主长程任务总开关（`tools.tasks`）

`tools.tasks.enabled` 是**整个自主长程任务机制的总开关**，同时门控三样东西：全部 task_* 工具（agent 维护[长程任务](./events-and-tasks.md)：`task_list`/`task_create`/`task_update`/`task_close`/`task_log`，以及任务会话里的 `task_step_end`）、内建 TaskDriver（后台扫描台账并唤醒任务），以及每回合注入的任务摘要（task digest）。默认开启；关掉即回到"纯对话助手"形态。

```jsonc
{
  "tools": {
    "tasks": { "enabled": true }
  }
}
```

- 关掉后 task 文件仍保留在磁盘，但没有受控的 task 工具、后台唤醒或摘要注入；需要继续托管时应重新开启。
- 这些工具只发给主 agent，不进子代理工具集。每任务 `budget`（`steps`/`usd`）在 `task_create`/`task_update` 上设置。进度记录属于 `task_step_end` 的 `note`（进循环日志），Goal/DoD 等大段正文仍用 write/edit。
- Task 创建即持续委托；外部动作由能力配置、任务 Goal、scope、真实状态查询和幂等 request id 约束，结果必须写入任务证据。

### 结构化搜索工具（`grep`，恒开）

`grep` 工具用扩展正则在文件/目录树里搜内容，输出按文件分组、每文件与每页有上限、并做字节封顶——优先用它而不是 `bash grep -rn`（后者会打爆上下文）。核心能力，无开关、始终注册。

- 执行层复用 Executor（沙箱内 `grep`），主 agent 与子代理都可用。

### 后台作业（`bash async` + `job`，恒开）

`bash` 多一个 `async: true` 参数，把长命令丢到后台并立刻返回作业 id，避免占住频道轮次；`job` 工具用来 list/poll/cancel。核心能力，无开关、始终注册。

- 作业进程活在 host 上，通过 shell 命令管理（`nohup` 启动、`kill -0` 探活、退出码写入 `.exit` 文件）；每频道最多 5 个并发运行作业，超时沿用 bash 的 `timeout` 预算。
- 作业状态持久化在 `${PIPICLAW_HOME:-~/.pipiclaw}/state/jobs/<name>/`：重启后 runtime 会认领仍在运行的作业，已结束作业保留 24 小时供查看。
- runtime sweeper 约每 30 秒检查一次后台作业；作业完成后会自动唤醒对应 channel 并带上输出尾部，不需要再排 check-in event。
- 只发给主 agent；子代理不能起后台作业，也不能使用 `job` 工具。

### 智能体委派（`subagent` + `subagent_list` + `subagent_run`，恒开）

这三个工具只发给主智能体，没有 `tools.json` 开关。`subagent` 调用内置或外部角色；`subagent_list` 查看 run，`subagent_run` 对单个 run 执行 show/cancel/follow_up（续接已结束的 Claude Code / Codex CLI run）。角色由 `workspace/sub-agents/*.md` 配置，空目录不会关闭 inline 内置委派。

外部角色不是 `bash async` 的别名：它有统一 run 状态、产物、工作区写锁、并发准入、完成唤醒、用量标记和重启对账。角色字段、调用参数与授权边界统一见 [sub-agents.md](./sub-agents.md)，不在本字段参考中维护第二份副本。

### bash 拦截器（`tools.bashInterceptor`）

拦截少数"有更好工具"的裸 shell 形态（整文件 `cat`、递归 `grep`、`sed -i`），报错把模型导向 `read`/`grep`/`edit`。默认开启。

```jsonc
{
  "tools": {
    "bashInterceptor": { "enabled": true }
  }
}
```

- 只拦最明确的裸形态；带管道/重定向的复合命令（如 `cat x | jq`）一律放行。
- 运行在 `command-guard` 之后、`rtk` 之前，只影响"用哪个工具"，不放行任何 guard 会拦的东西（递归 grep 被拦后由恒开的 `grep` 工具承接）。

### 记忆管理工具（`memory_save` / `memory_search` / `memory_forget`，恒开）

三个工具让主 agent 按需 `memory_save`（存一条持久事实，一条记忆一个 `memory/<name>.md` 文件，写入后自动重建索引）、`memory_search`（在工位记忆、journal、workspace `MEMORY.md` 里按需查找，索引已在首轮整份注入，中途怀疑"以前可能记过"才用它）、`memory_forget`（按 `name` 精确删除，写入不含原文的 tombstone 防止后台反思复活，不走裸 edit）。`forget` 不清理原始 session/log 或历史归档；工具返回会明确说明这个边界。写操作都走以工位为键的记忆串行队列（跨进程另持 `memory.lock`），杜绝与后台反思的竞态。核心能力，无开关、始终注册，只发给主 agent；`memory_save` 撞到相似已有条目（Jaccard 相似度）会先拒绝并要求带 `replaces` 二次调用。`session_search`（冷存储检索）与 `skill`（workspace skills 只读列出/加载）同理恒开。

用户可用 `/memory status` 查看记忆条数、按类型分布、观察期条目、上次后台整理时间、索引是否超预算；`/memory list` 按 `name` 列出工位记忆；`/memory show <name>` 展示某条记忆的正文与 frontmatter；`/memory journal [YYYY-MM-DD]` 查看某天的工作日记；`/memory forget <name>` 直接删除，不经过模型。元数据全部内联在 `memory/<name>.md` 的 frontmatter 里（`name`/`description`/`type`/`source`/`created`/`updated`/`expires?`），没有独立的 sidecar metadata 文件——`MEMORY.md` 索引是从这些 frontmatter 生成的，本身就可重建。反思动作的成本与结果记在 `memory-review.jsonl`，用 correlation id 关联 usage ledger。

### 出站附件工具（`send_media`，随前端自动启用）

`send_media` 把 workspace 内的本地文件作为**原生附件**发进当前会话：`.jpg .jpeg .png .gif .webp .bmp` 内联为图片，其余作为可下载文件。用于把生成好的报表、截图、图表、导出文件真正交到用户手里。

没有 `tools.json` 开关——只要驱动本次会话的传输层实现了出站附件端口就自动注册，钉钉已实现；Web API（含终端）没有附件通道，此时工具会告诉模型把文件在服务器上的路径告知用户。两个性质值得管理员知道：

- **目标会话在构建期绑定**，不是模型参数：agent 无法把文件发到当前会话以外的地方，也无从指定收件人。
- 路径经与 `read` **完全相同**的 path guard（`security.json`），越界文件在读取字节前就被拒绝并写入审计日志。

不发给子代理——出站投递归主 agent 所有。用法与失败处理见 [tools.md](./tools.md#附件交付send_media)。

### 网页抓取缓存（`web_fetch` offset 分页）

`web_fetch` 会把抓取到的正文按工位缓存（`desk-<name>/web-cache/`，键为 URL+抽取模式的哈希，TTL 15 分钟，LRU 上限 20 个文件）。长页面被截断时尾注会给出下一段的 `offset`；用同一 URL + 该 `offset` 再调一次即从缓存翻页，**不重新抓取**。图片结果原样返回、不缓存。无独立开关，随 `tools.web.enable` 生效。

### 任务摘要注入（Task Digest，恒随任务开关）

每个主 agent 回合，运行时会把一份紧凑的 active 任务摘要（`<task_agenda>`）注入进 prompt，让 agent 恒定知道在途工作，无需依赖 `ls tasks/` 的纪律。是否注入完全由总开关 `tools.tasks.enabled`（tools.json）决定，没有单独的配置项。

摘要上限固定为 8 条任务 / 约 1000 字符，超出会截断并标注剩余数量。摘要包含活动目录中的所有未关闭任务，每行显示 state、暂停状态、等待票摘要与兜底时间、工作项进度和用量。

### 内建任务驱动器（Task Driver，恒随任务开关）

DingTalk daemon 原生扫描各 `dm_*/group_*` channel 的任务。扫描本身不调用模型：兑现到期的 `time` 票、给过期的票兜底、停下超预算或空转的任务，然后排一个可跑任务的下一步。`work`/`ask` 票从不轮询——它们由各自的所有者推过来。暂停和已归档任务零 dispatch。是否运行完全由总开关 `tools.tasks.enabled`（tools.json）决定；预算与节奏是内置常量（每任务可在 frontmatter 的 `budget` 里覆盖）。

行为（供理解，非配置项）：

- driver 睡到最近的票据时刻或内置 15 分钟上限；步骤 `continue` 后会立即 nudge，连续两步没有工具调用则暂停任务并通知用户。
- 单次扫描全局最多派发 4 个 channel；同一 channel 每 tick 最多唤醒一个任务，并按 channel 和任务轮转保证公平。
- `work`、`ask` 票由各自所有者推送兑现（任一绑定委派/作业结算即兑现 `work`）；过了 runtime 派生的兜底时限会重开一次，连续第二次过期则暂停并通知用户。
- 内嵌运行时（没有 daemon 时的 `pipiclaw tui`）在终端打开期间驱动任务；终端退出后，没有 daemon 的任务不会继续，需要自动恢复的长期任务应运行在 daemon 下。

## 终端 TUI（Terminal TUI）

终端是 Web API 的**客户端**（[Web API](./webapi.md)）：`pipiclaw tui` 用官方 `openai` SDK 连接 `state/webapi/api.sock`，复用**同一套配置目录**（`auth.json` / `models.json` / `settings.json` / `tools.json` / `security.json`）。终端的会话和钉钉的私聊、群一样是一个频道（`webapi:conv_…`），绑定在某个工位上，与这个工位的其他频道共享记忆、任务、事件和工作文件，但有自己的对话。

**有没有 daemon 都能用**：

- daemon 在运行（持有 `state/daemon.lock`）时，终端连接它的 socket。daemon 没有打开 Web API 的 socket 时终端会报错并说明两种做法：在 `channel.json` 里打开 `webapi`（`"enabled": true, "socket": true`）并重启 daemon，或先停掉 daemon。
- 没有 daemon 时，终端在本进程里启动完整的运行时（只开 Web API 的 socket，不连钉钉、不开 TCP），退出时按 daemon 的顺序关闭。这期间事件和任务驱动也在运行；钉钉频道的任务和事件在内嵌运行时里不可达，按规则被跳过。

### 启动（Usage）

```bash
pipiclaw tui                                    # 交互式，打开 `default` 工位，续上次的对话
pipiclaw tui --desk news                        # 打开工位 `news`
pipiclaw tui --desk lab --create                # 工位不存在时先创建
pipiclaw tui --desk news --new                  # 在 `news` 开一个新对话，而不是续上次
echo "问题" | pipiclaw tui --desk news --print  # 一次性：发一个同步请求、打印答案、退出（可脚本化）
pipiclaw tui --desk news --print "总结今天的进展"  # 一次性，prompt 走命令行位置参数
```

选项：

| 选项 | 说明 |
|------|------|
| `--desk <name>` | 要打开的工位，省略时是 `default`。该工位上次用的对话会被续上（记录在 `state/tui/conversations.json`）；对话已被 `/desk bind` 到别的工位时视为失效，另建一个。新对话的第一条消息是 `/desk bind <name>`，绑定失败（例如工位不存在）时打印服务端的回复并以 1 退出。 |
| `--create` | 先发 `/desk new <name>` 再绑定（与钉钉里的 `/desk new` 相同）。 |
| `--new` | 总是开一个新对话。 |
| `--print`, `-p` | 一次性非交互模式：运行位置参数（或管道 stdin）作为唯一 prompt，打印最终答案后退出。 |
| `--quiet`, `-q` | 纯文本模式下只输出最终答案（进度与提示写入 stderr 的部分被静音）。 |
| `--plain` | 即使在 TTY 下也强制使用纯文本前端（不进入全屏 UI）。 |
| `--version` / `--help` | 打印版本 / 帮助。 |

**命令**：终端自己只处理 `/exit`、`/quit`（退出）、`/stop`（断开连接，等于取消当前回合，下一条消息自动重连）、`/steer <文本>`（插入当前回合）和 `/followup <文本>`（在客户端排队，当前回合结束后再发）。其余一切——`/help` `/status` `/usage` `/events` `/tasks` `/subagents` `/skills` `/desk`、`/model` `/new` `/compact` `/session` `/memory`——原样发给服务端，规则与钉钉相同。回合进行中，普通文本会插入当前回合；以 `/` 开头的命令交给服务端判断此时能不能运行。`Ctrl-C` 中止本轮，空闲时连按两次退出，`Ctrl-D` 退出。

非 TTY（管道 / 重定向）或 `--print` 会自动使用纯文本前端；真实终端下使用带滚动记录、状态行、斜杠命令补全的富界面。

### 会话续接（Resume）

- **退出重进即自动续上次对话**：同一个 `--desk` 的对话保存在 `state/tui/conversations.json`，对话本身是一个 Web API 会话，模型上下文在工位的会话区 `conversations/webapi-N/` 里。`/new` 开新的模型会话，旧的仍保留。
- **多个终端可以同时打开同一个工位**：它们默认会续上同一个对话（排队执行）；想要各用各的，给其中一个加 `--new`。
- **服务端自己产生的内容会显示出来**：空闲时终端每隔几秒读一次会话的 items，后台作业完成、任务汇报等没有请求方的回复会显示在对话里。
- **钉钉频道的对话不会出现在终端里**，只共享记忆、任务和文件。

### `tui` 设置（settings.json）

`settings.json` 顶层可选 `tui` 块控制终端显示多少过程（与钉钉的 `channel.json.responseMode` 相互独立）：

```json
{
  "tui": {
    "responseMode": "full_progress_then_plain_final"
  }
}
```

`responseMode` 取值与钉钉一致：`full_progress_then_plain_final`（默认，流式进度 + 纯文本最终答复）、`rolling_progress_then_plain_final`（与默认相同的显示）、`final_card_only`（隐藏进度，只在结束时显示答复）。缺省即默认值。

### 与钉钉常驻服务的并发约束（Concurrency Caveat）

终端可以打开一个正由钉钉使用的工位：

- 终端不再自己写工位。所有写入都由运行时（daemon 或内嵌运行时）完成，一个 app home 同时只有一个运行时进程（`state/daemon.lock`）。
- 工位的记忆、任务文件和 `desk.json` 的写入仍持有 `desk-<name>/.locks/` 下的跨进程短锁，与以前一样。
- 终端的会话区是 `conversations/webapi-N/`，钉钉频道的是 `dm-N`、`group-N`，互不共享。

## 渠道配置文件 `channel.json`（`channel.json`）

`channel.json` 配置 Pipiclaw 开哪些渠道：`dingtalk`（钉钉）和 `webapi`（[Web API](./webapi.md)）两段，各有 `enabled` 开关。**至少要打开一个**，否则拒绝启动；关闭的渠道不加载代码、不监听、不写自己的状态目录，里面的字段（包括占位值）也不会被检查。

```json
{
  "dingtalk": { "enabled": true, "clientId": "…", "clientSecret": "…" },
  "webapi": { "enabled": false, "socket": true }
}
```

旧版本的 `channel.json`（字段在根级）不再被读取，转换见[迁移说明](./channel-migration.md)。

### `webapi` 段

| 字段 | 默认 | 说明 |
|------|------|------|
| `enabled` | `false` | 是否打开 Web API |
| `socket` | `true` | 在 `state/webapi/api.sock` 监听（`0600`），不需要 key |
| `tcp` | 不监听 | `"host:port"`（IPv6 写 `"[::1]:8787"`）；每个请求都要带 key |
| `tls` | 无 | `{ "cert", "key" }` 绝对路径；`tcp` 不是 loopback 时必须配置 |
| `keys` | `[]` | `{ "name", "sha256", "desks" }` 的数组；用 `pipiclaw webapi key add\|list\|remove` 管理 |

key 命令、字段策略、错误与安全说明见 [Web API](./webapi.md)。

## 钉钉配置（`channel.json` 的 `dingtalk` 段）

以下字段都写在 `dingtalk` 段里（`enabled: true` 时）。

### 最小示例（Minimal Example）

```json
{
  "dingtalk": {
    "enabled": true,
    "clientId": "your-dingtalk-client-id",
    "clientSecret": "your-dingtalk-client-secret",
    "robotCode": "",
    "cardTemplateId": "",
    "cardTemplateKey": "content",
    "allowFrom": []
  }
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
| `responseMode` | 否 | `"full_progress_then_plain_final"` | 输出形态，统一控制「过程展示」与「最终投递方式」，取值见下方矩阵 |
| `cardAutoLayout` | 否 | `true` | 透传给钉钉 AI Card 模板的 `autoLayout` 渲染开关 |

#### `responseMode` 行为矩阵

| 取值 | 过程展示 | 最终答案投递 |
| --- | --- | --- |
| `full_progress_then_plain_final`（默认） | 完整累积工具/思考/中间文本 | 单独的纯文本消息，卡片收尾为进度全文 |
| `rolling_progress_then_plain_final` | 常驻首行 `⏱ 用时 · N 步` + 最近 3 条进展 | 单独的纯文本消息，卡片收尾为一行摘要 |
| `final_card_only` | 不展示任何过程 | 最终答案直接写入 AI Card，不再额外发纯文本 |

> 上表只覆盖**用户消息**。后台唤醒（任务驱动器、后台作业完成、定时事件）一律不展示过程：不建卡、不推思考流，只在有话要说时投递最终答案。想看后台在忙什么，用 `/status` 与 `/tasks`。

用户回合没有进展时，约 3.5 秒后才显示非空等待卡；此前答复完成则不建卡。等待卡直到答复时仍没有任何进度，答复就直接写进这张卡，不再另发纯文本消息。已有进度卡在静默结束或停止时保留内容并标记结束，不清空正文。进度更新累计失败两次后停止，最终答复仍独立投递；收尾不会额外创建进度卡或发送进度消息。`final_card_only` 不显示等待卡，只在最终答复时建卡。作业与委派完成通知即使标记为 `awaited`，也只展示结果。
>
> 旧字段 `progressDisplay` 与旧值 `responseMode: "progress_then_plain_final"` 已移除，请改用上表取值。

### 使用说明（Practical Notes）

- `clientId` 和 `clientSecret` 是唯一硬性必需字段
- `robotCode` 留空通常就够用
- `cardTemplateId` 建议配置；留空时 Pipiclaw 仍可工作，但不会使用 AI Card
- `allowFrom` 生效的是发送者 staff ID
- 当 `allowFrom` 非空时，不在列表中的发送者消息会被直接忽略
- `busyMessageDefault` 写成 `"followUp"` 或 `"followup"` 都会启用 follow-up 默认模式；其他显式值会在启动时报错
- `responseMode` 只接受矩阵中的三个取值；其他显式值会在启动时报错

常见接入、灰度和排队配置保留在 [configuration.md](./configuration.md)；本参考不再维护第二套场景示例。

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

- 需要 SDK 已支持 provider 的 OAuth / device-code 登录：使用 `pipiclaw auth login`，凭据写入 `auth.json`
- 目标模型提供方不是 OpenAI / Anthropic / Google 兼容 API
- 需要自定义 streaming implementation

第一类使用 Pipiclaw 自带的 provider 登录 CLI，见 [configuration.md](./configuration.md#订阅登录oauth-provider)。后两类才需要评估 pi-mono 的扩展 / 自定义模型提供方机制；它们不是通过简单 JSON 就能完成的用户配置。

上游参考：

- [pi custom-provider.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/custom-provider.md)

## 运行时设置文件 `settings.json`（`settings.json`）

`settings.json` 用来控制 Pipiclaw 的默认模型和部分运行时行为。

### 设计边界：只表达产品意图（What Belongs Here）

`settings.json` 只接受**你有依据做判断**的选项：用哪个模型、某个子系统跑不跑、某次可选的 LLM 调用值不值这些 token、输出长什么样。

维护周期、调度并发、置信阈值、退避时长这类 **app 级算法参数是代码常量**，不在这里出现；单项 task 的预算属于任务契约。原因很简单：没有人能凭手头信息判断反思间隔应该是 20 分钟还是 25 分钟，把这种决定摆进配置文件只是把调参责任转嫁给不掌握依据的人，同时让每个数字都变成一份兼容性承诺。

因此下表很短，而且**每一行都是布尔、枚举或模型引用**。

### 兼容性说明（Important Compatibility Note）

虽然 `settings.json` 这个概念来自 pi-mono，但 Pipiclaw 目前并没有完整支持上游 `settings.md` 里的所有字段。

可以把它理解为：

- Pipiclaw 采用了同一个文件名
- 复用了少量模型、压缩（compaction）、重试（retry）相关语义
- 但没有实现完整的 UI、资源加载、project override、packages、themes 等设置体系

因此，下面这张表比上游 `settings.md` 更重要，因为它描述的是 Pipiclaw 当前真实支持的行为。

### Pipiclaw 当前支持的字段（Supported Fields in Pipiclaw）

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `defaultProvider` | unset | 默认模型提供方 |
| `defaultModel` | unset | 默认模型 |
| `defaultThinkingLevel` | `"medium"` | 主 agent 的默认 thinking level；会按当前模型能力自动 clamp |
| `fallbackModel` | unset | 主模型回合失败时的备用模型引用，详见上文；内置子代理重试用尽后也会切到它一次 |
| `subagentModel` | unset | 子代理的默认模型引用，详见上文 |
| `compaction.enabled` | `true` | 启用自动上下文压缩 |
| `retry.enabled` | `true` | 启用自动重试 |
| `memoryMaintenance.enabled` | `true` | 启用内置后台 memory maintenance scheduler（spec 050 起单一反思 job，取代此前的 session refresh / memory checkpoint / structural maintenance 三个 job） |
| `sessionSearch.summarizeWithModel` | `false` | 是否用模型对 `session_search` 命中做 focused summary。同样**会额外发起 LLM 调用** |
| `delegation.notices` | `"live"` | 委派 run（`subagents/`）与后台 job 的旁路播报量：`"off"` 不播报；`"settled"` 播报结算回执（一句话，run 结束后几秒内到达，独立于唤醒回合的 LLM 延迟），以及外部 run 长时间无输出时的一次“可能卡住了”提示；`"live"` 在此基础上为长时间运行的 run（外部 run，以及转为异步的内置 run）追加稀疏的进度提示 |
| `logging.level` | `"info"` | `debug` \| `info` \| `warn` \| `error`，详见上文可观测性一节 |
| `logging.file.enabled` | `true` | 结构化日志是否落盘 |
| `tui.responseMode` | `"full_progress_then_plain_final"` | 终端 TUI 的输出形态，详见上文 TUI 一节 |

`session_search` 工具本身恒开，与 `grep`、`memory_save`、`event_manage` 一致，没有开关。

### 无效枚举值（Invalid Enum Values）

`logging.level`、`tui.responseMode`、`delegation.notices` 三个枚举字段在加载时会做校验：写了取值范围之外的字符串（含拼写错误），该键**被忽略**，回落到上表的默认值，并在启动时打印一条 warning：

```
settings.json: logging.level: "verbos" is not one of debug | info | warn | error; using the default instead
```

同一段配置里的其他键不受影响（例如 `logging.file.enabled` 仍然生效）。此前这类拼写错误是静默的，且后果不一致：错误的 `logging.level` 会让**全部日志**不再落盘，而 `delegation.notices: "liv"` 会等效于 `live`——恰好与写它的人想要的 `off` 相反。

### 已退役的字段（Retired Fields）

0.8.11 起，下列字段不再可配，其值已成为代码常量。**把它们留在 `settings.json` 里不会导致启动失败**——运行时按常量执行，并在启动时打印一条 warning 提示你删掉它们：

```
settings.json: memoryMaintenance.checkpointIntervalMinutes, taskDriver.maxDispatchesPerTick: no longer configurable; ...
```

- `compaction.reserveTokens`、`compaction.keepRecentTokens`
- `retry.maxRetries`、`retry.baseDelayMs`
- `memoryRecall` 整段（`enabled`、`rerankWithModel`、`maxCandidates`、`maxInjected`、`maxChars`）——spec 050 取消了每轮实时召回（D1），会话首轮改为整份注入索引，不再有排序/重排需要调
- `sessionMemory` 整段——`SESSION.md` 刷新流程随 spec 050 一并取消，被 journal 取代
- `memoryMaintenance` 除 `enabled` 外的全部字段（各类间隔、`minMemoryAutoWriteConfidence`、`failureBackoffMinutes`、两个 `cleanupShrinkGuard*`）——单一反思 job 的节奏是代码常量（见 `memory/maintenance-tuning.ts`）
- `sessionSearch` 除 `summarizeWithModel` 外的全部字段（含此前从未生效的 `enabled`）
- `logging.file.maxSizeBytes`、`logging.file.maxFiles`
- `taskDigest` 与 `taskDriver` 两段整体

行为上的关键常量仍然写在对应章节里（后台维护间隔见 `docs/memory.md`，任务驱动节奏见本文"内建任务驱动器"一节），只是不再作为可调项。

`security.json` 的 `projectAccess` 也已退役（spec 058）：项目边界与 `/project` 命令整体删除。留在文件里不会导致启动失败，启动时会打印一条 warning：

```
security.json: projectAccess: retired key ignored: project scope was removed; the desk directory is now the working directory
```

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

#### 2. 设置主 agent 的默认 thinking level（Set the Main Agent Thinking Level）

```json
{
  "defaultThinkingLevel": "medium"
}
```

支持 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。当前模型不支持的 level 会自动降级到该模型支持的值。
运行中也可以使用 `/thinking` 查看可用值，或使用 `/thinking <level>`、`/thinking cycle` 调整当前 session。

#### 3. 压到最省 token（Minimize Token Spend）

```json
{
  "sessionSearch": { "summarizeWithModel": false },
  "memoryMaintenance": { "enabled": false }
}
```

这两项是 `settings.json` 里仅有的与 LLM 调用量直接相关的选项。`sessionSearch.summarizeWithModel` 默认已经是 `false`；`memoryMaintenance.enabled: false` 关闭空闲定时反思，但压缩、`/new` 和正常退出等边界仍可能反思，显式 `memory_save` 也不受影响。

#### 4. 关掉日志落盘（Console-Only Logging）

```json
{
  "logging": {
    "level": "warn",
    "file": { "enabled": false }
  }
}
```

适合：容器内已有统一日志采集，不需要 `state/logs/runtime.jsonl`。

#### 后台记忆维护的行为（不可配，供理解）

- 普通用户 turn 结束后只记录 dirty/counter，不直接触发 memory LLM sidecar。
- `memoryMaintenance` 是内置后台 scheduler，不依赖也不会写入事件目录。
- `memoryMaintenance.enabled` 只门控这条空闲 scheduler；会话边界反思由同一个 reflect 实现处理，但不受该开关控制。
- spec 050 起只有一个后台任务——反思（reflect），取代此前的 session refresh / memory checkpoint / structural maintenance 三个 job。调用 LLM 前有本地 gate：无新内容、channel 仍活跃、未到间隔时不会调用 LLM。内置间隔为 20 分钟，channel 静默满 10 分钟才允许后台 LLM work，每个 tick 只处理 1 个 channel。
- 后台反思的 durable 写入有固定置信度闸门（`necessity: high` 且 `confidence ≥ 0.85`）；`necessity: medium` 的 `add` 以 30 天观察期写入（`confidence ≥ 0.9`），更新用户保存的条目还要求 `confidence ≥ 0.95`。显式 `memory_save` 不要求这两个判断字段，会检查凭据、名称与相似条目，并走相同的存储队列和落盘机制。被拒绝的反思候选记进 `memory-review.jsonl`，素材仍留在冷存储。
- 记忆是一条一文件，没有整份 `MEMORY.md` 重写导致的缩水风险——每次写入只影响被 `add`/`update`/`delete` 点名的那个 `name`，索引文件只是从这些文件生成的只读投影。
- `session_search` 只搜索当前 channel 的 `context.jsonl`、session JSONL、`log.jsonl` 和存在时的 `log.jsonl.1`。
- workspace skill 只能通过显式的 `write`/`edit` 调用创建/更新（`skill` 工具本身只读），后台记忆管线不会自动写 skill。

## 内建工具配置文件 `tools.json`（`tools.json`）

`tools.json` 用来配置 Pipiclaw 的实例级内建工具能力。当前主要配置项是 `web_search` / `web_fetch` 和自主长程任务总开关；记忆、技能、事件、结构化搜索和后台作业属于核心能力，恒开且没有独立开关。

### 启动后默认生成的模板（Bootstrap Template）

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
    "tasks": { "enabled": true }
  },
  "_examples": {
    "proxy": "http://127.0.0.1:7890",
    "apiKey": "BSA..."
  },
  "_notes": [
    "Set tools.web.enable to true to register web_search and web_fetch.",
    "Replace tools.web.search.apiKey with your Brave API key before enabling web tools.",
    "If needed, copy _examples.proxy to tools.web.proxy.",
    "tools.tasks.enabled is the master switch for autonomous long-running tasks (task_* tools + task driver + task digest)."
  ]
}
```

这份模板的意图是：

1. 默认不注册 `web_search` / `web_fetch`
2. 默认开启自主长程任务机制
3. 记忆、技能、事件、结构化搜索和后台作业工具作为核心能力直接注册
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
| `maxResponseBytes` | `5242880` | 抓取响应体最大字节数 |
| `preferJina` | `false` | 是否优先使用 Jina Reader |
| `enableJinaFallback` | `false` | 本地提取失败后是否允许回退到 Jina Reader |
| `defaultExtractMode` | `"markdown"` | HTML 默认提取格式 |

#### `tools.tasks`

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `enabled` | `true` | 自主长程任务总开关：同时门控全部 task_* 工具、内建 TaskDriver 与每回合任务摘要注入 |

> 记忆/技能/事件/搜索/后台作业工具（`memory_save`/`memory_search`/`memory_forget`、`session_search`、`skill`、`event_manage`、`grep`、`glob`、`job`）为核心能力，恒开、无配置项。

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
      "enable": true,
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

## 工作区级配置（Workspace-Level Configuration）

除了 JSON 配置文件，Pipiclaw 还高度依赖工作区（workspace）文件。

## 助手身份文件 `SOUL.md`（`SOUL.md`）

定义助手是谁、说话风格如何、默认语言和回复偏好是什么。

Pipiclaw 只有一套人格。所有工位共同使用 workspace 根目录的 `SOUL.md` 和 `AGENTS.md`；工位目录里的同名文件不会替代根文件。工位只划分工作的状态与资料。共享身份和规则在下一次建立会话时重新加载。

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

放工作区智能体角色。运行时只加载这个目录中实际存在且有效的配置，不自动启用默认角色。仓库和 npm 包中的 [`examples/sub-agents/`](../examples/sub-agents/) 分为两组：`agents/` 是按能力与成本组织的推荐入口，`roles/` 是 explorer、builder、reviewer 等按职责拆分的参考模板。

详细字段、示例和推荐写法见 [sub-agents.md](./sub-agents.md)。

## 事件目录 `desk-<name>/events/`

每个工位有自己的事件目录，放定时事件 JSON；事件的 `channelId` 是投递频道，必须绑定在这个工位上，否则到点跳过。可用于：

- 周期性检查
- 提醒
- 固定时间回顾记忆文件

详细事件类型、字段说明和使用建议见 [events-and-tasks.md](./events-and-tasks.md)。

事件调度层的审计记录会写入 `${PIPICLAW_HOME:-~/.pipiclaw}/state/events/history.jsonl`。该文件由 Pipiclaw 自动创建，用 JSON Lines 记录事件加载、调度、触发、`preAction` 结果和入队结果；其中 `ts` 使用本地时区时间。

## 技能目录 `workspace/skills/`（`workspace/skills/`）

放工作区级技能资源。Pipiclaw 只支持 workspace 级技能，所有工位共享，不支持工位级或频道级 skills。

相关工具：

- `skill list`：列出 workspace skills（含加载失败的原因）
- `skill read`：读取一个 skill 的 `SKILL.md` 全文，带路径解析框架

创建或修改直接用 `write`/`edit` 在 `workspace/skills/<name>/SKILL.md` 上操作，frontmatter 需要非空的 `name`（与目录名一致）和 `description`；支持文件放在 `references/`、`templates/`、`scripts/`、`assets/` 下，按需用 `read` 加载。skill 内容在加载进系统提示前会跑一次安全扫描，未通过的 skill 不会出现在目录里，原因体现在 `skill list` 的 warning 字段中。

## 工位级与会话区级运行时文件（Desk- and Conversation-Level Runtime Files）

每个工位是 `workspace/desk-<name>/` 下的一个目录，也是 agent 的工作目录；与它对话过的每个频道在其中有一个会话区：

```text
~/.pipiclaw/workspace/desk-<name>/                       # 工位级：记忆、任务、事件、委派记录、工作文件
~/.pipiclaw/workspace/desk-<name>/desk.json               # 名字与各频道的会话区登记；可选 "cwd"（见下）
~/.pipiclaw/workspace/desk-<name>/conversations/dm-1/    # 会话区级：某个频道的会话文件
~/.pipiclaw/workspace/desk-<desk>/conversations/group-1/
```

会话区里是 `active-session.json`、会话 JSONL、`context.jsonl`、`log.jsonl`（及轮转的 `log.jsonl.1`）和 `last_prompt.json`；其余都在工位目录下。

**把工作目录指到别处。** 默认情况下工位目录就是 agent 的工作目录（shell 的 cwd、相对路径的基准、委派默认的 `workingDirectory`）。工位的工作文件需要放在别处（比如你的主目录或一个代码仓库）时，在 `desk.json` 里加一个绝对路径：

```json
{ "version": 1, "name": "main", "createdAt": "…", "conversations": { … }, "cwd": "/home/me" }
```

记忆、日记、任务、事件、会话和委派记录仍然放在工位目录里，只有"在哪里干活"变了；相对路径不是绝对路径时该工位不可用。daemon 只在启动时读取 `desk.json`，修改后需重启；TUI 下次打开即生效。路径守卫的允许范围不变（workspace、主目录、临时目录和你在 `security.json` 里加的目录）。

常见文件：

| 文件 | 用途 |
|------|------|
| `memory/<name>.md` | 一条记忆一个文件（frontmatter：`name`/`description`/`type`/`source`/`created`/`updated`/`expires?`） |
| `memory/.tombstones.jsonl` | 遗忘防复活记录，只保存 name/content hash，不保存原文 |
| `MEMORY.md` | 从 `memory/*.md` 生成的索引，勿手改 |
| `journal/YYYY-MM-DD.md` | 按天追加的工作记录，只由后台反思写 |
| `conversations/<会话区>/context.jsonl` | 会话事件冷存储 |
| `conversations/<会话区>/log.jsonl` | 原始运行日志 |
| `conversations/<会话区>/log.jsonl.1` | 原始运行日志的轮转备份，存在时可被 `session_search` 检索 |
| `memory-review.jsonl` | 反思/工具写回的动作、suggestion、skipped 决策的审计文件 |
| `subagent-runs.jsonl` | 子代理运行摘要 |
| `subagent-artifacts/<runId>/` | 委派完整产出；外部 run 还含 prompt、协议事件与 stderr |

记忆分层（spec 050）：

- `memory/*.md` + 生成的 `MEMORY.md`：工位的 durable facts、决策、偏好、约束，同一工位的所有频道共享。索引会话首轮整份注入，元数据内联在各自的 frontmatter 里，没有独立的 sidecar metadata 文件。
- `journal/YYYY-MM-DD.md`：按天的工作记录，只由后台反思写；只有未来仍有用的事实会从 journal 提炼进 memory，一次性进度不会。
- 各会话区的 `context.jsonl` / `log.jsonl` / `log.jsonl.1`：冷存储，只通过 `session_search` 显式检索（覆盖本工位的所有会话区），不进入首轮注入。
- `${PIPICLAW_HOME}/state/memory/<name>/<会话区>.json`：内置 scheduler 的 hidden state，只记录 dirty、上次运行时间和 backoff，不是记忆来源。
- `${PIPICLAW_HOME}/state/subagent-runs/<name>/<runId>.json`：委派权威状态、pid、argv 和结算/唤醒幂等标记，记录里的 `channelId` 是发起委派的频道；工位内的 `subagent-runs.jsonl` 只是摘要。启动时按 `state/subagent-runs/` 下的每个工位目录恢复，与绑定无关。
- `${PIPICLAW_HOME}/state/dingtalk/conversations.json`：各频道的钉钉路由元数据（会话 id、私聊/群、发送者），用于重启后主动推送。

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

当前不要依赖。Pipiclaw 目前只使用 `~/.pipiclaw/settings.json`。

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

## OpenAI OAuth 安装身份

`<PIPICLAW_HOME>/state/auth/identity.json` 的格式为
`{"version":1,"installationId":"UUID v4"}`。仅 OpenAI OAuth 登录首次创建；
SDK 接收同步 `getDeviceId` 和 `agentName: "pipiclaw"`，凭据仍写入应用目录的
`auth.json`。创建用同目录独占临时文件、fsync 和不可覆盖的 hard link 发布；
并发登录使用赢家 UUID。不支持 hard link/目录同步的文件系统会明确失败。
取消若发生在发布之后，身份保留供下次复用，不开始 OAuth 网络流程。

新建目录 `0700`、文件 `0600`；已有身份只校验，不自动 chmod 或重置。
部署时检查既有权限并随完整应用状态备份。同一安装搬迁保留身份；独立新安装
单独生成身份，不把生产 credentials/identity 复制到并行测试实例。该文件无配置开关，
logout 不删除它，UUID 不进入状态报告或日志。

## pi 1.2.0 Azure 字段迁移

仅旧**内置** provider 身份 `azure-openai-responses` 改为 `azure`：

| 位置 | 迁移 |
|---|---|
| `auth.json` provider key | 把原内置 credential 移到 `azure`；已有 `azure` 时人工判断，不能覆盖 |
| `models.json.providers` key | 先确认内置/自定义语义，按需改成 `azure` |
| `settings.json.defaultProvider` | 原内置身份改为 `azure`，`defaultModel` 不变 |
| `settings.json.fallbackModel`、`subAgentModel` | 只改 `provider/model` 中的 provider 部分，保留具体 model id |
| `workspace/sub-agents/` model 引用 | 检查角色默认、覆盖及备用选择，按原内置语义迁移 |
| 历史 session `model_change` | 原样保留，以当前显式设置恢复目标模型，并核对实际 provider/model |

API 标识 `azure-openai-responses` 和 `AZURE_OPENAI_*` 环境变量保持原名。
同名自定义 provider 不自动改名；新旧 key 冲突须由部署者核对后处理。
无 Azure 配置无需迁移，不提供永久运行时别名。离线样本证明旧 metadata 与显式
新 provider 配置可共存，真实 Azure endpoint/认证须由使用 Azure 的部署验收。
