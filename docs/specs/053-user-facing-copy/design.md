# 对外文案：按受众分渠道、统一术语、错误必带下一步

| 字段 | 值 |
|------|------|
| 状态 | 已实施（2026-10-12）；实施偏差见文末"实施记录" |
| 日期 | 2026-10-12 |
| 触发 | 用户要求检查所有对外文案（钉钉回复、命令帮助、标准输出、日志），理解场景后给出优化方案 |
| 前置 | 2026-08-24 命令子系统评审（AGENTS.md「Command Reply Conventions」六条约定）、045 工具进度标签运行时化、047 可恢复拒绝不上屏 |
| 扩展 | AGENTS.md 六条约定的适用范围：从"斜杠命令回复"扩展到"所有对外文案" |
| 关联实现 | `src/commands/**`、`src/runtime/{bootstrap,dingtalk,delivery,*-commands,task-driver,task-spawn,app-home}.ts`、`src/agent/{channel-runner,session-events,command-extension,status-render}.ts`、`src/agent/prompt/manifest.ts`、`src/memory/commands.ts`、`src/events/event-commands.ts`、`src/tasks/{log,board}.ts`、`src/security/{block-message,path-guard-check}.ts`、`src/tools/bash.ts`、`src/usage/render.ts`、`src/tui/**`、`src/models/auth-cli.ts`、`src/main.ts`、`src/log.ts` |
| 明确不含 | i18n 框架或多语言切换、模型侧提示词（system prompt、playbook、工具 description）的措辞与语言、集中式"文案字典"文件、新的 settings 键、钉死具体文案的测试 |

## 摘要

2026-08-24 那轮评审把**斜杠命令回复**整理成了六条约定（一句确认 / 粗体标题加块 / 原因加下一步；中文叙述、英文标识符；不用 `#`；只有一层平铺列表；有长度预算；空状态一种句式）。命令回复的主体因此是合格的。

这一次逐个检查所有对外文案的出处后发现，剩下的问题不在措辞，而在三个结构性缺口：

1. **受众混淆。**同一段文本既写给模型又发给人：任务循环日志、团队看板、工具错误、后台唤醒文本，原样进入了用户的聊天。用户因此看到英文提示词、工具名、`<available_skills>` 这样的内部标签，以及 `op=follow_up` 这样的调用语法。
2. **约定只管到命令回复。**运行时主动推送、AI 卡片进度流、错误气泡、TUI、CLI 和日志都没有约定，各自形成了风格：中英混杂、错误没有下一步、长度不受控。
3. **术语与单一来源漂移。**设计文档里的词（等待票、兜底、契约、结算、墓碑化）直接成了界面用语；同一个概念有两种叫法（试用期 / 观察期）；"步"和"日志"各有多个含义；忙碌提示、任务状态标签、`/new` 回复在多处手抄，已经不一致。

本 spec 的方案：

| 决策 | 内容 |
|---|---|
| D1 | 三类受众，各自的语言政策：用户（中文）、部署者与运维（英文）、模型（不在本 spec 范围） |
| D2 | 受众隔离：给模型的文本不进入用户渠道；双受众的数据用两个渲染器 |
| D3 | 用户文案里不出现工具名、内部标签和调用语法 |
| D4 | 界面术语表，作为用户文案的唯一用语来源 |
| D5 | 错误一律"原因 + 用户能执行的下一步"；轮次失败分类；守卫拦截结构化 |
| D6 | 运行时主动推送纳入约定：形态、标记符号、必带标识符 |
| D7 | 进度流与卡片：全中文，"步"不再有歧义 |
| D8 | 单一来源：派生而不是手抄 |
| D9 | 长度预算覆盖所有报告类输出 |
| D10 | TUI 与钉钉共用同一份文案 |
| D11 | CLI：英文，补齐首次运行引导，文档引用改为 URL |
| D12 | 日志：事件名可筛选、频道上下文不丢、措辞一种句式 |
| D13 | 用结构性测试防回归，不钉文案 |

改动几乎全部是渲染层：不改数据格式、不改工具 schema、不改模型侧提示词、不加配置。唯一触及行为的是 D5 的守卫拦截要多携带一份结构化 `details`，以及 D12 修复群聊频道丢失 `channel` 日志字段的缺陷。

---

## 1. 现状与证据

数字与行号来自当前代码（master `1e817d8`）。

### 1.1 文案面与受众

| 文案面 | 受众 | 出处 | 现状 |
|---|---|---|---|
| 斜杠命令回复 | 钉钉 / TUI 用户 | `commands/catalog.ts`、`runtime/*-commands.ts`、`memory/commands.ts`、`agent/command-extension.ts`、`agent/status-render.ts`、`usage/render.ts` | 有六条约定，大体合规；`/context` 例外 |
| 运行时主动推送 | 钉钉用户 | `runtime/bootstrap.ts`、`runtime/dingtalk.ts`、`runtime/task-driver.ts`、`runtime/task-spawn.ts`、`runtime/subagent-commands.ts`（`renderRunNotice`） | 无约定 |
| 卡片进度流 | 钉钉用户 | `agent/session-events.ts`、`tools/presentation.ts`、`runtime/delivery.ts` | 工具标签已中文化（spec 045）；其余中英混杂 |
| 轮次级通知 | 钉钉用户 | `agent/channel-runner.ts` | 错误不分类、没有下一步；工具名外泄 |
| TUI | 终端用户 | `tui/**` | 中英混杂 |
| CLI | 部署者 | `main.ts`、`runtime/app-home.ts`、`tui/cli.ts`、`models/auth-cli.ts` | 全英文；首次运行引导不足 |
| 运行日志 | 运维 | `log.ts` 及 285 个调用点 | 两套写法并存 |

