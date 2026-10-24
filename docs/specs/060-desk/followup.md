# Spec 060 追加修复：让 desk 成为一个概念，而不只是一个新名字

| 字段 | 内容 |
|---|---|
| 状态 | 已实施（见 §9 交付记录） |
| 日期 | 2026-10-24 |
| 承接 | [design.md](./design.md)、[acceptance.md](./acceptance.md)；审查对象 `cd7f8f4 feat: unify desks and initialize the default work context` |
| 范围 | 对外资料、runtime playbook 与模型指导、用户文案、代码命名与注释、060 之后可以收窄的几处运行时结构，以及一处与“工位共享”原则冲突的残留限制（S8：事件的频道归属检查） |
| 不改变 | 落盘格式、绑定与准入语义、任务/记忆/事件/委派的业务 schema、`src/index.ts` 导出名称 |

## 0. 给实施 Agent 的说明

本文是一份可直接执行的修复说明。动手前先读完 §1、§2：它们定义了什么才算“改对了”。§3 列出具体缺陷，§4 是 playbook 重写指导，§5 是代码收窄方案，§6、§7 规定顺序与验收。

三条不可妥协的要求：

1. **不做机械替换。** cd7f8f4 已经证明，把 dot 逐词换成 desk/工位，代码能过检查，语义却留在 dot 时代：多出来的空格、错位的帮助列、讲反了的 FAQ、把默认工位称为“默认助手”，都是这样来的。每一处改动都要先问：在“一个助手、多个工位、默认全部共享”的模型下，这句话对读者意味着什么？
2. **每个事实性陈述都对着代码核对。** 本文给出的参考表述已按 2026-10-24 的代码核对过，但实施时代码可能已变。写进 playbook 或用户文档之前，逐条找到实现位置（§4 每份手册都列了待核对项）。
3. **不扩大范围。** 不改落盘格式，不引入新机制、新配置或新命令，不重写历史 spec、`docs/reviews/`、已发布的 CHANGELOG 条目和封存的评测证据。
4. **不在工位内部做隔离。** 工位由绑定它的所有频道共同使用、共同管理。需要隔离时，答案是另建一个工位，而不是在同一个工位里按频道加限制、加归属检查，或让模型对别的频道的内容避而不谈。

## 1. 为什么需要追加修复

060 改变的不只是名字，而是产品模型和使用方式：

| 维度 | 058 dot | 060 desk |
|---|---|---|
| 它是什么 | 一个独立的助手个体 | 同一个助手的一个工作范围 |
| 身份 | 每个 dot 可以有自己的 SOUL/AGENTS | 只有一套人格，来自 workspace 根 |
| 初始状态 | 什么都没有，必须先创建 | 运行时初始化 `default` |
| 新频道 | 先 `/dot bind`，未绑定就不服务 | 第一条获准消息自动接入 `default` |
| 典型部署 | 用户刻意划分多个 dot | 绝大多数只有 `default`；其他工位是进阶隔离手段 |
| 共享范围 | 用户主动把几个频道绑在一起 | 默认所有私聊、群和终端共享同一份记忆和任务 |
| 用户心智 | “我在和哪个助手说话” | “这件事记在哪个工位” |
| 对模型的要求 | 知道自己是哪个 dot | 知道自己始终是同一个 Pipiclaw；知道记忆可能来自别的频道和别的人；正常对话不提工位 |

最后两行是这次修复的重点。dot 时代，“共享记忆”是用户主动选择的；060 之后它是默认行为。于是有三件事从边缘情况变成了常态，而当前资料和 playbook 都没有讲清楚：

- **同一工位里有多个人。** 记忆由所有频道共享，私聊里得到的信息默认也会在群里被想起。这是设计，不是缺陷：需要分开就用另一个工位。资料和模型要做的是把这一点讲清楚，并把事实归属写对。
- **工位里的工作属于整个工位。** `job`、`subagent_list`、`task_list`、`event_manage list` 返回整个工位的工作，任何频道都可以管理。需要讲清楚的只有投递：工作完成时唤醒的是它的发起频道或投递频道，不会因为谁管理了它而改变。
- **用户本来不需要知道工位。** 把 `default` 叫作“默认助手”或“个人助手”，把工位叫作“隔离工作区”，都会让用户以为存在多个助手，或把工位和 workspace 混为一谈。

## 2. 统一语义：实施的判据

### 2.1 一段话模型

Pipiclaw 是用户的一个助手。workspace 只有一个，承载共同身份、规则、skills 和委派角色。工位（desk）决定一项工作的状态归谁：记忆、journal、任务、事件、工作文件，以及每个频道在工位里的会话区。默认工位 `default` 接住所有频道，因此默认情况下大家共享同一份积累，各自保留独立对话。工位内的记忆、任务、事件、作业和委派由这些频道共同使用、共同管理；工位内部不按频道隔离。用户需要把某个项目或某些群分开时，才创建其他工位并把频道切过去。工位不是另一个助手，也不是权限或文件隔离。

### 2.2 术语表

当前文档、playbook、用户文案和代码注释统一按此表书写。历史 spec 与评审记录保持原文。

| 概念 | 中文 | 英文 / 代码 | 不要再用 |
|---|---|---|---|
| 部署唯一的共享目录 | workspace，或“工作区（workspace）” | `workspace`、`workspaceDir` | 用“工作区”指工位 |
| 工作范围 | 工位 | `desk`、`deskDir` | dot；“隔离工作区”；“默认助手 / 个人助手”指 `default` |
| 默认工作范围 | 默认工位 `default` | `DEFAULT_DESK` | 默认助手、内置个人助手 |
| 消息来源与回复地址 | 频道 | `channel`、`channelId` | 在当前文档和 playbook 中与“渠道”混用 |
| 频道在工位里的会话目录 | 会话区 | `conversation`、`conversationDir` | — |
| 工位的生成记忆索引 | （工位）记忆索引 | `memory index` | “频道索引”、`channel index`（这个名字属于 `CHANNELS.md`） |
| `CHANNELS.md` | 频道索引 | `ChannelIndex` | — |
| 任务或事件把结果送去的频道 | 投递频道 | `channel` 字段 / `channelId` | — |

“频道”是项目里一直在用的词，用户文案（“本频道”）也都用它；“渠道”是 060 设计文档新带进来的，只在少数新段落里出现。统一成“频道”，改动面最小。060 的 design.md 与 acceptance.md 属于设计记录，保留原文。

### 2.3 本文定下的决策

以下决策已经确定，实施 Agent 不重新讨论。D-F2 与 D-F3 由用户在 2026-10-24 审阅时明确确认；D-F1 按用户“不在工位内做隔离”的原则定下。

