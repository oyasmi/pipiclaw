# Pipiclaw 长程自主任务与长期自主学习能力评审

| 字段 | 值 |
|---|---|
| 日期 | 2026-07-31 |
| 评审者 | Codex |
| 评审基线 | `0.8.11-beta.1`，commit `43d74a3` |
| 评审方式 | 只读代码审查、真实调用链核对、行为评测审查、类型检查、单元测试与覆盖率验证 |
| 评审目标 | 从“长程自主任务”和“长期自主学习”两个战略方向，判断 Pipiclaw 已经具备什么、尚缺什么，以及下一阶段怎样以实际效果为中心迭代 |

---

## 0. 执行摘要

Pipiclaw 目前已经是一个相当扎实的**可持续运行、可恢复、受治理的 Agent Runtime**，但还不是一个真正具备长程自主求解与长期自主学习能力的“数字员工”。

更准确地说：

- 长程任务方面，项目已经较好地解决了“任务怎么活下来、怎么被唤醒、怎么避免静默丢失、怎么控制完成和外部副作用”，但还没有系统性解决“怎么判断方向是否正确、怎样基于证据重规划、怎样区分忙碌和有效进展”。
- 长期学习方面，项目已经有不错的“记忆保存、压缩、召回、纠错和遗忘”设施，但还没有形成“从工作结果中提取经验、验证经验、固化为组织知识或技能、再度量这些经验是否真的提高了工作效果”的闭环。

一句话概括：

> Pipiclaw 已经具备数字员工的工作台账、值班机制、档案柜和规章制度，但还缺少真正的项目判断力，以及在绩效反馈中持续成长的机制。

这个差距不能主要靠增加提示词或 playbook 解决。下一阶段真正需要建设的是两个**可落盘、可观测、可评测**的闭环：

1. 任务闭环：`计划 → 执行 → 获取证据 → 判断进展 → 反思/重规划`
2. 学习闭环：`观察 → 经验候选 → 验证 → 晋升 → 使用 → 效果反馈 → 淘汰/修订`

当前最应该坚持的产品判断是：**不要先追求更复杂的多 Agent 拓扑、通用工作流引擎或更大的知识库；先让每一步是否有效、每条经验是否有用，都能被系统证明。**

---

## 1. 评审范围与方法

### 1.1 重点检查范围

本轮围绕两条真实运行链路展开：

- 长程任务：`src/tasks/`、`src/runtime/task-driver.ts`、`src/runtime/durable-dispatch.ts`、`src/agent/effect-ledger.ts`、`src/tools/task-manage/`、任务 playbook、后台 job 与 stop/recovery 路径。
- 长期学习：`src/memory/`、`src/tools/memory-manage/`、`src/tools/skill-manage/`、`src/playbooks/memory-and-learning.md`、workspace/channel 记忆边界、memory maintenance、recall 与行为评测。
- 效果证明：`evals/cases/`、`evals/gates.json`、当前 baseline、单元测试和覆盖率。

评审不以类名、注释或设计文档中的目标作为“已实现能力”，而是沿生产调用者检查机制是否真正进入运行时决策。例如，memory metadata 即使已经记录 `trust` 和 `expiresAt`，如果 recall 不读取它们，就不能把“记录了这些字段”等同于“召回已经执行可信度和时效语义”。

### 1.2 验证结果

- `npm run typecheck`：通过。
- `npm run test`：112 个测试文件、982 个测试全部通过。
- `npm run test:coverage -- --reporter=dot`：通过。
- 总体 statement coverage：82.83%。
- `src/tasks` statement coverage：95.23%。
- `src/memory` statement coverage：90.58%。
- 关键编排路径相对较弱：`src/agent/channel-runner.ts` 为 34.86%，`src/runtime/bootstrap.ts` 为 69.92%。

这说明项目的局部机制质量和单元测试已经比较扎实；下一阶段的主要瓶颈不在于再补几个普通单元测试，而在于建立跨多回合、跨重启、跨任务、跨时间的结果级评测。

### 1.3 明确盲区

- 本轮没有连接真实钉钉、真实公司知识源或真实外部业务系统。
- 没有进行持续数周的线上纵向实验；关于“长期是否变聪明”的判断来自能力链路缺失和现有 eval 覆盖，而不是一项已经运行一个月的生产实验。
- 没有修改项目代码。本报告是能力审计与迭代建议，不是实现提交。

---

## 2. 成熟度判断

评分口径：

- 1：主要依赖单回合模型临场表现。
- 3：具备持久化、恢复和确定性治理。
- 5：具备结果驱动的自我调整，并已被纵向评测证明。

