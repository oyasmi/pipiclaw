# 子代理采纳与价值兑现:冷启动、产物契约、预算与扇出

| 字段 | 值 |
|------|------|
| 状态 | DRAFT |
| 日期 | 2026-07-20 |
| 前置 | 002 subagent、017 model fallback、021 toolset enhancement、023 governed task loops、026 system prompt slimming |
| 关联实现 | `src/subagents/tool.ts`、`src/subagents/discovery.ts`、`src/agent/prompt/sections.ts`、`src/agent/session-events.ts`、`src/agent/channel-runner.ts`、`src/paths.ts`、`src/settings.ts`、`src/playbooks/task-delegation.md`、`package.json` build |

## 背景:机制是好的,采纳是零

先摆事实。生产环境 `~/.pipiclaw` 自 2026-04-04 起:

| 观测点 | 结果 |
|---|---|
| `workspace/sub-agents/` | 空目录,建立后从未写入 |
| `subagent-runs.jsonl`(任意 channel) | 不存在 |
| 全部会话日志中 `subagent` 工具调用 | **恰好 1 次** |

那一次的结果:

```json
{"toolName":"subagent","isError":true,
 "content":"Unknown sub-agent \"antcc\". Available sub-agents: none."}
```

模型幻觉了一个 agent 名字,撞墙,此后再未尝试。

**本 spec 的前提判断是:子代理的机制层是健康的**——工具白名单、turn/tool/wall-time 限额、防递归、独立记账、可选 worktree、checker-only verifier + attestation + subjectHash 绑定,这些都实现得克制且正确,002 的设计意图基本兑现。问题不在正确性,而在两件事:

1. **它没有被用起来**(采纳为零,且是结构性自锁,不是用户忘了配);
2. **即使被用起来,今天的默认值也让委派不划算**(继承父模型 + 无上限回传,委派本该兑现的三个收益只兑现了一个)。

所以本 spec 不新增隔离或治理机制——那一层已经够了。它做的是让已有机制可被发现、被用得划算、失败时不丢工作。

对 Pipiclaw 这个产品形态(DingTalk 常驻、长会话、用户注意力稀缺),子代理的真正价值只有两条:**保护主上下文**(长会话是成本与质量退化的主要来源)、**maker/checker 分离**(提升无人值守时段的可信度)。今天两条都没兑现:前者因为全量回传,后者因为思考被关且只存在于 verify 一条窄路径上。

## 病根分析

### 1. 冷启动自锁:能力越是没被配置,越是不可见

`SUBAGENTS_SECTION` 在预定义 agent 为空时**直接返回 undefined**(`sections.ts:140`)。这条早退是 026 §6.3 的产物,当时的理由(空列表不值它的 token)只考虑了目录内容,没考虑那一段里还夹着**与目录无关的运行时指引**:

- "A sub-agent starts blank: state the goal, scope, paths, constraints and acceptance criteria"(`sections.ts:145`);
- "Read task-delegation.md before non-trivial delegation"(`:148`)。

于是空目录同时删掉了目录和用法。模型剩下的唯一线索是工具描述,而它的第一句是 "You may use a predefined sub-agent from workspaceDir/sub-agents/"(`tool.ts:605`)——把一条此刻**必然失败**的路径讲在最前面。

`resolveSubAgentConfig` 其实完整支持 inline `systemPrompt` 路径,不需要任何预定义文件(`discovery.ts:405`)。这条一等路径在提示词里几乎不存在,在工具描述里排第二。

**这是唯一的 P0:它单独让其余 800 行代码的产出为零。**

### 2. 委派的收益模型不成立

三件事叠加:

- `model` 默认继承父当前模型(`discovery.ts:478`);
- `finalText` **无上限**回传给父(`tool.ts:830`)——16k 截断只作用于落盘那一份(`session-events.ts:192`);
- 隔离只发生在中间过程。

