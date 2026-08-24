# 命令子系统评审报告

- 日期：2026-08-24
- 范围：钉钉/TUI 斜杠命令（`src/agent/commands.ts`、`src/agent/command-extension.ts`、`src/runtime/{task,subagent,event,project}-commands.ts`、`src/memory/commands.ts`、`src/agent/status-render.ts`、`src/usage/render.ts`、`src/tui/commands.ts`）、它们的三条路由（`runtime/dingtalk.ts` 忙时分支、`runtime/bootstrap.ts` 空闲分支、`tui/turn-controller.ts`）、回显投递（`runtime/delivery.ts`、`runtime/dingtalk.ts:sendPlain`），以及 CLI 入口（`src/main.ts`、`src/tui/cli.ts`、`src/models/auth-cli.ts`、`src/runtime/app-home.ts:parseArgs`）。合计 2,554 行 / 17 个命令 / 约 40 个子命令。
- 基线：`8035200`
- 性质：评审输入，不是设计记录。落地应按 §4 的顺序分批改，必要时另起 spec。

---

## 0. 总体判断

**这个子系统的"骨"是对的，"皮"是脏的，"筋"是散的。**

骨对在三件事上，都不该动：

1. **命令是零 LLM 成本的人类控制面**，而不是"给模型的另一种提示词"。`/tasks set`、`/subagents cancel`、`/project set`、`/tasks pause` 全部绕过模型直接改磁盘状态，`/tasks set` 的注释（`task-commands.ts:278-285`）把理由写得很清楚："告诉模型'把 wake 改到明早 9 点'要花一整个回合和它的 token，才走到同一次单行写入"。这条对应设计哲学 §2（运行时守不变量）和 §3（自主必须能停），是 Pipiclaw 区别于"一个会聊天的脚本"的地方。
2. **未知斜杠命令不进模型**（`bootstrap.ts:674`、`turn-controller.ts:155`）。`/modle` 直接被拒，不会烧一个回合让模型猜。这是很多同类项目没做的。
3. **命令语法收敛在 `/<名词> <动词> [参数]`**：`/tasks pause <id>`、`/subagents cancel <id>`、`/events delete <name>`、`/project set <path>`。这是 `gh`/`kubectl` 的语法，可预测、可扩展，应该写进规范固化下来，而不是继续靠默契维持。

皮脏、筋散的部分，本次找到 10 条，其中两条是 P0：

- **`/help` 在广告一个不存在的命令。** `commands.ts:95/106` 至今宣传 `/tasks stats [id]`，而 `1644227` 已经把实现删了。用户照着 `/help` 敲 `/tasks stats weekly-report`，得到的是"未知的 /tasks 动作：stats"。这不是笔误，是 §1.1 要论证的结构问题：`commands.ts` 头部那句"single source of truth ... do not hand-maintain those in parallel"只对**命令名**成立，对**子命令、参数、可用性**全部不成立——它们各自散在 5 个 `usage()` 函数和 3 张路由表里。
- **命令回显被写进记忆语料。** 空闲态的 `/help`/`/context` 走 `sendCommandReply` → `respondPlain(text)`，`shouldLog` 默认 `true`（`delivery.ts:73/187`），2,787 字符的帮助文本被 `archiveBotResponse` 落进 `log.jsonl`；而 `log.jsonl` 正是 `memory/session-corpus.ts:296` 的记忆抽取语料。用户敲的 `/status`、`/tasks` 也在命令路由**之前**就被 `archiveIncomingMessage` 归档了（`bootstrap.ts:637-648`）。于是"零 LLM 成本的控制面"在下游变成了要花 LLM 成本去消化的噪声。

至于用户直觉上的"返回有些粗糙、不够漂亮"——**它有一个单一的技术成因，不是审美问题**：五个模块各自独立发明了"2 空格缩进续行"作为子字段约定（`task-commands.ts:219`、`event-commands.ts:91`、`subagent-commands.ts:106`、`usage/render.ts:95`、`command-extension.ts` 各处），而钉钉的 markdown 渲染会把它们并成一行；`/context` 更进一步用了空格列对齐（`prompt/manifest.ts:181-187`），在比例字体里必然塌掉。详见 §1.3。

**没有发现需要拆掉的过度设计。** 相反，这个子系统是**欠设计**的：它缺一个结果模型和一张真正的注册表，所以每加一个命令就要手写一遍解析、一遍 usage、一遍 markdown、并在 3 处路由表里各登记一次。§3 给出的目标形态是**减法**——它删掉 5 个 `usage()`、3 张路由表和约 40 处 ad-hoc 拼字符串。

---

## 1. 实现层缺陷（可验证，按影响排序）

### 1.1 **P0** — `/help` 广告了不存在的子命令；"单一事实源"只覆盖了命令名

```ts
// src/agent/commands.ts:94-108
{
    name: "tasks",
    argumentHint: "[show <id>|archive|pause <id>|resume <id>|run <id>|set <id> <字段> <值>|stats [id]|doctor]",
    ...
    examples: [ ..., "/tasks stats weekly-report", "/tasks doctor" ],
}
```