### 1.2 受众混淆（F1）

**F1.1 后台唤醒投递失败的通知会泄露提示词。**`bootstrap.ts:968-973` 把 `record.event.text` 截取 300 字发给用户，发送者显示为 `record.event.user`。对任务驱动来说，这段文本是 `task-driver.ts:99` 构造的英文提示词（`[TASK_DRIVER:x] Resume task x. Task capsule: title=…; state=open; … End the step with task_step_end (continue / park / done).`），发送者是 `TASK_DRIVER`。

**F1.2 `/tasks show` 复用了 step brief 的渲染器。**`tasks/log.ts:243` 的 `renderTaskLogLine` 和 `tasks/board.ts:121` 的 `renderTaskBoard` 注释写明服务于"the step brief and `/tasks show`"，所以用户看到：

- `- [2026-10-11 14:02] step 3 → continue: …`：`step`、`continue` 是 `task_step_end` 的参数值；
- `- [x] w2 … — …` 之后的 `    ↳ …`：4 空格缩进的续行，违反第 4 条约定（钉钉 Markdown 不保留缩进）；
- `（另有 3 项已结算且已看过，见 task_log）`：`task_log` 是模型的工具名；
- `结算 run_a1: completed VERDICT PASS exit 0`：字段堆叠，没有句子。

**F1.3 工具错误原样进卡片。**`session-events.ts:181-182` 把非可恢复的工具错误截取 200 字、压成一行放进卡片。按 AGENTS.md 的规则，只有"用户必须行动或知情"的错误才会走到这里，典型就是守卫拦截，可这段文本是写给模型的：

```
✕ Path blocked [outside_project] Reason: … Resolved path: /x/y
✕ Command blocked [dangerous] … If this operation is genuinely needed, explain the intent to the user so they can adjust security.json.
```

前者没有告诉用户该做什么；后者末句是在指挥模型，用户读来莫名其妙。

**F1.4 事件校验错误同时给两个受众。**`events/event-validation.ts:48-74` 的英文错误（`one-shot 'at' must be at least 2 minutes in the future (self-triggering guard).`）既作为 `event_manage` 的可恢复错误给模型看，又由 `/events list` 以 `⚠ 无效：…` 原样展示给用户（`event-commands.ts:117`）。

### 1.3 工具名与内部标签外泄（F2）

用户能做的只有两件事：发消息让助手做，或发斜杠命令。下列文案让用户去用他没有的东西：

| 出处 | 文案 |
|---|---|
| `channel-runner.ts:415`、`:1111`、`:1122` | "可以让我 **read** 该文件" |
| `skill-commands.ts:81` | "用 **read 工具**打开 … 继续查看" |
| `skill-commands.ts:49` | "用 **write/edit** 在 `workspace/skills/<name>/SKILL.md` 直接创建" |
| `skill-commands.ts:63` | "不在 **`<available_skills>`** 中" |
| `task-commands.ts:144` | "让 Agent 用 **task_create** 建立一个长程任务" |
| `subagent-commands.ts:243` | "（可用于 **subagent_run op=follow_up**）" |
| `task-driver.ts:129` | "不再需要：让 Agent **cancel** 该任务" |
| `board.ts:133` | "见 **task_log**" |
| `channel-runner.ts:968` | `/help` 里的 "**Prompt templates**" 小节标题 |

### 1.4 语言不一致（F3）

- **`/context` 整份英文**（`prompt/manifest.ts:158` 起）：`# Context Report` 标题、`units`、`truncated`、`Run /context detail for …`；`detail` 会列出全部工具名和 skill 名，没有长度预算。一个命令同时违反第 2、3、5 条约定。
- **进度流**：`Compacting context...`（`session-events.ts:314`）、`Retrying (1/3)...`（`:363`）、`Compaction failed`（`:344`），以及压缩失败时 SDK 的原始错误。
- **字段名用英文**：`/session` 的 Session ID / Thinking level / Tokens / Cost（`command-extension.ts:43-52`）；`/memory show` 的 type / source / created / updated / expires（`memory/commands.ts:94-98`）；`/project` 的 Enforcement、unbounded（`project-commands.ts:69-71`）；`/subagents show` 的 `usage：input=… output=…`、`purpose：`、`parserVersion=`（`subagent-commands.ts:220-238`）。第 2 条约定允许"字段名"保留英文，指的是用户会在命令或文件里输入的标识符（如 `wake`、`status`），而不是报告里的展示标签。
- **TUI 在同一屏里中英混用**：`当前没有运行中的回合。`（`turn-controller.ts:124`）与 `Queued as steer.`（`:162`）、`Queued as follow-up.`（`:174`）、`Run failed: …`（`:194`）、`Press Ctrl-C again to exit.`（`:259`）并存；`/steer requires a message.`（`tui/commands.ts:76`），而钉钉侧同一提示是 `无法排队：/steer 需要带上消息内容。`（`bootstrap.ts:566`）；状态栏有 `idle`、`ready`、`running` 三个词，其中 `idle` 和 `ready` 指同一状态（`turn-controller.ts:294-297`）；`/exit` 的描述是 `Leave the TUI`（`tui/commands.ts:95`）。
- **帮助示例是英文句子**：`/steer Use the Shanghai time zone and summarize only the latest updates`、`/followup After that, draft a short executive summary`、`/compact Keep the latest TODOs and decisions`（`catalog.ts`），而周围界面是中文。

