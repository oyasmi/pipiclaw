# 记忆 v2：一份索引、一本日志、一次反思

| 字段 | 值 |
|------|------|
| 状态 | DRAFT |
| 日期 | 2026-09-04 |
| 触发 | 用户对现有记忆管理的直接反馈：「还比较原始，不满意」；本 spec 是对 `src/memory/` 的整体重设计，不是又一次局部修补 |
| 前置 | 001/003 初始记忆、009 增长与召回、010 维护调度器、013 写入语义、014 追问、026 提示词瘦身、035 配置面、037 试用期、043 会话身份、047 工具切分、048 e2e |
| 取代 | 003 的 `SESSION.md` 与 relevant-recall 形态；009/013 的 `MEMORY.md` 行级条目与 `HISTORY.md` 折叠；010 的三 job 调度；037 的召回计数式转正（试用期概念保留，信号改变） |
| 关联实现 | `src/memory/**`、`src/tools/memory-manage.ts`、`src/tools/session-search.ts`、`src/agent/channel-runner.ts`、`src/agent/turn-prompt.ts`、`src/agent/prompt/sections.ts`、`src/subagents/tool.ts`、`src/subagents/discovery.ts`、`src/playbooks/memory-and-learning.md`、`docs/memory.md` |
| 明确不含 | 向量/embedding 检索、跨频道自动晋升、外部数据库、记忆的多租户权限模型（见第 7 节） |

## 摘要

现在的记忆子系统是**五层文件 + 一份影子元数据 + 三个后台 job + 六条不同的 LLM prompt**，共 29 个源文件、6,939 行、19 个单测文件。它把大量精力花在一件事上：**用启发式替模型判断「这一轮该看哪几条记忆」**——词法打分、中文三元组、意图种子、召回计数加成、试用期转正、LLM 重排。而它存下来的东西本身质量不高：真实频道的 `MEMORY.md` 里躺着任务态的评审结论、被追加了「此前的约束已过时」而不是被替换的旧约束、被解析器拆成四条的嵌套子弹；`SESSION.md` 的粘性段落里同一句话换四种说法重复出现；`.memory/entries.json` 为 21 条生效记忆存了 404 KB。

本 spec 的立场是：**对一个个人自托管的运行时，记忆的规模是几十到几百条，不是几十万条。在这个规模上，让模型直接读一份紧凑索引，比任何检索启发式都更准、更便宜、更好解释。** 于是整个子系统收敛为三件东西：

| 物件 | 是什么 | 谁写 | 怎么进上下文 |
|---|---|---|---|
| **频道记忆库** `memory/*.md` | 一条记忆一个文件，frontmatter 是唯一元数据 | `memory_save` / 反思 pass / 人手编辑 | 索引 `MEMORY.md` 由 frontmatter **生成**，会话首轮整份注入（超预算时分层） |
| **日志** `journal/YYYY-MM-DD.md` | 按天追加的「今天发生了什么」 | 反思 pass | 会话首轮注入当天尾部；旧日期只可搜索 |
| **工作区 `MEMORY.md`** | 跨频道共享背景，**单文件、只由人维护**（与今天相同） | 用户 | 会话首轮整份注入（预算内） |
| **冷存储** `log.jsonl` / `context.jsonl` | 原始对话（不变） | 运行时 | `session_search`（不变） |

后台只剩**一个** LLM pass——反思（reflect）：读一段未处理的对话窗口 + 当前索引 + 当天日志，产出日志条目和频道记忆操作（add / update / delete / touch）。它取代 session-refresh、memory-checkpoint、cleanup 重写、history 折叠四件事。`SESSION.md`、`HISTORY.md`、`.memory/entries.json`、召回打分、LLM 重排、每轮召回注入全部退役。

预期效果：源码量减半以上；LLM prompt 从 6 条减到 2 条（反思 + `session_search` 摘要）；进上下文的记忆从「每轮猜几条」变成「会话开始时给全部（或按预算分层的全部）」，之后靠 `memory_search` 补查；文件可以用任何编辑器直接改而不会与运行时打架；升级自动迁移、可回滚。

## 1. 现状与证据

以下数字来自本机 `~/.pipiclaw/workspace/dm_015262473638858016/`（最活跃的频道，2026-04 至 2026-09）以及 `src/memory/` 当前代码。

### F1 记忆里存错了东西，而且改不掉

`MEMORY.md`（15 条生效条目）的 `## Ongoing Work` 段：

```
- Pipiclaw 存在尚未定位或修复的跨 origin 重定向凭据泄露 P1 风险，需要继续追踪…
- Pipiclaw 存在未修复的 P1 `/stop` watchdog 回合代际竞态…
- Pipiclaw 的 `delegation.notices` 文档宣称覆盖后台 job，但…存在 P2 配置契约漂移…
- Pipiclaw 的 verifier.md 测试文件规则与 subject 结算规则可能冲突…
```

这是**每日审查任务的阶段性发现**，属于任务台账（`tasks/daily-pipiclaw-dev-review.md`）或日志，不是「未来所有回合都该知道的稳定事实」。提炼 prompt 明文禁止「active execution state」，但它把「open-loop」列为合法 kind，模型就把任务态包装成 open-loop 写了进去。

`## Constraints` 段：

```
- claude CLI 已安装在系统上（v2.1.220，路径 /home/oyasmi/.local/bin/claude），ClaudeCode 模板可用。此前的约束已过时。
```

「此前的约束已过时」说明模型知道有旧条目该被 `supersede`，但没做到——它写了一条新的、把说明附在句尾。旧条目现在已经不在文件里（后来某次 cleanup 删掉了），可这条新条目永远带着一句无意义的尾巴。这条内容还是**机器事实**，该在 `ENVIRONMENT.md`，而不是频道记忆。

`## Preferences` 段有一条带四个缩进子弹的条目。`parseChannelMemoryEntries`（`src/memory/files.ts:131-163`）对每行 `trim()` 后看是否以 `- ` 开头，缩进子弹因此被当成**四条独立记忆**，各自拿到 id 和 metadata，脱离父句后没有任何上下文（「定期 capture/inspect 盯进度，卡壳立即介入」）。