| 能力 | 当前成熟度 | 判断 |
|---|---:|---|
| 任务持久化与跨回合恢复 | 4/5 | 已是项目强项 |
| 宕机、重投和调度可靠性 | 4/5 | 机制扎实，端到端外部幂等仍不足 |
| 截止时间、尝试预算和审批治理 | 3.5/5 | 有确定性门禁，缺全局资源闸 |
| 目标与验收条件保持 | 3.5/5 | DoD 和最终验证较强 |
| 机器可理解的计划表达 | 2/5 | 主要仍是自然语言和 `nextAction` |
| 中间进展判断 | 2/5 | 能判断“有动作”，不能可靠判断“有效前进” |
| 反思与重规划 | 1.5/5 | 主要依赖模型遵守 playbook，没有运行时状态机 |
| 长期事实记忆 | 4/5 | 写入保守，支持更新、失效和维护 |
| 记忆召回 | 3/5 | 中文词法和 rerank 不错，语义召回存在硬边界 |
| 纠错与遗忘 | 3.5/5 | 显式 forget 和 tombstone 扎实 |
| 跨频道组织知识沉淀 | 1.5/5 | workspace memory 基本依赖人工维护 |
| 程序性经验自主学习 | 1.5/5 | 有 skill 工具和规则，没有学习闭环 |
| “越来越聪明”的纵向证明 | 1/5 | 没有长期对照实验和效果门禁 |

因此，两个战略方向的阶段判断是：

- **长程自主任务**：处于“可恢复、受治理的执行循环”，尚未进入“证据驱动的自适应任务循环”。
- **长期自主学习**：处于“持久记忆系统”，尚未进入“基于结果反馈的学习系统”。

这里必须区分“基础设施成熟度”和“最终能力成熟度”。Pipiclaw 的前者已经不低，但不能因为基础设施丰富，就高估后者。

---

## 3. 长程自主任务评审

### 3.1 已经形成的核心资产

#### 3.1.1 任务已经成为真正的持久对象

任务不是聊天中的临时计划，而是带 Goal、DoD、Manual、Verification、Current Cycle、History 的磁盘对象。标准段定义在 `src/tasks/ledger.ts:70-77`，结构化 control 定义在 `src/tasks/control.ts:70-94`。

`task_manage create` 要求 Goal 和 checkbox 形式的 DoD，避免创建只有模糊愿望、没有客观完成条件的后台任务。任务契约和执行日志也有清楚边界：Goal、DoD、Manual、Verification 属于契约段；Current Cycle 和 History 属于工作记录。

这是正确的地基。长程自主能力首先不是“模型多聪明”，而是任务真相不能只存在于上下文窗口中。

#### 3.1.2 调度和恢复底座已经较成熟

TaskDriver 已具备：

- 多频道公平调度；
- priority、deadline、wake；
- 周期任务；
- attempt claim 和 generation；
- 停滞退避；
- 连续空转暂停；
- 自适应唤醒；
- 周期任务的确定性重开和历史折叠。

核心循环见 `src/runtime/task-driver.ts:354-535`。

Durable Dispatch 使用磁盘 outbox、lease 和 at-least-once 语义。进程崩溃后，synthetic wake 不会因为离开内存队列而静默消失，见 `src/runtime/durable-dispatch.ts:83-100`。后台 job 也有持久记录和恢复路径，job 完成后可以唤醒所属任务。

很多 Agent 系统还停留在“循环调用模型”；Pipiclaw 已经开始处理长期运行时真正困难的故障语义，这是应当保留的优势。

#### 3.1.3 等待、暂停、恢复和周期运行语义较清楚

当前语义可以区分：

- `active`：当前可以继续推进；
- `waiting` 且无 wake：停泊，等待用户、后台 job 或其他信号；
- `waiting` 且有 wake：定时回访外部状态；
- `verifying`：进入只读 checker 阶段；
- `paused`：用户或 governor 明确停止；
- `done`：完成或周期任务睡眠；
- `cancelled`：终止并归档。

相关运行手册见 `src/playbooks/task-driving.md:27-37`。这类确定性状态边界对于“不卡住”和“不乱跑”十分重要。

#### 3.1.4 最终验收是目前设计最强的一环

任务完成不只是由执行者声明：

- DoD checkbox 必须完成；
- 外部副作用需要用户审批；
- 可要求独立 verifier；
- attestation 绑定任务契约 hash；
- Git 工作区还绑定 HEAD、staged、unstaged、untracked 共同形成的 artifact subject；
- 验收后修改契约或产物会使 PASS 失效。

完成门禁见 `src/tools/task-manage/lifecycle.ts:84-142`，attestation 结构和校验见 `src/tasks/verification.ts:58-112`。

这有效解决了“Agent 自己宣布自己成功”的常见缺陷。它不仅应当保留，还应当向任务中间阶段延伸。

### 3.2 结构性缺口

#### G1：有任务台账，但没有机器可理解的计划

当前机器字段主要包括：

- status；
- nextAction；
- lastOutcome；
- blockedReason；
- budget；
- verification。

计划本身仍主要存在于 Goal、Manual、Current Cycle 等自然语言中。任务还明确取消了 `parent`、`dependsOn` 等关系，见 `src/tasks/control.ts:177-211` 和 `src/playbooks/task-planning.md:27-35`。

因此 runtime 无法可靠回答：

- 当前处于计划的第几阶段；
- 这个阶段应该产生什么证据；
- 哪个假设刚刚失败；
- 是否跳过了必要步骤；
- 当前 `nextAction` 属于原计划还是临时绕路；
- 计划已经修改过几次，为什么修改；
- 任务虽然产生了很多文件，是否真的更接近 DoD。

