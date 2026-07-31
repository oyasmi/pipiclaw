# Pipiclaw 长程自主与长期学习评审

| 字段 | 值 |
|---|---|
| 审查日期 | 2026-07-31 |
| 审查对象 | `master` 分支（当前工作区，源码含 `.ts`） |
| 审查视角 | 产品目标视角，非通用代码审查。以「长程自主任务」「长期自主学习」两个方向为唯一标尺，评估现状、找结构性缺口、给迭代路线 |
| 审查方式 | 只读代码审查：精读 `src/tasks/`、`src/runtime/task-driver.ts`、`src/memory/` 全域、`src/playbooks/*.md`、`src/agent/effect-ledger.ts`、`src/agent/prompt/sections.ts`、`evals/`；核对 `docs/architecture.md`、`AGENTS.md`、三份既有审查（`architecture-review-2026-07-25.md`、`deep-review-2026-07-27.md`、`leverage-and-experience-review-r2-2026-07-27.md`）与本次发现是否重叠或矛盾 |
| 与既有审查的关系 | 既有三份报告审的是「机制是否正确、是否安全、是否浪费」，本报告审的是「机制是否指向产品要的那两个能力」，是新的坐标轴，不重复举证已被那三份记录和修复的问题 |
| 结论一句话 | 项目把「让不可靠的 LLM 循环不失控」做到了同类项目里少见的高水平，但两个产品目标方向上，**只有闸（gate/guard/governor/budget/confidence bar），没有轮（feedback loop）**。闸把坏结果挡住了，但没有任何东西让下一次比这一次更好 |

---

## 0. 评分与判断依据

| 方向 | 子能力 | 评分 | 一句话 |
|---|---|---|---|
| 一、长程自主任务 | 治理层（不跑飞、不卡住） | 8/10 | 幂等投递、确定性熔断、契约段哈希验收，同类项目里少见的扎实 |
| 一、长程自主任务 | 认知层（规划-实施-检查-反思-调整） | 3/10 | 基本不存在，靠模型每次现场重建；卡住时唯一动作是交给人 |
| 二、长期自主学习 | 记忆基础设施 | 7/10 | 分层、provenance、防灾、审计一应俱全 |
| 二、长期自主学习 | 「变聪明」的闭环 | 2/10 | 写入闸门调到几乎不学；已采集的信号没有任何消费者；知识不跨频道 |

评分不是印象分：每一条都在下文给出文件、行号、代码原文或既有审查报告的原句作为依据。

---

## 1. 长程自主任务

### 1.1 已经做对的（迭代时不要弄坏）

以下五条是这个项目在这个方向上真正的资产，是后续所有改动的地基，不应被当作技术债清理掉：

1. **进展判据不采信模型自述。** `src/agent/effect-ledger.ts:27`：

   ```ts
   const EFFECT_TOOLS = new Set(["write", "edit", "send_media", "subagent"]);
   ```

   `task_manage`/`memory_manage` 故意不在其中——模型说自己在推进，不算证据。这是对「agent 不能被信任来判断自己是否在空转」少见的清醒认识，文件头部注释直接讲述了它修复的真实历史故障（`effect-ledger.ts:6-21`）。

2. **三档退避按证据分级**（`runtime/task-driver.ts:123-134`）：本任务 effect 增长 ⇒ 立即接续；只改台账 ⇒ 常规延迟；什么都没变 ⇒ 长退避 + futile 计数。这是「治理粒度对齐真实工作节奏」的正确设计。

3. **契约段哈希 + 三重校验链**（`tasks/control.ts:53-68` 的 `TaskVerification.bodyHash`，`tasks/store.ts` 的 `taskBodyHash`）。只对 Goal/DoD/Manual/Verification 做哈希，不对整体正文，日常记日志不使 PASS 失效，改契约才失效。这是全项目设计精度最高的一处，deep-review 也把它列为第一亮点。

4. **发生时刻即身份的幂等 dispatch id**（`task-driver.ts:155-158`）+ `DurableDispatchService` 的租约续期（不是固定超时）。三份既有审查都点名这是值得沉淀的模式。