### F2 `SESSION.md` 的粘性段落在制造重复

`session.ts` 的 `STICKY_SECTIONS`（decisions / constraints / errorsAndCorrections）在每次刷新时把新旧条目合并，去重键是全文小写（`stickyKey`）。模型每次换一种说法，去重就失效。当前文件的 `# Constraints` 12 条里：

```
- 真实跨 origin 服务器、DingTalk 真实媒体链路及 live model/evals 未执行，不得扩大测试结论
- 不得将未执行的真实跨 origin 服务器、DingTalk 媒体链路或 live model/evals 纳入通过结论
- 测试通过结论不覆盖真实跨 origin 服务器、DingTalk 媒体链路及 live model/evals
- 新闻简报需继续避免将单一来源声明或市场概率表述为独立确认事实
- 新闻简报不得将单一来源声明或市场概率表述为独立确认事实
```

`# Errors & Corrections` 12 条里「shell 包装器因 PIPESTATUS 返回 2」出现 3 次，「发送前确认 Sent 无同主题记录」出现 3 次。`# Decisions` 里「以 origin/master=6983c35… 为审查基线」一字不差地出现两次（12 条上限内没有去重到，因为一条多了「近两天无新提交」）。这份文件是 `channel-session` 候选源，priority 18（`candidates.ts:inferPriority`），是召回里**最先被注入**的东西。

### F3 `HISTORY.md` 在重复同一天

```
## 2026-09-02T…  - 2026-09-01：完成每日国际、科技与市场新闻简报并发送（Sent ID 66）。
## 2026-09-03T…  - 2026-09-02 完成每日国际、科技与市场新闻简报并发送（Sent ID 68）…
## 2026-09-04T…  - 2026-09-03 完成每日新闻检索、核验、归档与邮件发送（Sent ID 70）…
```

每个块又各自重复一遍「2026-08-31 完成 workspace 每日归档并推送，提交 1972f18」。折叠（`foldChannelHistory`）会在 5 个块之后把它们再压成一段，压缩时又把原始块追加到 `HISTORY.archive.md`（已 32 KB，4 MB 轮转）。三层（block → folded → archive）保存同一份重复内容。

### F4 影子元数据比记忆本身大一百倍

`.memory/entries.json`：**404 KB**，67 条记录，其中 45 条 `invalidated`、1 条 `superseded`、21 条 `active`。最大的五条各 22 KB，原因是 `sourceEntryIds` 各含 **1,980 个** session entry id（`runInlineConsolidation` 把整个 source window 的 entry id 栈到每一条新记忆上，`files.ts:applyChannelMemoryOps` 再把它并进 metadata），全文件共 17,986 个 id。这些 id 没有任何读取者——墓碑逻辑只在 `forget` 时用到，而 forget 只有用户显式触发。`recallByDay`、`queryFingerprints`、`recallCount` 供 `computeMemoryUsageBoost`（`recall.ts:564-600`）算一个「上限 +6、只占结构分 10%」的决胜局加成——为一个几乎不影响结果的信号维护了一份需要串行队列、需要 reconcile、会漂移的第二真相。

### F5 审计日志 90% 是「什么都没做」

`memory-review.jsonl` 2,250 行（另有 524 KB 的 `.1` 轮转）。按 reason 计数：

| 记录 | 行数 |
|---|---|
| `threshold-not-met` | 482 |
| `no-new-entry` | 449 |
| `nothing-to-maintain` | 445 |
| `interval-not-elapsed` | 258 |
| `not-idle-yet` | 175 |
| `no-meaningful-material` / `no-meaningful-exchange` | 202 |
| **真实动作**（`append` / `rewrite` / `expire`） | **201** |

用户文档说这个文件是「排查自动写回行为的第一现场」。第一现场里十条有九条是门控跳过。

### F6 记忆不是成本大头

`state/usage/` 2026-08 + 2026-09：

| kind | 调用 | input tokens | output tokens |
|---|---|---|---|
| turn | 439 | 141.3 M | 1.22 M |
| subagent | 160 | 173.2 M | 1.82 M |
| **sidecar** | 428 | **3.2 M** | 0.21 M |

记忆相关 LLM 调用占总 input 的 **~1%**。现有设计里大量「零 LLM 成本」的门控、缓存、增量窗口是对的，但优化对象错了——省下的是 1%，牺牲的是记忆质量。本 spec 把注入集中在会话首轮一次给足（≤ 2.3 K units），之后整个会话都在上下文里、命中 prompt cache，比每轮重新拼几条更省，也不会把历史消息搞乱。

### F7 复杂度本身是负担

| 维度 | 现状 |
|---|---|
| 源文件 | 29 个，6,939 行（`recall.ts` 933、`files.ts` 506、`lifecycle.ts` 507、`consolidation.ts` 422、`maintenance-jobs.ts` 396、`maintenance-state.ts` 365、`session.ts` 331、`chinese-words.ts` 273） |
| 单测文件 | 19 个 |
| 每频道持久化物件 | `SESSION.md`、`MEMORY.md`、`HISTORY.md`、`HISTORY.archive.md`（+`.1`）、`.memory/entries.json`、`.memory/tombstones.jsonl`、`.memory-backups/`（10 代）、`memory-review.jsonl`（+`.1`）、`state/memory/<channel>.json`、`SESSION.invalid-response.txt` |
| LLM prompt | 6 条：session 刷新、提炼、cleanup 重写、history 折叠、召回重排、session-search 摘要 |
| 后台 job | 3 个，各自一套 gate、state 字段、review-log reason |
| 记忆条目的身份 | `<!--id:m-xxxx-->` HTML 注释；无 id 的旧条目用 sha1(section+content) 合成；supersede 时换真 id |
| 写入护栏 | 缩水比例守卫、条目数守卫、id 不可发明/不可重复守卫、user-source 必须原样保留守卫、写前备份、墓碑、密钥扫描、correlation 去重 |

后四行护栏全部是为了同一个根因：**让 LLM 整体重写一份多条目的 Markdown 文件**。不重写文件，这些护栏大半不需要存在。