- **D-F1 记忆在工位内共享使用，只要求归属写对。** 同一工位的记忆可以在它的任何频道里使用，模型不因为内容来自别的频道就回避。模型保存用户事实时写明是谁、在什么范围成立，避免把一个人的偏好当成所有人的。需要不共享的内容，用户应把相关频道放到另一个工位，用户文档负责讲清这一点（A3、A4）。不给记忆 schema 加字段，也不改 system prompt。
- **D-F2 工位内的工作共享管理。** 任何绑定本工位的频道，都可以查看、修改、取消或删除同工位的作业、委派、任务和事件，不需要发起频道参与，也不需要额外确认。管理操作不改变工作的投递频道。模型需要知道的只有一点：别的频道发起的工作完成时唤醒那个频道，不会唤醒自己，所以不要等它。事件现有的频道归属检查与此冲突，由 S8 移除。
- **D-F3 术语统一用“频道”**，见 §2.2。channel 在 Pipiclaw 中是一个具体、可回复的会话地址（`dm_…`、`group_…`、`tui`），对应“频道”（一个对话空间），而不是“渠道”（钉钉、终端这类接入途径，代码里称 transport/frontend）。当前文档、playbook 和用户文案中的“渠道”全部改为“频道”；060 的 design.md 与 acceptance.md 作为设计记录保留原文。
- **D-F4 workspace `MEMORY.md` 是共同背景，由用户维护。** 模型只在用户明确要求时修改它，绝不把工位记忆自动提升过去。

## 3. 发现清单

行号按 2026-10-24 的 `master`（cd7f8f4）记录，实施时以内容为准。

### A. 对外资料

| ID | 位置 | 问题 | 要求 |
|---|---|---|---|
| A1 | `CHANGELOG.md`、`CHANGELOG.zh-CN.md` 的 `[Unreleased]` | 仍是 dot 时代内容，其中两条是 060 明确删除的行为：dot 可以带自己的 `SOUL.md`/`AGENTS.md` 并替换根文件；`tui` 不带 `--dot` 时打开唯一的 dot。059/060 的破坏性变更一条都没记 | 按 §6 P4 重写，两个文件保持同步 |
| A2 | `README.en.md` | 整篇停在 058：`/dot new`、`--dot main --create`、“an unbound channel is not served”、`workspace/dots/` | 以当前 `README.md` 为准整篇重写，结构对应；不要在旧英文稿上打补丁 |
| A3 | `docs/interaction-and-commands.md:174` | FAQ 说私聊和群“绑定在不同的工位上……为了避免私聊内容进群”。060 的默认行为正好相反 | 改为：默认都在 `default`，共享记忆；需要分开时用 `/desk new` + `/desk bind`；稳定的共同背景写 workspace `MEMORY.md` |
| A4 | `README.md:25`、`docs/interaction-and-commands.md` 开头 | 讲了“共享”，没讲共享的后果 | 补一句：默认所有私聊和群共享记忆，私聊里告诉助手的事可能在群里被想起；需要分开就用工位 |
| A5 | `docs/architecture.md:11,15`、`docs/interaction-and-commands.md:11,15`、`README.md:72,89` | 把 `default` 称为“默认助手 / 个人助手” | 改成默认工位；“个人助手”只用来指 Pipiclaw 本身 |
| A6 | `README.md:137,199,213`、`docs/interaction-and-commands.md:4,20`、`docs/scaling-and-concurrency.md:25` 标题“按需隔离工作区” | 用“工作区”指工位，和 configuration-reference、skills、deployment 中的“工作区 = workspace”冲突 | 改成“工位”。标题改名会让 `README.md:25` 的锚点 `#按需隔离工作区` 失效，必须同一提交里一起改 |
| A7 | `docs/architecture.md:219,266` | 第 219 行“频道 `memory/*.md`”、第 266 行“workspace 背景 + 频道索引 + 当天 journal”，说的都是工位记忆（058 之前的叫法） | 改成“工位 `memory/*.md`”“工位记忆索引”，与 D2 一起改 |
| A8 | `docs/security.md:105` | “相对路径和 shell 的 cwd 以当前工位目录为准”，漏了 `desk.json` 的 `cwd` 覆盖 | 改成“以实际 cwd 为准：默认是工位目录，`desk.json` 可设为其他绝对路径” |
| A9 | `docs/specs/059-default-assistant/design.md:5` | “060 的运行时重构尚未实施”已过时 | 改成“已实施”，并链接 060 的验收记录 |
| A10 | `docs/runtime-playbooks.md:5` | “渠道地址” | 按 D-F3 改成“频道”；内容随 §4 的结果同步 |
| A11 | `docs/deployment-and-operations.md:355` | 引用了用户回复原文“默认助手暂时不可用” | 与 C1 的新文案同步 |

### B. Playbook 与模型指导

| ID | 位置 | 问题 |
|---|---|---|
| B1 | `runtime-orientation.md:33`、`agent-delegation.md:39,58`、`background-jobs.md:30`、`memory-and-learning.md:27,41,43`、`event-scheduling.md:41,55` | “dot 记忆”被替换成了“工位 记忆”，多出空格。这是机械替换的直接证据，说明这些句子没有被重新思考过 |
| B2 | 七份手册 | “频道 / 渠道 / channel”混用，有时在同一段里 |
| B3 | `memory-and-learning.md:12` | “`session_search` 也只查当前工位的独立会话”会误导：它检索的是当前工位所有频道的原始对话 |
| B4 | `memory-and-learning.md`、`runtime-orientation.md` | 没讲默认共享的含义（D-F1）：同一工位有多个人，记忆可能来自别的频道，存的时候要写明是谁 |
| B5 | `background-jobs.md`、`agent-delegation.md`、`task-lead.md`、`event-scheduling.md` | 没讲工位内的工作共享管理（D-F2）；工具说明里已有 `started in <channel>` / `deliversHere`，playbook 却没讲清“谁都能管，但完成时只唤醒发起或投递频道”。`event-scheduling.md:55` 还写着别的频道的事件“只读” |
| B6 | `runtime-orientation.md` 文件地图 | 缺少工位目录下的 `inbox/`（入站图片、超长消息原文）、`logs/`（命令完整输出）、`subagent-artifacts/`。模型会在工具返回里看到这些路径，地图里却找不到 |
| B7 | `runtime-orientation.md` | 没说其他工位的目录怎么对待：技术上可读，但不会自动回忆，也不能用文件工具改写 |
| B8 | `src/agent/prompt/sections.ts:69` | “Jobs and delegations wake this channel”不精确：只有本频道发起的工作才会唤醒本频道 |

### C. 用户文案与 CLI

