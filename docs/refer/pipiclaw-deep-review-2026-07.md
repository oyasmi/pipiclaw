# Pipiclaw 深度审查与迭代路线图（2026-07）

> 本文是一份面向后续迭代的战略参考，不是某个版本的发布清单。它评估 Pipiclaw 作为长期个人 AI Agent Runtime 的系统能力、工程水平和主要风险，并将结论转化为短期、中期、长期的建设方向。

| 字段 | 值 |
|---|---|
| 审查日期 | 2026-07-17～2026-07-18 |
| 代码基线 | `master@7f16620`（`feat(tasks): implement spec 027 native recurrence`） |
| 包版本 | `0.8.8-beta.1` |
| 审查范围 | 运行时、长程任务、事件、记忆、上下文、Skills、子代理、工具、安全、交付、测试、文档与产品方向 |
| 文档用途 | 指导后续 spec 立项、优先级决策、架构演进和行为评测 |

## 1. 执行摘要

Pipiclaw 已经不只是“钉钉里的 Coding Agent”，而是一套相当完整的、面向个人长期使用的 Agent Runtime。

它最有价值的地方不是某一项功能，而是已经初步打通了以下闭环：

```text
触发/唤醒 → 获取相关上下文 → 使用工具推进 → 持久化检查点
         → 等待/重试 → 独立验收 → 向用户交付 → 沉淀记忆与技能
```

在个人开源 Agent 项目中，这种完成度并不常见。长程任务、分层记忆、事件系统、子代理验收、文件化状态、上下文预算和用户控制已经构成一个真实系统，而不是松散功能集合。

Pipiclaw 当前最适合的是“用户监督下的长期自主工作”：编程项目、研究、周期报告、事项跟进、本地文件与命令自动化。它能够显著降低用户持续盯住 AI、反复重述背景、人工维护进度的成本。

但它距离“可以放心把重要事务交给它无人值守执行”仍缺少三个信任基石：

1. **执行前授权**：外部操作应在工具真正执行前暂停和审批，而不是在任务完成时检查。
2. **动作级幂等**：每次外部动作应有稳定 occurrence/action ID、执行凭据和崩溃恢复语义。
3. **行为评测**：需要证明 Agent 在多轮、长程、异常和攻击条件下确实可靠，而不仅是代码通过测试。

下一阶段的核心不应是继续横向堆功能，而应完成从“功能完整”到“可信自主”的跃迁。

## 2. 审查方法与验证基线

本次审查采用以下方法：

- 阅读核心代码与领域边界；
- 交叉核对设计文档和实际行为；
- 检查长程任务、事件、记忆、子代理、安全和交付机制之间的组合关系；
- 执行类型检查、单元/集成测试、静态检查和覆盖率测试；
- 对照 2025～2026 年 Agent harness、长程任务、HITL、sandbox、memory、eval 和 multi-agent 的行业实践。