现在的“规划”仍主要是模型每次重读 prose 后自行恢复，而不是 runtime 可以监督的计划。

这并不意味着应该立刻恢复完整依赖图或工作流引擎。更合理的下一步是引入一个最小、线性的“阶段/步骤/证据”模型，使关键判断能够被持久化和评测。

#### G2：effect 证明发生了动作，不证明取得了进展

TaskDriver 使用 effect tally 辅助判断是否立即继续。写文件、编辑、子 Agent、外发、后台任务等会算作 effect；同步 bash 只要退出码为 0 且有输出也算。

`src/agent/effect-ledger.ts:67-80` 明确承认 `echo x` 也能通过。这个设计能够判断：

> 这个回合不是完全空白。

但不能判断：

> 这个回合使任务更接近 DoD。

一个方向错误但持续改文件、跑命令的 Agent，可以一直被认为“有可见动作”，直到耗尽 attempts。现有 governor 防止的是绝对空转，不是高成本横向移动、方向性错误或产物退化。

TaskDriver 的 fingerprint 也主要来自 status、wake、nextAction、blockedReason、verification、cycle 和 effect 数量，见 `src/runtime/task-driver.ts:80-103`。它没有纳入阶段预期、实际证据、测试结果趋势或与 DoD 的距离。

#### G3：反思是行为建议，不是系统状态转换

任务 playbook 对恢复真相、检查上一步产物、记录证据、更新 Manual、修正 nextAction 写得很好，见 `src/playbooks/task-driving.md:10-25`。

但运行时没有明确的：

- `needs-reflection`；
- `plan-invalid`；
- `hypothesis-failed`；
- `replanning`；
- `milestone-verification-failed`。

因此“反思是否发生”主要依赖模型是否认真遵守手册。即使模型输出了一段反思，runtime 也无法判断它是形成了新的可执行计划，还是只换了一种叙述。

目前连续 3 次 fingerprint 不变会让 governor 暂停任务，见 `src/runtime/task-driver.ts:478-496`。这是可靠的停止机制，但它回答的是“什么时候停止烧钱”，不是“怎样自主换路继续前进”。

#### G4：最终验收很强，但发生得太晚

最终 verifier 能防止错误完成，却不能防止 Agent 在错误方向上消耗前 10 次尝试。

长程任务需要的不只是终点验收，还包括：

- 阶段性验收；
- 关键假设验证；
- 主路径改变前后的检查；
- 风险动作前的 preflight；
- 大规模修改后的回归检查。

当前状态可以概括为“终点门禁强，中途护栏弱”。应优先把现有 verifier 的原则推广到 milestone，而不是为所有细小步骤都启动昂贵的独立子 Agent。

#### G5：governor 和 effect 状态重启后丢失

effect tally 和 futile counter 都在进程内存中。`src/agent/effect-ledger.ts:16-20` 对此有明确说明。

一次重启通常只是多宽容一轮，但频繁崩溃、滚动部署或异常退出会反复刷新“无进展耐心值”。这与“长程任务的治理状态也应可恢复”的目标不完全一致。

任务本体、dispatch 和 usage 已经持久化，因此 governor evidence 继续停留在内存里，正逐渐成为恢复链路中的不一致点。

#### G6：缺少全局自治资源闸

当前每任务只保留 `maxAttempts`。`src/tasks/control.ts:20-30` 明确指出 token、cost、wall-time 控制应属于 global spend guard，而不是单任务预算；但这个 global guard 当前并未实现。

Usage ledger 提供 record 和 summarize，没有 admission/cap API，见 `src/usage/ledger.ts:71-84`。

因此存在一个明确风险：

> 单个任务都符合 12 attempts，但 50 个自治任务仍然可以共同消耗巨大资源。

对于长期无人值守运行，这是 P0 级缺口。未知价格模型还需要 `costKnown=false` 的明确策略，否则单纯使用美元上限会 fail-open。

#### G7：at-least-once 已做到，端到端幂等尚未做到

当前重投时会提示模型检查既有副作用，见 `src/runtime/durable-dispatch.ts:35-52`。这对文件操作有一定效果，但对发消息、调用业务 API、创建工单、发布或审批等外部动作，仍主要依赖模型自行检查。

系统缺少通用的：

- effectId；
- idempotencyKey；
- effect receipt；
- 外部调用状态；
- “请求已发送但响应未知”的中间态；
- dispatch、step 和 effect 之间的稳定关联。

如果 Pipiclaw 未来承担真正的外部业务操作，这会比“重复改一个本地文件”危险得多。

#### G8：任务之间只有调度公平，没有语义依赖治理

当前设计有意删除 parent/dependency graph。这个简化对于控制复杂度是合理的，但代价是跨任务的前置条件只能写在 prose 或通过 wake 错开。

因此 driver 可以保证任务之间较公平，却不能保证：

- B 不会在 A 的必要产物完成前启动；
- 上游契约变化后下游计划自动失效；
- 一组任务的关键路径被正确推进。