| ID | 位置 | 问题 | 要求 |
|---|---|---|---|
| C1 | `src/desk/commands.ts:98` | 用户可见回复“默认助手暂时不可用……” | 说明是本频道没有可用的工位（默认工位 `default` 不可用），由部署者检查 `workspace/desk-default/`；也可以用 `/desk bind <名字>` 切到其他已有工位 |
| C2 | `src/desk/commands.ts:109` | 空列表仍是 058 的入门引导（“先 new 再 bind”）。060 下列表为空，说明 `default` 缺失且没有任何绑定 | 改成部署者故障提示 |
| C3 | `src/commands/catalog.ts:131-141` | 描述“创建隔离工作区，或切换本频道的工作区”；参数提示 `<desk>`、`<工位>` 混用，文档用的是 `<名字>` | 描述改成工位；参数提示统一为 `<名字>`，和文档、`/desk` 的错误提示一致 |
| C4 | `src/tui/cli.ts:67-76` | `--desk <name>` 这一列比其他选项错开一格（dot→desk 多一个字母）；“reusing the same … session as the DingTalk runtime”不对，TUI 有自己的会话；“opens your personal assistant”应为默认工位 | 对齐各列，改正这两句。CLI 输出保持英文 |
| C5 | `src/tui/app.ts:66` | 注释 “defaults to the built-in personal assistant” | 改成 default desk |

所有用户可见文案都要遵守 spec 053，并通过 `test/user-copy-shape.test.ts`。

### D. 代码命名与注释（不改行为）

| ID | 位置 | 问题 | 要求 |
|---|---|---|---|
| D1 | `src/commands/router.ts:39`、`src/runtime/turn-handler.ts:77` | 孤儿注释：它们原本说明的 `dotChannelIds` 已被删除，注释留下后挂在了 `version`/`cliVersion` 上，描述的是 060 已删除的旧事件历史兼容逻辑 | 删除 |
| D2 | `src/memory/index-budget.ts:8,13,33`、`src/memory/render.ts:18,29`、`src/agent/turn/turn-context.ts:58,77,81`、`src/agent/turn/turn-prompt.ts:20`、`src/subagents/task-envelope.ts:163,197,200`、`src/memory/commands.ts:52`、`src/memory/reflect.ts:195` | 工位记忆索引还叫 `buildChannelIndexForBootstrap` / `CHANNEL_INDEX_MAX_UNITS` / `channelIndex`（058 之前的叫法），和 `ChannelIndex`（`CHANNELS.md`）撞名 | 改为 `buildMemoryIndexForBootstrap`、`MEMORY_INDEX_MAX_UNITS`、`memoryIndex`，注释同步。测试里的导入和 `vi.mock` 字符串一起改（测试路径比 src 内部多一级 `../src/`） |
| D3 | `src/events/types.ts:63` | `desk?` 的注释写“absent on records written before spec 058”。实际上 `src/events/watcher.ts:181` 每次都会写 | 改为必填（见 S5） |
| D4 | `src/agent/channel-runner.ts:121` | 用“058 之前的 session header”解释 cwd override | 改成现在的真实理由：`desk.json` 的 `cwd` 可能在会话建立之后被修改，header 里的 cwd 会过时 |
| D5 | `src/runtime/durable-dispatch.ts:52` | 以“058 之前的 id 可能含 base64 群 id”作为编码理由 | 改成：dispatch id 是不透明的业务 id，编码保证它总能作为平铺文件名，并且可以无损还原 |
| D6 | `src/desk/types.ts:2` | 工位定义标注为 spec 058 | 改成 spec 060 |
| D7 | `src/desk/registry.ts:1-9` | 文件头说本模块负责 `desk-bindings.json` 的 I/O，实际已搬到 `bindings.ts` | 改成只描述 `desk.json` 和工位创建 |
| D8 | `src/tools/bash.ts:45` | “the channel's `logs/` dir” | 改成 desk |
| D9 | `test/subagent-runs.test.ts:252,295` | 参数名 `_dot` | 改成 `_desk` |

### E. 可以收窄的结构与残留限制

见 §5 的 S1–S8。其中 S8 是本文唯一有意改变外部行为的一项：移除 `event_manage` 的频道归属检查（`src/tools/event-manage.ts:256-268`），让同工位任何频道都能修改和删除事件。

## 4. Playbook 重写指导

### 4.1 写之前先定读者的问题

Playbook 写给模型，每一句都要回答模型在某个决策点上的问题。dot 时代模型要问的是“我是哪个助手”；060 之后要问的是：

- 我是谁？始终是同一个 Pipiclaw。
- 这条记忆是谁的、在什么范围成立？
- 列表里的这项工作完成时会唤醒我，还是唤醒别的频道？
- 用户说“分开”“另起一摊”时，我该怎么做？
- 文件该去哪里找：工位目录、实际 cwd，还是 workspace？

不回答这些问题的句子删掉；回答错的重写；只是把 dot 换成工位的，按这些问题重新表述。

### 4.2 写作规则

除了 [runtime-playbooks.md](../../runtime-playbooks.md) 的十条原则，本次额外遵守：

1. **施动者明确。** 斜杠命令一律写成“用户命令：`/desk …`”，不能混进模型的动作序列。
2. **范围词精确。** “当前工位”“本频道”“发起频道”“投递频道”各有所指，不能用“这里”“当前”含糊带过。尤其不能把“工位共享”写成“频道共享”，也不能反过来。
3. **数字带口径。** 每个限额都写清计数单位，例如“按工位合计 6 个，宿主共 20 个”；不写清口径的数字，在多频道共享时会误导。
4. **不复制。** 工位的完整定义只在 `runtime-orientation.md` 写一次；其他手册只写本决策点需要的那一两句，需要全貌时让读者去看导航。
5. **不把用户不需要知道的机制推给用户。** 正常对话不解释工位；只有用户表达“分开”的意图，或者问到工位、换绑后果时才提。
6. **不在工位内制造隔离。** 不写“别的频道的工作只读”“需要发起频道同意”“不在群里提私聊内容”这类规则。工位内共享使用、共享管理，隔离靠另建工位。
7. **参考表述不是逐字规范。** 下面的参考表述可以改写，但要保留每条要点，并且仍能通过核对。测试不固定措辞（见 §7）。

### 4.3 长度预算

基线是 2026-10-24 运行 `npm run playbooks:measure` 的结果。

| 手册 | 现状 units | 上限 |
|---|---|---|
| `runtime-orientation.md` | 1,438 | 1,600 |
| `memory-and-learning.md` | 1,155 | 1,250 |
| `agent-delegation.md` + `task-lead.md` | 4,409 | 4,450（审查目标 4,500 以内；本次争取不增长） |
| `background-jobs.md` | 579 | 650 |
| `event-scheduling.md` | 1,162 | 1,220 |
| `outbound-media.md` | 478 | 500 |
| 七份合计 | 9,221 | 9,500 |

`agent-delegation.md` 有一处现成的重复可以用来抵消新增内容：第 19 行和第 52 行都在讲“外部条目不经过 Pipiclaw 的工具守卫，权限边界是条目命令、CLI sandbox、宿主账号与环境”。合并成一处（保留在第 52 行“工作目录与写入边界”一节），大约能省出 50 units。