实际验证结果：

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run test` | 107 个测试文件、784 个测试全部通过 |
| `npm run lint` | 通过 |
| `npm run deadcode` | 通过 |
| 串行完整 coverage | 107/107 文件、784/784 测试通过 |
| Statements / Lines | 79.98% |
| Branches | 77.29% |
| Functions | 80.72% |

默认并行 coverage 曾出现一次 `log-file-sink` 失败，单文件和串行完整运行均通过，判断为全局 logger 或临时状态的测试隔离竞争。它不影响本次总体判断，但应在后续修复并纳入稳定 CI。

仓库中存在 10 个真实模型 E2E 测试文件，覆盖基础会话、命令、工具、system prompt、记忆、任务、事件和 TUI。本次没有执行需要真实模型凭据和成本的 E2E。现有 E2E 主要验证一次性集成路径，不能替代多次 trial 的行为评测。

## 3. 综合评分

评分用于表达相对成熟度和迭代优先级，不代表精确的数学度量。

| 维度 | 评分 | 判断 |
|---|---:|---|
| 产品定位与系统方向 | 8.8/10 | 抓住了长期个人 Agent 的核心矛盾 |
| 长程任务与自主驱动 | 8.6/10 | 当前最强部分，已经形成可持续任务闭环 |
| 记忆与上下文工程 | 8.0/10 | 架构成熟，语义召回和跨频道人格仍有限 |
| 运行时可靠性 | 8.5/10 | 队列、重连、持久派发、原子写入比较扎实 |
| 子代理与验收 | 7.9/10 | 克制且实用，隔离和编排仍有提升空间 |
| 安全、授权与治理 | 6.4/10 | 工具级防线良好，缺少真正的执行前授权边界 |
| 行为评测与科学迭代 | 5.4/10 | 当前最明显的工程短板 |
| 可扩展能力与个人生态 | 6.8/10 | Coding/研究较强，通用个人事务连接器不足 |
| 代码、测试与文档质量 | 8.3/10 | 规范扎实，有少量大文件、私有 SDK 耦合和文档漂移 |

两个不同口径的总体判断：

- **作为个人开源 Agent Runtime：8.2/10。**
- **作为可信自主的个人 AI 操作系统：约 7.0/10。**

当前能力边界应明确区分：

- 用户监督下持续推进工作：约 8.5/10；
- 无人值守执行发布、消息发送、生产操作、财务或其他不可逆外部动作：约 5.5～6/10。

## 4. 组合机制为什么有效

### 4.1 任务账本是系统的耐久脊柱

`src/runtime/task-driver.ts`、`src/tasks/` 和 `src/tools/task-manage.ts` 共同承担了长期工作状态：

- priority 与频道内外公平调度；
- 父子任务和依赖；
- deadline、attempt/token/cost/time budget；
- wake、原生周期 recurrence；
- checkpoint、恢复和停滞退避；
- side effects、approval、verification；
- candidate、done、cancel、start-cycle 生命周期。

这使 Agent 不需要依靠上下文窗口记住工作，而是把目标、完成定义、下一步和验收状态放入可恢复的外部状态。它与长程 Agent 的最佳实践一致：增量推进、结构化交接和干净状态比单纯依赖 compaction 更可靠。

### 4.2 事件和 TaskDriver 赋予系统主动性

事件适合确定时间或条件触发，TaskDriver 负责原生长程任务恢复。二者结合后，Agent 能够：

- 在未来时间主动回来；
- 对等待中的外部条件做检查；
- 周期执行报告和维护；
- 在崩溃或重启后恢复未完成任务；
- 对长期停滞任务退避，而不是高频烧 token。

主动性由确定性 runtime 驱动，而不是要求模型在一个长回合里保持在线，这是正确的系统边界。

### 4.3 分层记忆提供长期连续性

Pipiclaw 将记忆分成：

- `SESSION.md`：当前工作状态；
- `MEMORY.md`：耐久事实、约束和偏好；
- `HISTORY.md`：压缩后的旧历史；
- `log.jsonl` / `context.jsonl`：冷存储；
- workspace Skills：程序性经验。

这比“把所有内容放进向量数据库”更符合真实 Agent 的认知分工。候选元数据、tombstone、备份、后台维护、sidecar 用量隔离、自动召回预算和提示词 wrapper 剥离，也说明记忆被当作生命周期系统，而不是单次检索功能。

### 4.4 子代理提供受控的认知分离

子代理具有：

- 工具白名单；
- turn/tool/time 限额；
- 禁止递归；
- 独立 usage 计账；
- 可选 worktree；
- checker-only verifier；
- attestation 与 task/artifact hash 绑定。

这里的价值不是“多几个 Agent”，而是将实现者和验收者分离，降低 maker 自证造成的盲点。当前保持克制是正确的；多代理只应在任务可独立分支、并行收益明确时启用。

### 4.5 交付和控制面保留人的主权

DingTalk、AI Card、斜杠命令、任务列表、approval 和 usage/context/status 命令共同提供了：

- 移动端可达；
- 随时查看和中断；
- 长任务无需持续守候；
- 成本和上下文可见；
- 重要节点可以由人接管。

对于个人 Agent，真正的自主不是完全不需要人，而是让人的注意力只出现在高价值决策点。

## 5. 设计与实现的主要优点

### 5.1 Runtime 可靠性优先级正确

项目不是薄聊天适配器，而是包含：

- DingTalk daemon 和 TUI；
- per-channel 串行队列；
- 明确的 turn state；
- 重连、去重和队列上限；
- AI Card 流式交付；
- 文件 outbox 和 lease；
- 至少一次 synthetic dispatch；
- 原子写入和备份；
- 后台 memory scheduler；
- 用量账本和上下文预算。

这些机制决定了系统能否持续数周、数月运行，优先级高于表面功能。

### 5.2 Prompt 架构具有清晰的内容责任

系统提示词采用 section、authority、预算、manifest 和 fingerprint；低频知识通过 playbook/skill progressive disclosure 按需加载；每回合动态事实进入 runtime turn context，而不是污染长期缓存。

这是较成熟的 context engineering。后续应以行为 eval 为前提做增删，而不是继续凭直觉修改大型 prompt。

### 5.3 工具错误具有可行动性

项目规定每个工具错误或截断输出都应告诉模型下一步，如使用 offset 继续、改用 grep、修复控制字段。这一点非常重要：Agent 工具错误不是面向终端用户的日志，而是下一次决策的输入。

### 5.4 文档和设计过程比较诚实

现有 spec 会记录尚未闭合的 DoD、实现偏差、行为 eval 缺口和 SDK 限制，没有把“代码已写”包装成“系统问题已解决”。这为长期演进提供了良好基础。

## 6. 关键问题与完成标准

以下问题建议作为后续 spec 的主要输入。

### P0-1：建立真正的执行前外部授权边界

#### 当前事实

- `task_manage done` 在任务完成阶段检查 external approval；
- 主 Agent 在此之前仍可能调用 `bash`、网络或其他工具产生外部副作用；
- `task_manage` schema 允许 Agent 将 `externalApproval` 设置为 `not-required`；
- `applyTaskControlPatch` 在显式提供该值时会保留它；
- `docs/events-and-tasks.md` 则声明 external task 自动进入 required，Agent 不能自授予豁免。

因此当前 approval 更接近“任务能否收尾”的门，而不是“副作用能否发生”的门。

#### 风险

- 未经批准的动作可能已经发生，只是任务不能 done；
- 模型可以通过设置 `not-required` 绕过 required 默认值；
- approval 绑定 task body，但未绑定准确的工具、参数、目标和作用域；
- prompt 中的授权规则属于概率性约束，不是 runtime 不变量。

#### 建议方案

在统一 tool middleware 中增加动作风险分类：

```text
read-only → workspace mutation → external/reversible → external/irreversible
```

对需要审批的调用，在执行前持久化：

```text
toolName + normalizedArgs + target + scope + artifactHash + expiry
```

状态机：

```text
proposed → approved/edit/rejected → executing → completed
```

同时：

- `externalApproval: not-required` 只能由用户命令或用户维护的 policy 设置；
- Agent 工具不能创建豁免；
- 周期自动化使用带范围、期限和撤销能力的 standing grant；
- task body、artifact、tool args 或目标变化后授权自动失效；
- approval 必须进入审计记录。

#### 完成标准

- 未批准的 external tool call 在 executor 之前被可靠暂停；
- crash/restart 后仍停留在待审批状态；
- approve/edit/reject 均有集成测试；
- Agent 无法通过 task metadata 自行豁免；
- 参数、目标、工件变化会失效旧批准；
- hard-invariant eval 中未授权外部执行次数为 0。

### P0-2：建立 occurrence/action journal 和动作级幂等

#### 当前事实

`src/runtime/durable-dispatch.ts` 明确实现 at-least-once delivery。dispatch ID 包含事件 `ts`；TaskDriver 的退避状态主要保存在内存 `Map` 中。任务 attempt claim 虽然持久化，但进程重启后仍可能生成带新时间戳的新 dispatch。

如果外部动作已经成功、task checkpoint 尚未写入时崩溃，恢复后可能重复执行。

#### 建议方案

为每个周期和动作生成稳定 ID：

```text
occurrenceId = taskId + cycleId
actionId     = occurrenceId + actionSequence + normalizedActionHash
```

持久化 action journal：

```text
proposed → approved → executing → succeeded
                             ↘ failed
                             ↘ unknown