5. **停泊语义**：`waiting` 且无 `wake` ⇒ driver 不打扰。这是 `leverage-and-experience-review-r2` 的 E-6 刚修好的能力——零轮询委派「等一个会自己叫醒你的信号」的首选路径，现在才第一次真正跑得通。

**这一层的定位需要被明确写下来：它是刹车和护栏，不是发动机。** 本报告要指出的问题是：这个项目目前只有刹车。

### 1.2 结构性缺口

#### G1 🔴 任务里没有「计划」这个承载体

任务正文的标准段是 Goal / DoD / Manual / Verification / Current Cycle / History（`tasks/ledger.ts:70`）。表达「下一步」的只有 `control` 里一个自由文本字段：

```ts
// src/tasks/control.ts:99
nextAction?: string;
```

没有步骤分解、没有步骤状态、没有「当前在第几步」、没有「这一步依赖哪一步」。每次唤醒，模型都要从 `latestNote` + `nextAction` + 通读正文里**重新推导**一遍计划。

后果不是效率问题，而是**「规划-调整」这个循环里「规划」没有承载体，所以「调整」无从发生**：runtime 无法回答「这个任务的计划变过吗」「变得对不对」「偏离 Goal 了吗」。DoD 勾选是唯一的进度信号，是只增不减的单调量——能告诉你走了多远，不能告诉你是否走在正确方向上。

`task-planning.md` 明确写「`goal` 写结果不写行动清单」，这个取舍本身是对的（防止把计划冻死）。但正确的结论是「计划应当是可变的、有版本的、可被审视的」，不是「不要计划」。

#### G2 🟠 检查只发生在终点

验收链 `candidate → verifier subagent → task_manage verify → done`（`task-closeout.md`）只在任务收尾时跑一次。一个 20 步任务的前 19 步完全由 maker 自己勾 DoD 决定，没有任何独立视角介入过程。等到 candidate 才发现方向错了,代价是整条链重来,而 attempt 预算已经烧掉了。

`task-closeout.md` 里「FAIL 后 progress 记录失败证据、status 回 active、修复后重新 candidate」这条路径存在，但它是**终点失败后的返工**，不是**过程中的纠偏**。

#### G3 🔴 卡住的唯一出口是「交给人」

futile 计数 3 次（`task-driver.ts` 的 `FUTILE_WAKE_LIMIT = 3`）⇒ 治理器暂停 ⇒ 派发升级回合，指令是（`task-driver.ts:226-229`）：

> `diagnose before changing control, inform the user of the cause and recovery, and do not continue implementation in this run.`

`paused` 任务不能 `progress`/`candidate`，只剩 `set` 或用户 `/tasks resume`。`task-driving.md` 又叮嘱「不要反射性加预算」。

综合起来：**系统对「卡住」的标准响应是停下来找人，而不是自己想办法**。这在有人盯着的场景是合理保守；但「长程自主」的定义恰恰是**没人盯着的时候还能往前走**。缺的是中间态：

- 没有「换一条路试试」——重试同一策略 vs 更换策略，runtime 完全不区分；
- 没有「缩小范围交付」——任务只有全成/全败/取消三档，虽然 `done` 支持 `residualRisk` 字段，但没有「降级交付 + 说明残余」这条合法路径的引导；
- 没有「自我诊断 → 改写 Manual → 重新开工」的合法闭环——技术上 `set` 能做到，但 playbook 和升级回合文案都在劝阻模型自己动手。

#### G4 🔴 12 次终身额度 vs 完全无停损，二选一

```ts
// src/tasks/control.ts:238
budget: { maxAttempts: 12 },
```

一次性任务**终身**只有 12 次非静默唤醒（周期任务每开新 cycle 才清零，`resetTaskControlForCycle`，`control.ts:328-361`）。`leverage-and-experience-review-r2` 的 E-8 已经点破：「12 步就是这个 runtime 事实上的长程上限」，其建议 2（改成滚动窗口）被记录为**本轮不做**。本次复核确认现状未变。

更要紧的是另一半：spec 036 D1 把 token / cost / wall-time 的**逐任务**预算全部删掉了，理由写在 `control.ts:20-30`：

> Cost control belongs in a global spend guard, not here.

而那个 global spend guard 至今不存在——全项目搜索 `usage/ledger.ts`/`settings.ts` 未发现任何 spend 阈值，`ledger.ts:133` 的注释本身用的是假设语气（"any spend guard built on this ledger"）。