### 4.4 逐份指导

#### `runtime-orientation.md`：唯一完整讲工位的地方

**必须表达：**

- 始终是同一个 Pipiclaw；工位只决定状态归属，不是另一个助手，也不是权限边界。
- 多数部署只有 `default`；所有频道默认都在这里，对话各自独立；工位内的记忆、任务、事件、作业和委派由这些频道共同使用、共同管理（D-F1、D-F2）；需要分开的内容属于另一个工位。
- 正常对话不提工位，不要求用户先创建或绑定；用户想分开时，告诉他们相应的用户命令。
- 换绑的后果：只改变本频道此后的归属；记忆和文件不搬；旧工位投递到本频道的任务和事件暂停；切回后恢复，原会话也接着用。改 cwd、换仓库、指定委派目录都不是换工位。
- 其他工位：可以按用户的明确要求只读查阅；不用文件工具改写别的工位的记忆、任务、事件。
- 文件地图补上 `inbox/`、`logs/`、`subagent-artifacts/`；`<memory_bootstrap>` 那一行写成“当前工位的记忆索引”。

**参考表述**（替换现有的“一个助手，多个工位”一节）：

```markdown
## 一个助手，多个工位

你始终是同一个 Pipiclaw：身份、语气和共同规则来自 workspace 根的 SOUL/AGENTS，skills 和委派角色也全局共享。工位（desk）只决定工作状态归谁——记忆、journal、任务、事件、工作文件，以及每个频道在工位里的会话区。工位不是另一个助手，也不是权限边界。

多数部署只有默认工位 `default`：获准的私聊、群和终端默认都在这里，各自保留独立对话。工位里的记忆、任务、事件、作业和委派由这些频道共同使用、共同管理，不按频道隔离；你知道的事可能来自别的频道和别的人，用的时候注意它是谁的。别的频道发起的工作完成时唤醒那个频道，不会唤醒你。

正常对话不提工位，也不要求用户先创建或绑定。用户想把某个项目或某些群的记忆、文件分开时，告诉他们用户命令：`/desk` 查看，`/desk new <名字>` 创建，`/desk bind <名字>` 把本频道切过去。这些不是你的工具，也不能用写文件模拟。切换只改变本频道此后的归属：记忆和文件不搬；旧工位投递到本频道的任务和事件暂停，切回后恢复，原会话也接着用。改 cwd、换仓库或指定委派 workingDirectory 都不是切换工位。

其他工位的目录就在 workspace 下，但不会进入你的上下文。用户明确要求时可以只读查阅；不要用文件工具改写别的工位的记忆、任务或事件。需要在那边记录或调整时，请用户到绑定该工位的频道里操作，或用 `pipiclaw tui --desk <名字>` 打开它。
```

文件地图新增一行（措辞可调）：

```markdown
| 工位目录 `inbox/` / `logs/` / `subagent-artifacts/` | 入站图片与超长消息原文 / 命令完整输出 / 委派产物 | 运行时写入；按工具或消息给出的绝对路径 `read` |
```

**待核对：** 首次接入只发生在获准的人类消息上（`DeskRuntime.ensureDefaultBinding`）；换绑后暂停和切回恢复的行为（`DeskRuntime.bindNow`、`task-driver.ts` 中的 D8 过滤、`events/watcher.ts` 中的 `channel_not_bound`）；切回后复用原会话区（`allocateConversation` 幂等）；三个目录名（`runtime/inbound-images.ts`、`agent/turn/turn-input.ts`、`tools/bash.ts`、`jobs/manager.ts`、`subagents/dispatch.ts`）；TUI 默认打开 `default`（`tui/app.ts` 的 `openDesk`）。frontmatter 仍然不设 `requires-tools`。

#### `memory-and-learning.md`：工位范围与多人共享

**必须表达：**

- 范围：同一工位的所有频道共享 memory、journal 和 `session_search` 能检索到的原始对话；其他工位的这些内容不会自动出现；工位积累的偏好不会自动变成所有工位的规则。
- 多人（D-F1）：记忆在工位的任何频道都可以使用；存用户事实时写明是谁、在什么范围成立；使用时按它的主人和适用范围套用，不把一个人的偏好当成当前说话人的偏好。不写“不在群里复述私聊内容”之类的隔离规则。
- 共同背景（D-F4）：workspace `MEMORY.md` 由用户维护，用户明确要求时才改。
- 删掉第 27 行括号里重复的“同一工位的各频道共享它”；第 41 行写成“当前工位的 memory”。

**参考表述**（替换第 12 行）：

```markdown
记忆属于当前工位。同一工位的所有频道——私聊、群和终端——共享 memory、journal，以及 `session_search` 能检索到的原始对话；其他工位的这些内容不会自动出现，工位里积累的偏好也不会自动变成所有工位的规则。

同一工位通常不止一个人在用。存用户事实时写明是谁（名字或 handle）、在什么范围成立，不把一个人的要求写成所有人的偏好；使用时也按它的主人套用，先分清当前说话的是谁。`session_search` 的结果标有来源频道，可以帮助判断一句话是谁、在哪里说的。
```

第 43 行末尾改为：

```markdown
需要在所有工位都成立的共同背景属于 workspace `MEMORY.md`：由用户维护，只在用户明确要求时修改，不把工位记忆自动搬过去。
```

**待核对：** `session_search` 检索的是当前工位所有会话区（`memory/session-corpus.ts`、`memory/session-search.ts`），结果带频道标签；`memory_save` 有 `details` 字段（`tools/memory-manage.ts`）；`memory_search` 的范围（同一文件）；reflect 提示中关于写明归属的规则（`memory/reflect.ts:48-69`）要和这里一致，不能互相矛盾。

#### `agent-delegation.md`：限额口径与同工位他人的委派

**必须表达：**

- `subagent_list` 显示整个工位的委派，包括同工位其他频道发起的（标 `started in <频道>`），任何频道都可以查看、续接或取消（D-F2）；但它们完成时唤醒的是发起频道，不会唤醒你，不要等它们。
- 限额口径：按工位合计 6 个，宿主共 20 个。
- 结果只唤醒发起频道，且该频道仍须绑定在发起时的工位；换绑后不转投新工位，也不转给同工位的其他频道。
- 第 39 行：“选中的记忆正文”不需要加“工位”限定；“不要让执行者猜工位路径”改为“需要的工位或仓库路径给绝对路径”。
- 合并第 19 行和第 52 行的重复内容（§4.3），抵消新增长度。

**参考表述**（替换第 58 行）：

```markdown
需要作出进度判断时用 `subagent_list`。它列出整个工位的委派，同工位其他频道发起的也在其中（标 `started in <频道>`），同样可以管理；但它们完成时唤醒的是发起频道，不会唤醒你，不要等它们。运行中委派按工位合计最多 6 个、宿主共 20 个；满额时等待已有结果，不为腾名额取消仍有用的工作。
```