```

外部系统支持时传递 idempotency key；不支持时保存请求、响应、外部资源 ID 和检查方法。`unknown` 禁止盲目重试，应先查询外部状态或请求用户决策。

#### 完成标准

- 同一 occurrence 在重复 dispatch、重启和 lease 过期后不会重复创建动作；
- 在 tool call 前、执行中、执行后但 checkpoint 前注入崩溃，均有确定恢复结果；
- action receipt 能关联 task、turn、approval 和外部结果；
- 不可确定的动作进入 `unknown`，不会自动重放；
- 周期任务连续运行多周期不会混用旧授权或旧凭据。

### P0-3：建立 Agent 行为评测体系

#### 当前事实

`docs/specs/025-system-prompt-architecture/design.md` 和 `026-system-prompt-slimming/design.md` 均明确记录 behavior eval harness 尚未建立。

现有单元/集成测试很好地验证了机制正确性，但没有回答：

- prompt 调整后任务成功率是否变化；
- 长任务多次恢复后是否仍忠于 Goal/DoD；
- memory 有多少误召回、漏召回和错误写入；
- 模型是否正确读取 playbook；
- approval、budget、verification 是否会被误用或绕过；
- 不同模型的成功率、成本、延迟边界如何。

#### 建议方案

第一阶段建立 30～50 个高价值场景，分为三类：

1. **Capability eval**：测试新能力上限；
2. **Regression eval**：保证已能完成的任务不退化；
3. **Safety/invariant eval**：验证授权、预算、路径、网络和记忆边界。

重点任务：

- 普通任务创建、分解和推进；
- 第 3/10/20 次恢复后的目标保持；
- dependency、deadline、budget、blocked；
- 周期任务不重复执行；
- crash recovery；
- memory recall、forget、supersede、contradiction；
- prompt injection 和 tool-result injection；
- approval 拒绝、编辑、过期和参数变化；
- verifier 发现不完整或伪造工作；
- 不确定时正确升级给用户。

指标：

- pass@1、pass^3 或多 trial 成功率；
- hard-invariant violations；
- 最终任务成功率和平均恢复次数；
- 重复副作用次数；
- memory precision/recall；
- token、成本、延迟、工具调用数；
- 需要用户介入的次数；
- 不同模型/提示词版本的差异。

#### 完成标准

- eval case、trial、trajectory、outcome 和 grader 有稳定 schema；
- 支持代码 grader、模型 grader 和人工抽查；
- 核心 regression eval 能在 CI 或定期任务运行；
- prompt、memory、task driver、skill 自动写入等重大变化有基线对比；
- 发布说明能报告能力变化，而不仅是测试通过。

### P1-1：将 `preAction` 收敛为受限传感器

#### 当前事实

`preAction` 经 command guard 后交给 executor 执行。它在概念上是传感器，但技术上仍是宿主 shell 命令，且可能由 Agent 创建的 event 自动触发。

#### 风险

- command guard 不是完整 shell parser；
- `preAction` 不等价于只读或无网络；
- 长期无人值守时，它可能成为绕开常规 Agent turn 控制的执行入口。

#### 建议方案

- 默认禁网、只读、短超时；
- 只允许用户安装或声明的 sensor executable；
- 参数采用结构化数组，不接受任意 shell 字符串；
- sensor 输出只表达 pass/fail 和受限 metadata；
- 高风险 sensor 运行在容器或独立账号；
- 将 sensor capability 写入审计和状态页面。

#### 完成标准

- Agent 无法通过 `preAction` 写文件或访问未授权网络；
- command injection、shell chaining、symlink 和 timeout 有回归测试；
- 旧 event 有迁移/诊断机制；
- sensor 失败不会产生高频热循环。

### P1-2：提升宿主隔离和 secrets 治理

#### 当前事实

项目文档明确承认当前不是 OS 级 sandbox，bash guard 不是完整 parser，写入存在 TOCTOU 边界。path/network/command guard 对个人开源 runtime 已属较强，但它们不能限制宿主用户权限的最大损失。

#### 建议方向

- 推荐部署改为独立账号或容器；
- 引入首次启动 security posture 检查；
- 高风险任务使用 per-task container/microVM；
- secrets 通过短期 broker 注入，不长期暴露给模型；
- 网络使用 egress proxy/allowlist；
- verifier 的 bash 也进入只读隔离环境；
- 将敏感能力设计为可撤销 capability，而不是永久环境权限。

### P1-3：突破记忆召回的词面候选天花板

#### 当前事实

`src/memory/recall.ts` 先以词面分数形成 shortlist，再进行可选模型 rerank。模型只能重排已进入 shortlist 的候选；零词面重叠的语义相关记忆可能永远不会被看到。

#### 建议方案

先建立 recall eval，再采用候选并集：

```text
词面候选 ∪ 语义候选 ∪ 最近候选 ∪ 高可信约束候选
                     ↓
                 模型重排