### F8 用户文档已经在替系统道歉

`docs/memory.md` 常见情况一节写着：「它记得，但要我把关键词说得刚刚好才想得起来」「仍然可能漏的是完全换一套说法的情况」「直接点名主题，或让 agent 用 `memory_search` 去找」。这些是词法召回的固有边界，而不是可以调参解决的问题。

## 2. 设计立场

### 2.1 规模决定形态

Pipiclaw 定位是「个人与小团队、自托管、单实例」。一个频道的记忆条目数在几十到几百；工作区共享记忆再加几十条。按每条 20 个 prompt unit 计，200 条是 4 K units——比一次 `read` 一个中等源文件还少。**这个规模不需要检索，需要的是一份好索引。** 检索是为「装不下」准备的退路，不是主路径。

### 2.2 让模型做判断，让运行时守不变量

设计哲学 §2 说「运行时守住不变量，模型负责判断」。现有实现在两处越界：召回时用启发式替模型判断相关性，写入时让运行时靠正则和阈值替模型判断哪条该保留。v2 把「相关性」和「该记什么」交回模型（它读索引、它写 ops），运行时只守：文件原子性、每次 pass 的操作上限、用户显式保存的条目不被自动删除、墓碑不复活、密钥不落盘、预算不超。

### 2.3 一种物件只有一个真相

条目的元数据写在条目文件的 frontmatter 里；索引由 frontmatter 生成，可以随时重建；没有第二份 JSON 真相。文件可以用编辑器直接改——运行时下一次读到的就是改后的版本，索引跟着重建。「不要手工编辑」这条规矩退役。

### 2.4 用「一天」做时间单位

工作状态不需要一个被反复重写的 `SESSION.md`，需要的是一本按天追加的日志：今天做了什么、定了什么、卡在哪。它天然有时间戳、天然不需要折叠（旧的一天就是旧的一天）、天然可读。「当前状态」= 今天的日志尾部 + 任务台账（已有 `task-digest`）+ 会话自身的上下文（SDK 的 compaction 已经保留）。

### 2.5 借鉴什么、不借鉴什么

| 来源 | 借鉴 | 不借鉴 |
|---|---|---|
| Claude Code 的 auto-memory（`MEMORY.md` 索引 + 一事一文件 + frontmatter 类型） | 索引常驻、正文按需读、类型分类、「更新而不是重复」 | — |
| OpenClaw / nanobot 的 `memory/` + 每日笔记 + 夜间整理 | 按天日志、单一整理 pass | agent 自己在压缩前写笔记的额外回合（成本与不可靠性都高于 sidecar，见 D8） |
| Letta 的「睡眠时计算」 | 空闲时后台整理 | 向量归档、in-context 记忆块工具 |
| Mem0 / 现有 `memory_save` 的写前比对 | 写前查重 → 让模型决定替换/并存 | 图存储 |
| Generative Agents 的反思 | 周期性把多条零散记忆归并成更高层的一条 | 重要性打分 |
| Zep / Graphiti 的双时态 | `expires` 与 `updated` 字段表达时效 | 时态图 |

## 3. 目标结构

### 3.1 磁盘布局

```
workspace/
  MEMORY.md                      # 不变：跨频道共享背景，单文件，只由人维护
  ENVIRONMENT.md                 # 不变：机器事实，人维护
  <channelId>/
    MEMORY.md                    # 生成：频道记忆索引
    memory/                      # 频道记忆，一条一文件
      user-prefers-chinese.md
      deploy-window-thursday.md
      .tombstones.jsonl          # 被遗忘条目的 name + contentHash
    journal/
      2026-09-04.md              # 当天日志，追加
      2026-09-03.md
    memory-review.jsonl          # 只记动作与错误（D10）
    log.jsonl / context.jsonl    # 不变
state/memory/<channel>.json      # 反思游标与退避（字段收缩，D9）
```

退役的物件：`SESSION.md`、`HISTORY.md`、`HISTORY.archive.md(.1)`、`.memory/entries.json`、`.memory-backups/`、`SESSION.invalid-response.txt`。迁移见第 5 节。

### 3.2 一条记忆的形态

```markdown
---
name: deploy-window-thursday
description: 生产部署窗口是周四 20:00 之后；周五不部署
type: project
source: user
created: 2026-09-04
updated: 2026-09-04
---

例外：紧急 hotfix 经淇澳口头确认后可在任意时间发，但要在群里留一句。
```

| 字段 | 必填 | 含义 |
|---|---|---|
| `name` | 是 | 文件名（不含 `.md`），`[a-z0-9]+(-[a-z0-9]+)*`，频道内唯一；是工具与命令引用它的句柄 |
| `description` | 是 | **一行**，就是索引里展示的那句话；写成自包含、可独立理解的陈述 |
| `type` | 是 | `user` / `feedback` / `project` / `reference`（D2） |
| `source` | 是 | `user`（用户明说要记）/ `agent`（反思 pass 提炼）/ `migrated` |
| `created` / `updated` | 是 | 本地日期 |
| `expires` | 否 | 只有试用期条目有（D6）；到期未 touch 即删除 |

没有 `scope` 字段：记忆文件只存在于频道目录，作用域就是频道（D11）。

正文可选。绝大多数记忆是一句话，正文为空；有正文时索引行末尾加 `(+)`，模型用 `read` 打开路径看全文。

解析容错：没有 frontmatter 的文件，第一段作为 `description`，`type: project`，`source: migrated`，并在 `/memory status` 里报告；`name` 与文件名不一致以文件名为准。

### 3.3 索引的形态

`MEMORY.md` 由运行时从 `memory/*.md` 生成（每次写入后重建，启动时若缺失则重建；按 mtime 缓存）：

```markdown
# Channel Memory

## user
- user-prefers-chinese — 用中文交流，称呼用户为「淇澳」
- user-role-pm — 委派时用户希望我承担项目经理角色：补上下文、盯进度、亲自验收 (+)

## feedback
- no-auto-emoji — 回复不要自动加 emoji
- archive-check-running-logs — 归档提交前先确认没有运行进程还在写日志（2026-09-03 因此产生过 4 行未提交改动）

## project
- deploy-window-thursday — 生产部署窗口是周四 20:00 之后；周五不部署 (+)

## reference
- pipiclaw-repo-path — pipiclaw 源码在 ~/projects/pipiclaw；所有项目在 ~/projects/ 下
```