第 64 行第一句改为：

```markdown
结果只唤醒发起频道，且该频道仍须绑定在发起时的工位；换绑后不转投新工位，也不转给同工位的其他频道。
```

**待核对：** `subagent_run` 的 cancel / follow_up 不检查发起频道（如果有检查，按 D-F2 和 S8 的方式一并移除）；`MAX_RUNNING_SUBAGENT_RUNS_PER_DESK` / `PER_HOST`（`subagents/run-record.ts:212,215`）；`subagent_list` 的来源标签（`tools/subagent-manage.ts:67,142`）；完成唤醒的绑定检查（`subagents/runs.ts` 中的 D8 分支）。

#### `background-jobs.md`

**必须表达：** 作业属于当前工位，同工位各频道都能查看和取消；别的频道发起的标 `started in <频道>`；完成通知只回发起频道，且该频道仍须绑定本工位，所以不要等别的频道的作业；限额按工位合计。

**参考表述**（替换第 10 行）：

```markdown
作业属于当前工位，同工位各频道都能查看和取消，别的频道发起的在 `job op=list` 里标 `started in <频道>`。完成通知只回发起它的频道，且该频道仍须绑定本工位，所以不要等别的频道的作业。绑定到任务的作业记在该任务的看板上。
```

第 30 行改为“运行中作业按工位合计最多 5 个；……”。

**待核对：** `MAX_RUNNING_JOBS` 按每个工位的 `DeskJobManager` 计数（`jobs/manager.ts:83,262`）；工具说明（`tools/job.ts:72-77`）。

#### `event-scheduling.md`

**必须表达：** 事件文件、数量上限和触发历史按工位计；工位内任何频道都能查看、修改、删除任何事件（S8 之后）；触发结果送到事件的投递频道，也就是创建事件时的当前频道，修改不会改变它；投递频道换绑离开本工位后，期间的触发不会投递到任何频道，切回后恢复；不能靠改绑定让它投递。第 27 行“投递频道由 runtime 绑定为当前频道”要随之写清：新建的事件投递到当前频道，更新保留原投递频道。

**参考表述**（替换第 10 行）：

```markdown
事件文件在当前工位的 `events/`，工位内任何频道都能管理，数量上限和触发历史也按工位计。触发时，消息或任务实例送到事件的投递频道：新建时是当前频道，之后的修改不会改变它。这个频道换绑离开本工位后，期间的触发不会投递到任何频道，切回后恢复；不要靠改绑定让它投递。
```

第 55 行改为：

```markdown
事件名字不确定时先 list；已知名字直接操作。列表包含本工位的全部事件，投递到别的频道的会标注投递目标；无法解析的文件也会列出，可以删除，但用途不清楚时先问用户。停用、闭环或改期时及时清理临时事件。
```

**待核对：** S8 实施后的 update / delete 行为（`tools/event-manage.ts`）；`MAX_EVENT_FILES`（`events/validation.ts:32`）；未绑定时在 preAction 之前就跳过（`events/watcher.ts:517`）；工位休眠时 watcher 停止。参考表述有意没有写一次性事件过期后的补触发行为。如果要写，必须先从 `watcher.ts` 的启动扫描确认实际行为。

#### `task-lead.md`

**必须表达：** 任务属于当前工位，但有自己的会话，不是哪个频道聊天的延续；`report` 和回执只发到投递频道（立项时的频道，或生成它的事件的投递频道）；投递频道离开本工位时任务整体暂停，切回后继续，不会转到新工位；`task_list` 也列出同工位其他频道建的任务（`deliversHere` 标出投递到这里的），同样可以管理，管理不改变它们的投递频道（D-F2）。新段落的长度不能超过它替换的第 12 行太多，§4.3 的合并预算是给这份手册和 `agent-delegation.md` 共用的。

**参考表述**（替换第 12 行）：

```markdown
任务属于当前工位，但有自己的会话，不是哪个频道聊天的延续；`report` 和回执只发到任务记录的投递频道（立项时的频道，或生成它的事件的投递频道）。投递频道换绑离开本工位时任务整体暂停，切回后继续，不会转到新工位。`task_list` 也列出同工位其他频道建的任务（`deliversHere` 标出投递到这里的），同样可以管理，但结果仍发往各自的投递频道。
```

**待核对：** `tasks/create.ts:18` 的投递频道来源；`task-driver.ts:360` 的过滤；`tools/task-manage/factory.ts:58` 与 `lifecycle.ts:84` 的 `deliversHere`。

#### `outbound-media.md`

**必须表达：** `send_media` 只发到当前频道；文件放在工位里，不等于同工位的其他频道会收到；模型不能指定其他收件频道。

**参考表述**（替换第 10 行第一、二句）：

```markdown
`send_media` 只发到当前频道。文件放在工位里，不代表同工位的其他频道会收到；你也不能指定别的收件频道。
```

**待核对：** `tools/send-media.ts:23-26,90` 绑定的 `channelId`；任务步骤里“当前频道”实际是哪个频道，核对后再决定是否需要补一句。

#### System prompt 与回合上下文

- `sections.ts:69` 改为 “Jobs and delegations you start wake this channel on completion.”，其余不变。该 section 的 `maxChars` 是 700，改完由测试确认不超限。
- `<runtime_turn_context>`（`turn-context.ts`）保持现状，不列出工位的其他绑定（058 的决策仍然有效）。

#### 发布与同步

- `docs/runtime-playbooks.md` 的目录表和门控说明保持与 frontmatter 一致（`test/playbooks.test.ts` 会对账）。
- 改完运行 `npm run build`，确认 `dist/playbooks/` 是当前正文，没有退役文件。

## 5. 代码收窄方案

S1–S7 都不能改变外部行为。S8 是有意的行为变更，单独提交。

### S1：统一“没有可用工位”的回复

**现状：** “未绑定 / 绑定的工位不可用”的同一个三元表达式写了三遍：`runtime/turn-handler.ts:234`、`:315`，`runtime/turn-run.ts:483`。060 之后，人工发消息的频道只在默认工位不可用、自动接入失败时才会处于未绑定状态，两种情况对用户来说都是“本频道没有可用的工位”。

**方案：**
- 在 `desk/commands.ts` 提供一个 `formatNoDeskReply(resolution)`，参数取 `ChannelResolution` 中非 `bound` 的两个分支（或者一个等价的结构类型，避免 desk 层反向依赖 runtime 的类型），替换上面三处，内部仍然区分两种情况的措辞（C1）。
- `commands/router.ts` 的 `UnboundCommandContext` / `kind: "unbound"` 改名为 `NoDeskCommandContext` / `kind: "no-desk"`，因为它也覆盖“不可用”的情况。
- `DeskRuntime` 内部的 `ChannelResolution` 保留 `unbound` 和 `unavailable` 两个分支，日志和生产者侧仍需要区分它们。
- `turn-run.ts:520-527` 用于日志的 `boundDesk` 嵌套三元，改用一个小的局部函数或 `deps` 已有的查询。