于是今天的实际局面是二选一：
- 用默认 12：真正的长程任务（几十步）跑不完；
- 按 `task-planning.md` 教的把 `maxAttempts` 调高（其原话：「预计要十几步以上的长程任务，创建时就调高」）：**这个任务就没有任何停损了**——deadline 是可选的，futile 计数只防「完全空转」，而 `bash` 只要退出码 0 且有输出就算 effect（`effect-ledger.ts:82-89`），意味着「看似在干活」的空转很难触发熔断。

这是长程自主最直接的结构性卡点，且是唯一一条被三份既有审查、本报告共同独立确认、且明确记录为「未修」的问题。

#### G5 🟠 任务的「经验」没有承载体，且 runtime 反向激励

`effect-ledger.ts` 刻意不给 `task_manage` 记 effect（对治理是正确的判断）。但副作用是：**模型写 progress 笔记这件事，runtime 给零奖励**。而任务跨唤醒的全部记忆，就是 Current Cycle 里的这些笔记（因为 `AgentSession` 是 per-channel 的，会和用户闲聊、其它任务共用一条上下文，还会被 compaction 清掉）。

结果是逆向选择：**runtime 奖励「埋头干活」，不奖励「记下试过什么」**，而后者恰恰是长程任务不重复踩坑的唯一依靠。`task-planning.md` 叮嘱「每轮闭环前把返工原因写回 Manual」，但没有任何检查确认这件事真的发生过。

---

## 2. 长期自主学习

### 2.1 已经做对的

分层文件（SESSION/MEMORY/HISTORY + 冷存储）、单一提炼路径（`extraction.ts` 的头部注释明确讲述了它修复的历史问题——多条路径各写各的 prompt，质量由最松的那条决定）、entry 级 provenance（`metadata.ts` 的 `MemoryEntryMetadata`：kind / trust / sourceType / sourceEntryIds / sourceCorrelationIds）、墓碑防复活（`tombstones.ts`）、cleanup 的 id 集合比对 + 体量骤降护栏（deep-review 亮点 #11）、证据制词法召回 + 中文三元组（`recall.ts` 头部长注释对「为什么不按 query 长度归一」的推导是站得住的工程判断）、gate 前置零成本的维护调度、`memory-review.jsonl` 可审计。

**基础设施质量确实不错。问题全在「用它做什么」。**

### 2.2 结构性缺口

#### L1 🔴 自动写入闸门是 AND 条件，把系统调成了「几乎不学」

```ts
// src/memory/promotion.ts
export function shouldAutoWriteMemory(
	candidate: MemoryPromotionCandidate,
	threshold = DEFAULT_MEMORY_AUTO_WRITE_CONFIDENCE, // 0.85
): boolean {
	return (
		candidate.confidence >= threshold &&
		candidate.necessity === "high" &&
		...
	);
}
```

而 `necessity: "high"` 在提炼 prompt 里的定义是（`memory/extraction.ts:41-42`）：

> `necessity is "high" only when future turns would go wrong without this entry. Routine progress is "low".`
> `Be conservative. Empty arrays are correct when nothing should be stored.`

对照用户设定的目标场景——**「入职一个月的数字员工，之后对公司非常熟稔」**。一个新员工一年里积累的知识，绝大部分是 **medium necessity**：谁负责哪块、这个群里「上线」默认指周四发布、财务报销要先过谁、这个仓库的命名习惯、某客户的联系人换了。这些**没有一条**满足「没有它未来回合就会出错」的 high 门槛。

**所以按当前配置，这个系统结构性地学不会一家公司的日常运作知识。** 它只会记住那些「不记住就立刻出事」的硬约束和显式说的「记住/以后默认」（后者走 `memory_manage` 立即写入路径，`memory-and-learning.md` 明确要求，不受此闸门约束）。

缓解项：被拒的候选进 `memory-review.jsonl` 的 skipped，素材留在 HISTORY.md，而 HISTORY 确实是召回源之一（`candidates.ts:15`）。所以不是完全丢失——但它以未结构化、会被反复折叠压缩、无 metadata、无 kind、无 trust 的形态存在。这是「档案室里也许还有」，不是「员工记得」。