`git log -S"stats" -- src/runtime/task-commands.ts` 的第一条就是 `1644227 refactor(tasks): drop dead provenance/recurrence fields and /tasks stats`。实现删了，`parseTasksCommand`（`task-commands.ts:73-120`）里没有 `stats` 分支，`task-commands.ts:58-71` 的 `usage()` 里也没有它——**只有 `commands.ts` 这份对外广告没跟上**。

用户路径：`/help` → 看到 `/tasks stats weekly-report` → 敲进去 → `未知的 /tasks 动作：stats` + 一份**不含 stats** 的用法。两份"权威"用法互相矛盾。

**这不是孤例，是结构决定的。** `commands.ts:33-37` 的注释声称：

> Single source of truth for a slash command's metadata. `HELP_TEXT`, the TUI autocomplete list, the busy-time hint, and the known-command set are all derived from these tables — do not hand-maintain those in parallel.

这句话对 `name` 成立，对 `argumentHint` 不成立：`argumentHint` 是一段**手写散文**，与实际的 `parseXxxCommand` 之间没有任何编译期或运行期联系。同一份子命令清单目前有六个副本：

| 副本 | 位置 | 用途 |
|---|---|---|
| `argumentHint` 散文 | `commands.ts:95` 等 | `/help` 与 TUI 自动补全 |
| `examples` 数组 | `commands.ts:97-108` 等 | `/help` |
| `parseTasksCommand` | `task-commands.ts:73` | 真正的解析 |
| `usage()` | `task-commands.ts:58` | 参数错误时的提示 |
| 文档表格 | `docs/interaction-and-commands.md:76-97` | 用户文档 |
| 文档代码块 | 同上 | 用户文档 |

`/subagents`、`/events`、`/project`、`/memory` 各有一套同构的六份。任何一次子命令增删都要人工同步六处，`/tasks stats` 证明了这个流程已经漏过一次。

**验证**：全仓库没有一个测试断言"`argumentHint` 里出现的每个动作都能被对应 parser 接受"。`test/commands.test.ts` 只测了 `parseBuiltInCommand` 的顶层名字与空白处理。

---

### 1.2 **P0** — 命令流量污染记忆语料，并被 LLM 二次消化

三条证据串起来：

```ts
// src/runtime/delivery.ts:73
respondPlain: async (text: string, shouldLog = true) => this.sendFinal(text, shouldLog),
// src/runtime/delivery.ts:187
if (shouldLog) { this.archiveBotResponse(text); }
```

```ts
// src/agent/channel-runner.ts:985
private async sendCommandReply(ctx: ChannelContext, text: string): Promise<void> {
    const delivered = await ctx.respondPlain(text);   // ← shouldLog 取默认值 true
```

```ts
// src/memory/session-corpus.ts:295-297
{ path: join(options.channelDir, "context.jsonl"), source: "context" },
{ path: join(options.channelDir, "log.jsonl"),     source: "log" },
```

于是：**空闲态的 `/help`（2,787 字符）和 `/context detail`（可达数千字符）以 `isBot: true` 的形式进入 `log.jsonl`，成为记忆抽取与 consolidation 的输入。** 更早一步，`bootstrap.ts:637-648` 在**命令路由之前**无条件归档了用户消息本体，所以 `/status`、`/usage`、`/tasks doctor` 这些纯查询也全部进语料。

三个后果：

1. **成本**：本来"零 LLM 成本"的控制面，在下游触发按 token 计费的抽取工作。
2. **质量**：记忆抽取被迫在一堆"# Status / - Uptime: 3d 4h"里找可固化事实。这与 §0 引用的记忆哲学"记住一切等于找不到重要的东西"直接冲突。
3. **不一致**：**同一个命令在忙/闲两条路径上归档行为相反。** `/context` 空闲走 `sendCommandReply`（归档），忙时走 `dingtalk.ts:1397-1402` 的 `bot.sendPlain`（不归档）。`/help` 同理（`dingtalk.ts:1369` vs `channel-runner.ts:787`）。用户看到同样的输出，磁盘上留下不同的痕迹。

**附带发现（P3，同一处）**：`LoggedMessage.skipContextSync`（`store.ts:21`）在全仓库**只有写入方，没有读取方**——`bootstrap.ts:594` 写它，`store.ts` 存它，`session-corpus.ts` 从不看它。这是一个已经失效的意图，正好是这条缺陷本该有的开关。

---

### 1.3 **P1** — 回显的排版约定与钉钉 markdown 子集不兼容（这就是"粗糙"的来源）

五个模块各自独立发明了同一种失败的约定：**用 2 空格缩进的续行表达子字段**。

```ts
// src/runtime/task-commands.ts:219-235
const detail = [`  status: ${status}`, `next wake: ${relativeWake(entry.wakeMs, now)}`];
...
return `- ${entry.id} — ${entry.title}\n${detail.join("   ")}`;
```