### S2：一条合成事件准入规则

**现状：** “合成事件带有 desk，且它的频道仍绑定在这个工位上”这条规则写成了四种形态：`turn-run.ts:517`（权威检查）、`turn-handler.ts:481`（`reserveEvent`）、`wake-coalescing.ts:32`（合并）、`DeskRuntime.isBoundTo`。058 评审 R1 当时就建议“封成纯判断，供单条准入和合并复用”，只完成了一半。

**方案：** 在 `runtime/` 里定义一个纯函数，例如 `admitsSyntheticEvent(resolution: ChannelResolution, event: ChannelEvent): boolean`，放在 `desk-runtime.ts` 或新建的小文件中（遵守 800 行预算）。`runEventTurn` 和 `reserveEvent` 都改用它。`canAbsorbWake` 保持“候选必须和已准入的主事件属于同一工位、且 desk 不能缺失”，注释写明它依赖主事件已通过 `admitsSyntheticEvent`；如果调用点能拿到 resolution，也可以直接复用这个函数。

**风险：** 这是准入逻辑。要求按 §7.2 做 mutation check。

### S3：工位创建只保留一层

- 删除 `desk/registry.ts:156` 的 `createDesk`：它只是把同步的 `createDeskRecord` 包了一层 async。`DeskRuntime.create`（`desk-runtime.ts:226`）和 `tui/app.ts:100,244` 改为直接调用 `createDeskRecord`（必要时用 `Promise.resolve` 包装以满足端口签名）。
- 初始化时 `initializeBindings` 会执行两次：`desk/default.ts:8` 一次，`createDeskRecord` 内部又一次。这两次是幂等读，可以保留；如果要去掉，必须保证“绑定表先于第一个工位发布”的顺序和竞态保护不变（060 §5.2），否则就保留并在注释里说明原因。
- 统一 JSON 缩进：`bindings.ts:79` 和 `registry.ts:136` 用两个空格，`writeBindings` 和 `writeJson` 用 tab。统一成一种，这只影响新写入文件的格式。

### S4：工位布局集中到 `desk/paths.ts`

**现状：** 060 §5 要求“不在各调用者手写目录前缀”，但工位内部的子路径仍然散落在各处：

| 路径 | 写在哪里 |
|---|---|
| `conversations` | `memory/session-corpus.ts:281,334`（`desk/paths.ts` 已有 `getConversationsDir` / `getConversationDir`） |
| `inbox` | `runtime/inbound-images.ts:34`、`agent/turn/turn-input.ts:35`（重复） |
| `logs` | `tools/bash.ts:28`、`jobs/manager.ts:1012`（重复） |
| `subagent-artifacts` | `subagents/dispatch.ts:34` |
| `.memory-work` | `memory/boundary-work.ts:31` |
| `subagent-runs.jsonl` | `channel/store.ts:157`、`memory/session-corpus.ts:47` |
| `.locks/task-*.lock` | `tasks/mutation-lock.ts:23` |

**方案：** 在 `desk/paths.ts` 增加对应的路径函数（如 `getDeskInboxDir`、`getDeskLogsDir`、`getSubagentArtifactsDir`、`getMemoryWorkDir`、`getSubagentRunsLogPath`），由 memory、runtime、agent、tools、jobs、subagents、channel 调用；按 AGENTS.md 的模块表，这些模块都允许依赖 desk。磁盘上的名字不变。

**例外：** `tasks/` 位于第 2 层，和 `desk/` 同层，模块表不允许它依赖 desk。不要为此给 `tasks/mutation-lock.ts` 加依赖，也不要放宽架构规则：在它的注释里注明 `.locks` 目录名必须和 `desk/paths.ts` 的 `LOCKS_DIRNAME` 保持一致即可。

**同步文档：** 把 `inbox/`、`logs/` 补进 AGENTS.md 和 060 design §3 所说的工位文件清单。AGENTS.md 由 `npm run arch` 的 R5 检查文件引用；design.md 是设计记录，只在 §8 的实施交付记录里补一句，不改正文结构。

### S5：`EventHistoryRecord.desk` 改为必填

watcher 每次都会写 `desk`，060 也删除了旧记录的读取。把 `events/types.ts:64` 改成必填，删掉过时注释（D3），检查类型改动引起的所有调用点。`ChannelEvent.desk` 仍然保持可选：钉钉入站消息本来就不带它，这是结构上的需要，不是兼容遗留。

### S6：统一“已有工位目录”的判断

`desk/bindings.ts:65` 在判断“是否已有工位”时把符号链接也算进去，`desk/registry.ts:113` 的 `listDesks` 只算目录。两处统一成同一个判断，抽成一个小函数供两处共用。不确定选哪种时，选与 060 §3.3（只识别 workspace 下 `desk-` 前缀的直接子目录）一致、且对“有工位但缺绑定表”的保护更保守的那一种，并在提交说明里写明。

### S7：让 spec 058 的引用继续有效

代码注释中大约有 60 处引用 “spec 058, D*/INV-*”，而 058 已被 060 取代，正文仍在讲 dot。不要批量改写这些注释。在 060 的 design.md §8 之后增加一个小节“仍然有效的 058 决策与不变量”，用一张表列出这些编号的当前含义（用 desk 术语），例如 INV-3：频道 id 永远不能成为路径的一段；INV-8：记忆写入按工位串行；D7：合成事件只在频道仍绑定其工位时准入。这样现有引用依然成立，读者也不会被带回 dot 的语境。编号和含义以 058 design.md 的原文为准，逐条核对，不要凭记忆写。

### S8：移除事件的频道归属检查（有意的行为变更）

**现状：** `event_manage` 的 update 和 delete 会先调用 `readOwnedEvent`（`tools/event-manage.ts:256-268`，调用点在 `:324`、`:360`）。如果事件投递到同工位的另一个频道，就报错 “delivers to another channel of this desk and cannot be modified from here”；list 也把这些事件标为 “read-only here”（`:167`），工具说明里同样写着只读（`:85`）。这种检查等于在工位内部按频道做隔离，与 D-F2 冲突。作业、委派、任务在代码里都没有类似限制，事件是唯一的例外。

这条限制原本的理由，是“修改事件会把投递频道改成调用者的频道”（`:256` 的注释）。真正需要的不是限制谁能改，而是让修改不改变投递频道。

**方案：**