### 1.5 术语外泄与不统一（F4）

**设计词成了界面词。**下列词在 spec 和架构文档里有精确含义，但用户没读过 spec：

| 词 | 出现位置（举例） |
|---|---|
| 等待票 | `catalog.ts:153/173`、`task-commands.ts:217`、`log.ts:252` |
| 兜底 | `task-commands.ts:127/167/306`、`task-driver.ts:287` |
| 契约 | `task-commands.ts:183`（`/tasks show` 小节标题） |
| 派发 / 结算 | `log.ts:248-250`、`catalog.ts:161` |
| 团队看板 | `task-commands.ts:174` |
| 游标 | `memory/commands.ts:63` |
| 墓碑化 | `catalog.ts`（`/memory forget` 描述）、`memory/commands.ts:118` |
| 准入、可选根、app 默认值 | `project-commands.ts:64/80/107` |

**同一概念两个名字。**`/memory status` 说"试用期条目"（`memory/commands.ts:61`），`/memory list` 说"观察期至"（`:79`）。

**过时概念。**v5 任务没有"阶段"，但 `catalog.ts:153/173`、`task-commands.ts:217` 仍写"保留阶段与等待票"；任务停止回执写 `当前阶段：${entry.fields.state}`（`task-driver.ts:128`），直接打印 `open` / `parked`。

**一词多义。**

- "步"：卡片页脚 `完成 · 12 步`、滚动头 `⏱ 1m02s · 12 步`（`delivery.ts:456/489`）数的是工具调用次数；`/tasks` 的 `3 步`、预算 `已用满 20 步` 数的是任务步数。同一屏可能同时出现两者。
- "日志"：`/memory journal` 叫"日志"（`catalog.ts`、`memory/commands.ts:130`）；`/tasks log` 叫"日志"/"循环日志"；运行日志也叫日志。
- "task"（日志里）：关机日志 `Waiting for N active task(s) to finish`（`bootstrap.ts:1123`）的 task 指回合，和长程任务撞名。

**按架构分组的帮助。**`/help` 把命令分成"传输层命令 / 会话层命令"（`catalog.ts:455/461`）。用户关心的是"什么时候能用"，而且分组说明本身不准确：会话层写"需要在空闲时使用"，但 `/new` 是 `availableWhileBusy: true`。

**措辞与标点。**`找不到事件`（`event-commands.ts:129`）对比 `未找到任务`；`未知的 /tasks 动作` / `未知的 /subagents 子命令` / `未知的 memory 命令` 三种写法；同一列表里半角 `(running, 持有写锁)` 与全角 `（失败原因：…）` 混用（`subagent-commands.ts:97-99`）；`/new` 的回复在 `bootstrap.ts:472` 写 `Session ID: `，在 `command-extension.ts:218/226` 写 `Session ID：`。

### 1.6 错误没有下一步（F5）

| 场景 | 出处 | 现状 |
|---|---|---|
| 轮次失败 | `channel-runner.ts:665` | `_抱歉，出错了。_` 加上原始 provider 错误。401、429、上下文溢出、网络超时、5xx 一律如此，不提示 `/model`、`/compact`、`/new` 或去服务器重新登录 |
| 委派失败通知 | `subagent-commands.ts:424` | `⚠️ builder 失败 · 3m12s`，不带 runId，用户无法接着 `/subagents show` |
| 后台唤醒投递失败 | `bootstrap.ts:972` | 路径 `state/dispatch/x.json` 没说相对哪个目录；没有下一步 |
| 排队失败 | `bootstrap.ts:637` | `无法排队这条消息：${errMsg}`，原始错误 |
| 文档引用 | `auth-cli.ts:236/269`、`task-commands.ts:299` | `docs/configuration.md`、`docs/events-and-tasks.md`：npm 安装的用户本地没有 `docs/` |
| 首次运行 | `bootstrap.ts:1236-1241`、`app-home.ts:385` | 只说 `Fill in channel.json and run pipiclaw again.`，不说哪些字段必填、去哪里拿，也不提模型凭据（`pipiclaw auth login`）；退出码 1，像是出错了 |

### 1.7 单一来源漂移（F6）

`catalog.ts` 的头注释承诺"`HELP_TEXT`、TUI 补全、忙碌提示、已知命令集合都从这些表派生，不要并行手写"。实际上：

- **忙碌提示手抄了两份**（`dingtalk.ts:1658`、`tui/turn-controller.ts:147`），手列 `/model`、`/compact`、`/session` 为"需要空闲"，漏了 `/memory`、`/thinking`。
- **任务状态标签有三套**：`task-commands.ts:114` 与 `task-spawn.ts:17` 各写一份 `STATE_LABEL`（后者缺 `done`），`task-driver.ts:128` 不用任何一份。
- **`/new` 的确认语手抄两处**，标点已经分叉（见 F4）。

### 1.8 长度预算覆盖不全（F7）

`capReply` 只在 `memory/commands.ts`、`events/event-commands.ts`、`runtime/skill-commands.ts` 三个文件里使用。未受控的报告：