```ts
// src/runtime/event-commands.ts:91-99
const lines = [`- ${name}`, `  type: ${event.type}`, `  channelId: ${event.channelId}`];
```

```ts
// src/usage/render.ts:92-96
lines.push(`本频道：${money(channel.totalCost)} · ${tokens(channel.totalTokens)}`);
if (channelKinds) { lines.push(`  ${channelKinds}`); }
```

`subagent-commands.ts:106`（`\n  失败原因：…`）、`command-extension.ts` 的多处同理。

**在 markdown 里，`- item` 下方 2 空格缩进的行是 lazy continuation，会被并进同一个段落**；渲染成 HTML 后连续空格再被折叠。`/tasks` 的一条任务因此渲染成：

> weekly-report — 每周构建报告 status: active next wake: 2026-08-25 09:00:00+08:00 (15h) verify: required/pending next: 跑一遍构建并贴出失败堆栈

——一整条挤在一行、字段之间只有一个空格、没有任何视觉层级。`/events list` 的每个事件、`/usage` 的每个分解行、`/subagents` 的每条失败原因，全部是这个形状。**这就是"我用了这么久，时不时觉得返回粗糙"的直接技术成因。**

两个加重情节：

**(a) `/context` 用空格做列对齐，必然塌掉。**

```ts
// src/agent/prompt/manifest.ts:181-187
const width = Math.max(...build.sections.map((s) => s.id.length), 12) + 2;
lines.push(
    `- ${pad(section.id, width)}${formatNumber(section.injectedUnits).padStart(6)} units  ...`
);
```

列对齐的前提是等宽字体 + 空格保真。钉钉消息两个都不满足。`/context` 在 TUI 里好看，在钉钉里是一堆长短不齐的碎句——而它恰恰是被显式标注为"忙时也可用"的诊断命令（`commands.ts:129-131`）。

**(b) 围栏代码块的可渲染性未经验证，却是四个命令的主要载体。**

`task-commands.ts:368`（```` ```markdown ```` 包整个任务文件）、`event-commands.ts:139`（```` ```json ````）、`memory/commands.ts:154`、`subagent-commands.ts:241/260/342`、`command-extension.ts:246`。钉钉机器人 markdown 的**官方文档列出的支持子集是：标题、引用、加粗/斜体、链接、图片、有序/无序列表**——不含表格，围栏代码块的支持在各端不一致。这需要一次 5 分钟的实测确认；但无论结论如何，把**整个任务文件**（`/tasks show`）或**整段 system prompt**（`/subagents roles <name>`）原样倒进一条钉钉消息，在手机上都不是可用的交付形态。

**(c) 每条 markdown 回显的标题都是字面量 "Bot"。**

```ts
// src/runtime/dingtalk.ts:927-929
const hasMarkdown = /^#{1,6}\s|^\s*[-*]\s|\*\*.*\*\*|```|`[^`]+`|\[.*?\]\(.*?\)/m.test(text);
const msgKey = hasMarkdown ? "sampleMarkdown" : "sampleText";
const msgParam = hasMarkdown ? JSON.stringify({ text, title: "Bot" }) : JSON.stringify({ content: text });
```

钉钉会话列表和通知里显示的就是这个 `title`。**所有命令、所有报告、所有错误，在消息列表里一律显示为"Bot"**，用户无法从列表区分"任务体检结果"和"停止确认"。

同一段代码还有第二个问题：**是否用 markdown 是靠正则猜的**。一条恰好含 `` `id` `` 的确认句（例如 `已请求终止 run \`run_a1b2c3\`：…`）走 markdown 通道，一条纯中文确认句（`已停止当前回合。`）走纯文本通道。两者在钉钉里的外观、气泡样式和列表预览都不同——**同一类回显随内容漂移**。命令自己知道它产出的是什么，不该让传输层猜。

---

### 1.4 **P1** — 一份能力，三张手写路由表，且它们编码了表里没有的信息

`BUILT_IN_COMMANDS` 的 `availableWhileBusy` 是唯一被声明的可用性元数据，但真正决定分发的是另外三处**手写清单**：

```ts
// src/agent/commands.ts:220 —— 哪些由 runner 处理
const RUNNER_BUILT_IN_NAMES = new Set<string>(["help", "stop", "steer", "followup", "context"]);

// src/runtime/bootstrap.ts:163 —— 空闲态哪些走无状态报告
const IDLE_RUNTIME_COMMAND_NAMES = new Set<string>(["events", "tasks", "status", "usage", "subagents", "project"]);

// src/runtime/dingtalk.ts:1367-1405 —— 忙时的 switch，逐个字面量列出 11 个名字
```

第四处是 TUI：`tui/commands.ts:58-85` 又一个逐名 `switch`。第五处是文档 `docs/interaction-and-commands.md:63-74` 的表格。