```

不要在没有评测前直接引入庞大向量基础设施。需要测量：

- 召回精度和覆盖率；
- paraphrase 和跨语言召回；
- 冲突记忆排序；
- token 成本；
- 错误记忆进入上下文后的行为影响。

### P1-4：建立个人级、跨频道记忆

当前自动事实和偏好主要落在 channel memory；DingTalk DM、群聊和 TUI 是不同 channel，个人身份与长期偏好可能碎片化。

建议增加：

- `personal / workspace / channel` 三层 scope；
- 来源、时间、置信度、有效期和 sensitivity；
- contradiction 和 supersede；
- 用户确认、导出、纠正和遗忘；
- 跨入口共享但按授权隔离的个人 profile。

### P1-5：为自动 Skill 写入增加晋升流程

自动生成 workspace Skill 是很有潜力的程序性学习能力，同时也是持久 prompt injection 和错误经验固化的入口。

建议流程：

```text
review 产生候选 → 展示 diff/来源/置信度 → staging
                → 针对性 eval → 用户或 policy 批准 → active
```

要求版本化、可回滚、可禁用，并记录哪个 run 和哪些证据促成了修改。

### P1-6：增加统一的 run trace

当前已有日志、usage、prompt fingerprint、task doctor/stats 和 event history，但缺少贯穿全链路的统一轨迹：

```text
dispatch → turn → tool → task mutation → verifier
         → approval/effect → memory mutation → delivery