| 报告 | 最坏情况 |
|---|---|
| `/tasks show` | 头部 + 看板 + 8 条日志 + 契约正文（单此一项上限 2,400 字） |
| `/tasks log` | 30 行 |
| `/subagents show` | 完整 argv JSON + stderr 尾部 |
| `/context detail` | 全部工具名、skill 名、每段来源与 hash |
| `/compact` | 把整段压缩摘要原样贴进代码块（同时违反第 4 条"不原样粘贴长文"） |
| `/help` | 顶层约 25 行，含一段面向管理员的 `channel.json` 配置说明 |

### 1.9 日志（F8）

- **事件名无法筛选。**248 处 `logInfo` / `logWarning` 的事件名全是 `system.info` / `system.warning`；结构化的 `logEvent` 只有 37 处。JSONL 里按事件过滤基本不可用。
- **群聊频道丢失 `channel` 字段（缺陷）。**`log.ts:254` 用 `/^\[([A-Za-z0-9._-]+)\]\s*/` 从消息前缀解析 channelId。群聊 channelId 是 `group_${conversationId}`，钉钉 conversationId 是 base64 形式，含 `=`、`+`、`/`（`task-driver.ts` 的注释也记录了这一点），匹配失败。结果是群聊频道的日志没有 `channel` 字段，`[group_cid…==]` 前缀残留在 message 里。
- **措辞三种句式**：`Failed to X` / `X failed` / `Could not X`；前缀三种：`DingTalk: …`、`DingTalk Card: …`、`DingTalk media upload error`。
- **缺上下文**：`Silent response - ended progress delivery`、`Failed to post error message` 不带频道。
- **级别失当**：`Task driver enqueued x` 每步一条 info。
- **死代码**：`logUsageSummary`（`log.ts:278`）拼了一段英文 Markdown 作为返回值，唯一调用点（`channel-runner.ts:714`）丢弃了它。

---

## 2. 原则

**P1 先认受众，再写文字。**每一段对外文本只有一个受众。数据可以共享，渲染不共享。

**P2 用户只有两种手段。**发消息让助手做，或发斜杠命令。用户文案里的每个"下一步"都必须落在这两种手段之一，或落在部署者能做的服务器操作上（并且说明是在服务器上做）。

**P3 界面用语来自术语表，不来自设计文档。**设计词可以精确，界面词必须不需要解释。两者的对照写在用户手册里，而不是让用户反推。

**P4 约定是给所有渠道的。**六条约定原本针对命令回复，它们背后的理由（钉钉 Markdown 子集、手机阅读、错误要可执行）同样适用于推送、进度流和 TUI。

**P5 派生优于手抄。**能从目录、类型或枚举派生的文案，不允许写第二份。

**P6 不钉文案。**防回归靠结构性约束（长度、形态、不出现内部标记、派生集合相等），不靠断言具体字符串（AGENTS.md「Test Layering」第 2 条）。

---

## 3. 设计决策

### D1 三类受众与语言政策

| 受众 | 渠道 | 语言 | 理由 |
|---|---|---|---|
| 用户 | 钉钉消息与卡片、TUI 交互界面 | 中文叙述；只保留**用户会输入或会在文件里看到的标识符**为英文：命令名、子命令、id、model ref、文件路径、frontmatter 键 | README 中文优先，用户在钉钉里工作 |
| 部署者与运维 | CLI 的 stdout/stderr、运行日志（控制台与 JSONL） | 英文 | 终端与日志生态惯例；便于 grep 和贴进 issue；与依赖库的输出一致 |
| 模型 | 提示词、工具 `content`、step brief、唤醒文本 | 不在本 spec 范围 | 由 spec 025/026 等提示词设计管辖 |

这是**明确的选择**，写进 AGENTS.md，免得后来者把 CLI 当成"忘了翻译"。

TUI 的 `--help` 属于 CLI（部署者在 shell 里看），保持英文；TUI 进入交互界面以后属于用户渠道，用中文。

"展示标签"与"标识符"的区分：`- 状态：等待中` 里"状态"是展示标签，必须中文；`/memory show` 里展示的 frontmatter 键（`type`、`expires`）是用户打开文件时会看到的标识符，可以保留，但要用中文标签引出，例如 `- 类型（type）：feedback`。

### D2 受众隔离

规则：**模型受众的文本不得进入用户渠道。**数据被两个受众共用时，各写一个渲染器，放在同一文件里，共享数据结构，不共享输出。

具体落点：

| 数据 | 模型侧渲染（保持） | 新增用户侧渲染 |
|---|---|---|
| 任务循环日志 | `renderTaskLogLine`（step brief） | `renderTaskLogLineForUser`：中文动作词、无参数值、无工具名 |
| 团队看板 | `renderTaskBoard`（step brief） | `renderTaskBoardForUser`：平铺、无缩进续行，多个关联委派合并为一行 |
| 后台唤醒（投递失败） | 原始 `event.text`（留在记录文件里） | 按 `parseDriverTaskId` 等识别来源，渲染为"任务 `x` 的后台唤醒""委派 `run_a1` 的完成通知"；不知道来源时只说"一次后台唤醒" |
| 守卫拦截 | `formatBlockMessage` 的英文多行文本（模型据此调整或向用户解释） | 见 D5：由结构化 `details` 渲染 |
| 事件校验错误 | `EventValidationError` 英文消息（工具可恢复错误） | `/events list` 展示时用错误种类映射为中文短句；未识别的种类只说"定义无效，用 `/events show <name>` 查看"，不贴原文 |