`RuntimeCommandName` 用 `Exclude<...>` 从主表派生（`commands.ts:22`），注释说这样"can never drift"——但派生出来的是**类型**，`IDLE_RUNTIME_COMMAND_NAMES` 仍然是手写 `Set<string>`，而 `isIdleRuntimeCommandName` 的返回类型 `name is Exclude<RuntimeCommandName, "context">` 是**断言，不是证明**。往 `BUILT_IN_COMMANDS` 里加第 12 个命令，TypeScript 会在 `dingtalk.ts` 的 switch 上报错（好），但**不会**在 `IDLE_RUNTIME_COMMAND_NAMES` 上报错——新命令会静默地在空闲态走不到 `runRuntimeCommand`，只在忙时可用。

同处的注释已经开始腐烂：

```ts
// src/agent/channel-runner.ts:807-808
// The four session/query commands (events/tasks/status/usage) are routed ...
```

现在是六个（多了 `subagents`、`project`）。

**还有一处能力声明与实现不符**：`/project` 标了 `availableWhileBusy: true`（`commands.ts:157`），但 `set`/`reset` 在忙时会被拒（`project-commands.ts:117-119`）。于是忙时提示语 `formatBusyCommandList()` 把 `/project` 列为"可用"，用户敲 `/project set` 却被拒。代码注释承认了这个折衷，但**用户看到的那句话没有承认**。顺带：这条提示语现在是把 12 个命令名塞进一个句子（`dingtalk.ts:1413`），本身也是 §1.3 的一个实例。

---

### 1.5 **P1** — 中英混杂，没有任何成文规范

按语言把 17 个命令的回显分类：

| 全中文 | 全英文 | 中英混杂 |
|---|---|---|
| `/tasks`（正文）、`/subagents`、`/project`、`/usage`、`/help` | `/events`、`/memory`、`/session`、`/context` | `/status`、`/tasks`（字段名）、`/model`、`/thinking`、`/compact`、`/new` |

具体到能并排看的地方，割裂感最强：

```
# 任务体检                                    ← 中文标题
发现 3 个问题：                                ← 中文
- tasks/weekly.md is missing standard section(s): Plan.   ← 英文正文
  Next step: Ask the agent to normalize ...               ← 英文
```

```
# Status                                      ← 英文
- Run state: idle
- Fallback: active（primary anthropic/xxx 冷却至 18:20）  ← 一行之内切换语言
- Uptime: 3d 4h 12m
```

TUI 更严重，**同一个文件里**：`turn-controller.ts:142` `"正在停止…"`、`:144` `"当前没有运行中的回合。"`，而 `:168` `"Queued as steer."`、`:180` `"Queued as follow-up."`，`tui/commands.ts:80` `"/steer requires a message."`。

`/tasks` 的列表更是一行中文标题 + 一行英文字段名（`status:` / `next wake:` / `waiting for:` / `deadline:`）。

这不是"哪种语言更好"的问题，是**没有规范**：仓库里没有任何一处写明命令回显该用什么语言、标识符和字段名怎么处理。于是每个 spec 的实现者按自己的习惯写，`/events`（较早）是英文，`/subagents`（spec 040/041/042，较晚）是中文。

---

### 1.6 **P2** — TUI 忙时，`/model` 等会话命令被当作 steer 文本注入模型

```ts
// src/tui/turn-controller.ts:153-160
case "run":
    if (outcome.text.trim().startsWith("/") && !this.deps.runner.isKnownSlashCommand(outcome.text)) {
        ... 拒绝未知命令 ...
    }
    await this.applyText(outcome.text);   // ← 已知会话命令落到这里
// :164-172
private async applyText(text: string): Promise<void> {
    if (this.deps.runner.isBusy()) {
        await this.deps.runner.queueSteer(text, ...);   // ← 把 "/model opus" 作为 steer 消息发给模型
```

`/model`、`/compact`、`/session`、`/memory` 在 `tui/commands.ts:52-56` 都返回 `{kind:"run"}`（它们由 SDK 命令扩展在回合内处理）。忙时 `applyText` 不区分"这是会话命令"还是"这是普通消息"，直接 `queueSteer`——**字面文本 `/model opus` 被当作用户指令注入运行中的回合**，模型会看到并试图理解它。用户得到的反馈是 `"Queued as steer."`。

对照钉钉：同样的输入得到干净的拒绝——`当前已有回合在运行。运行中可用：… 会话命令（/model、/compact、/session）需要等空闲后再用。`（`dingtalk.ts:1410-1415`）。**两个前端对同一输入的行为不同，且 TUI 的那个是错的。**

---

### 1.7 **P2** — `/help` 是钉钉方言，TUI 原样复用

```ts
// src/tui/app.ts:172
renderHelp: () => renderBuiltInHelp(),
```

而 `renderHelpText()`（`commands.ts:244-267`）的正文写着：

> 由**钉钉传输层**／运行时直接处理 …
> 回合进行中发送的普通消息按 `busyMessageDefault` 处理 … 在 **channel.json** 里设为 `followUp` …
> **channel.json** 的 `responseMode` 控制输出形态：`full_progress_then_plain_final`（默认）流式展示完整进度，再发一条纯文本**卡片**…