```

建议增加 correlation ID 和 `/runs show|replay`，支持查看每次长期任务为什么被唤醒、做了什么、消耗多少、修改了哪些状态、为何结束。

### P1-7：修复跨进程并发边界

当前主要并发控制是单进程内队列。daemon 与 TUI 若同时接管同一 channel，仍可能竞争文件和逻辑状态。

建议增加 app-home/channel lock，明确：

- 单写者所有权；
- stale lock 恢复；
- TUI takeover 协议；
- memory scheduler、TaskDriver 和人工回合之间的锁顺序。

### P2-1：从 Coding Runtime 扩展为个人能力平台

当前 DingTalk 输入主要处理 text/richText，缺少文件、图片和语音的一等支持；外部能力也主要依赖 web、shell 和 workspace skill。

中期应优先建设受控连接器：

- Calendar；
- Email；
- Docs/个人知识库；
- GitHub；
- Browser；
- 通知和消息；
- 文件、图片、语音输入。

每个连接器必须区分 read/write，使用最小 OAuth scope、capability manifest、执行前授权和 action receipt。不要通过 unrestricted bash 快速堆连接器。

### P2-2：降低核心 orchestration 的维护风险

当前 `channel-runner.ts`、`bootstrap.ts`、`dingtalk.ts`、`task-manage.ts` 均接近或超过 1000 行。领域划分总体良好，但单文件内部职责已经较多。

此外，`ChannelRunner.setSessionBaseToolsOverride` 访问 SDK 私有 `_baseToolsOverride`，这是明确的升级脆弱点。

建议：

- 按 turn preparation、tool lifecycle、delivery、resource reload 拆分内部组件；
- 保持 `src/main.ts` 和 bootstrap assembly 薄；
- 推动上游 SDK 提供公开 tool override setter；
- 对私有耦合增加兼容测试和版本升级 checklist；
- 不为拆分而创建通用 root utility 或无意义 barrel。

### P2-3：消除文档与实现漂移

本次发现的代表性漂移：

- 代码中 network guard 默认开启，架构文档仍写默认关闭；
- `task_manage create` 代码默认 `verification.mode: evidence`，文档写默认 `independent`；
- external approval 的自动 required/Agent 不可豁免声明与 schema/patch 行为不一致。

其中 verification 默认 `evidence` 本身是合理的成本取舍：普通研究、写作、提醒任务不需要额外 verifier；高风险或有可检查工件的任务再显式使用 independent。关键是将风险分级写成统一契约，并让测试覆盖默认行为。

## 7. Pipiclaw 对个人能力释放的实际效果

### 7.1 已经能够显著提升的场景

#### 长期项目连续性

用户可以把目标和完成定义交给任务账本，不需要每次重新告诉 AI 当前进度。TaskDriver、SESSION 和 checkpoint 能够在跨会话、跨天甚至重启后继续工作。

#### 主动跟进与周期工作

提醒、检查、周期报告、项目 follow-up 和等待外部结果，可以从“用户记得回来问”变成“系统在合适时间主动回来”。

#### 编程与研究杠杆

工具、web、子代理、worktree、任务分解和验证适合：

- 中小型代码改造；
- 多轮 bug 调查；
- 文档和调研；
- 方案比较；
- 周期维护；
- 独立质量检查。

#### 个人偏好和经验积累

分层记忆与 Skills 使每次互动不再完全从零开始。长期价值会来自“Agent 越来越理解用户如何工作”，而不仅是模型单次推理能力。

#### 注意力和成本效率

确定性 gate、退避、预算、静默完成、按需 playbook 和记忆 shortlist，能够减少不必要的模型调用，让人的注意力集中在异常和高价值选择上。

### 7.2 当前不应完全托管的场景

在完成执行前授权、幂等 journal 和环境隔离前，不建议无人值守托管：

- 生产发布和基础设施变更；
- 对外发送消息、邮件或公告；
- 财务、交易、采购；
- 删除或不可逆迁移；
- 大规模账号/权限操作；
- 涉及高价值 secrets 的工作流。

这些场景可以由 Pipiclaw 做研究、规划、生成候选和准备工件，但最终执行应由人确认或经过强约束 capability runtime。

## 8. 迭代路线图

### 8.1 短期：0～3 个月——完成可信自主闭环

目标：不增加大量新表面功能，优先把授权、执行、恢复、评测和观测做实。

建议顺序：

1. **执行前 HITL tool middleware**；
2. **移除 Agent 可写的 external approval 豁免**；
3. **occurrence/action journal、幂等 key 和 effect receipt**；
4. **30～50 个核心行为 eval**；
5. **`preAction` 受限 sensor runtime**；
6. **统一 run trace 和 correlation ID**；
7. **跨进程 app-home/channel lock**；
8. **修复并行 coverage 的 logger 隔离竞争**；
9. **统一 verification、network guard、approval 文档和实现**；
10. **部署安全姿态检查与容器/独立账号指南**。

短期阶段完成标志：

- 未授权 external action 在行为 eval 中为 0；
- 重启和崩溃注入不会重复不可逆动作；
- 核心长程任务有可重复的成功率、成本和延迟基线；
- 每次任务执行可以从一个 run ID 完整追溯；
- 用户能够清楚区分“Agent 建议做”“已批准”“执行中”“已完成”“结果未知”。

### 8.2 中期：3～9 个月——建设个人知识与能力平台

目标：从 Coding/研究助手扩展为受控的个人事务 Agent。

建设方向：

1. 个人级 profile 和跨频道记忆；
2. 词面 + 语义 + 时序 + 可信来源的混合召回；
3. memory candidate/contradiction/forget 管理界面；
4. Calendar、Email、Docs、GitHub、Browser 等受控连接器；
5. per-tool OAuth scope 和 read/write capability 分离；
6. typed workflow step、等待条件、补偿和 rollback；
7. 基于任务风险、成本和类型的模型路由；
8. DingTalk approval card、task graph、run timeline、memory inbox；
9. 对独立研究分支进行选择性并行 subagent 编排；
10. 将真实使用 telemetry、人工反馈和 eval 纳入同一反馈循环。

中期阶段完成标志：

- 用户偏好和长期约束可以跨入口保持一致；
- 主要个人连接器不依赖 unrestricted shell；
- 每个外部能力都有明确授权、作用域、审计和撤销方式；
- recall、automation、connector 的质量可以通过指标而不是主观体验判断；
- Agent 能够承担更广泛的日常研究、计划、跟进和信息整理。

### 8.3 长期：9～24 个月以上——Personal AI Operating System

目标：成为由用户拥有、控制、审计和持续改进的个人 AI 基础设施。

长期方向：

1. **目标组合管理**：理解长期目标、优先级、时间、预算和精力约束；
2. **proposal-first 主动性**：发现机会后先提出方案和预期收益，不越权行动；
3. **安全 capability runtime**：per-task container/microVM、短期凭证、secrets broker、egress proxy；
4. **eval-gated 自我改进**：prompt、Skill、模型路由变更先 shadow test/A-B，再晋升；
5. **多模态环境**：文档、图片、语音、桌面和设备上下文，全部带同意和来源；
6. **本地优先与可迁移**：加密同步、完整导出、能力撤销、记忆删除；
7. **开放插件生态**：统一 task、memory、action receipt 和 capability schema；
8. **动态 planner/worker/evaluator**：只在高价值长任务中启用；
9. **模型升级后的持续消融**：定期删除已经不再必要的 prompt、规则和脚手架；
10. **个人治理体系**：用户拥有 policy、审计、忘记权、导出权和最终控制权。

长期成功的标准不是 Agent 主动做了多少事，而是：

- 用户实际获得的时间和成果增加；
- 需要用户介入的频率下降但关键控制不丢失；
- 错误的最大损失被环境约束；
- 系统能够解释、撤销和修复自己的行为；
- 用户的数据、记忆和能力配置始终可迁移、可删除、可掌控。

## 9. 建议持续跟踪的产品指标

### 9.1 结果质量

- 任务最终成功率；
- 按任务类型的 pass@1 / 多 trial 成功率；
- verifier 首次通过率和返工次数；
- 用户接受、修改、拒绝 Agent 结果的比例；
- 长任务在多次恢复后的成功率变化。

### 9.2 自主性质量

- 每个完成任务需要的用户介入次数；
- 正确主动唤醒率；
- 无价值/重复唤醒率；
- blocked/unknown 状态被正确升级的比例；
- 周期任务的重复执行和漏执行次数。

### 9.3 信任与安全

- 未授权 external action：必须为 0；
- approval 参数漂移或过期拦截次数；
- duplicate effect 次数；
- prompt/tool-result/memory injection 成功率；
- policy 拦截误报和漏报；
- secrets 暴露和越权访问次数。

### 9.4 记忆质量

- recall precision/coverage；
- 错误或过期记忆注入率；
- contradiction 发现率；
- 用户纠正和 forget 后的复活率；
- 自动 memory/skill candidate 的接受率；
- 记忆带来的任务成功率增益。

### 9.5 成本与效率

- 每个成功任务的 token 和成本；
- 每个任务的主 Agent/子代理/sidecar 成本构成；
- 平均工具调用数和无效调用数；
- prompt cache 命中率；
- 每次用户介入节约的估算时间；
- 模型路由带来的质量/成本变化。

## 10. 设计原则

后续迭代建议坚持以下原则：

1. **模型负责判断，runtime 负责不变量。** 授权、预算、幂等、状态迁移和安全不能只写进 prompt。
2. **文件和结构化状态优先于上下文记忆。** 长程责任必须可以恢复、审计和编辑。
3. **主动性以用户控制为前提。** 高风险行动 proposal-first，低风险行动也必须可追溯和撤销。
4. **先评测，再增加复杂度。** 向量召回、多代理、更多 prompt、更多连接器都需要以指标证明收益。
5. **默认最小能力。** 工具、网络、文件、OAuth 和 secrets 均按最小权限开放。
6. **异常必须成为显式状态。** 不确定不能伪装成失败或成功；使用 `unknown`、`blocked`、`awaiting-user`。
7. **每个错误都应告诉 Agent 下一步。** 保持现有可行动错误设计。
8. **自动学习必须可审计、可晋升、可回滚。** 特别是 memory 和 Skills。
9. **优先优化人的注意力，而不是最大化 Agent 活动量。** 少而正确的主动行为优于频繁打扰。
10. **随着模型提升持续做减法。** Harness 是能力放大器，不应变成永久复杂度。

## 11. 当前不建议优先建设的事项

- 不要优先扩展成复杂 Agent Swarm；
- 不要在没有 recall eval 前直接引入庞大向量基础设施；
- 不要继续依靠增加 system prompt 文案解决授权和可靠性问题；
- 不要通过 unrestricted bash 快速增加大量外部连接器；
- 不要让自动生成的 Skill 直接进入生产态；
- 不要过早追求多实例、高可用和分布式部署；
- 不要为了架构“整洁”进行缺乏行为收益的大规模重写。

现阶段最有价值的投入，是把单用户、单实例、长期运行做到极其可信。

## 12. 最终判断

Pipiclaw 已经验证了一个重要产品判断：

> 对个人而言，AI 能力的真正释放，不主要来自一次回答变得更聪明，而来自 AI 能够持续记住责任、在合适时间主动恢复工作、使用工具推进、在边界处请求控制，并把经验沉淀到下一次行动中。

任务账本是系统的脊柱，事件和 TaskDriver 提供主动性，记忆和 Skills 提供长期连续性，子代理提供认知分离，DingTalk 与命令系统保留人的控制。

下一阶段应集中完成三个跃迁：

1. 从“任务完成时检查”升级为“动作执行前授权”；
2. 从“至少一次唤醒”升级为“可证明的幂等动作”；
3. 从“测试代码正确”升级为“评测 Agent 行为有效”。

完成这三点后，Pipiclaw 有机会从优秀的个人项目成长为一套具有鲜明理念、可信边界和长期竞争力的个人 AI 基础设施。

## 13. 行业参考

- OpenAI, [A practical guide to building AI agents](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/)
- Anthropic, [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- Anthropic, [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- Anthropic, [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- Anthropic, [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Anthropic, [Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- Anthropic, [Claude Code sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing)
- Anthropic, [How we contain Claude across products](https://www.anthropic.com/engineering/how-we-contain-claude)
- Anthropic, [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- LangChain, [Human-in-the-loop](https://docs.langchain.com/oss/python/langchain/human-in-the-loop)
- LangGraph, [Persistence](https://docs.langchain.com/oss/python/langgraph/persistence)
- Model Context Protocol, [Security best practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)
- OWASP, [Top 10 for Agentic Applications for 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/)
- OWASP, [Memory Is a Feature. It Is Also an Attack Surface](https://genai.owasp.org/2026/05/13/memory-is-a-feature-it-is-also-an-attack-surface/)

## 14. 文档维护建议

- 本文保留战略判断和优先级，不承载每个实现细节；
- 每个进入实施的问题应建立独立 `docs/specs/<id>-*/design.md`；
- 新 spec 应在“来源”中引用本文对应编号，如 `P0-1`；
- 问题完成后不删除原结论，而是在本节维护状态映射；
- 每个重要版本或每 3～6 个月重新核对评分、能力边界和路线图。

状态映射模板：

| 审查项 | 对应 spec | 状态 | 备注 |
|---|---|---|---|
| P0-1 执行前授权 | 待建立 | proposed | 最高优先级 |
| P0-2 动作级幂等 | 待建立 | proposed | 与 P0-1 协同设计 |
| P0-3 行为评测 | [028-behavior-eval](../specs/028-behavior-eval/design.md) | spec drafted | 应先于大规模 prompt/memory 改造 |