`/tasks show` 不再展示 step brief 视角的"已看过 / 未看过"区分（那是给模型去重用的）。

### D3 用户文案不出现工具名、内部标签和调用语法

禁止出现在用户文案里的：

- 工具名：`read`、`write`、`edit`、`task_create`、`task_log`、`subagent_run` 等；
- 提示词标签：`<available_skills>`、`<memory_bootstrap>` 等；
- 调用语法：`op=…`、`action: …`；
- 运行时内部身份：`TASK_DRIVER`、`[REDELIVERY:n]`。

替换规则（P2）：

| 现在 | 改为 |
|---|---|
| 可以让我 read 该文件 | 需要时让我读取这个文件 |
| 用 read 工具打开 X 继续查看 | 完整内容在 `X` |
| 用 write/edit 在 … 直接创建 | 让我帮你创建，或手动放到 `workspace/skills/<name>/SKILL.md` |
| 不在 `<available_skills>` 中 | 未加载，无法用 `/skill:名称` 调用 |
| 让 Agent 用 task_create 建立 | 在对话里告诉我目标，并说明作为长程任务推进 |
| 可用于 subagent_run op=follow_up | 可以让我在这个会话上继续追问 |
| 让 Agent cancel 该任务 | 不再需要：直接告诉我取消该任务 |

### D4 界面术语表

这张表是用户文案的唯一用语来源。设计文档、架构文档、spec 和模型侧文本保留原有设计词，不受影响。

| 概念 | 设计词（保留在 spec / 架构 / 提示词） | 界面用语 | 示例 |
|---|---|---|---|
| turn | 回合 | 回合（不变；在 `/help` 首段解释一次："助手处理一条消息的完整过程"） | 当前已有回合在运行 |
| ticket | 等待票 | 等待条件 | `- 等待：委派 run_a1 完成` |
| ticket `by` | 兜底时限 | 最晚检查时间 | `（最晚 3 小时后重新检查）` |
| contract | 契约 | 任务说明 | `/tasks show` 小节标题"任务说明" |
| dispatch / settle | 派发 / 结算 | 开始 / 结束 | `14:02 开始委派 run_a1（builder）` |
| team board | 团队看板 | 工作项 | `/tasks show` 小节标题"工作项" |
| task loop log | 循环日志 | 任务记录 | `/tasks log` 标题"任务 x 的记录" |
| task `state` | open / parked / done | 进行中 / 等待中 / 已结束 | 只从统一的标签表取（D8） |
| task step | 步 | 步（仅指任务步） | `已用 12 步` |
| tool call count | 步（卡片） | 工具调用 | `完成 · 工具调用 12 次 · 1分02秒` |
| memory probation | 试用期 / 观察期 | 观察期 | `（观察期至 2026-11-01）` |
| memory tombstone | 墓碑化 | 已记入忽略名单 | 后台整理不会再自动写回 |
| reflect cursor | 游标 | （不展示） | 从 `/memory status` 移除 |
| journal | 日志 | 工作日记 | `/memory journal` 描述"查看某天的工作日记" |
| project allowed roots | 可选根 | 允许的根目录（spec 058 删除了项目边界，此行仅存档） | |
| sandbox level | Enforcement | 隔离级别 | |
| delegation run | 委派 run | 委派（以 `run_…` 指代具体一次） | `委派 run_a1 失败` |
| transport / session commands | 传输层 / 会话层 | 随时可用 / 空闲时可用 | `/help` 分组 |
| phase | 阶段 | （删除；v5 无此概念） | |
| dot | dot | dot（不翻译；首次出现时解释为"一个独立的助手，拥有自己的记忆、任务和文件"）（spec 058 追加） | `本频道已绑定到 dot \`news\`。` |
| binding | 绑定 | 绑定 / 换绑（spec 058 追加） | `/dot bind <名字>`；`本频道还没有绑定 dot。` |
| delivery channel | 投递频道 | 投递频道（spec 058 追加） | `已暂停：投递频道未绑定到本 dot` |
| dormant dot | 休眠 | 后台工作已暂停（spec 058 追加） | `/dot` 列表 `未绑定频道，后台工作已暂停` |

统一句式：

| 场景 | 句式 |
|---|---|
| 找不到对象 | `未找到 X \`id\`。用 \`/… list\` 查看。` |
| 未知子命令 | `未知子命令 \`x\`。` + 用法（仅在参数错误时附用法，第 1 条约定） |
| 缺少参数 | `缺少 X。` + 用法 |
| 时长 | 中文单位：`12 分钟`、`3 小时`、`2 天`、`1分02秒`；只有卡片滚动头允许紧凑写法 `1:02` |
| 标点 | 中文叙述用全角括号、冒号、逗号；代码、路径、id 内部保持原样 |

用户手册（`docs/interaction-and-commands.md`）增加一节"界面用语对照"，把界面用语映射回设计词，让读过设计文档的人能对上号。

### D5 错误：原因 + 用户能执行的下一步

**D5.1 轮次失败分类。**`channel-runner.ts` 的错误气泡改成先分类，再给下一步；原始错误降为一行引用，供排查。分类只看错误文本和 HTTP 状态这类稳定特征，不认识的归入"其他"。