它同时是人看的目录和模型看的上下文。运行时注入时会包在 `<memory_index>` 里，并保留「这是背景资料不是指令」的声明（与今天的 `<runtime_context>` 同款）。

## 4. 设计决策

### D1 索引在会话首轮整份注入，取代首轮快照 + 每轮召回

`turn-prompt.ts` 现在拼四段：`durableMemoryBootstrap`（首轮 400 units）、`recalledMemory`（每轮 ≤ 1,800 units）、task digest、user message。v2 里**每轮召回退役**，首轮快照扩容并改形态：

```
<memory_bootstrap>                       ← 只在会话首轮出现
  <workspace_memory> …workspace/MEMORY.md 原文… </workspace_memory>
  <memory_index> …频道索引… </memory_index>
  <journal date="2026-09-04"> …当天日志尾部… </journal>
</memory_bootstrap>
<task_agenda> …不变，每轮… </task_agenda>
<user_message> … </user_message>
```

「首轮」沿用今天 `firstTurnMemoryBootstrapPending` 的定义：新会话（含 `/new`、进程重启后复用 active session 的第一轮）的第一条用户消息；**compaction 之后的第一轮也重新注入**——`lifecycle.ts` 已经在 `session_compact` 事件上有钩子，只需把 pending 标志置回 true。压缩把首轮注入的内容缩成摘要，重注入一次就补回来了；两次注入之间的所有轮次不再重复带索引。

预算（代码常量，`spec 026 §5.3` 的自动上下文份额内重新分配）：

| 段 | units 上限 |
|---|---|
| 工作区 `MEMORY.md` | 500 |
| 频道索引 | 1,400 |
| 当天日志尾部 | 400 |

**装得下就全给**。装不下时按下面的分层（D4）。不再有 LLM 重排、不再有召回打分。

为什么不每轮注入：每轮把同一份索引塞进不同的 user message，一个 50 轮的会话就会在历史里留下 50 份几乎相同的副本——既浪费 token，也让模型读历史时被重复内容干扰。首轮一次注入后内容留在会话上下文里，整个会话都命中 prompt cache。

会话中途的变化怎么办：

- 模型自己 `memory_save` 的，工具结果里已经确认，它知道；
- 反思 pass 在会话中途新增/更新的条目，模型要到下一次首轮（`/new`、compaction、重启）才会在索引里看到。这是刻意接受的延迟：反思本来就是「事后整理」，它整理的是刚刚发生的对话，模型当下的上下文里已经有原始信息；
- 模型怀疑「这事以前可能记过」时用 `memory_search`（D3）——playbook 明写这一条，因为索引不再每轮刷新。

### D2 四种类型，映射是全射

| type | 存什么 | 对应今天的 kind |
|---|---|---|
| `user` | 用户是谁：称呼、语言、角色期待、长期偏好 | `preference`（关于人的部分） |
| `feedback` | 用户对「怎么工作」的纠正与确认，以及吃过亏得出的教训 | `lesson`、`preference`（关于做法的部分）、`SESSION.md` 的 Errors & Corrections |
| `project` | 关于工作对象的稳定事实、决策、约束 | `fact`、`decision`、`constraint` |
| `reference` | 指针：路径、URL、命令、联系人、id | `fact`（指针类） |

**没有 `open-loop`**。未闭合的事项属于任务台账（有 wake、有 DoD）或当天日志；写成「记忆」既没有生命周期也没有闭合信号，F1 就是后果。反思 prompt 明文：进行中的事写进 journal，需要跟进的事建议用 task，不进 memory。

### D3 三个工具，语义收窄

| 工具 | 参数 | 行为 |
|---|---|---|
| `memory_save` | `content`（一行，成为 description）、`name?`、`type?`（默认 `project`）、`details?`（正文）、`replaces?`（要替换的 name，或 `"none"`） | 写频道 `memory/<name>.md`、重建索引。`source: user`，永不试用期 |
| `memory_search` | `query` | 词法搜索频道 `memory/*.md`（description + 正文）、`journal/*.md`，以及工作区 `MEMORY.md` 的段落（只读），返回 name/日期/段落标题 + 命中行 |
| `memory_forget` | `name` | 删文件、写墓碑、重建索引 |

三个工具都只作用于频道目录；工作区 `MEMORY.md` 对工具是只读的（D11）。

`memory_save` 的查重：模型在会话首轮看过索引，通常自己就会带 `replaces`。运行时仍做一道确定性兜底——新 description 与任一现有 description 的 token Jaccard ≥ 0.6 或规范化哈希相等时，抛 `RecoverableToolError` 列出候选 name，要求带 `replaces` 重发（与今天的行为同构，但不再依赖召回打分）。第二次调用必定执行。这道兜底在会话中途尤其有用：索引可能已经被反思 pass 更新过，而模型手里的还是首轮那份。

`name` 缺省时运行时用 `m-` + 6 位哈希生成，能用但不好看；playbook 要求模型给一个短的英文 kebab 名。

`memory_forget` 从「按文本模糊匹配、多命中则拒绝」改为**按 name 精确删除**——name 在索引里，模糊匹配的歧义问题不再存在。

正文按需读：索引里 `(+)` 标记的条目，模型用 `read` 打开 `memory/<name>.md`。频道目录本就在 path guard 的可读例外内（`path-guard.ts:278-297`），不需要改 guard。

### D4 索引超预算时的分层

频道索引装不下 1,400 units 时（大约 70–100 条以后）：

1. `user` 与 `feedback` 类型**全部**注入——它们决定行为，条数天然少；
2. `project` / `reference` 按 `updated` 降序填充，直到预算；
3. 末尾加一行 `[- N more entries omitted; use memory_search]`。