TUI 用户在终端里敲 `/help`，被告知去改 `channel.json`——而 TUI 的输出模式在 `settings.json.tui.responseMode`（文档 `interaction-and-commands.md:45` 明确说"彼此独立"）。同时，TUI 独有的 `/exit`（以及**根本没进自动补全的 `/quit`**，`tui/commands.ts:50` vs `:99`）在 `/help` 里一个字都没有。

顺带一提体量：`/help` 现在是 **2,787 字符 / 99 行**。在手机钉钉上，这是需要滚动好几屏的一堵墙，而其中 40 行是 `示例：` ——每个例子独占一行，且因 §1.3 的续行问题会和描述并成一行。

---

### 1.8 **P2** — 命令回显没有长度上限，超限时静默失败

`sendPlain`（`dingtalk.ts:920-932`）没有任何长度检查；失败时只 `log.logWarning` 并返回 `false`（`sendRobotMessage`）。命令回显的两条路径中：

- `bot.sendPlain(channelId, response)`（`bootstrap.ts:662`、`dingtalk.ts:1402`）——**返回值被丢弃**，用户什么也收不到，也收不到任何解释。
- `sendCommandReply`（`channel-runner.ts:985-990`）——有 `replaceMessage` 兜底，但兜底走的是同一条超长内容。

而能超限的命令不少：`/tasks show <id>`（整个任务文件，可以是几十 KB）、`/subagents roles <name>`（整段 system prompt）、`/subagents show`（stderr 尾部 2,000 字符 + argv + 全部字段）、`/context detail`、`/memory list`（50 条 × 180 字符）、`/tasks doctor`（问题数无上限）。

对比：`/subagents` 已经做对了一部分——`LIST_FILTER_CAP = 50`（`subagent-commands.ts:137`）和 `OUTPUT_TAIL_CHARS = 4_000`（`:197`）带明确的截断说明。**这个做法是对的，但只在一个模块里。** `/tasks archive`、`/tasks doctor`、`/events list`、`/memory list` 都没有等价保护。

---

### 1.9 **P2** — `/skill:` 不校验；skills 与 prompt template 无法从命令面发现

```ts
// src/agent/commands.ts:287-289
export function isKnownCommandName(name: string): boolean {
    return KNOWN_COMMAND_NAMES.has(name) || name.startsWith("skill:");
}
```

`/skill:` 后面跟任何东西都被判为"已知命令"，直接绕过 §0 表扬过的那道"未知命令不进模型"的闸门——`/skill:typoo` 会开一个完整的 LLM 回合。对比 prompt template 走的是真校验（`channel-runner.ts:836` 查 `session.promptTemplates`）；同一个函数里两种标准。

发现性同样缺失：`/help` 不列 workspace skills，不列 prompt templates，没有 `/skills` 命令。用户在钉钉里**没有任何办法知道有哪些 `/skill:<名称>` 可用**——只能去读 `workspace/skills/` 目录。而这两份清单在运行时都是现成的（`resolvePipiclawSkills`、`session.promptTemplates`）。

---

### 1.10 **P3** — CLI：四份手写 help、两处重复的命令清单、可观测性缺口

`pipiclaw` 的命令行有四个独立的参数解析与四份手写 help：

| 入口 | 解析 | help |
|---|---|---|
| `pipiclaw [run]` | `app-home.ts:403 parseArgs` | `app-home.ts:417-429` |
| `pipiclaw tui` | `tui/cli.ts:22 parseTuiArgs` | `tui/cli.ts:58-78` |
| `pipiclaw auth` | `auth-cli.ts:43 parseAuthArgs` | `auth-cli.ts:101-120` |
| 未知子命令 | `main.ts:33-39` | `main.ts:35-38`（**第四份**） |

`main.ts:35-38` 手抄了一遍 `app-home.ts:420-422` 的命令清单：

```
console.error("Usage: pipiclaw [run] [options]         Run the DingTalk daemon (default)");
console.error("       pipiclaw tui [options] [prompt]   Chat with the agent in the terminal");
console.error("       pipiclaw auth status|login|logout Manage provider credentials");
```

两份都是手写、都不派生、都要同步。这是 §1.1 在 CLI 侧的同构复制。

**可观测性**：`log.logEvent("info", "runtime.command.started", …)`（`bootstrap.ts:656`）是全仓库唯一的命令事件——只在钉钉路径、只在 built-in、只有 started 没有 completed/failed，会话命令和 TUI 完全不记。想回答"上周谁用了几次 `/tasks pause`""哪个命令最常报错"，现在没有数据。这条本身优先级低，但它是**下一次做减法时唯一能依据的证据来源**——不知道哪些命令没人用，就没法删。

---

## 2. 设计层判断

### 2.1 命令的定位选对了，应该更彻底

设计哲学 §5 说"能力应有清楚的输入、输出、权限和失败语义"，§6 说"传输是端口，不是核心"。命令子系统在**输入**侧做到了（名词-动词、零 LLM、绕过模型直改状态），在**输出**侧几乎没做——17 个命令产出的是 17 种手工拼接的 markdown 字符串，没有共享结构、没有共享约束、没有共享上限。