| 类别 | 判定特征（示意） | 用户看到 |
|---|---|---|
| 鉴权 | 401、403、`invalid api key`、`unauthorized` | 模型凭据无效或已过期。请部署者在服务器上执行 `pipiclaw auth login`，或用 `/model` 换一个模型 |
| 限流 / 额度 | 429、`rate limit`、`quota`、`insufficient` | 模型暂时限流或额度不足。稍后重发，或用 `/model` 换一个模型 |
| 上下文溢出 | `context length`、`too many tokens`、`prompt is too long` | 会话上下文已满。用 `/compact` 压缩，或 `/new` 开新会话 |
| 网络 | `ETIMEDOUT`、`ECONNRESET`、`fetch failed`、5xx | 连不上模型服务。稍后重发；持续出现请检查服务器网络或代理 |
| 其他 | — | 处理失败。可以重发一次；持续出现请用 `/status` 查看模型状态 |

形态：

```
处理失败：模型暂时限流或额度不足。
稍后重发，或用 `/model` 换一个模型。
已切换备用模型 `x` 重试，仍失败。          ← 仅在发生过回退时
原始错误：`429 rate_limit_error: …`（截取 240 字）
```

分类函数是一个纯函数，有分支，值得单测（输入错误文本，断言类别，不断言文案）。

**D5.2 守卫拦截结构化。**路径守卫和命令守卫目前抛出普通 `Error`，消息是英文多行文本。改为：

- 保留给模型的英文消息不变（它承担"向用户解释意图"的引导）；
- 同时在工具结果 `details` 上携带结构化信息：`{ blocked: { guard: "path" | "command" | "network", category, target } }`；
- `session-events.ts` 遇到带 `blocked` 的错误时，用它渲染用户侧的一行，不再截取模型文本：

```
✕ 已拦截：写入项目目录以外的路径 `/x/y`（如需放行，由部署者调整 security.json）
✕ 已拦截：命令 `rm -rf …` 属于高危操作（如需放行，由部署者调整 security.json）
```

其余普通错误只取第一行，截取 120 字；完整内容已在日志里（`agent.tool.failed`）。

**D5.3 推送里的错误同样要有下一步**，见 D6。

**D5.4 文档引用一律用 URL。**用户和部署者看到的文档引用改为 GitHub 链接（如 `https://github.com/oyasmi/pipiclaw/blob/main/docs/configuration.md`）。链接常量集中在 `src/paths.ts` 附近的一处（只有一个 base URL 常量加相对路径），不散落。

### D6 运行时主动推送纳入约定

主动推送指不是用户命令直接引起的消息：任务回执、委派通知、投递失败、卡住回合被强制结束、消息积压、图片处理结果、模型回退。

规则：

1. **形态**同命令回复：确认（一句）、报告（粗体标题 + 块）或错误（原因 + 下一步）。
2. **必带标识符。**涉及任务就带任务 id，涉及委派就带 runId，用户能拿着它接着发命令。
3. **标记符号只用四个**，含义固定：

   | 符号 | 含义 |
   |---|---|
   | ✅ | 完成 |
   | ⚠️ | 需要你注意或处理 |
   | 🛑 | 已停止 / 已取消 |
   | ⏳ | 进行中 |

   不再使用 `⚠`（无变体选择符）、`✕` 以外的其他错误符号（`✕` 保留给卡片进度流的错误行）。
4. **一条推送只说一件事**，下一步不超过两条。

示例（改后）：

```
⚠️ 委派 run_a1（builder）失败 · 3分12秒
用 `/subagents show run_a1` 查看原因。
```

```
🛑 任务 weekly-report（周报）已停止自动执行：已用满 20 步。
状态：进行中 · 已用 20 步
查看：`/tasks show weekly-report`　继续并追加预算：`/tasks resume weekly-report +steps 10`
不再需要：直接告诉我取消该任务。
```

```
⚠️ 任务 weekly-report 的一次后台唤醒连续 5 次未送达，已停止重试。
用 `/tasks show weekly-report` 确认任务状态；排查记录在 `~/.pipiclaw/state/dispatch/<id>.json`。
```

路径用绝对路径（由 `APP_HOME_DIR` 渲染），不用相对路径。

### D7 进度流与卡片

- 进度流全中文：`正在压缩上下文…`、`模型请求失败，正在重试（1/3）…`、`上下文压缩失败：<分类后的一句>`。
- 卡片页脚与滚动头的计数改称"工具调用"：`完成 · 工具调用 12 次 · 1分02秒`；滚动头为了窄屏保留紧凑写法 `⏱ 1:02 · 工具 12`。
- 收尾语统一：正常结束 `已答复。`，静默结束 `已处理，无需答复。`，中止 `已停止。`。现在的 `答复已发送。` / `处理已结束。` 在不同路径各用一套，改为按结局取。
- `已沉淀：workspace skill 已更新，下一轮生效。` 改为 `已更新 workspace skill，下一条消息起生效。`（"沉淀"是内部说法；"下一轮"含义模糊）。

### D8 单一来源