- **update：** 读出已有事件，保留它的 `channelId`，只替换定义的其余部分。`validateDefinition` 现在固定用调用者的 `options.channelId` 作为投递频道（`:203-208`），并对调用者执行 `assertBackgroundDeliverable`（`:189`）；改为接收一个“投递频道”参数：create 传当前频道，update 传已有事件的频道，后台投递检查也针对这个投递频道。已有文件无法解析时，update 拿不到原投递频道，此时报可恢复错误，提示先 delete 再 create。
- **delete：** 不再检查归属，直接按名字删除本工位 `events/` 下的事件文件，包括无法解析的文件。路径仍由 `resolveEventPath` / `resolveSafeIdPath` 限定在本工位内。
- **list / show：** 保留“投递到哪个频道”的标注，删掉 “read-only here”。
- **工具说明：** 改为“列出、查看、创建、修改、删除本工位的事件；新建的事件投递到当前频道，修改保留原投递频道”。
- 删除 `readOwnedEvent`，不要留下空壳。用户命令 `/events delete` 本来就没有这层检查，不需要改。
- 文档同步：`docs/events-and-tasks.md` 的事件管理说明、`event-scheduling.md`（§4.4），以及 CHANGELOG。

**不改：** 事件的投递语义、准入（`channel_not_bound`）、数量上限、preAction 守卫。

## 6. 实施顺序

在新分支上进行（例如 `fix/desk-followup`）。每个阶段单独提交，使用 conventional commit，不加任何署名 trailer（见 CLAUDE.md）。

| 阶段 | 内容 | 建议的提交主题 | 门禁 |
|---|---|---|---|
| P1 代码卫生 | D1–D9、S3、S4、S5 | `refactor: name desk memory and paths consistently, drop stale dot-era comments` | `npm run check` |
| P2 结构收窄与用户文案 | S1、S2、S6、C1–C5 | `refactor: share the no-desk reply and the synthetic-wake admission rule` | `npm run check`、`npm run test:e2e`、S2 的 mutation check |
| P2b 工位内共享管理事件 | S8 | `feat: let any channel of a desk manage its events` | `npm run check`、`npm run test:e2e`、S8 的 mutation check |
| P3 Playbook 与模型指导 | B1–B8，按 §4 执行 | `docs(playbooks): restate desk scope for one assistant with shared desks` | `npm run check`、`npm run playbooks:measure`（满足 §4.3）、`npm run build`、§7.3 的评测 |
| P4 对外资料与记录 | A1–A11、S7，README.en 重写，CHANGELOG | `docs: align guides, changelog and English README with desks` | `npm run check`；人工检查文档链接与锚点 |

P4 放在最后，是为了让 CHANGELOG 和文档反映 P1–P3 最终的文案和行为。

**CHANGELOG `[Unreleased]` 的内容要求：**

- Breaking：desk 取代 dot（目录 `workspace/desk-<name>/`、`desk.json`、根目录的 `desk-bindings.json`、`/desk`、`tui --desk`）；只有一套人格，工位目录中的 SOUL/AGENTS 不再替换根文件；启动时初始化 `default`，获准的新频道自动接入；公开的 `ChannelEvent` 类型中 `dot` 字段改为 `desk`；迁移脚本已删除，升级须按 `docs/desk-migration.md` 在停机状态下离线完成；不提供 `/dot`、`--dot` 的别名。
- 删除原 Unreleased 中与 060 矛盾的条目：dot 级 SOUL/AGENTS 覆盖、“只有一个 dot 时自动打开”；把 `dot.json` 的 `cwd` 改写为 `desk.json` 的 `cwd`。
- 保留仍然成立的条目：终端拒绝 `task_create` 和创建事件、`task_list` 显示投递频道、死代码清理；用 desk 术语重写它们。
- Changed：同工位任何频道都可以修改和删除事件（S8），修改保留原投递频道。
- `[0.9.5-beta.1]` 及更早的条目属于历史记录，不改。

**提交说明：** P2 写明 S2 的 mutation 证据，P2b 写明 S8 的行为变化和 mutation 证据；P3 写明各手册改动前后的 units，以及评测的 run id 或未执行的原因。按 AGENTS.md，任何单测或 e2e 用例数量的变化都要报告。

## 7. 验证与验收

### 7.1 测试数量

按 AGENTS.md 的规定，默认单测和确定性 e2e 都不净增。本次所有改动都应通过扩展或更新现有用例来覆盖：

- D2 的改名只改导入，不改用例数量。
- S1 由 `test/user-copy-shape.test.ts` 和现有 runtime 用例覆盖。
- S2 由现有的 wake-coalescing / desks / structured-wake 用例覆盖（见 §7.2）。
- S5、S6 由类型检查和现有 registry 用例覆盖。
- S8：`test/event-manage.test.ts:297`（rejects updating an event owned by another channel）和 `:319`（refuses to delete …）锁定的是被移除的旧契约。把这两个用例改写成新契约，用例数量不变：从另一个频道 update 后，事件内容更新而投递频道保持原值；从另一个频道 delete 能成功删除。

不要新增断言 playbook 或用户文案具体措辞的测试，也不要用“全文不含 dot”这类检查当作语义正确的证据。

### 7.2 S2 的 mutation check

改完后临时把 `admitsSyntheticEvent` 里的工位相等判断删掉，再运行 `npx vitest run test/wake-coalescing.test.ts` 和 `npm run test:e2e`。至少要有一个现有用例变红：合成事件被送进了已换绑的工位，或者旧工位的唤醒被合并进新工位的回合。如果没有任何用例变红，说明现有覆盖有缺口：按 AGENTS.md 扩展最接近的现有场景（优先 `test/e2e/deterministic/desks.test.ts` 或 wake-coalescing），在提交说明中写明缺口和用例数量变化。验证完恢复实现。

**S8：** 临时让 update 改用调用者的频道作为投递频道（也就是恢复旧的覆盖行为，但不加归属检查），改写后的 update 用例必须变红；再临时恢复 delete 的归属检查，delete 用例必须变红。验证完恢复实现。

### 7.3 行为评测（P3）

Playbook 和 system prompt 的改动会影响模型行为。按 060 §10 的做法：

1. 运行 `npm run eval -- plan --changed-since <P3 之前的提交>`，记录选中的范围和预算。
2. 有本机凭据时，运行每日的六个 dev 案例，记录 run id、控制组结果和失败归因；凭据不可用时如实记录“未执行”，不能视为通过。
3. D-F1（多人共享记忆时的归属）和 D-F2（别的频道的工作不会唤醒自己）目前没有专门的探针。新增评测案例会产生持续成本，需要用户单独批准。本次在验收记录里把它们列为“未覆盖”，并附上建议的探针设计：一个探针是工位里存着 A 的偏好，B 在群里提出相反要求，看模型是否把两人的偏好区分开；另一个是 `job op=list` 里只有别的频道发起的作业在跑，看模型是否结束回合去“等它唤醒”。

### 7.4 验收表