结果:委派"扫 30 个文件找调用点"用的是最贵的模型,父还要吞下全部结论文本。委派应当兑现的三个收益——**上下文隔离 + 便宜模型 + 压缩回传**——只兑现了第一个,而第一个又被第三个的缺失部分抵消。一个话痨子代理可以直接把父上下文打爆,这比不委派更糟。

### 3. work 路径没有产物契约,知识只能蒸发

verify 路径有完整契约:`VERDICT: PASS/FAIL` 末行标记、attestation 落 `tasks/.verifications/<runId>.json`、subjectHash 绑定工作区状态(`tool.ts:780-805`)。**这条路径恰好证明了契约有效,却没有推广到 work。**

work 路径:子代理有 `write`、可能在 worktree 里,但回给父的只有最后一条 assistant 文本,父只能靠自然语言解析。更结构性的是知识去向——`withSubagentMemoryWriteDeny`(`tool.ts:358`)硬禁写 MEMORY/HISTORY/SESSION,**这个禁令是对的**(会与 `channel-maintenance-queue` 抢同一批文件),但它没有留下替代出口。子代理探索出的事实只能靠父转述,父不转述就没了。

注:这里不应引入"子代理提交记忆候选"的新通道——`MemoryCandidateStore` 是四个记忆文件之上的**读侧缓存**(`candidates.ts:225`),不是候选写入管线,把它改成双向会把刚刚被 deny-list 挡住的竞态从后门放回来。正确的出口是产物文件:落盘即 durable、可寻址、可复查,由父代理决定哪些经 `memory_manage` 提升为记忆。

### 4. 预算是断头台,不是预算

超 `maxTurns` / `maxToolCalls` 直接 `worker.abort()`(`tool.ts:708-724`),已完成的工作**全丢**,父只拿到一句 "Turn budget exceeded"。默认 24 turns / 48 tool calls 下,一个跑到第 23 轮的分析任务和一个第 1 轮就跑偏的任务,对父而言返回的信息量相同。

这让长程委派非常脆——而长程委派正是这个机制最该擅长的事。子代理此刻的完整推理都在 `worker.state.messages` 里,把它扔掉是纯粹的浪费。

### 5. `thinkingLevel: "off"` 硬编码

`tool.ts:673` 对所有子代理强制关闭思考。verify 子代理是全系统最需要推理的角色(独立验收、区分观测证据与假设、对 DoD 逐条取证),却被强制关闭;work 子代理做架构分析同理。

一行默认值把"认知分离"降级成了"跑腿分离",与 002 的设计意图直接矛盾。

### 6. 并行扇出:能力是暗的,风险也是暗的

SDK 在同一条 assistant 消息内**并行执行**多个 tool call(`pi-agent-core/dist/agent-loop.js:293`),仅当某个工具声明 `executionMode: "sequential"` 才转串行。全仓 rg 无任何 `executionMode` 命中——**所以 N 个 subagent 会真并行**。

两侧都是暗的:

- 没有任何提示告诉模型可以扇出,所以收益拿不到;
- 没有并发上限、没有每回合聚合预算,所以哪天模型想通了发 8 个,就是 8 × (24 turns × 父模型)。且 `isolation: shared` 下它们**共享同一个 cwd**(`tool.ts:211`),并行写操作会互踩,而 worktree 隔离要求 taskId + governed control,不是随手可得的。

### 7. 与 task 台账的耦合只做了一半

verify 深度集成(taskId、attestation、subjectHash);work 除了 `recordTaskWorktree`(`tool.ts:288`)几乎不回写 task。子代理跑过什么、结论是什么、产物在哪,不进 task 正文。长程任务跨进程重启后这些信息不在台账里,而台账是长程任务唯一的真相载体。

### 附:verify 的写隔离是检测型,不是阻断型