这不是最优先缺口。应先完成单任务内部的阶段、证据和重规划闭环，再根据真实用例决定是否引入最小的 hard dependency，而不是直接建设通用 DAG。

---

## 4. 长期自主学习评审

### 4.1 已经形成的核心资产

#### 4.1.1 记忆分层合理

现有层次基本清楚：

- `SESSION.md`：当前工作状态；
- channel `MEMORY.md`：长期事实、偏好、决策、约束、open loop 和经验；
- `HISTORY.md`：旧历史摘要；
- `log.jsonl` / `context.jsonl`：冷存储；
- workspace `MEMORY.md`：共享背景知识；
- workspace `skills/`：程序性记忆；
- task Manual：单任务内部的执行经验。

相关使用边界见 `src/playbooks/memory-and-learning.md:12-24`。

这种“状态、事实、历史、流程”分离，比把全部内容无差别塞进一个向量数据库健康得多。

#### 4.1.2 自动记忆写入相当克制

统一 extraction pipeline 支持：

- add；
- supersede；
- invalidate；
- confidence；
- necessity；
- discarded candidates；
- 对敏感内容和 prompt injection 的防护。

规则见 `src/memory/extraction.ts:31-42`。只有 `confidence >= 0.85` 且 necessity 为 high 才自动写入，见 `src/memory/promotion.ts:14-24`。

这能有效抑制“什么都记、最终记忆污染”的问题。对于企业场景，宁可少记也不要悄悄固化未经证实的规则，这一原则应当保留。

#### 4.1.3 维护、纠错和遗忘设施较完整

项目已经具备：

- 共享串行维护队列；
- source window 和 correlation id 去重；
- tombstone；
- idle/boundary consolidation；
- HISTORY folding；
- cleanup shrink guard；
- 备份与 review log；
- `memory_manage save/search/forget`。

这是真正可以长期运行的工程能力，而不是演示性质的 RAG。

#### 4.1.4 中文词法召回和成本控制有针对性设计

当前 recall 对中文做了词典、bigram/trigram 等处理，并结合章节意图、recency、priority 评分。只有候选数量超过注入上限且排序存在歧义时，才按条件调用 LLM rerank；失败时 fail-open。

这套设计对成本、延迟和中文可用性进行了现实权衡。问题不在它“没有价值”，而在它不能单独承担长期知识召回的全部目标。

### 4.2 根本问题：当前更像记忆系统，还不是学习系统

#### L1：工作结果没有自动进入学习链路

最有价值的学习信号通常不是普通对话，而是：

- 用户纠正 Agent；
- verifier 判定失败；
- 同一种错误重复出现；
- 某个预检缺失导致返工；
- 某项操作成功但成本过高；
- 周期任务逐步形成稳定 SOP；
- 用户或 Agent 修改了 task Manual；
- 某条记忆被召回后导致错误回答。

目前这些事件没有统一生成“学习候选”。现有路径主要是：

- consolidation 从对话中抽取 memory；
- 模型自行决定是否更新 Manual；
- 模型自行决定是否创建或维护 skill。

这会导致学习能力依赖 Agent 当时有没有“想到要学习”，而不是系统稳定地从工作反馈中学习。

#### L2：memory metadata 很丰富，但多数没有进入召回决策

Memory metadata 已经包含：

- subjectId；
- ownerId；
- trust；
- validFrom；
- expiresAt；
- status；
- sensitivity；
- recallCount；
- lastRecalledAt；
- query fingerprints。

定义见 `src/memory/metadata.ts:14-48`。

但候选生成仍主要读取 SESSION、channel MEMORY、workspace MEMORY 和 HISTORY 的 Markdown 内容，见 `src/memory/candidates.ts:240-263`。召回打分主要使用词法证据、章节、优先级和时间，见 `src/memory/recall.ts:521-542`。

因此 metadata 目前更像记录层和遥测层，而不是完整执行语义：

- 过期事实不一定被过滤；
- 低可信事实不一定降权；
- owner/subject 不参与作用域判断；
- recallCount 不参与保留或淘汰；
- 召回后是否帮助任务，不反馈给排序。

记录这些字段是良好基础，但在进入召回、冲突和淘汰决策之前，不能把它视为已经实现了时间、可信度和主体语义。

#### L3：语义召回存在结构性上限

当前 LLM rerank 只能从词法检索已经找到的候选中筛选，不能把未进入 shortlist 的语义相关记忆找回来，见 `src/memory/recall.ts:600-651`。

也就是说：

> Agent 可能已经记住了一件事，但用户换一种没有关键词重合的表达方式，它仍然想不起来。

当前 capability case `M-recall-02` 正在探测这种场景，描述中也标明 expected partial failure；而它在 `evals/gates.json` 中仍是 report-only。

合理的改进不是简单用向量检索替换现有词法召回，而是增加一个并行语义候选通道，再把词法、语义、scope、trust、freshness 共同交给统一排序和冲突处理。

#### L4：跨频道知识不能自然成长为公司知识

channel memory 默认隔离是正确的隐私选择，但当前缺少受控晋升路径：

```text
频道内事实
  → 多次独立确认
  → 判断适用范围
  → 项目/团队/公司级候选
  → 审批或可信来源验证
  → workspace/company knowledge
```