**没有相关性排序**。首轮的 user message 往往只是一句「在吗」或一个新话题，拿它去给几十条记忆打分没有意义，而这正是旧方案里最容易膨胀的那种启发式。装不下的部分由 `memory_search` 按需查；反思 pass 在索引超预算时会收到附加指令（D7 的 `condense` 模式），让索引回到预算内才是长期解。

分词器（`tokenizeRecallText` 与中文词典）只为 `memory_search` 保留，搬到 `search.ts`；`recall.ts` 的打分、意图、使用计数加成整体删除。

### D5 日志替代 `SESSION.md` 与 `HISTORY.md`

`journal/YYYY-MM-DD.md`（本地日期）：

```markdown
# 2026-09-04

- 01:12 完成 Pipiclaw 只读审查并发邮件（Sent ID 71）；两项 P1 仍未修复
- 01:40 每日新闻简报发送（Sent ID 72）；web_search 14 路里 10 路 429，改用 Exa 补足
- 04:20 用户确认下周起简报改为工作日发送 → 已记入 memory `briefing-weekdays-only`
```

只追加，只由反思 pass 写（每次 pass 产出 0–N 条带时间的 bullet）。规则写进反思 prompt：记「发生了什么、定了什么、卡在哪、下一步是什么」，不记寒暄、不复述工具输出、**同一件事今天已经记过就不再记**（模型看得到当天日志）。

它承担了：

- `SESSION.md` 的 Current State / Next Steps / Worklog（按时间追加，不再被重写和粘性合并）；
- `SESSION.md` 的 Decisions / Constraints / Errors & Corrections——这些要么是**记忆**（稳定的 → `project` / `feedback`），要么是**当天的事**（→ journal）。粘性段落这个「介于两者之间」的形态不再存在；
- `HISTORY.md` 的 boundary 摘要块；
- `HISTORY.archive.md` 的「不被折叠模糊化的原文」——journal 从不折叠。

会话首轮只带当天尾部（400 units ≈ 最近十来条）；昨天及更早通过 `memory_search` 查。不做留存清理：一天几 KB 文本，一年不到 2 MB。

`/new` 之后、进程重启后、compaction 之后，模型看到的「刚才在做什么」= 当天日志尾部 + 任务台账。这比 `SESSION.md` 的九段结构短，且没有粘性重复。

### D6 试用期保留，但信号从「被召回」改为「被 touch」

037 的两档写入是对的：硬约束直接永久，日常运作知识先试用。v2 保留两档与阈值（`high ≥ 0.85` 永久；`medium ≥ 0.90` 试用，`expires = created + 30d`），改变的是**转正信号**。

今天靠 `recordMemoryRecall`：条目被词法召回注入过一次就转正。v2 里索引在首轮整份注入，「被注入」不再是信号。改为：反思 pass 的输出里有 `touch: [names]`——模型在读对话窗口时判断「这段对话依赖或印证了哪些既有记忆」。被 touch 一次即转正（删除 `expires`）；`update` 同样转正。30 天内没有任何一次 pass 认为它相关，反思 job 的确定性前置步骤把它删除（不留墓碑，之后仍可重新学到，同 037 D8）。

`touch` 是同一次 LLM 调用里的一个数组字段，边际成本为零；它比「被词法命中」更接近「真的被用到了」。

### D7 一个后台 pass：反思

取代 session-refresh、memory-checkpoint、structural-maintenance（cleanup + fold）三个 job。

**触发**（沿用 010/035 的门控与常量）：

- 空闲 ≥ 10 分钟，且自上次游标以来有新 session entry，且有 meaningful exchange；间隔 ≥ 20 分钟；失败退避 30 分钟；每 tick 一个频道；
- 边界：compaction 前（窗口 = 将被压缩的消息）、`/new` 前（后台异步，快照先行）、shutdown（松门控）。

这与今天的 checkpoint 触发完全一致，只是不再有另外两个 job 的门控与状态字段。

**输入**：

```
频道索引（全文，不裁剪——它本来就在预算内）
工作区 MEMORY.md（裁到 3,000 字符；只作为「已知背景」供查重，反思 pass 不能改它）
当天日志（尾部 3,000 字符）
对话窗口（sanitizeMessagesForMemory 后序列化，头 35% / 尾 65% 裁到 28,000 字符，同今天）
[condense 模式下] 「索引现有 N 条、预算内约 M 条，请把可合并的合并、过时的删除」
```

**输出**（严格 JSON）：

```json
{
  "journal": ["01:12 完成 Pipiclaw 只读审查…", "…"],
  "ops": [
    {"op": "add", "name": "briefing-weekdays-only", "type": "feedback",
     "description": "每日简报改为只在工作日发送（2026-09-04 起）",
     "details": "", "confidence": 0.95, "necessity": "high", "reason": "用户明确要求"},
    {"op": "update", "name": "deploy-window-thursday",
     "description": "…", "details": "…", "confidence": 0.9, "necessity": "high", "reason": "…"},
    {"op": "delete", "name": "old-ci-runner", "confidence": 0.9, "reason": "用户说 CI 已迁移，此条不再成立"},
    {"op": "touch", "names": ["user-prefers-chinese", "pipiclaw-repo-path"]}
  ],
  "discarded": [{"content": "…", "reason": "任务进度，属于 journal"}]
}
```

**运行时守的不变量**（全部确定性，写进 `reflect.ts`，各自有单测）：

| 不变量 | 规则 |
|---|---|
| 写入档位 | `add`/`update` 按 D6 分档；`delete` 只接受 `confidence ≥ 0.85` |
| 每次 pass 上限 | `add` ≤ 8（其中试用 ≤ 5），`delete` ≤ 3，`update` 不限；超出的记入 review-log `skipped` |
| 用户显式保存的条目 | `source: user` 的条目**不可被 `delete`**；`update` 仅当 `confidence ≥ 0.95` 且窗口内含用户消息 |
| 墓碑 | `add`/`update` 的 description 规范化哈希命中墓碑 → 拒绝 |
| 密钥 | description/details 命中 `containsSecret` → 拒绝 |
| 幂等 | 游标 `lastReflectedEntryId` 前进后同一窗口不再处理；边界 pass 与空闲 pass 共用游标（同今天 `lastCheckpointEntryId`） |
| 名字 | `name` 不合法或与现有条目冲突且不是 `update` → 自动加 `-2` 后缀，记入 review-log |
| 索引重建 | 所有 ops 应用后重建一次 `MEMORY.md`，原子写 |
| 日志追加 | `journal` 条目去掉与当天已有行规范化相同的，追加剩余 |