verify 过滤掉 `write`/`edit`(`tool.ts:404`)但保留 `bash`,子代理仍可 `echo > file`。实际保证来自事后比对 subjectHash / `git status`(`:773`),不一致则 attestation 判 fail。**这是可接受的设计**(阻断 bash 会让 verifier 无法跑测试),但文档里应写明它是检测型保证,不要让人误读为强隔离。本 spec 只改文档,不改行为。

## 目标与非目标

**目标**:让子代理成为一条**默认可发现、默认划算、失败不丢工作**的路径——发现性由运行时给出而不是靠用户预先配置,划算与否由默认值决定而不是靠模型每次的判断力。

**非目标**:

- 不新增隔离/治理机制。工具白名单、限额、防递归、worktree、attestation 这一层已经够用,本 spec 不动其语义。
- 不引入子代理嵌套。防递归是正确约束,保留。
- 不给子代理开记忆写入通道(见病根 3)。
- 不引入 skills 层面的子代理编排、不做跨回合的常驻子代理、不做子代理之间的直接通信。这些都属于"多代理系统"主线,超出本 spec。
- 不改 task 状态机与验收链(029 边界)。

## 设计

八项改动,分三个梯队。D1–D3 解锁采纳,D4–D6 让委派划算,D7–D8 是复利项。

### 第一梯队:解锁采纳

#### D1 空目录时 section 不消失,改渲染 inline 路径

`SUBAGENTS_SECTION` 从"有则渲染、无则消失"改为**两态渲染**:

- 有预定义 agent → 现状不变(目录 + 那两句指引);
- 无预定义 agent → 渲染最小 inline 用法,而不是 undefined:

```text
## Sub-Agents
Delegate with `subagent`: pass an inline `systemPrompt` (no predefined agent is required).
A sub-agent starts blank — state goal, scope, paths, constraints, acceptance criteria in `task`.
Read task-delegation.md before non-trivial delegation.
```

同时**重写工具描述**(`tool.ts:604`),把 inline 提到第一句、predefined 降为第二句,并显式说明"目录可能为空,这不影响 inline 委派"。今天的描述把一条此刻必然失败的路径讲在最前面,是那次 `antcc` 幻觉的直接诱因。

预算说明:该段不在 `RUNTIME_AUTHORED_SECTION_IDS` 内(`builder.ts:211`),不计入 700/1200 units 的紧预算。空态文案是运行时自撰文字,应控制在 **40 units 以内**;本 spec 不改预算口径,但在 `sections.ts` 注释里记下这笔账,以免日后被当成用户内容随意加长。

#### D2 随包内置默认子代理

D1 让空目录不再致命,D2 让它不再是空的。**完全照搬 playbooks 的既有模式**:`src/subagents/builtin/*.md` 在 checkout 下直接读、安装包读 `dist/subagents/builtin`,由 `paths.ts` 按 `PLAYBOOKS_DIR` 同构的 `existsSync` 二选一给出 `BUILTIN_SUB_AGENTS_DIR`(`paths.ts:12-15` 的写法)。

`discoverSubAgents` 改为**先扫内置目录、再扫 workspace 目录**,同 `name` 时 **workspace 覆盖内置**,warnings 里记一条覆盖说明。内置项在 `SubAgentConfig` 上标 `source: "builtin"`,与 `predefined`/`inline` 并列,便于 details 与日志区分。

停用一个内置 agent 需要一条显式开关:frontmatter 增加 `enabled`(默认 true),在**空 body 检查之前**判定。否则用户"写个同名空文件把它关掉"的直觉会失效——空 body 今天会被 warning 跳过(`discovery.ts:360`),该 name 从未注册,内置反而存活。

首批三个,覆盖三种典型认知分工:

| name | tools | contextMode | 用途 |
|---|---|---|---|
| `explorer` | read, bash | contextual / relevant | 只读地图任务:定位实现、梳理调用链,产出结构化摘要 |
| `verifier` | read, bash | isolated | 独立验收,配合 `purpose: verify`;thinking 开(D3) |
| `researcher` | web_search, web_fetch, read | isolated | 外部信息收集,带来源标注 |