结果就是 §1.3：传输层被迫用正则猜内容是不是 markdown（`dingtalk.ts:927`），因为**上游没告诉它**。这正是 §6 说的"被协议绑死"的镜像版本——不是运行时被钉钉绑死，而是运行时把渲染决策推给了传输层，传输层只好猜。

**判断：欠的不是"更多命令"，是"一个结果模型"。**

### 2.2 业界经验里真正值得抄的四条

对照 Claude Code、`gh`、`kubectl`、Slack app 的斜杠命令：

1. **两级 help。** `git`/`gh`/`kubectl`/Claude Code 的顶层 `help` 只给一行一命令，详细用法在 `help <command>`。Pipiclaw 现在把 40 个例子全塞进一屏。**顶层 `/help` 应该是 17 行，`/help tasks` 才展开子命令和例子**——而且 `/help tasks` 的内容应该由同一张表生成，顺手解决 §1.1。
2. **命令输出是 ephemeral 的。** Slack 的 slash command 默认 `response_type: ephemeral`——只有发起人看得见，不进频道记录。Pipiclaw 反过来：命令输出进 `log.jsonl`，还喂给记忆抽取（§1.2）。**命令回显应当默认不进任何持久语料**，这是 Slack 十年前就定下的默认值。
3. **用户自定义命令是一等公民。** Claude Code 的 `.claude/commands/*.md` 带 frontmatter（`description`、`argument-hint`），且**出现在 `/help` 和自动补全里**。Pipiclaw 已经有等价物（workspace skills、SDK prompt templates），但它们在命令面**完全不可见**（§1.9）。这是最低成本的用户价值：两份清单运行时都在手上，只是没接上 `/help`。
4. **一套 core，多个前端。** `gh` 的每个命令是纯函数 + 一个 formatter（`--json` / TTY 表格）。Pipiclaw 的 `*-commands.ts` **已经是**"纯函数返回 markdown，无 bot/event 耦合"（`subagent-commands.ts:8-12` 和 `project-commands.ts:11-15` 的注释都明说了这一点，这是很好的设计）——差的只是最后一步：**返回结构，而不是返回已经拼好的 markdown**。

### 2.3 一个真实的能力缺口：命令只能从对话里发起

`/tasks list`、`/subagents list`、`/usage`、`/events list`、`/memory status` **全部是从磁盘派生的只读报告**，不需要 daemon、不需要模型、不需要 session。但今天要看它们，只能去钉钉发消息，或者启动一个 TUI（`tui/app.ts` 会建 runner、加载 session、启动记忆调度）。

对一个"长期运行的 daemon"来说，`pipiclaw tasks`、`pipiclaw usage 7d`、`pipiclaw subagents list running` 这种能进 cron、进监控、进 `ssh` 一行的入口是缺的。而按 §2.2.4 的形态，**这几乎是免费的**：命令核心已经是纯函数，只要给它第三个 frontend（stdout）。

我不建议做"CLI 通过 IPC 指挥 daemon"——那要引入 socket、鉴权、并发写，违背"简约"。**只读、从磁盘派生的那一半可以直接做；会改状态的那一半（`/tasks pause`、`/subagents cancel`）留在对话里**，因为它们需要 daemon 的活状态（run manager、dispatch）。这条边界是天然的，不需要设计。

### 2.4 该做的减法

评审同时要回答"什么可以删"。三条候选：

- **`/context detail` 在钉钉里没有存在价值**（§1.3a）。它是开发者诊断工具，输出天然是列对齐的表格。建议：钉钉里 `/context detail` 落盘成文件并回一行路径，或干脆只在 TUI 可用。
- **`/tasks show <id>` 倒整个文件**（`task-commands.ts:368`）不是"查看任务"，是"倾倒文件"。人在钉钉上要的是标题、状态、下一步、DoD 进度——不是 frontmatter 的 control JSON。
- **`/help` 的 40 行 `示例：`**：按 §2.2.1 移到 `/help <command>`。

这三条合起来能让钉钉侧的命令回显体积下降一个数量级，且不损失任何能力。

---

## 3. 建议的目标形态

约束：**简约而好用，不要复杂、精巧。** 下面每一条都必须是净减法或近似零增量。

### 3.1 一张表：把子命令纳入注册表（删掉 5 个 `usage()` + 3 张路由表）

把今天散在六处的元数据收进已有的 `CommandSpec`：

```ts
interface CommandSpec {
    name: string;
    description: string;
    examples?: string[];
    /** 替代 BUILT_IN_COMMANDS / SESSION_COMMANDS 两个数组的物理拆分 */
    layer: "runtime" | "session";
    /** 替代 availableWhileBusy + RUNNER_BUILT_IN_NAMES + IDLE_RUNTIME_COMMAND_NAMES + 两个 switch */
    busy: "ok" | "idle-only";
    /** 替代 argumentHint 散文 + 每个模块的 usage()；没有子命令的就不写 */
    subcommands?: Array<{ name: string; args?: string; description: string; example?: string }>;
}
```