**`condense` 模式**：索引超预算（D4 触发过分层）时，prompt 附加合并指令，`delete` 上限放宽到 8，并要求每个 `delete` 要么伴随一个覆盖其内容的 `update`/`add`，要么 reason 说明过时。这是 Generative Agents「反思」的最小形态：把多条零散记忆归并成一条更高层的。**没有单独的 condense job**，它只是同一个 pass 的一个开关。

**不做**：LLM 整体重写 `MEMORY.md`（cleanup）——索引是生成的，没有可重写的对象；history 折叠——journal 不折叠。缩水守卫、id 校验守卫、写前备份随之退役。

### D8 主 agent 不在压缩前自己写记忆

OpenClaw 让 agent 在 compaction 前跑一个静默回合写笔记。这里不采用：那是一次完整的主模型回合（带全部工具与上下文，成本是 sidecar 的 10–50 倍），且模型在被要求「现在写点什么」时倾向于写太多。用户明说「记住」时走 `memory_save`（当回合立即生效），其余交给反思 pass——它看得到同一段对话。

### D9 状态与调度收缩

`MemoryMaintenanceState` 从 13 个字段收到 6 个：

```ts
interface MemoryMaintenanceState {
  channelId: string;
  dirty: boolean;
  lastActivityAt?: string;
  eligibleAfter?: string;
  lastReflectAt?: string;
  lastReflectedEntryId?: string;
  failureBackoffUntil?: string | null;
}
```

`turnsSinceSessionRefresh` / `toolCallsSinceSessionRefresh` / `lastSessionRefresh*` / `lastStructuralMaintenanceAt` 退役。`maintenance-gates.ts` 只剩一个 `shouldRunReflect`；`scheduler.ts` 的轮转与「先跑成一个就停」逻辑简化为「一个频道一个 job」。`maintenance-tuning.ts` 保留 `minIdleMinutesBeforeLlmWork`、`checkpointIntervalMinutes`（改名 `reflectIntervalMinutes`）、`failureBackoffMinutes`、`maxConcurrentChannels`、两档置信度；其余常量删除。`PIPICLAW_TEST_FAST_MAINTENANCE` 测试钩子保留。

### D10 审计只记动作

`memory-review.jsonl` 只在**有动作、有拒绝、有错误**时追加一行；纯门控跳过降级为 debug 日志。reason 集合：`reflect` / `reflect-boundary` / `memory-save` / `memory-forget` / `migration`。1 MB 轮转保留。

`/memory` 命令：

| 子命令 | 行为 |
|---|---|
| `status` | 频道/工作区条目数、按 type 计数、试用期条数与最早到期、frontmatter 解析失败的文件、上次反思时间与游标、索引是否超预算 |
| `list [type]` | 索引原样（不经 LLM） |
| `show <name>` | 该文件全文 |
| `forget <name>` | 不经 LLM 的删除入口（设计哲学：控制命令不依赖模型可用） |
| `journal [date]` | 某天日志（默认今天） |

`recent` 退役——journal 就是「最近发生了什么」。

### D11 作用域：自动与工具写入止于频道，工作区 `MEMORY.md` 只由人维护

- 反思 pass 与三个记忆工具**只写频道目录**。从任何频道（私聊、群聊、TUI）出发，都没有一条路径能改到工作区 `MEMORY.md`——它对 agent 是只读的，与 `ENVIRONMENT.md`、`SOUL.md`、`AGENTS.md` 同一待遇。私聊里学到的不会漏到群里，群成员也不可能通过对话改动所有频道共享的背景（043 D3 的同一判断：群成员不等于宿主主人）。
- 工作区 `MEMORY.md` 保持今天的形态：一份自由 Markdown、用户手写、会话首轮整份注入（预算 500 units，超出时按 H2 段从头截断并提示）。它是**用户主动**把某件事「升格为所有会话都该知道」的唯一入口——比如把频道里某条记忆的内容复制过去。这一步是人的决定，不做自动化，也不做工具化：一旦有工具能写它，就必须回答「哪个频道的谁有权写」，而那正是本项目定位下没有可靠输入的问题。
- 换个角度看，「跨频道晋升」的需求真正出现时，用户会在 `/memory list` 或直接看文件时发现某条频道记忆放错了层，然后手动搬过去。这个动作一个月发生不了几次，不值得一条写路径。
- `ENVIRONMENT.md` 同样不变。

### D12 子代理上下文

`sub-agents/*.md` 的 `memory: none | session | relevant` 改为 `memory: none | index`。`index` = 注入工作区 `MEMORY.md` + 频道索引 + 当天日志尾部（与主 agent 首轮相同的三段，预算减半）。旧值 `session`、`relevant` 在 discovery 时映射为 `index` 并打一条 warning（frontmatter 在用户工作区里，不能直接报错拒绝角色）。`subagent_inline` 的 `context` 参数枚举同步。

### D13 `session_search` 不变

冷存储检索（`session-corpus.ts` / `session-search.ts`）保持现状。它有自己的分词缓存与 TTL，工作得可以，且不在本次的问题清单里。`memory_search` 与它共享 `search.ts` 里的分词器；未来若要换 SQLite FTS5（Node 22.13+ 内置 `node:sqlite`，自带 trigram 分词），两者一起换。本 spec 不做。

## 5. 迁移

一次性、确定性、**不调用 LLM**、幂等（`memory/.migrated-v2` 标记）、可回滚（原文件整份移到 `.memory-v1/`，不删除）。在 daemon / TUI 启动时对每个已知频道执行。**工作区目录不迁移**：`workspace/MEMORY.md` 与 `ENVIRONMENT.md` 原样保留。