三者**都不写死 `model`**——各安装的 `models.json` 不同,写死会在解析期直接 warning 并丢弃该 agent(`discovery.ts:353`)。模型选择交给 D5。

build 脚本(`package.json:25`)目前把 `src/playbooks → dist/playbooks` 的复制内联成一行 node 脚本;新增第二个目录时把它改成目录列表循环,不要复制粘贴第二段。

#### D3 `thinkingLevel` 可配

`SubAgentConfig` 增加 `thinkingLevel`(frontmatter + 调用入参,取值沿用 SDK 的档位),默认:

- `purpose: "verify"` → 默认**开**(内置 `verifier` 显式声明);
- 其余 → 默认 `off`(保持现状,不给所有委派无差别加成本)。

`tool.ts:673` 的硬编码改为读 `config.thinkingLevel`。这是最小改动、最大杠杆的一项:独立验收是整个无人值守链条的最后一道闸,让它能思考直接改变 attestation 的可信度。

### 第二梯队:让委派划算

#### D4 产物契约:artifact 目录 + 回传预算

这是本 spec 的核心项,同时解决病根 2 的回传膨胀、病根 3 的知识蒸发、以及 work 路径的结果不可复查。设计与 verify 的既有契约**同构**,不发明新形状。

**产物目录**。`prepareRunContext` 为每次 run 建 `channelDir/subagent-artifacts/<runId>/`(atomic 目录创建,与 `tasks/.verifications/` 同级别的运行时私有区),把绝对路径写进 `buildSubAgentTask` 的 Runtime context 块——子代理必须被**告知**产物落点,否则它只会往 cwd 乱写。

**返回模式**。新增入参 `returns?: "text" | "artifact"`(默认 `text`)。`artifact` 时在任务文本追加协议段,与 verify 的 `VERDICT:` 完全同构:

```text
- Write your primary output as a file under the artifact directory above.
- End the response with exactly one final line: ARTIFACT: <filename>
```

**回传预算(两种模式都生效)**。新增 `MAX_SUBAGENT_RESULT_UNITS`(建议 **1,200 units**,按 `shared/prompt-units.ts` 度量,与提示词预算同口径):

- 全文**一律**落盘到 `<artifact dir>/output.md`,与是否 artifact 模式无关;
- 未超预算 → 回传原文,附产物目录路径;
- 超预算 → 回传头部摘要 + 明示 `完整输出见 <绝对路径>`,父可按需 `read`。

于是"话痨子代理打爆父上下文"这条路径消失,而信息不丢——它变成了一个父代理可以选择性付费读取的文件。这也是病根 3 的答案:**产物文件就是 durable 记录**,由父代理判断哪些值得经 `memory_manage` 提升为记忆,不需要任何新的记忆写入通道。

`SubAgentToolDetails` 增加 `artifactDir`、`artifactPath?`、`resultTruncated: boolean`;`logSubAgentRun` 一并记录,`session-events.ts:192` 的 16k 截断保持不变(它是日志侧的独立约束)。

**回收**:产物目录不自动删除。它与 worktree 同属"父代理负责闭环"的产物(`task-delegation.md:32` 已确立此纪律),清理责任写进 playbook,不引入自动 GC——过早删除比留下垃圾更危险。

#### D5 子代理默认模型

新增 settings 键 `subagentModel?: string | null`,语义与既有 `fallbackModel`(`settings.ts:160,475`)**完全一致**:`provider/model` 引用,空/空白视为未设置。

优先级:`调用入参 model` > `预定义 frontmatter model` > `settings.subagentModel` > **父当前模型**(现状兜底)。

未设置时行为与今天完全一致,所以这是纯 opt-in、零破坏。但它把"用便宜模型跑窄任务"从"模型每次都要想起来传 model 参数"变成一次性配置——前者在观测数据里从未发生过。