配套三件事，都是删代码：

1. `usage()` 由 `subcommands` 渲染 —— 删掉 `task/subagent/event/project-commands.ts` 与 `memory/commands.ts` 的 5 个手写 `usage()`。
2. `parseXxxCommand` 的"这是不是一个合法动作"改为查 `subcommands` —— **`/tasks stats` 这一类漂移变成结构上不可能**：表里没有就不会被广告，表里有就一定能被解析。
3. 加一个测试：遍历所有 `subcommands`，把每个 `example` 喂给对应 parser，断言不抛"未知动作"。**这一个测试就能永久关闭 §1.1。**

`argumentHint` 由 `subcommands` 生成，`/help` 顶层只印 `name + description`（17 行），`/help <name>` 才展开 subcommands + examples。

分发端：三处路由表换成一次查表。`dingtalk.ts:1367-1405` 的 switch 和 `bootstrap.ts:163` 的 Set 合并为：

```ts
const spec = lookupCommand(name);
if (busy && spec.busy === "idle-only") return replyBusyRefusal(spec);
```

TUI 的 `switch`（`tui/commands.ts:58-85`）同样收敛，顺手修掉 §1.6（会话命令在忙时走 `replyBusyRefusal`，而不是掉进 `applyText` 被 steer）。

### 3.2 一个结果模型 + 每前端一个渲染器（删掉约 40 处 ad-hoc 拼字符串）

命令不再返回 `string`，返回：

```ts
type CommandResult =
    | { kind: "ok";     text: string }                       // 一句话确认
    | { kind: "error";  text: string; usage?: string }       // 一句原因 + 一句下一步
    | { kind: "report"; title: string; blocks: Block[] };

type Block =
    | { kind: "kv";    items: Array<{ k: string; v: string; warn?: boolean }> }
    | { kind: "items"; items: Array<{ title: string; sub?: string[]; warn?: boolean }> }
    | { kind: "note";  text: string }                        // 空态、截断说明、下一步提示
    | { kind: "pre";   text: string; path?: string };         // 长文本：渲染器决定截断还是给路径
```

**三种 kind、四种 block，足够渲染今天全部 17 个命令。** 这不是一个 widget 框架，是一层薄的数据结构。

渲染器两个：

- `renderForDingTalk(result)`：**不用 `#` 标题**（钉钉里 h1 过大）、**不用 2 空格续行**（改成真正的嵌套列表或 `·` 分隔的单行）、**不用列对齐**、`pre` 超过阈值就截断 + 给路径、统一行数/字数上限并在超限时用 `note` 说明下一步。返回 `{ text, isMarkdown, title }`——**`title` 用命令名，`isMarkdown` 由渲染器判定，`sendPlain` 不再猜**（修 §1.3c）。
- `renderForTerminal(result)`：TUI 是等宽字体，`kv` 可以对齐、`pre` 可以全量、颜色可用。

顺带一次性修掉：`respondPlain(text, /* shouldLog */ false)` 用于所有命令回显，且命令消息本体不进 `log.jsonl`（修 §1.2）；`sendPlain` 的返回值必须被检查，投递失败要给用户一句可见的反馈（修 §1.8）。

### 3.3 回显文案规范（写进 `AGENTS.md`）

这是目前完全空白、且最便宜的一块。六条：

1. **一个命令只有三种回显形态**：确认（一句话）、报告（title + blocks）、错误（一句原因 + 一句下一步，参数错才附 usage）。
2. **中文叙述，英文只留标识符**：命令名、任务 id、字段名（`wake`/`status`/`mutates`）、model ref、文件路径保持英文原样；其余一律中文。终结 §1.5。
3. **不用一级标题**，用 `**粗体**` 首行做标题。
4. **只允许一层无序列表**；禁止 2 空格续行、禁止空格列对齐、禁止把长文本原样倒进消息。
5. **每个报告有上限**（建议钉钉 ≤ 20 行 / 1,500 字符），超出时给的是"下一步该敲什么命令"，不是更多内容。
6. **空态有统一句式**：`暂无 X。` + 一句"怎么开始"。

配一个具体的前后对比，说明这套规范值多少：

**`/tasks` 现在（渲染后并成一行）**

> 任务：2 个活动任务
> weekly-report — 每周构建报告 status: active next wake: 2026-08-25 09:00:00+08:00 (15h) verify: required/pending next: 跑一遍构建并贴出失败堆栈
> inbox-triage — 收件箱分诊 status: waiting next wake: — waiting for: user reply

**规范之后**

> **任务** · 2 个进行中
>
> **weekly-report** — 每周构建报告
> - 状态：进行中 · 下次唤醒 08-25 09:00（15 小时后）
> - 验收：需要验收，尚未通过
> - 下一步：跑一遍构建并贴出失败堆栈
>
> **inbox-triage** — 收件箱分诊
> - 状态：等待中 · 无唤醒时间
> - 等待：user reply
> - ⚠ 没有唤醒时间、也没有运行中的来源，只能由你唤醒：`/tasks run inbox-triage`
>
> 详情 `/tasks show <id>`，体检 `/tasks doctor`