| 来源 | 去向 | 规则 |
|---|---|---|
| 频道 `MEMORY.md` 每条 bullet（`parseChannelMemoryEntries`） | `memory/<name>.md` | `name`：从 content 前 6 个 ASCII 词生成 slug，无 ASCII 则 `m-<hash6>`；`description` = content（去 id 注释）；`type` 由 section 标题 + `entries.json` 的 `kind` 映射（D2 表）；`source`：`entries.json` 里 `sourceType: user` → `user`，其余 → `migrated`；`created` 取 `## Update` 时间戳或 `entries.json.createdAt`；`probationUntil` → `expires` |
| **缩进子弹**（F1 的 bug） | 并入父条目正文 | 修正解析：只有零缩进的 `- ` 是条目，缩进行归到上一条的 `details` |
| `## Ongoing Work` 段 | **journal 今天的「迁移自 MEMORY.md 的进行中事项」段**，不进 memory | 这一段的内容按定义是任务态（F1） |
| `.memory/tombstones.jsonl` | `memory/.tombstones.jsonl` | 保留 contentHash；`entryId` 字段丢弃 |
| `.memory/entries.json` | 读取一次取 `kind` / `sourceType` / `createdAt` / `probationUntil`，随后随 `.memory/` 整目录移入 `.memory-v1/` | — |
| `HISTORY.md` 每个 `## <timestamp>` 块 | `journal/<该日期>.md` | 同一天多个块合并；bullet 前缀加块时间 |
| `HISTORY.md` 的 `## Folded History Through …` 块 | `journal/folded-through-<date>.md` | 一个文件，不拆 |
| `HISTORY.archive.md(.1)` | 移入 `.memory-v1/`，不迁 | 内容已在 journal 或 log.jsonl 中 |
| `SESSION.md` | Decisions / Constraints / Errors & Corrections 三段 → journal 今天的「迁移自 SESSION.md」段；其余段丢弃 | 不自动晋升为记忆——下一次反思 pass 看到今天的日志会自己判断哪些该 `add`；粘性段落的重复在此一次性消失 |
| `state/memory/<channel>.json` | `lastCheckpointEntryId` → `lastReflectedEntryId`；其余字段丢弃 | — |
| `memory-review.jsonl` | 原地保留，新格式续写 | 读取端两种形状都容忍（今天已经如此） |

迁移写一条 review-log（`reason: migration`，含各来源条数），并在 `/memory status` 里显示「已从 v1 迁移，原文件在 `.memory-v1/`」直到该目录被人删除。

**回滚**：把 `.memory-v1/` 里的文件移回原位、删除 `memory/`、`journal/`、`MEMORY.md`（生成物）与标记文件，装回旧版本。文档里写明这四步。

## 6. 测试

### 单元（`npm run check`）

| 模块 | 必测 |
|---|---|
| `store.ts` | frontmatter 解析/序列化往返；缺 frontmatter 的容错；`name` 与文件名不一致以文件名为准；索引生成的分组与排序；`(+)` 标记；原子写；缓存按 mtime 失效 |
| `index-budget.ts`（D4） | 装得下全给；装不下时 user/feedback 全给、其余按 updated 降序；省略行；边界：单条超预算；工作区 `MEMORY.md` 按 H2 段截断 |
| `reflect.ts` | 每条不变量各一例：档位、上限、user-source 保护、墓碑、密钥、名字冲突、幂等游标、condense 放宽；JSON 解析容错（旧字段名、缺字段） |
| `journal.ts` | 追加去重；本地日期分界（23:59 → 00:00）；尾部裁剪 |
| `migrate.ts` | 真实形状的 v1 文件夹（用本机脱敏后的样本做 fixture）→ 逐条断言去向；缩进子弹并入父条目；幂等；回滚后与原文件字节相同 |
| `tools/memory-manage.ts` | save 查重 → RecoverableToolError → 带 replaces 重发成功；forget 按 name 精确；search 命中 memory、journal 与工作区 `MEMORY.md` 段落；三个工具都碰不到工作区文件 |
| `maintenance-gates.ts` | 只剩一个 gate 的全部分支 |

删除的测试：`memory-recall.test.ts`（933 行代码的测试）、`session-memory.test.ts`、`memory-bootstrap.test.ts`、`memory-metadata.test.ts`、`memory-probation.test.ts`（并入 reflect）、`memory-promotion.test.ts`（并入 reflect）、`memory-consolidation-ops.test.ts`、`memory-write-ops.test.ts` 中针对行级编辑的部分。

### e2e 确定性层（`npm run test:e2e`，遵守 048 的六条硬规则）

| 用例 | 抓什么 |
|---|---|
| M1 `memory_save` 后 `/new`，**新会话首轮**的请求体里 `<memory_index>` 含该 description；同一会话的第二轮请求体里**没有** `<memory_bootstrap>` | 索引注入接线断了 / 退化成每轮注入 |
| M1b 触发 compaction 后的第一轮请求体里再次出现 `<memory_bootstrap>` | 压缩后不重注入，记忆随摘要丢失 |
| M2 索引超预算的频道，首轮请求体里 user/feedback 全在、有省略行 | 分层退化成全丢或全给 |
| M3 `/new` 触发反思：脚本化 provider 返回 ops → 文件落盘、索引重建、journal 追加；同一窗口不重复处理（provider 请求数为 1） | 游标幂等 |
| M4 反思返回 `delete` 一个 `source: user` 条目 → 文件仍在，review-log 有 skipped | user-source 保护 |
| M5 `memory_forget` → 文件删除、墓碑写入；随后反思 `add` 同内容 → 被拒 | 墓碑 |
| M6 启动时对 v1 形状的频道目录迁移 → 文件去向断言；再启动一次无变化 | 迁移幂等 |
| M7 反思 pass 返回一个指向工作区的操作（或 `memory_save` 带任何越界 name 如 `../MEMORY`）→ 拒绝，`workspace/MEMORY.md` 字节不变；而它的内容出现在每个频道的首轮请求体里 | 工作区文件被自动路径写入 / 共享注入断了 |
| M8 反思 `touch` 一个试用期条目 → `expires` 消失；未 touch 的过期条目在下一次反思前被删 | 试用期 |