workspace `MEMORY.md` 主要依赖人工维护。因此 Agent 在 A 群学到的公司规则，不会安全、系统地成为 B 群可用的组织知识。

“长期像老员工一样熟悉公司”不能只依靠聊天记忆，还需要：

- 明确的知识作用域；
- 来源和所有者；
- 生效时间和过期时间；
- 组织权威来源；
- 变更检测；
- 受控跨频道晋升。

#### L5：Skill 是可编辑文件，不是有生命周期的学习产物

Playbook 已规定“单任务经验先写 Manual，跨任务可复用时才建 skill”，见 `src/playbooks/memory-and-learning.md:36-47`。这个方向是正确的。

但当前没有：

- skill candidate；
- draft/active/deprecated 状态；
- 来源证据；
- 使用次数；
- 成功率；
- 生效前测试；
- 版本和回滚；
- 更新后的回归检测；
- 与模型版本或工作环境的兼容性记录。

所以现有 skill 更接近“Agent 可以编辑 SOP”，而不是“系统通过工作结果学习并治理 SOP”。

#### L6：没有把召回与最终效果关联起来

Metadata 可以记录某条 memory 被 recall 了多少次，但系统不知道：

- 它是否被 Agent 实际使用；
- 它是否帮助任务成功；
- 它是否导致错误；
- 用户是否随后纠正了相关结论；
- verifier FAIL 是否与某条旧规则有关。

没有这种 attribution，就无法回答“这条记忆有用吗”，也无法让 retrieval、retention 和 skill promotion 随真实工作效果改进。

应记录最小的因果链：

```text
task/turn
  → recalled memory IDs / activated skill versions
  → step outcome
  → verifier/user feedback
  → utility signal
```

这不是要求系统可靠推断完整因果，而是至少保留可分析的关联证据。

#### L7：没有证明“越用越聪明”的纵向评测

现有行为评测基础设施是项目亮点：真实 runtime 路径、进程 crash、证据产物、grader 和 gate 都已经存在。

但它主要验证：

- 能否记住一个事实；
- 能否在 3 或 10 次 wake 后保持目标；
- 能否从 crash 恢复；
- 是否触发预算、安全和验收门禁。

它没有验证：

> 同一类任务做第 20 次时，是否比第 1 次更快、更准、返工更少。

当前 baseline 还存在明显可解释性问题：

- baseline 日期为 2026-07-18，早于当前代码；
- configured model 是 `claude-sonnet-4-5`，observed model 是 `glm-5-turbo`；
- 2,597,325 tokens 记录成本为 0；
- 29 个 human review decision 尚未完成；
- 当前若干重要 capability case 仍是 report-only。

证据见 `evals/baselines/2026-07-18T10-06-46-544Z-cpkhq5/report.md:1-27` 和 `evals/gates.json:1-11`。

因此，目前还不能用评测结果证明 Pipiclaw 已经具备可靠长程自治或长期学习。

---

## 5. 建议建设的任务闭环

### 5.1 引入最小 Step Contract

建议每次自主回合必须持久化一个结构化步骤结果。概念模型可类似：

```ts
interface TaskStepCheckpoint {
  planRevision: number;
  stageId: string;
  stepId: string;
  hypothesis?: string;
  intendedAction: string;
  expectedEvidence: string[];
  observedEvidence: string[];
  outcome: "progress" | "no-progress" | "blocked" | "plan-invalid";
  failureClass?: string;
  nextAction?: string;
}
```

关键不在字段名称，而在于让 runtime 可以确定性判断：

- 预期证据是否出现；
- 当前阶段是否通过；
- 同一 failureClass 是否重复；
- 是否需要进入 reflection-only 回合；
- 是否只是产生 effect，却没有产生预期状态变化；
- 用户修改目标后，当前 planRevision 是否已经过期。

Markdown task 仍可作为人类可读的任务真相；机器状态应通过 task domain 内部的受控写入维护。不要把状态散落到新的通用 root utility，也不要允许模型随意覆写整个 JSON 状态。

### 5.2 增加阶段和 milestone 验收

不是每一步都需要独立 verifier。建议分为三类：

1. **确定性检查**：测试命令、文件 hash、schema 校验、API read-back。
2. **阶段检查**：阶段目标和 evidence 是否成立，可由 runtime 或当前 Agent判定。
3. **独立 milestone verifier**：在高风险或高返工成本节点使用只读 sub-agent。

最终 done verifier 保持现有强约束；milestone verifier 只证明一个阶段，不提前赋予任务完成资格。

### 5.3 把重规划变成状态机

满足以下任一条件时，进入 `replanning`：

- 同一 failureClass 连续出现两次；
- expectedEvidence 缺失；
- 阶段检查失败；
- verifier 返回 FAIL；
- 用户修改 Goal、DoD 或关键约束；
- nextAction 连续多次未改变；
- 阶段消耗超过预期 attempts；
- 外部依赖状态与计划假设不一致。

`replanning` 回合只允许：

- 读取证据；
- 修改计划；
- 更新 Manual 和 nextAction；
- 请求用户做必须由人决定的选择。