**`/status` 现在**：8 行、英文标题、行内中英混切。
**之后**：

> **状态** · 空闲
> - 模型：`anthropic/claude-opus-4-6`（thinking `medium`）
> - 上下文：42k / 200k（21%）
> - 已运行 3 天 4 小时 · 版本 `0.9.1-beta.2`

（`Fallback` 只在生效时出现，别的字段不变；4 行装下今天 8 行的信息。）

### 3.4 三个小补丁

- **`/help` 列出 skills 与 prompt templates**，`/skill:` 走真校验（修 §1.9）。两份清单运行时都有，这是纯接线。
- **`/events delete` 回显被删事件的内容**（现在只回 `Deleted event: <name>`，删了就没了），让误删可恢复。`/subagents cancel all` 同理列出被终止的 run。
- **CLI 的四份 help 收敛成一份生成的**（修 §1.10）；`main.ts` 的未知子命令分支复用 `parseArgs` 的 help，不再手抄。

### 3.5 明确不做

- 不做 `--json` / `-o` 输出格式矩阵。`pipiclaw tui --print` 已覆盖脚本化需求。
- 不做 CLI→daemon 的 IPC。只读命令直接从磁盘渲染（§2.3），写命令留在对话里。
- 不做命令权限/角色系统。频道隔离已经是边界。
- 不做交互式确认对话。`/events delete` 用"回显内容"换"可恢复"，比引入一个确认状态机便宜得多。
- 不新增命令。本报告没有一条建议是"加一个命令"。

---

## 4. 落地顺序

按"每一批都能独立发布、且不依赖后一批"排：

| 批次 | 内容 | 对应 | 规模 |
|---|---|---|---|
| **A** | 删掉 `commands.ts` 里的 `stats` 广告；命令回显与命令消息不进 `log.jsonl`（`shouldLog=false` + 归档跳过，或启用已死的 `skipContextSync`）；`sendPlain` 返回值检查 | §1.1 §1.2 §1.8 | 小，纯修复 |
| **B** | 文案规范进 `AGENTS.md`；按规范重写 `/tasks`、`/events`、`/status`、`/usage`、`/memory` 的回显；`sendPlain` 不再猜 markdown、`title` 用命令名 | §1.3 §1.5 §3.3 | 中，改的是字符串 |
| **C** | `CommandSpec.subcommands` + 生成 `usage()`/`/help <name>` + example 往返测试；三张路由表收敛为查表；TUI 忙时会话命令走拒绝 | §1.1 §1.4 §1.6 §3.1 | 中，净删代码 |
| **D** | `CommandResult` + 两个渲染器；长度上限统一；`/context detail`、`/tasks show`、`/subagents roles <name>` 的长文本改成截断+路径 | §1.3 §1.8 §2.4 §3.2 | 中，净删代码 |
| **E** | `/help` 列 skills/prompt templates + `/skill:` 校验；`/events delete` 回显内容；CLI help 收敛 | §1.9 §1.10 §3.4 | 小 |
| **F**（可选） | 只读命令的 stdout frontend（`pipiclaw tasks|usage|subagents|events|memory`）；`runtime.command.completed/failed` 事件 | §2.3 §1.10 | 中，纯新增，可延后 |

A 和 B 各自独立见效，且合起来就能消掉用户感知到的"粗糙"的绝大部分。C/D 是把它变成结构上不再复发。E/F 是价值补齐。

---

## 5. 附：本次核对过但**没有**发现问题的地方

为免后续重复审：

- `parseBuiltInCommand`（`commands.ts:295-316`）的空白处理是对的——按第一段空白切分，`/steer\n修复这个` 能正确解析（移动端换行），大小写不敏感，有测试覆盖。
- `/new` 在忙检查**之前**路由（`dingtalk.ts:1355-1361`）是刻意的，注释也说清了理由（卡死的 compaction 不能挡住恢复路径）。正确。
- `/stop` 的看门狗（`bootstrap.ts:189-211`）会在 15 秒后强制释放卡住的回合并明确告知用户。这是本子系统里写得最好的一处失败语义。
- `*-commands.ts` 全部是"纯函数返回文本、不耦合 bot/event"。这是让 §3.2 变成可行改造的前提，不该动。
- `resolveTaskPath`（`task-commands.ts:126-135`）和 `resolveEventPath`（`event-commands.ts:75-83`）都做了路径逃逸校验。命令面没有发现路径注入。
- `/subagents` 的截断（`LIST_FILTER_CAP` / `OUTPUT_TAIL_CHARS`）和 `resolveRef` 的歧义处理（`subagent-commands.ts:199-206`）是全子系统里唯一做对了"有界输出 + 有解释"的模块，应当作为 §3.2 的模板。