| 文案 | 唯一来源 | 使用者 |
|---|---|---|
| 忙碌提示（运行中可用 / 需空闲） | `catalog.ts` 新增 `formatBusyHint()`，由 `availableWhileBusy` 派生两份列表 | `dingtalk.ts`、`tui/turn-controller.ts` |
| `/help` 分组 | 同上，按 `availableWhileBusy` 分"随时可用 / 空闲时可用"，不再按处理层分 | `renderHelpText` |
| 任务状态标签 | `src/tasks/` 内导出一个 `taskStateLabel(state)` | `task-commands.ts`、`task-spawn.ts`、`task-driver.ts` |
| `/new` 确认语 | 一个导出函数 | `bootstrap.ts`、`command-extension.ts` |
| 时长格式化 | 一个中文时长格式化函数（替换 `relative()`、`formatUptime()`、`formatElapsed()`、`formatRunDuration()` 中面向用户的部分） | 各报告与推送 |
| 文档 URL | D5.4 的常量 | CLI、`/tasks doctor` |

不引入集中式"文案字典"文件：文案仍由拥有对应状态的层持有（与 `catalog.ts` 只共享目录、不共享 handler 的原则一致），只把**被多处使用**的片段收成函数。

### D9 长度预算覆盖所有报告

所有报告类输出最终都经过 `capReply`，默认上限 1,500 字，超出时给出下一步。

| 报告 | 做法 |
|---|---|
| `/tasks show` | 头部 + 工作项 + 最近 5 条记录 + 任务说明前若干行；超出时提示 `/tasks log <id>` 与任务文件路径 |
| `/tasks log` | 最近 15 条；超出时提示文件路径 |
| `/subagents show` | argv 只显示前 200 字；stderr 尾部限 10 行；超出提示 `/subagents output <runId>` 与产物目录 |
| `/context` | 中文化，去掉 `#` 标题；默认视图只有汇总；`detail` 经过 `capReply` |
| `/compact` | 只回压缩前后 token 数和摘要首行，不贴全文 |
| `/help` | 顶层只列命令；`channel.json` 的 `busyMessageDefault` / `responseMode` 说明移到 `/help steer` 的详情里（它们解释的是忙碌时普通消息的去向） |

### D10 TUI 与钉钉共用文案

- TUI 的排队确认、"没有运行中的回合"、缺参数提示、失败提示直接复用钉钉侧同一函数的输出；
- 状态栏统一为 `空闲` / `运行中`，上下文占用写 `上下文 42%`；
- `/exit` 描述改为中文；开屏提示改为 `输入消息开始；/help 查看命令。`；
- 退出相关的终端提示（`Press Ctrl-C again to exit.`、`Saving session memory…`）属于交互界面，同样改为中文。

### D11 CLI

保持英文（D1），补三件事：

1. **首次运行引导。**生成模板后输出：

   ```
   Initialized pipiclaw under /home/u/.pipiclaw:
     - channel.json
     - …

   Next steps:
     1. Edit /home/u/.pipiclaw/channel.json — required: clientId, clientSecret
        (DingTalk Open Platform → your app → Credentials). Optional: cardTemplateId for AI Card streaming.
     2. Configure a model: run `pipiclaw auth login`, or add a provider to models.json.
     3. Run `pipiclaw` again.
   Docs: https://github.com/oyasmi/pipiclaw/blob/main/docs/configuration.md
   ```

   "刚生成模板"不是错误，退出码改为 0；配置校验失败仍为 1。
2. **文档引用改 URL**（D5.4）。
3. **`tui --help` 去掉语义重叠。**`--quiet` 现在写 `Plain mode: print only the final answer`，`--plain` 写 `Force the plain frontend`，读者分不清。改为：`--plain` 只决定前端（不用全屏界面），`--quiet` 只决定输出量（只输出最终答复，隐含 `--plain`）。

`main.ts` 的未知子命令错误、`auth` 的提示措辞保持现状，只统一成 `Run \`pipiclaw … --help\` for usage.` 一种收尾。

### D12 日志

1. **修复群聊频道上下文丢失。**`legacyContext` 的正则改为匹配 `[` 到 `]` 之间的任意非空白字符（`/^\[([^\]\s]+)\]\s*/`）。这是缺陷修复，配一条回归测试：给定 `[group_cid+a/b==] msg`，断言解析出的 `channelId` 与剩余 message。
2. **高频与关键调用点迁到 `logEvent`，给出可筛选的事件名。**不追求一次迁完 248 处；优先迁移 warn 级别、DingTalk 连接与投递、任务驱动、委派结算、关机流程。事件名按 `<domain>.<object>.<verb>`，与现有 `agent.turn.started` 一致，例如 `dingtalk.reconnect.failed`、`taskdriver.step.enqueued`、`dispatch.exhausted`、`runtime.shutdown.waiting`。
3. **措辞一种句式。**message 用 `<Subject> <verb-ed>` 或 `<Subject> failed`，原因放 `details` / `fields.reason`，不拼进 message。前缀统一用事件名表达，不在 message 里写 `DingTalk:`。
4. **级别。**每步都会出现的成功事件（`Task driver enqueued`）降到 debug。
5. **术语。**日志里的 task 只指长程任务；回合写 turn（`Waiting for N active turn(s)`）。
6. **删除** `logUsageSummary` 中被丢弃的 Markdown 拼接，只保留结构化事件。

### D13 防回归

按 P6，只写结构性测试：