这是本次审视里**改动最小、影响最大**的一条，但**必须和 L2、L6 一起做**，否则只是把 MEMORY.md 变成垃圾场——见第 3 节路线图的顺序说明。

#### L2 🔴 召回统计写了，但没有任何消费者

`metadata.ts` 每次召回都在写：

```ts
// src/memory/metadata.ts:144-152, 174-214
recallCount / lastRecalledAt / recallByDay（90 天窗口）/ queryFingerprints（保留最近 32 个）
```

全量核对消费者：

```
src/memory/commands.ts:64,81,83,86   ← 仅 /memory stats 的人工展示
```

**没有第二个消费者。** 这些字段不参与召回打分、不触发晋升、不触发衰减、不触发清理决策。

这意味着记忆系统**没有 use-it-or-lose-it 动力学**——而这恰恰是记忆系统会「变好」而不是只「变大」的核心机制。一条被召回 40 次的记忆和一条 90 天没被碰过的记忆，在系统眼里完全等价。

好消息：**所有采集钩子都已经就位**，只差接线消费。这是本报告里投入产出比最高的一条。

#### L3 🔴 没有跨频道晋升，「公司知识」永远出不了一个群

`workspace/MEMORY.md` **是**召回候选源（`candidates.ts:15` 的 `"workspace-memory"`），所以跨频道知识是**读得到**的。但写入侧完全断开：

- `memory_manage save` 写死了 `options.channelDir`（`tools/memory-manage.ts:141,149,174,205,228` 全部落在 channel 目录），没有 scope 参数，模型无法主动请求写入 workspace 层；
- 系统提示词明确禁止用文件工具直接编辑记忆文件（`agent/prompt/sections.ts:85-86`：*"SESSION.md, MEMORY.md and HISTORY.md are runtime-managed; do not edit them with file tools"*）；
- 全项目唯一写 `workspace/MEMORY.md` 的地方是 `runtime/bootstrap.ts:358` 的**首次模板生成**（`writeTextFileIfMissing`，只在文件不存在时写一次默认内容）。

**结论：workspace 记忆 100% 靠人手工维护。** 在 A 群学到的「公司的发版流程」，到 B 群就不存在，A 群自己换个会话主题继续聊也可能被折叠遗忘。对「数字员工」这个目标，这是最大的结构性缺口——员工的知识不会因为换了个会议室就失忆。

需要的是一条**晋升通道**：channel 记忆里被多个频道独立命中 / 被高频召回 / 属于 `kind: constraint|preference` 且 `subjectId` 非个人的条目，经确定性 gate + 一次 LLM 判定后晋升到 workspace 层。这套东西的每一块（gate / job / sidecar / review-log / 队列）都已经存在于 `src/memory/scheduler.ts` + `maintenance-jobs.ts` 的流水线里，是**复用现有维护流水线加第四个 job**，不是新建子系统。

#### L4 🟠 程序性学习完全靠模型自觉，零基础设施

事实性记忆有：scheduler + gates + jobs + state + review-log + tombstones + metadata，六层机制。

程序性记忆（`workspace/skills/`）有：一个 `skill_manage` 工具，和 `memory-and-learning.md` 里一段「只有流程能跨任务复用时才建 skill」的劝导性文字。**没有触发器、没有 gate、没有 job、没有复用统计、没有 eval。**

没有任何东西能发现「这个流程在三个任务里被重复推导了三次，该沉淀了」。而这正是「越来越熟练」的主要形态——熟练不是知道更多事实，是不用再想怎么做。

spec 028（`docs/specs/028-behavior-eval/design.md`）自己把「P1-5 skill 晋升需要针对性 eval」列在排队项里，方向已经被认到，只是还没做。

#### L5 🟡 只有词法召回（已知，且被自己的前置条件卡住）

`MIN_MATCH_EVIDENCE = 2.5` 的证据制打分 + 中文三元组是很聪明的词法设计（`recall.ts` 头部注释对早期"覆盖率制"失败案例的复盘是扎实的）。但它仍然是词法的：新人问问题的措辞和存储事实的措辞天然不同，语义相近但字面不重叠的记忆召不回来。