不允许继续执行外部副作用。这样才能把“反思”变成真正的系统阶段，而不是模型输出的一段自我描述。

### 5.4 用状态变化替代粗粒度 effect 作为进展证据

Effect ledger 可以继续用于判断“这个回合完全没做事吗”，但不应继续承担“是否取得进展”的主要语义。

更可信的进展证据包括：

- expected artifact 出现且内容满足检查；
- 测试失败数下降；
- 某项 DoD 的证据成立；
- 阶段状态由 open 变为 passed；
- 已知 blocker 被解除；
- 外部系统 read-back 与期望一致。

进展判据应该绑定 step/stage，而不是把“写过文件、跑过命令、发过回复”统一视为前进。

### 5.5 持久化 governor evidence

至少持久化：

- 连续 no-progress 次数；
- 最近 failureClass；
- 最近 expected/observed evidence hash；
- 最近 planRevision；
- 最近阶段检查结果；
- effect receipt 索引。

这样重启不会重新给失控任务无限刷新耐心，也方便 `/tasks inspect` 解释为什么任务继续、退避、重规划或暂停。

### 5.6 为外部副作用引入稳定 effect identity

建议稳定关联：

```text
taskId / cycleId / planRevision / stepId / effectId
```

对于支持幂等键的外部系统，直接透传 idempotency key；不支持时至少写入本地 effect receipt，并在重投前执行 read-back 或 reconciliation。

必须显式表达：

- prepared；
- submitted；
- acknowledged；
- outcome-unknown；
- reconciled；
- failed。

不能把“工具调用返回前进程死了”简单归为未执行或已执行。

### 5.7 实现全局自治预算

建议最小能力包括：

- 每日、每月 token cap；
- 已知成本 cap；
- `costKnown=false` 模型仍受 token cap；
- 最大并发自主回合；
- 每频道或优先级配额；
- 触顶后暂停非关键任务；
- 一次性、去重的用户通知；
- 明确的人工恢复路径。

保留 per-task attempts 作为局部 stop-loss；全局 budget 解决总体资源治理，两者不能互相替代。

---

## 6. 建议建设的长期学习闭环

### 6.1 建立 Learning Candidate Ledger

不要让 runtime 从一次观察直接自动修改 workspace memory 或 skill。先生成可审计候选：

```ts
interface LearningCandidate {
  id: string;
  kind: "fact" | "policy" | "procedure";
  claim: string;
  scope: string;
  evidenceRefs: string[];
  sourceEvents: string[];
  occurrenceCount: number;
  confidence: number;
  contradictions: string[];
  proposedTarget: "channel-memory" | "workspace-memory" | "task-manual" | "workspace-skill";
  status: "candidate" | "validated" | "promoted" | "rejected" | "retired";
}
```

建议在领域层新增 `src/learning/`，承载候选、验证、晋升和效果反馈，而不是继续扩大 `src/memory/` 或新建泛化 root utility。

### 6.2 建立稳定的候选来源

至少接入：

- 用户纠正、steer、forget；
- task verifier FAIL；
- 相同 failureClass 跨任务重复；
- task Manual 的返工教训；
- 周期任务连续成功形成的稳定操作步骤；
- 召回内容被用户否定；
- skill 使用后发生明显回归；
- 权威数据源发生变化。

候选生成不等于候选自动生效。它只是保证“系统不会忘记自己曾经学到一个可能有价值的教训”。

### 6.3 按知识类型实施不同验证策略

#### 事实

- 优先要求权威来源或明确用户陈述；
- 记录 subject、owner、scope、validFrom、expiresAt；
- 与现有事实冲突时形成 conflict set，不静默叠加。

#### 政策和约束

- 默认需要用户或组织权威来源确认；
- 不允许普通聊天自动扩大权限；
- 必须有适用范围和生效时间。

#### 程序和 skill

- 至少在多个真实任务中重复出现，或由用户明确要求；
- 在隔离 fixture 或 behavior eval 上验证；
- 对高风险外部动作继续保留审批；
- 通过后以版本化方式激活。

### 6.4 建立受控晋升路径

建议目标分工保持清楚：

- channel memory：局部事实、偏好和决定；
- task Manual：单一任务中的执行教训；
- workspace memory：经过验证、跨频道适用的组织事实；
- workspace skill：跨任务复用的程序性知识。

自动晋升应当比自动写 channel memory 更保守。尤其不能把一个群中的偶然说法直接变成公司政策。

可引入作用域层级：

```text
user → DM/group → project → workspace → company
```

默认只在原作用域生效；扩大作用域需要额外证据、策略或审批。

### 6.5 让 metadata 真正参与 recall

召回至少应执行：

- status 过滤；
- expiresAt 过滤或显著降权；
- trust 加权；
- subject/owner/scope 匹配；
- verified source 优先；
- conflict set 联合返回或明确裁决；
- sensitivity 对可见范围的限制。

对于互相矛盾的记忆，不应只看词法得分随机选一个。合理行为是：

- 优先最新且 verified 的条目；或
- 同时呈现冲突及其时间、来源；或
- 要求用户确认。