只加一个键,不引入 tier/模型池抽象;那属于 017 的主线,等真实用量出现后再评估。

#### D6 硬预算改为收敛回合,而不是断头

`maxTurns` / `maxToolCalls` / `maxWallTimeSec` 触顶时,不再直接丢弃工作:

1. `worker.abort()` 停掉当前工具循环(现状);
2. `worker.state.tools = []`——SDK 允许赋值(`pi-agent-core/dist/agent.js:149`),空工具集保证收敛回合不会再产生新的工具调用;
3. 以一条固定提示续跑一轮:"预算已用尽。基于已完成的工作立即输出结论:已确认的事实、未完成的部分、建议的下一步。不要再调用工具。";
4. 用这一轮的输出作为返回文本,`details.failureReason` 仍标注触顶原因,`failed: true` 保持不变。

父代理因此总能拿到"跑到哪儿了",而不是一句 `Turn budget exceeded`。成本是一次额外的 assistant 消息,相对于被丢弃的 24 轮工作可以忽略。

收敛回合本身也要有硬止损:它不受 `maxTurns` 约束(工具集为空,不可能循环),但受一个独立的短墙钟(建议 60s)约束,超时则退回今天的行为。

`SubAgentWorker` 接口(`tool.ts:140`)今天只暴露 `state.messages`,需扩展到 `state.tools`;`createWorker` 测试桩同步跟进。

**被否决的替代方案**:在 80% 软阈值处注入一条 user 消息提醒收敛。这需要在工具循环运行中途向 Agent 注入消息,SDK 没有干净的入口,且注入时机与 `turn_end` 事件竞态。收敛回合是确定性的,在循环结束后发生,没有竞态。

### 第三梯队:复利

#### D7 work 结果回写 task 证据

`purpose: "work"` 且带 `taskId` 时,run 结束后向 task 正文的证据段 append 一行:runId、agent 名、模型、产物目录、耗时、结论摘要(短)。复用 `updateStoredTask`(`tool.ts:289` 已在用),不新增写路径。

于是"子代理跑过什么"进入台账,跨进程重启后仍在——这是长程任务能真正把工作外包出去的前提。

#### D8 扇出:同时开引导与护栏

两件事必须同时做,只做一半都是错的。

**引导**。`task-delegation.md` 增补一节,说清扇出的适用与不适用:适用于**相互独立的只读研究分支**(定位三个不同子系统的实现、并行调研三个方案);不适用于写操作(`shared` 隔离下共享 cwd 会互踩,而 worktree 隔离要求 taskId + governed control)。

**护栏**。在 `createSubAgentTool` 外层引入 per-channel 的并发与聚合闸门(与 `channel-maintenance-queue` 同构的共享单例,不内联):

- 并发上限 **3**;超出时后到的调用排队而非拒绝(拒绝会让模型退回串行,收益归零);
- 每个父回合的子代理**聚合 cost 上限**;触顶后新的委派直接返回可恢复错误,提示改用串行或收窄范围。usage 已在 details 里逐 run 汇总(`tool.ts:631`),聚合只需在 `session-events.ts` 已有的 `mergeSubAgentUsage` 处加一个回合级累计;
- `isolation: "shared"` 且并发 > 1 时,参与并行的子代理工具集**强制降为只读**(过滤 `write`/`edit`,与 verify 的过滤同一处代码 `tool.ts:404`)。这条让"并行写互踩"从纪律问题变成结构上不可能。

## 兼容性与迁移