spec 028 明确把语义召回列为非目标，要求「先有 recall eval，P1-3 拿到数据再立项」——这个纪律是对的。但 `evals/gates.json` 里 `M-recall-02` 目前是 `report-only`，不是 `required`，意味着这个前置条件本身还没有被建立成硬门槛。这条被自己声明的前置条件卡住了，卡住本身不是错，但需要有人去解卡。

#### L6 🟠 没有「学到的东西被用对了吗」的闭环

`memory-review.jsonl` 记录了写了什么、跳过了什么。`metadata` 记录了被召回多少次。**但没有任何东西把「召回了这条记忆」和「这一轮的结果好坏」关联起来。**

`sourceCorrelationId` 已经把成本、review log、source window 串起来了——这个串联再往前接一步（这一轮召回了哪些 entry → 这一轮的产出是否被用户纠正 / 任务是否推进 / 是否触发返工）就是反馈信号。目前这个信号完全没有被采集。

---

## 3. 前置条件：eval 覆盖撑不起这两个方向的迭代

`evals/` 现有 29 个 case（`evals/cases/{regression,safety,capability}.ts` + `evals/gates.json`），harness 本身设计成熟（parent runner + 每 trial 一个 worker 子进程，见 `docs/specs/028-behavior-eval/design.md`）。但按两个方向核对覆盖：

| 需要测什么 | 现有 case | 状态 |
|---|---|---|
| 多步长程任务真的能完成（10-20 步） | 无 | 缺 |
| 卡住之后能自我纠偏 | `S-escalate-01`（测的是升级正确发生） | 只测了刹车，没测复原 |
| 计划漂移检测 | 无 | 缺 |
| 跨越数周历史后记忆精确率/召回率 | `M-recall-02`/`M-recall-03` | **report-only**，不阻塞 |
| 记忆是否越用越准 | 无 | 缺 |
| skill 晋升 | 无 | 缺 |

spec 028 自己写着「**先评测，再增加复杂度**」。这条纪律是对的，那就必须承认：**这两个方向今天连基线都没有，任何改动都无法判断是升是降。** 第 4 节路线图的第 0 批就是把这件事补上，不建议跳过直接动手改机制。

---

## 4. 迭代路线（按 收益 ÷ 成本 排序）

### 第 0 批：先能量体温（否则后面全是盲改）

| # | 事项 | 依据 | 量级 |
|---|---|---|---|
| 0.1 | 长程任务 eval case：一个 12-20 步、跨多次 driver 唤醒、含一次故意的死胡同的任务，度量「完成率 / 步数 / 是否被治理器误停 / 总成本」 | G1/G3/G4 | 1 个 case + fixture |
| 0.2 | 记忆 eval 升级为 required：给 `M-recall-02`/`M-recall-03` 定 `minPass`；新增一条「注入 30 天合成历史后，问 10 个不同措辞的问题」的精确率/召回率 case | L5 | 改 gates.json + 1 个 case |

这两条建成之前，下面每一条都只能算「有理由的猜测」。

### 第 1 批：接线（改动小，全是现成钩子）

| # | 事项 | 依据 | 量级 |
|---|---|---|---|
| 1.1 | 召回统计接入打分与清理：`recallCount`/`lastRecalledAt` 参与 recall 排序的轻度加权；`structural-maintenance` job 增加一条「90 天零召回且 `trust=inferred` ⇒ 降级/归档」的确定性规则 | L2，钩子全部就位 | 中 |
| 1.2 | attempt 预算改滚动窗口 + 补全局 spend guard：`leverage-and-experience-review-r2` E-8 建议 2 + spec 036 D1 欠下的债一起还。滚动窗口让「长程」的横轴变成天而不是步数；全局 guard 才是删掉逐任务成本预算时承诺要建的替代品 | G4 | 中大，建议单开 spec |
| 1.3 | 写入闸门分级：`necessity: high` ⇒ 直接写；`necessity: medium` + `confidence ≥ 0.9` ⇒ 写入但标记试用期，由 1.1 的衰减规则在窗口内决定去留 | L1，**必须排在 1.1 之后** | 小（判断改动）+ 需 0.2 的 eval 兜底 |

1.1 → 1.3 是一个自洽的小包：**先建立「用不上就会消失」的动力学，再放宽入口。** 顺序反了，1.3 单独做就是把 MEMORY.md 变成垃圾场。