### 6.6 增加语义候选通道，而不是替换现有检索

推荐采用混合召回：

```text
词法候选
  + 语义候选
  + intent seeds
  → scope/trust/freshness/conflict filter
  → rerank
  → prompt injection
```

这样既保留关键词和标识符检索的精确性，也能覆盖无明显词法重合的改写问题。

### 6.7 为 skill 建立版本、验证和回滚

最小生命周期：

```text
candidate → draft → validated → active → deprecated/rolled-back
```

每个版本至少记录：

- 来源任务和 evidence；
- owner；
- 创建、验证和最近使用时间；
- 适用环境；
- 使用次数；
- 成功/失败关联；
- 验证用例；
- 前一版本和回滚路径。

Agent 可以自动提出 patch；是否自动激活，应依据风险级别和测试结果，而不是统一放开。

### 6.8 建立最小效果 attribution

每个 turn/task 记录：

- 注入了哪些 memory IDs；
- 激活了哪些 skill version；
- 产生了什么 step outcome；
- verifier 是否 PASS；
- 用户是否纠正；
- 是否发生返工或回滚。

然后形成简单 utility signal。早期不必声称精确因果，只需能够发现：

- 某条记忆经常被召回但随后被纠正；
- 某个 skill 使用后失败率显著上升；
- 某个候选晋升后从未被使用；
- 某类任务随着经验积累 attempts 是否下降。

---

## 7. 评测与效果证明

### 7.1 长程自主任务 benchmark

建议覆盖：

- 20、50、100 次 wake；
- 多次冷启动、滚动重启和 SIGKILL；
- 工具偶发失败和超时；
- 外部等待与延迟回调；
- 中途目标和约束变化；
- 初始假设错误；
- 重复投递；
- 外部动作响应未知；
- 多任务争用资源；
- verifier 在中间 milestone 返回 FAIL。

关键指标：

- DoD 真正通过率；
- 错误完成率；
- 无人干预完成率；
- 平均每任务 attempts；
- 用户纠正次数；
- 重启后的恢复点丢失量；
- 重复外部副作用次数；
- false-progress rate；
- no-progress 检测延迟；
- plan revision 次数和原因；
- verifier 首次通过率；
- token、成本和墙钟时间。

### 7.2 长期学习 benchmark

建议模拟至少 30 个工作日、50 个具有重复结构的任务，并刻意插入：

- 政策变化；
- 用户纠正；
- 过期事实；
- 同义改写；
- 跨频道权限边界；
- 重复流程；
- skill 更新后的潜在回归。

必须对比：

- fresh workspace；
- learned workspace；
- learned workspace 但禁用 recall/skill 的消融组。

否则无法区分提升来自记忆、skill，还是模型随机波动。

关键指标：

- 首次成功率提升；
- attempts/task 是否随重复次数下降；
- 用户纠正次数是否下降；
- 召回 precision/recall；
- 过期记忆导致的错误率；
- 冲突记忆错误裁决率；
- skill 使用后的成功率 uplift；
- skill 更新后的回归率；
- 候选晋升后实际复用率；
- 无 provenance 的组织知识比例；
- 一个月后仍有效的记忆比例。

如果这些指标没有改善，就不能称为“长期学习”，最多只能称为“积累了更多文本”。

### 7.3 当前 eval 的近期整改

1. 用当前 commit 和实际运行模型重新生成 baseline。
2. 修正 configured/observed model 不一致问题。
3. 补齐价格元数据；未知价格时保留 token cost signal，不把 `$0` 解释成免费。
4. 完成 human grader calibration。
5. 将稳定后的 `T-resume-10`、`T-crash-01` 等核心能力升级为 required gate。
6. 新增长程 replan、duplicate effect、learning uplift 和 stale memory case。
7. 将 `channel-runner`、`bootstrap` 的关键编排故障场景纳入进程级或 behavior eval，而不只增加函数级覆盖率。

---

## 8. 分阶段迭代路线

### P0：可信基线与自治安全，建议 1～2 周

目标：先确保系统不会在没有总量治理和效果测量的情况下扩大自治规模。

交付：

1. 当前 commit 的可信 baseline。
2. 长程任务和长期学习纵向 benchmark 初版。
3. 全局 token/cost/concurrency guard。
4. 持久化 no-progress/governor evidence。
5. task step outcome 和 evidence 的观测埋点。

验收：

- baseline 可以复现；
- observed model、token、cost 状态可解释；
- 达到全局上限时不再派发非关键自治任务；
- 重启后 no-progress 计数不被清空；
- 每个 task turn 都能追踪 outcome 和 evidence。

### P1：证据驱动的任务循环，建议 2～6 周

目标：从“可靠任务调度器”跨到“受控自主执行器”。

交付：

1. Step Contract、planRevision、stage evidence。
2. 确定性 replan triggers。
3. reflection-only/replanning 状态。
4. milestone check 和高风险独立 verifier。
5. effectId、idempotency key、receipt 和 reconciliation。
6. `/tasks inspect <id>`，展示阶段、计划版本、证据、失败原因和重规划历史。

验收：