| 约束 | 测试方式 | 失败意味着 |
|---|---|---|
| 报告不超预算 | 用大数据量样例（50 个任务、200 条 run、超长契约）调用每个报告 handler，断言长度 ≤ 1,500 + 截断提示，且截断时包含 `/` 开头的下一步命令 | 新报告或新字段绕过了 `capReply` |
| 用户文案形态 | 对所有报告 handler 和推送渲染函数的输出，断言不含：以两个以上空格开头的行、`#` 开头的行、`<[a-z_]+>` 标签、`op=`、`TASK_DRIVER` | 违反第 3、4 条约定或 D3 |
| 忙碌提示派生 | 断言忙碌提示中出现的命令集合等于目录里按 `availableWhileBusy` 派生的集合 | 有人又手抄了一份 |
| 错误分类 | 表驱动：错误文本 → 类别 | 分类分支回归 |
| 群聊日志上下文 | D12.1 的回归用例 | 正则回退 |
| 用户侧任务渲染 | 断言 `renderTaskBoardForUser` 输出无缩进续行、多关联委派合并为一行 | 双渲染器被合并回去 |

这些测试只会在约定真正被违反时变红，改措辞不会触发。

---

## 4. 取舍与不做的事

- **不做 i18n。**产品是中文优先的个人 / 团队工具，没有第二语言用户群；引入消息目录会把每处文案变成间接引用，可读性下降，收益为零。D1 的"用户中文、运维英文"是固定分工，不是可配置项。
- **不改模型侧文本。**提示词、playbook、工具 description、工具错误 `content` 的语言与措辞由提示词设计管辖。本 spec 只保证它们不流进用户渠道（D2）。已知的模型侧问题（如 `turn-recovery.ts` 英文开头接中文指引）记为后续，不在此处理。
- **不建集中文案字典。**理由见 D8。
- **术语表不回改设计文档。**spec、`architecture.md`、`runtime-mechanisms.md` 继续用设计词；用户手册通过"界面用语对照"连接两者。
- **CLI 不中文化。**理由见 D1。代价是部署者要读英文 CLI 输出；README 和配置手册已有中文说明可以对照。
- **不追求一次性迁完所有日志调用。**D12 只要求关键路径；其余在后续触及时顺手迁移。

## 5. 影响面

- **用户可见行为**：只有文案变化，加上 D5.2 的拦截提示、D6 的推送多带标识符和下一步、D9 的截断。没有功能增删。
- **模型可见行为**：无变化。守卫拦截给模型的消息不变，只是 `details` 多一个字段（`details` 是运行时渠道，模型不读，AGENTS.md「Engineering Rules」）。
- **部署者可见行为**：首次运行的退出码从 1 变为 0；CLI 文档引用变为 URL；JSONL 日志里群聊频道开始有 `channel` 字段，部分事件名从 `system.*` 变为具体名称（依赖 `system.info` 做筛选的外部脚本需要调整，在 release notes 里说明）。
- **测试**：现有测试中若有断言具体文案的，按 AGENTS.md 规则本就不应存在；遇到时删除断言或改为结构性断言，不跟着改文案。

## 6. 需要同步的文档

- `AGENTS.md`：「Command Reply Conventions」改名为「User-Facing Copy Conventions」，补 D1 语言政策、D2 受众隔离、D3 禁用清单、D6 推送规则，并链接本 spec 的术语表。
- `docs/interaction-and-commands.md`：`/help` 新分组、忙碌规则、"界面用语对照"一节。
- `docs/events-and-tasks.md`：`/tasks show` / `/tasks log` 的新输出形态与用语。
- `docs/memory.md`、`docs/configuration-reference.md`：试用期统一为观察期、journal 称工作日记。
- `docs/deployment-and-operations.md`：首次运行步骤、日志事件名的变化。
- `docs/specs/README.md`：登记 053。

## 实施记录

与设计的差异，均为实施时发现的约束：

- **D5.2 守卫拦截的结构化信息不在 `details` 上。** 拦截必须继续以抛错的方式结束工具调用，模型侧才会收到 `isError` 标记；而 SDK 把抛出的错误重建为只含 `message`、`details: {}` 的结果（`createErrorToolResult`），任何挂在错误上的字段都会丢失。实现改为：`withToolDetails` 捕获 `GuardBlockedError` 时按工具调用 id 暂存 `blocked`，`session-events.ts` 在 `tool_execution_end` 取用，并要求结果文本与暂存的消息完全一致才采用（防止 id 冲突串用）；暂存表有上限。模型侧消息与 `isError` 均不变。
- **D2 `/events list`** 的无效原因来自新的 `EventDefinitionError.kind`（解析错误）与 `EventValidationError.kind`（准入规则）。`EventValidationError` 继承前者，`event_manage` 对可恢复校验错误的处理不变；`/events list` 同时执行与 watcher 相同的准入规则（不含仅在创建时生效的提前量规则），所以"列出时正常"意味着"会被调度"。
- **D11 `--quiet`** 现在隐含 `--plain`：此前全屏界面会忽略它。
- **D12 日志**：全部 warn 级调用迁到 `log.logWarn(event, message, { channelId, reason, fields })`，`logWarning` 已删除；info 级迁移了关机、停止、DingTalk、task driver、任务生成、委派与作业恢复等关键路径，其余仍走 `logInfo`（`system.info`）。
- **D9 `/subagents output`** 的尾部从 4,000 字缩到 1,200 字，`/subagents roles <name>` 的 system prompt 片段从 4,000 字缩到 800 字，以落入回复预算。