| 验收项 | 证据 |
|---|---|
| 当前文档、playbook、用户文案、代码注释不再用 dot 时代的含义描述工位 | 用下面的检索清单逐条人工分类，结果写入交付记录 |
| §2.2 术语表被一致使用 | 同上；重点核对“工作区”“默认助手”“渠道”“频道索引” |
| 七份 playbook 满足 §4.4 的“必须表达” | 逐份对照，`playbooks:measure` 满足 §4.3 |
| 用户文案符合 spec 053 | `test/user-copy-shape.test.ts` |
| S1–S7 没有改变外部行为 | `npm run check`、`npm run test:e2e`；S2 的 mutation 证据 |
| S8：工位内任何频道都能修改、删除事件，修改保留投递频道 | 改写后的 `test/event-manage.test.ts` 用例与 S8 的 mutation 证据 |
| 当前资料和 playbook 里没有工位内按频道隔离的规则 | 人工核对，重点查“只读”“不能修改”“需要发起频道”一类措辞 |
| 正式构建产物里是当前手册 | `npm run build` 后对比 `dist/playbooks/` |
| CHANGELOG 中英文同步，并如实记录 060 的破坏性变更 | 人工核对 |
| 评测按 §7.3 执行或如实记录未执行 | run id 或说明 |

**检索清单**（只用于辅助人工分类，不写成测试）：

```bash
rg -n -i '\bdots?\b' src docs/*.md README*.md AGENTS.md CLAUDE.md test evals
rg -n '\p{Han} 工位|工位 \p{Han}' src docs/*.md README*.md
rg -n '渠道' src docs/*.md README*.md
rg -n '默认助手|个人助手|personal assistant|隔离工作区' src docs/*.md README*.md
rg -n '工作区' README.md docs/interaction-and-commands.md docs/scaling-and-concurrency.md src
rg -n 'ChannelIndexFor|CHANNEL_INDEX_MAX|channelIndex' src test
rg -n 'spec 058|before spec|written before|older than' src
```

前两条在 `docs/desk-migration.md` 和历史 spec 中的命中是预期的；“个人助手”用来指 Pipiclaw 本身时也是合法的。

## 8. 范围之外

- 不改落盘格式、绑定语义和准入行为；S1–S7 只是代码收窄，S8 只移除一项工位内的频道限制。
- 不新增命令、配置、权限检查或记忆 schema 字段，也不在工位内新增任何按频道的隔离。
- 不改历史 spec、`docs/reviews/`、已发布的 CHANGELOG 条目和评测证据。
- 不处理 spec 050 的 `source: "migrated"` 记忆来源、`memory: session|relevant` 角色字段映射等与 desk 无关的兼容逻辑。
- 不迁移真实部署，不启动正式 daemon，不向钉钉发送消息。

## 9. 交付记录

2026-10-24，分支 `fix/desk-followup`，五个阶段各一次提交。

| 阶段 | 提交 | 结果 |
|---|---|---|
| P1 代码卫生 | `refactor: name desk memory and paths consistently, drop stale dot-era comments` | D1–D9、S3–S6 完成；`npm run check` 通过 |
| P2 结构收窄与用户文案 | `refactor: share the no-desk reply and the synthetic-wake admission rule` | S1、S2、C1–C5 完成；`npm run check` 与 `npm run test:e2e` 通过 |
| P2b 工位内共享管理事件 | `feat: let any channel of a desk manage its events` | S8 完成；`npm run check` 与 `npm run test:e2e` 通过 |
| P3 Playbook 与模型指导 | `docs(playbooks): restate desk scope for one assistant with shared desks` | B1–B8 完成；`npm run check`、`npm run playbooks:measure`、`npm run build` 通过 |
| P4 对外资料与记录 | `docs: align guides, changelog and English README with desks` | A1–A11、S7 完成；`npm run check` 通过 |

**用例数量：** 单测 918 → 918，确定性 e2e 63 → 63（25 个文件）。S8 改写了 `test/event-manage.test.ts` 里锁定旧契约的两个用例；D2、S3 只改导入和调用。

**mutation 证据：**

- S2：删掉 `admitsSyntheticEvent` 里的工位相等判断，`test/bootstrap-structured-wake.test.ts` 的重绑用例和 e2e `DESK-3` 变红；恢复后全绿。现有覆盖足够，没有扩展用例。
- S8：让 update 改用调用者的频道作为投递频道，update 用例和“重写旧 immediate 事件”用例变红；恢复 delete 的归属检查，delete 用例变红。均已恢复。

**S6 的选择：** `listDesks` 与“workspace 已有工位”保护共用 `isDeskEntry`，两处都接受指向目录的符号链接。理由：`createDeskRecord` 用 lstat 判断“已存在”，保护缺失绑定表的一侧更保守。

**Playbook units（改前 → 改后）：** runtime-orientation 1,438 → 1,591；memory-and-learning 1,155 → 1,238；agent-delegation + task-lead 4,409 → 4,361；background-jobs 579 → 605；event-scheduling 1,162 → 1,196；outbound-media 478 → 483；七份合计 9,221 → 9,474（上限 9,500）。

**行为评测：** `npm run eval -- plan --changed-since c9aa759` 选中 12 个案例；本机有凭据，运行每日六个 dev 案例：run `2026-10-24T03-24-46-070Z-yj49oa`，6/6 通过，0 行为失败、0 安全违规，约 $0.05（`openai-codex/gpt-5.6-luna`）。这是 smoke，不构成基线。

**未覆盖项**（新增评测案例有持续成本，需用户批准）：

- D-F1：工位里存着 A 的偏好，B 在群里提出相反要求，看模型是否把两人的偏好区分开。
- D-F2：`job op=list` 里只有别的频道发起的作业在跑，看模型是否结束回合去“等它唤醒”。

**检索清单分类：**

- `\bdots?\b` 在 `src`、`test`、`evals`、`AGENTS.md`、`CLAUDE.md`、`docs/*.md`、`README*.md` 中已无命中（`docs/desk-migration.md` 除外，属预期）。
- `\p{Han} 工位` / `工位 \p{Han}`：无命中。
- `渠道`：当前文档和 `src` 无命中；`docs/desk-migration.md` 与 `events-and-tasks.md` 已改为“频道”，“随渠道自动启用”（指传输前端）改为“随前端”。
- `默认助手|个人助手|personal assistant|隔离工作区`：剩下的命中都指 Pipiclaw 本身（两份 README 的“同一个个人助手”和 system prompt 的 “personal assistant”），属合法用法。
- `工作区`：剩下的命中都指 workspace 或 skills 目录。
- `ChannelIndexFor|CHANNEL_INDEX_MAX|channelIndex`：只剩 `ChannelIndex`（`CHANNELS.md`）的命中，工位记忆索引已改为 `memoryIndex`。
- `spec 058|before spec|written before|older than`：`spec 058` 的约 60 处引用都对应 D*/INV-*，已在 design.md §8.2 给出 desk 含义（补上了表中缺的 D9、D11）；`before spec`/`written before` 的两处命中（`shared/local-time.ts`、`jobs/record.ts`）与工位无关。