- 重复失败能触发换路，不只是增加 attempts；
- 只有 effect、没有 expected evidence 的回合不再被视为有效进展；
- 用户修改契约会使旧 plan revision 失效；
- crash/replay 不产生重复外部副作用；
- milestone 失败能在最终 candidate 前被发现。

### P2：可审计的学习闭环，建议 6～10 周

目标：让纠正、失败和成功经验稳定进入学习系统，而不是依赖模型临场自觉。

交付：

1. `src/learning/` 和 learning candidate ledger。
2. user correction、verifier FAIL、重复 failureClass 等候选来源。
3. metadata-enforced recall。
4. conflict、expiry 和 scope 语义。
5. channel → workspace 的受控晋升。
6. skill draft、validate、active、rollback 生命周期。
7. memory/skill 使用与 task outcome 的关联记录。

验收：

- 每个高价值纠正都能生成候选或明确说明为什么丢弃；
- 过期记忆不会无提示地作为当前事实使用；
- 组织级知识都有 provenance 和 scope；
- skill 激活前有验证证据，回归后可以回滚；
- learned workspace 在重复任务上显著优于 fresh workspace。

### P3：组织知识与规模化优化，建议 10～14 周

目标：让 Pipiclaw 在公司环境中持续积累可信知识，同时不突破隐私和权限边界。

交付：

1. 词法 + 语义混合召回。
2. user/channel/project/workspace/company scope lattice。
3. 公司文档、仓库和内部系统的 provenance-aware 同步。
4. TTL、change detection 和 conflict review。
5. learning dashboard、候选审批和 skill canary。

验收：

- 无关键词重合的已知事实能够稳定召回；
- 跨频道知识不会未经授权扩散；
- 权威知识变化后旧事实能自动失效或进入 review；
- skill 更新不会未经 canary 直接影响全部任务。

---

## 9. 不建议优先投入的方向

1. **继续主要扩充 system prompt 或 playbook。** 它们可以指导行为，但不能替代运行时状态和效果反馈。
2. **立即建设完整任务 DAG、复杂多 Agent 组织图或通用工作流引擎。** 先把单任务内部的计划、证据和重规划做实。
3. **把向量数据库当作长期学习本身。** 它只解决部分召回，不解决验证、晋升、反馈和淘汰。
4. **自动把每次任务总结直接写成 skill。** 这会快速积累未经验证的错误 SOP。
5. **在没有 fresh-vs-learned 对照实验前宣称“越用越聪明”。** 文件数量增长不是能力增长。
6. **把代码覆盖率等同于自治效果。** 当前 tasks/memory 覆盖率已不低，真正缺少的是跨时间的结果评测。
7. **让学习系统自动扩大外部操作权限。** 知识学习、技能优化和权限授权必须分开治理。
8. **优先优化记忆压缩参数。** 在没有 utility attribution 前，无法知道删掉或保留的内容是否真正影响工作效果。

---

## 10. 关键产品原则

后续 spec 和实现建议持续遵守以下原则：

1. **任务真相必须落盘。** 包括计划版本、证据、失败类别和 governor 状态，而不只是 Goal 与日志。
2. **动作不等于进展。** 进展必须由预期状态变化或可验证证据定义。
3. **反思必须能改变受控状态。** 只有输出文字、没有新计划版本，不算完成反思。
4. **最终验收之外，还要有经济的阶段检查。** 尽早发现方向错误。
5. **at-least-once 必须配合 effect identity。** 否则可靠重投可能转化为重复副作用。
6. **记忆不等于学习。** 学习必须有结果反馈和行为改善证据。
7. **候选与生效分离。** 观察可以自动化，组织知识和 skill 的晋升必须经过验证。
8. **默认局部作用域。** 跨频道、跨项目和公司级知识必须显式晋升。
9. **可回滚比自动修改更重要。** 特别是程序性 skill 和外部动作流程。
10. **以效果曲线而不是功能清单作为北极星。** 同类任务是否越来越快、越来越准、越来越少需要人纠正，才是数字员工是否成长的证据。

---

## 11. 最终判断

Pipiclaw 当前最值得肯定的不是“已经实现了自主学习”，而是它已经搭建了一个足以承载未来自主学习和长程自治的可靠底座：持久任务、恢复、调度、审批、验证、分层记忆、维护队列、遗忘和行为评测，这些都不是表面功能。

但也必须保持清醒：

- 任务系统当前擅长的是**保证循环继续运行并在必要时停下来**，还不擅长**根据证据判断应该怎样改变方向**。
- 记忆系统当前擅长的是**保存和召回可能有用的信息**，还不擅长**从工作成败中判断应该学什么，以及学到的东西是否真的有用**。

因此，下一阶段最具杠杆的工作不是增加更多工具、更多 Agent 角色或更多记忆容量，而是：

> 先让每一步都能用证据判断“是否真的前进”，再让每次失败和纠正都进入可验证的学习候选；最后才扩大任务编排、语义检索和组织知识规模。

如果这两个闭环能够被实现并由纵向 benchmark 证明，Pipiclaw 才会从“可靠的 Agent Runtime”真正迈向“会长期工作、会持续成长的数字员工”。