### 第 2 批：补「轮」

| # | 事项 | 依据 | 量级 |
|---|---|---|---|
| 2.1 | workspace 记忆晋升 job：复用现有 scheduler/gates/jobs 流水线加第四个 job，把跨频道命中 / 高频召回 / 非个人 subject 的 channel 条目晋升到 workspace 层；晋升留 review-log 且可通过 `/memory` 撤销 | L3 | 中，全是复用 |
| 2.2 | 任务计划物化：正文新增一段结构化 Plan（步骤 + 状态 + 对应哪条 DoD），`task_manage progress` 支持更新步骤状态。关键是要让 driver 能读它——步骤长期停在同一步是比 futile 计数更早、更准的漂移信号 | G1 | 中大 |
| 2.3 | 中途检查点：DoD 勾选到约 50% 时触发一次轻量 verifier（只查方向、不查完成度），而不是只在 candidate 时检查 | G2 | 中 |

### 第 3 批：真正的「反思」

| # | 事项 | 依据 |
|---|---|---|
| 3.1 | 治理器暂停前先给一次自省回合：futile 计数到 2 次时（不是 3 次）派发一个明确的 reflect 回合——只准读、诊断、改写 Manual/Plan/nextAction，不准继续实现；第 3 次仍无进展才升级给人。把「卡住 ⇒ 找人」变成「卡住 ⇒ 换策略 ⇒ 还不行才找人」 | G3 |
| 3.2 | skill 晋升 gate：统计跨任务重复出现的操作序列，达阈值时提示/自动起草 workspace skill，走和记忆晋升一样的 review-log + 可撤销路径 | L4 |
| 3.3 | 召回效果反馈采集：把「本轮召回了哪些 entry」与「本轮是否被用户纠正 / 任务是否推进」关联进 metadata，为 L5 的语义召回立项提供真实数据 | L6 |

---

## 5. 三条建议写进设计原则的判断

1. **闸与轮要配对。** 现在每加一个能力就加一道闸（confidence bar / attempt budget / futile limit / shrink guard），但一道闸也没有对应的反馈轮。闸让系统安全，轮让系统变强；只有闸的系统会**稳定地停在初始水平**——这正是本报告两个方向评分差距的来源。

2. **「保守」是有成本的，而这个成本目前没被计量。** `necessity: high` AND `confidence ≥ 0.85`、`maxAttempts: 12`、futile 3 次即停——每一条单独看都合理，叠起来是一个「宁可什么都不做」的系统。漏学一条有用知识、少推进一个本可完成的任务，代价和写错一条记忆、烧掉一些 token 是同一个量纲的，但代码里只有后者被度量。建议在 `memory-review.jsonl` 汇总和 `/memory stats`、`/tasks stats` 里把 skipped 率、governor 停机率作为一等指标暴露出来——一个健康的学习系统，skipped 率应该是被主动调优的对象，而不是一个无人看的副产品。

3. **「数字员工」的知识主体是团队，不是频道。** 频道是隔离单元这个设计对并发和安全是对的，但被无意中借用成了知识的边界。跨频道晋升（2.1）不是一个 feature，它是这个产品定位能否成立的分水岭。

---

## 6. 本轮盲区

- 未运行 `npm run check` / `npm run eval`，全部结论来自静态代码追踪 + 既有审查报告交叉核对，未做端到端实测。
- 未审 `src/tui/`（TUI 场景下 TaskDriver 不常驻，长程任务语义与 daemon 模式本就不同，本报告的结论以 daemon 场景为准）。
- 未评估模型选择（哪个模型跑 sidecar/主 turn）对 `necessity`/`confidence` 判定质量的影响——L1 的闸门是否「过严」某种程度上也是模型标定问题，不是纯规则问题；如果第 0 批 eval 显示某模型标定明显更松，第 1 批的分级策略可能需要按模型调整阈值而非全局一刀切。
- 未评估「计划物化」（G1/2.2）与 spec 025/026 的 prompt units 预算约束是否冲突——`<task_agenda>` 已经有 600 units 硬顶（`memory/task-digest.ts:6`），Plan 结构如果注入 turn context 需要在同一预算内竞争，具体设计留给 2.2 实施时评估。