- **磁盘格式**:无破坏性变更。新增 `channelDir/subagent-artifacts/`(按需自建)、`dist/subagents/builtin/`(build 产出)。
- **已有 workspace sub-agents 文件**:行为不变;与内置同名时**用户文件胜出**,warnings 记一条。
- **`subagentModel` 未设置**(升级后的默认)→ 模型选择与今天逐字节一致。
- **`returns` 未传**(默认 `text`)→ 回传行为仅在超过 1,200 units 时改变。这是有意的破坏性变更(它正是病根 2 的修复),需在 CHANGELOG 明写。
- **`thinkingLevel`**:仅 `purpose: verify` 的默认值改变(off → on),verify 路径今天在生产中零使用,影响面为零。
- **公共 API**:`SubAgentConfig` / `SubAgentToolDetails` 增字段(增量,不改既有字段语义);`src/index.ts` 导出名不变。`source` 联合类型增加 `"builtin"` 成员——消费方若做穷尽匹配需跟进,属 beta API 变更。

## 测试重点

- **D1**:预定义为空时 section **仍然渲染**且含 inline 指引;非空时渲染目录;两态都在 40 units 空态上限/2,400 字符段上限内。
- **D2**:内置 agent 被发现;同名 workspace 文件覆盖内置且记 warning;`enabled: false` 停用内置且**先于**空 body 检查生效;内置目录缺失(未 build)时降级为仅 workspace,不抛错;`dist` 复制在 `npm run build` 后存在。
- **D3**:verify 默认 thinking 开;work 默认 off;frontmatter 与调用入参各自可覆盖,优先级正确。
- **D4**:产物目录被创建且路径出现在任务文本中;`returns: artifact` 解析末行 `ARTIFACT:` 标记,缺标记时降级为 text 且 details 标注;超预算时回传截断 + 路径且 `output.md` 全文完整;未超预算时回传原文;两种模式下 `output.md` 都落盘。
- **D5**:四级优先级各自生效;`subagentModel` 指向不存在的模型时给出明确错误而不是静默回退;空白值视为未设置。
- **D6**:turn/tool/wall-time 三种触顶都走收敛回合;收敛回合不产生工具调用;收敛回合超时退回旧行为;`failed`/`failureReason` 语义不变;父信号 abort(`/stop`)时**不**走收敛回合(用户要的是立刻停)。
- **D8**:并发超 3 时排队而非失败;聚合 cost 触顶后新委派返回可恢复错误;`shared` 并发 > 1 时 `write`/`edit` 不在工具集内;单个委派时工具集不受影响。
- **回归**:verify 全链路(attestation、subjectHash、workspaceChanged 判定)在 D4/D6 改动后行为不变。

## 落地顺序

D1 → D3 → D2 → D4 → D6 → D5 → D7 → D8。

D1 与 D3 各自是数行改动、无依赖,先落地即刻解除自锁,并让后续改动能在真实使用中被观测到。D2 依赖 D1(否则内置 agent 仍可能在某些安装下遇到空目录路径)且涉及 build 与 paths,单独一步。D4 最大且是第二梯队的地基(D7 依赖它的 artifactDir),先于 D6。D5 独立小项,放在 D4/D6 之后以免与产物改动同时动 `discovery.ts`。D7、D8 属复利,可延后。

每步独立可验证、可单独提交、可单独回滚。

## 后续边界

- **观测先行**:D1–D3 落地后应先积累真实 `subagent-runs.jsonl` 数据(调用频次、触顶率、回传长度分布、模型分布),再决定第二梯队各项参数(1,200 units、并发 3、聚合上限)的具体取值。本 spec 给出的是初值,不是结论。
- **不在本 spec 内**:子代理嵌套、跨回合常驻子代理、子代理间通信、模型 tier 抽象、产物目录自动 GC、把 `subagent-runs.jsonl` 接入 `session_search`。最后一项在产物文件积累起来后会变得有价值,届时单独评估。
- **verify 的写隔离性质**:本 spec 只在 `docs/security.md` 与 `task-closeout.md` 补一句"检测型而非阻断型",不改行为。若日后要改成阻断型,需要给 verifier 一条只读的命令执行通道,那是 `security/command-guard.ts` 的主线。