每条用例注释里写明 mutation check 的做法（048 规则 6）。

### evals（`npm run eval`，不进门禁）

新增 `memory-recall-quality` 集：预置 30 条记忆（中英混合、含改述陷阱），用 20 个换说法的问题问真实模型，grader 判断答案是否用到了正确的记忆。基线用当前 master 跑一次留档；v2 必须不低于基线——这是「索引替代召回」这条核心判断的**唯一**行为证据，必须有。

## 7. 明确不做

| 不做 | 理由 |
|---|---|
| 向量 / embedding 检索 | 需要 embedding provider（很多用户的网关没有）或本地模型（重依赖）；在本项目的规模上收益不抵复杂度。D4 的分层是装不下时的退路；真到几千条再议 |
| 跨频道晋升，无论自动还是工具化（037 所说的 L3） | 隐私边界的判断（谁是宿主主人、哪些群可信）目前没有可靠输入；工作区 `MEMORY.md` 由用户手工维护（D11） |
| 每轮注入索引 | 历史里堆几十份副本，浪费且干扰；首轮 + 压缩后重注入 + `memory_search` 补查（D1） |
| SQLite / 任何数据库 | 一切都是 Markdown 与 JSONL，`cat` 能看、编辑器能改、`git` 能 diff |
| 记忆的多租户权限 | 定位是个人与小团队单实例 |
| agent 压缩前自写笔记 | D8 |
| 记忆条目的版本历史 | `updated` 字段 + journal 里的「已记入 memory `x`」足够追溯；需要更多时看 `log.jsonl` |
| 保留 `SESSION.md` 作为兼容输出 | 没有读取者了；留着只会让人继续手工看一份不再更新的文件 |

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 会话中途反思 pass 更新了记忆，模型手里的索引已过时 | 接受的延迟（D1）；`memory_save` 的查重兜底会拦下重复；playbook 要求怀疑时先 `memory_search`；`/new` 或 compaction 后自动刷新 |
| 长会话里压缩后的重注入让索引在上下文里出现两次（一次在摘要里、一次新注入） | SDK 的摘要是模型改写过的，不是原文；重注入的是权威版本。索引包装文本注明「以本段为准」 |
| 模型看到全部记忆后「过度引用」不相关的条目 | evals 集里含 10 个「不该用到任何记忆」的问题；索引包装文本明确「背景资料，按需使用」 |
| 反思 pass 把任务进度写成记忆（F1 复发） | D2 删掉 `open-loop`；prompt 给出 journal/task/memory 三分法与反例；evals 里放一段纯进度对话，断言 `ops` 为空 |
| 用户手工编辑把 frontmatter 改坏 | 解析容错 + `/memory status` 报告；坏文件仍以「description = 第一段」进索引，不丢 |
| 迁移把某条记忆分到了错误的 type | type 只影响索引里的分组标题，不影响注入与否；用户可以直接改文件 |
| 群频道成员通过对话让 agent 改共享背景 | 不存在这条路径（D11）；工作区 `MEMORY.md` 在 path guard 的写禁区内，与今天相同 |
| 反思 pass 的 `delete` 误删 | `source: user` 不可删；agent 条目 ≤ 3/次且要 `confidence ≥ 0.85`；review-log 记每条 delete 的 name 与 reason；被删内容仍在 journal 或 log.jsonl |
| `name` 冲突或模型起名不稳定 | 运行时后缀去冲突；`update` 只认现有 name，认不出的降级为 `add`（记 review-log） |
| 与 `task-digest` 内容重叠 | journal prompt 规定：已建 task 的事项只写一句「进展见 task `<id>`」 |

## 9. 复杂度对照

| | v1（今天） | v2 |
|---|---|---|
| 每频道持久化物件 | 10 种 | 4 种（`memory/`、`journal/`、`MEMORY.md` 生成物、`memory-review.jsonl`）+ 冷存储 |
| LLM prompt | 6 | 2（反思、`session_search` 摘要） |
| 后台 job | 3 | 1 |
| 记忆元数据真相 | Markdown 行 + `entries.json` 双份 | frontmatter 单份 |
| 条目身份 | HTML 注释 id / 合成 hash id | 文件名 |
| 上下文注入路径 | 首轮快照 + 每轮召回 + 重排 | 首轮（及压缩后首轮）一次注入 + 预算分层 |
| 写入护栏 | 9 类 | 5 类（档位、上限、user-source、墓碑、密钥） |
| `src/memory/` 预估 | 6,939 行 | 约 2,500 行（估算，以实施为准） |
| 「不要手工编辑」的频道文件 | 3 个 | 0 个 |
| 工作区 `MEMORY.md` | 人维护、首轮注入 | 不变 |

## 10. 对现有文档与规则的影响

- `docs/memory.md` 重写（五层 → 三件东西；「一句话记住」「怎么忘」「它自己会记什么」保留；F8 那段道歉删除）。
- `docs/architecture.md §6` 重写；§11 磁盘布局更新。
- `docs/deployment-and-operations.md` 维护任务一节改为单 job；降本选项只剩 `memoryMaintenance.enabled` 与 `sessionSearch.summarizeWithModel`（`memoryRecall.rerankWithModel` 退役，进 `RETIRED_SETTINGS_KEYS`）。
- `docs/configuration.md`：`memoryRecall`、`sessionMemory` 两段退役。
- `AGENTS.md` / `CLAUDE.md`：Channel-level files 与 Memory subsystem 段落更新；「`SESSION.md` 是当前工作状态」等三句删除；Workspace-level files 一行不变。
- `src/playbooks/memory-and-learning.md` / `runtime-orientation.md`：表格改为 channel memory / journal / task / workspace MEMORY（只读，用户维护）/ ENVIRONMENT / skills；`memory_save` 的 `type`/`replaces` 用法；「索引只在会话开始时给，中途怀疑记过就 `memory_search`」；「可以直接编辑频道记忆文件」。
- `docs/specs/README.md` 加 050 一行。

实施顺序与文件级清单见 [plan.md](./plan.md)。
