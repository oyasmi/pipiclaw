# 计划承载体与记忆试用期：给长程任务补「手段层」，给durable memory补「中间态」

| 字段 | 值 |
|------|------|
| 状态 | IMPLEMENTED |
| 日期 | 2026-08-01 |
| 前置 | 019 task-ledger、022 native-task-driver、026 system-prompt-slimming、029 task-lifecycle-simplification、036 task-governance-slimming；009 memory-growth-and-recall、010 memory-maintenance-scheduler、013 memory-write-semantics、035 config-and-api-surface |
| 来源 | `docs/refer/long-horizon-autonomy-and-learning-review-2026-07-31.md` 的 **G1**（任务里没有「计划」这个承载体）与 **L1**（自动写入闸门是 AND 条件，把系统调成了「几乎不学」） |
| 关联实现 | `src/tasks/ledger.ts`、`src/tools/task-manage/*`、`src/runtime/task-driver.ts`、`src/runtime/task-commands.ts`、`src/memory/{promotion,extraction,consolidation,metadata,files,probation,maintenance-gates,maintenance-jobs,commands}.ts`、`src/playbooks/*` |
| 明确不含 | G2/G3/G4、L2 余下部分、L3–L6（见第 6 节） |

## 背景

评审报告的结论句是：**只有闸（gate/guard/governor/budget/confidence bar），没有轮（feedback loop）**。两个产品方向的评分差距全部来自这一条——长程自主任务的「治理层」8/10 而「认知层」3/10，长期自主学习的「记忆基础设施」7/10 而「变聪明的闭环」2/10。

本 spec 取其中两条**改动最小、且互不依赖**的结构性缺口先做：G1 与 L1。选它们不是因为它们最重要（L3 跨频道晋升才是产品定位的分水岭），而是因为它们是另外几条的**前置载体**：

- 没有 G1 的 Plan，2.3 的中途检查点无从检查、3.1 的反省回合无从改写；
- 没有 L1 的分级写入，L2 的召回统计消费、L3 的跨频道晋升都只能作用在一个几乎空的 MEMORY.md 上。

## 病根的准确表述

两条缺口是同一个形状：**系统缺少「暂定 → 被使用 → 转正 / 未被使用 → 淘汰」这个中间态**，于是只能在「不记录」和「永久记录」之间二选一。

### G1 — 任务正文只有契约层和流水层，没有手段层

任务正文的标准段是 Goal / DoD / Manual / Verification / Current Cycle / History（`tasks/ledger.ts:70-77`）。这六段可以归成两层：

| 层 | 段 | 性质 |
|---|---|---|
| 契约层 | Goal / DoD / Manual / Verification | 被 `taskContractSegment`（`ledger.ts:116`）哈希，绑定 verification PASS 与 external approval，**改一次就作废一次验收** |
| 流水层 | Current Cycle / History | 只增日志，`startTaskCycle` 折叠归档 |

「这一版的打法」两层都放不下：放契约层会让每次推进都作废 PASS，放流水层则无法表达状态。于是它只能落在 `control.nextAction`（`control.ts:74`）这一个自由文本字段里——没有步骤分解、没有步骤状态、没有「当前在第几步」。

后果不是效率问题：**「规划-实施-检查-反思-调整」里的「规划」没有承载体，所以「调整」无从发生。** 每次唤醒模型都要从 `latestNote` + `nextAction` + 通读正文重新推导一遍计划，推导结果不落盘，下一次再推导一遍；runtime 则永远无法回答「这个任务的计划变过吗 / 偏离 Goal 了吗」。DoD 勾选是唯一的进度信号，而它是只增不减的单调量——能告诉你走了多远，不能告诉你走得对不对。

### L1 — 闸门把两个正交的轴用 AND 连了起来

```ts
// src/memory/promotion.ts:20-24
return (
	candidate.confidence >= threshold &&   // 0.85
	candidate.necessity === "high" &&
	...
);
```

`necessity`（没有它未来回合会不会出错）与 `confidence`（我对这条判断有多确定）是两个正交的轴，现在被要求**同时**取最严的一档。叠加提炼 prompt 的定义（`extraction.ts:41-42`）：

> `necessity is "high" only when future turns would go wrong without this entry. Routine progress is "low".`
> `Be conservative. Empty arrays are correct when nothing should be stored.`

对照目标场景「入职一个月的数字员工，之后对公司非常熟稔」——一个新员工积累的知识绝大部分是 **medium**：谁负责哪块、群里「上线」默认指周四发布、报销要先过谁、这个仓库的命名习惯、某客户的联系人换了。这些**没有一条**满足「没有它未来回合就会出错」。

**所以按当前配置，这个系统结构性地学不会一家公司的日常运作知识。** 它只记住硬约束，以及用户明说「记住/以后默认」的条目（后者走 `memory_manage` 立即写入，`trust: "explicit"`，不受此闸门约束）。

被拒的候选进 `memory-review.jsonl` 的 skipped、素材留在 HISTORY.md，所以不是完全丢失——但它以未结构化、会被反复折叠压缩、无 metadata、无 kind、无 trust 的形态存在。**这是「档案室里也许还有」，不是「员工记得」。**

## 设计

### 第一部分：G1 — Plan 作为第三层正文

#### D1 位置：`## Plan` 置于 Verification 与 Current Cycle 之间，契约段终点前移

`taskContractSegment` 的现定义是「到 Current Cycle 之前的全部正文」。把 Plan 插进这个范围，会让每勾一个步骤就作废一次 PASS 和一次 external approval——那是全项目设计精度最高的一处机制，**绝不能弄坏**。

改法：**契约段的终点改为「Plan 与 Current Cycle 中先出现的那个」**。

```ts
// tasks/ledger.ts:116 taskContractSegment
// 终点从 ["Current Cycle","当前周期"] 改为在 ["Plan","计划"] 与 ["Current Cycle","当前周期"] 之间取先出现者
```

由此得到一条**可测试的不变量**：给一个已有 PASS 的存量任务补写 Plan（插在 Verification 之后、Current Cycle 之前），新契约段 = `lines.slice(0, planHeadingIndex)` 去尾部空白，与原契约段 `lines.slice(0, currentCycleHeadingIndex)` 去尾部空白**逐字节相同**——哈希不变，PASS 与 approval 均不失效。

语义上这也正是我们要的划分：**Goal/DoD 是承诺，Plan 是手段，改手段不该重新验收。** Manual 同为「怎么做」却留在契约段，是既有行为，本 spec 不动它（Manual 是跨周期沉淀的方法与教训，改动频率天然低于 Plan）。

#### D2 语法：四态 checkbox，当前步骤由 runtime 推导而非模型申报

```markdown
## Plan

- [x] P1 对齐上游 schema 字段 → dod:1
- [ ] P2 迁移 reader 到新 schema → dod:1,2
- [!] P3 联调 staging（等运维开权限）→ dod:3
- [~] P4 旧兼容层（改由 P2 覆盖）
```

| 标记 | 含义 |
|---|---|
| `[ ]` | todo |
| `[x]` | done |
| `[!]` | blocked（有明确外部阻塞，与「停在这一步没动」不同） |
| `[~]` | dropped（这一步被放弃，**显式改写而非静默删行**） |

**故意不设 `doing` 态。** 当前步骤 = 顺序上第一个 `[ ]` 或 `[!]`，由 runtime 推导。少一个需要模型维护、也可能被模型谎报的状态——这与 `effect-ledger.ts` 那条「agent 不能被信任来判断自己是否在推进」的既有判断同源。

解析：

```ts
/^\s*[-*]\s+\[([ x!~])\]\s+(?:(P\d+)[.、)]?\s+)?(.*)$/
```

尾部可选的 `→ dod:1,2`（或 `-> dod:1,2`）解析为 DoD 序号列表并从 text 中剥离。**step id 可缺省**：手写的、没有 `P<n>` 前缀的计划仍可解析，summary 里按位置补 `P<index>`——与 ledger 一贯的 fail-open 风格一致（任务文件是可手改的）。

派生结构：

```ts
export interface TaskPlanStep {
	id: string;
	status: "todo" | "done" | "blocked" | "dropped";
	text: string;
	dodRefs: number[];
	lineIndex: number;
}
export interface TaskPlanSummary {
	steps: TaskPlanStep[];
	/** 不含 dropped */
	total: number;
	done: number;
	/** 顺序上第一个 todo/blocked；全部完成时为 undefined */
	current?: TaskPlanStep;
}
```

`TaskLedgerEntry.plan?: TaskPlanSummary`，在 `toEntry` 中解析。ledger 的解析缓存按 (mtime, ctime, size) 失效（`ledger.ts:749-770`），plan 随 entry 一起被缓存，**对 driver 的每分钟全量扫描是零新增成本**。

**Plan 不加入 `STANDARD_TASK_SECTIONS`**：它是可选的，两步小任务和全部存量任务都没有它，`missingStandardTaskSections` 不该因此让 `/tasks doctor` 刷屏。

#### D3 写入面：create 播种、progress 增量、大改走 edit

| 入口 | 参数 | 行为 |
|---|---|---|
| `task_manage create` | `plan?: string`（一行一步） | 渲染进骨架；缺 id 自动补 `P1..Pn` |
| `task_manage progress` | `planSteps?: Array<{id, status?, text?}>` | id 已存在 ⇒ 改状态/改文案；id 不存在且给了 text ⇒ 追加 |
| 重新规划 | `write` / `edit` | 与 Goal/DoD 改动同轨 |

`progress` 的 planSteps 补丁**不引入任何新的持久状态**来记录「计划变过」：工具算出 delta，追加到它本来就要写的那条 Current Cycle note 末尾：

```
- 迁移完 reader，单测通过；下一步联调 staging。plan: P2→done; P3→blocked; +P5 回归脚本
```

计划的变更史因此自动落进 Current Cycle → 被 `startTaskCycle` 折进 History → 被既有的 History 上限压缩。「可变、有版本、可被审视」由既有机制满足。

**这是一条刻意的取舍**：本可以加一个 `control.plan.revision` 计数器，但它没有消费者——而「采集了却没有任何消费者」正是评审 L2 批评的那个错误，不能在修 G1 时重犯。

补丁作用在没有 `## Plan` 段的任务上时，**在 Current Cycle 标题前自动插入该段**（这保持 D1 的字节不变量）；正文连 Current Cycle 都没有的非标准任务，抛 `RecoverableToolError` 指向 `edit`。

`startTaskCycle` 增加一步 plan 重置（`[x]`/`[!]` → `[ ]`，`[~]` 保持），与既有的 `resetTaskAcceptanceCheckboxes`（`ledger.ts:648`）对称——否则周期任务开新周期时会看到一份全绿的旧计划，与「验收框已重置」自相矛盾。

#### D4 可见面：三处，全部是既有渲染路径的小增量

1. **唤醒 capsule**（`task-driver.ts:177-184`）增加 `plan=2/5 done, current=P3;`。这一条直接消掉 G1 描述的核心浪费——模型不必再重新推导计划。
2. **`<task_agenda>`**（`task-digest.ts:39-58`）每行增加 `plan 2/5 · @P3`，约 6 prompt units/任务。600 units 硬顶（`task-digest.ts:6`）内完全放得下，且**完整 Plan 只存在于任务文件里**（唤醒时才读）。这正面回答评审 §6 留下的那条盲区：计划物化不与 spec 025/026 的预算约束冲突。
3. **`/tasks doctor`**（`task-commands.ts:581`）增加两条确定性漂移检查：
   - 步骤引用了不存在的 DoD 序号；
   - **有 Plan 但存在无任何步骤覆盖的 DoD 项**——这是「偏离 Goal 了吗」的第一个真实消费者，零 LLM 成本。

#### D5 明确不做：plan 状态绝不进 `taskFingerprint`

`taskFingerprint`（`task-driver.ts:90-104`）刻意排除了 `latestNote`，理由写在其上方注释里：那是模型对自己工作的自述，纳入后「一次只写了条笔记的唤醒」就能永久重置 futile 计数。

**plan 状态是同一类东西**。勾一个 plan 复选框若能重置 futile 计数、换到短退避，等于给模型开了一条绕过治理器的路。本 spec 因此：

- `taskFingerprint` **不变**，并在注释里点名 plan 与 latestNote 同属「模型自述」而被排除；
- 三档退避（`attemptDelayMs`）**不变**；
- **不新增任何暂停条件**。评审的核心批评是「只有闸没有轮」，用一个新闸来修 G1 是跑偏。G1 本轮只做载体与可见性；`TaskPlanSummary.current` 是留给 3.1（futile 到 2 次时派发反省回合）的测量点，不在本 spec 消费。

---

### 第二部分：L1 — 分级写入闸门与记忆试用期

#### D6 闸门从 AND 变成两档

```ts
export type MemoryWriteTier = "durable" | "probationary";

/** 返回 undefined 表示拒绝写入。 */
export function classifyMemoryWrite(
	candidate: MemoryPromotionCandidate,
	durableThreshold = DEFAULT_MEMORY_AUTO_WRITE_CONFIDENCE,
): MemoryWriteTier | undefined;
```

| necessity | confidence | 结果 |
|---|---|---|
| `high` | ≥ 0.85 | `durable`（与今天**完全一致**） |
| `medium` | ≥ 0.90 | `probationary`（新） |
| `medium` | < 0.90 | 拒（进 review-log 的 skipped，同今天） |
| `low` | 任意 | 拒（一次性进度，正确） |

阈值倒挂是刻意的：**越不必要，越要求确定。** 两个数都是**代码常量**——`minMemoryAutoWriteConfidence` 早在 spec 035 就退役为 `maintenance-tuning.ts` 的算法参数（`RETIRED_SETTINGS_KEYS` 含此键），试用期阈值同理，不进 `settings.json`。

**试用期只对 `op: "add"` 生效。** `supersede` / `invalidate` 仍需 durable 档：用一条会过期的条目覆盖或删除一条 durable 条目，会在过期时造成净数据丢失。这是本节最重要的一条安全性质。

单次 consolidation 最多写 `MAX_PROBATION_WRITES_PER_RUN = 5` 条 probationary（durable 不限，同今天），防止一个话痨窗口一次灌进十几条。

`shouldAutoWriteMemory` 由 `classifyMemoryWrite` **替换**（不留兼容别名，遵循 AGENTS.md）。

#### D7 试用期的生命周期：寄生在既有写路径上，零额外 I/O

新增一个字段：

```ts
// MemoryEntryMetadata
/** 这条条目必须在此时刻前被用到一次，否则失效。durable 条目为 undefined。 */
probationUntil?: string;
// MemoryWriteMetadataInput 同名字段类型为 string | null，null = 显式清除
```

| 事件 | 处理 | 落点 |
|---|---|---|
| **打标** | probationary add 写入 `probationUntil = now + 30 天` | `toMemoryOp`（`extraction.ts:155`） |
| **转正 ①（主路径）** | 条目被召回一次 ⇒ 清除 `probationUntil` | `recordMemoryRecall`（`metadata.ts:174`） |
| **转正 ②** | 用户重述同一事实，add 走 `skippedDuplicate` 分支 ⇒ 清除已有条目的试用期 | `applyChannelMemoryOps`（`files.ts:241`） |
| **转正 ③** | 任何 durable op 命中该条目（supersede 替换） ⇒ 清除 | `toMemoryOp` 对 durable op 统一 stamp `probationUntil: null` |

转正 ① 是整个设计的关键：`recordMemoryRecall` **本来每次召回就要打开 metadata 文件写一次**，清标搭在同一次写里，**确认闭环的边际成本为 0**。

被召回一次即转正，判据故意宽松。理由：词法召回本身是精确率导向的（`MIN_MATCH_EVIDENCE = 2.5`，`recall.ts:99`），且 shortlist 还要过 rerank 与 `maxInjected` 截断——**能被注入本身就是有意义的证据**。「一个月内没有任何一次对话需要它」才是我们真正想淘汰的形态。

试用期条目在召回中**完全平权**，不加任何降权。降权会让它必然过期，是自我实现的预言。

#### D8 淘汰：structural-maintenance 里的确定性前置步骤

新增 `src/memory/probation.ts`（单一职责，不塞进已 470 行的 `files.ts`）：

```ts
export const MEMORY_PROBATION_DAYS = 30;
export function probationDeadline(now: Date): string;
export function collectExpiredEntryIds(metadata: MemoryMetadataFile, now: Date): string[];
export async function expireMemoryEntries(channelDir: string, now: Date): Promise<number>;
```

挂载点是 `runStructuralMaintenanceJob`（`maintenance-jobs.ts:332`）——它已经拥有 cleanup、走 gate、走 per-channel 串行队列、写 review-log。淘汰步骤**排在 LLM cleanup 之前**（确定性优先，且让 cleanup 看到清理后的文件）。

两个必须的配套：

1. **淘汰用 `invalidate`，绝不用 `forget`。** `forget` 会写墓碑（`tombstones.ts`）永久阻断同一内容再次写入；而试用期到期恰恰意味着「暂时用不上」，**这条知识以后重新变得相关时必须能被重新学到**。墓碑是留给「用户明确说忘掉」的。
2. **gate 增加物料位**。`StructuralMaintenanceMaterial` 增 `expiredEntryCount: number`，decision 增 `runProbationExpiry: boolean`；`nothing-to-maintain` 与 `empty-template-files` 两条 deny 都要把它计入，否则「只有过期要清、没有 cleanup/folding 要做」的通道会被闸死。

顺手给一个躺了很久、**没有任何消费者**的既有字段接上同一个消费者：`metadata.expiresAt`（`metadata.ts:39`，全项目只写不读）到期即失效，与试用期共用这一个淘汰步骤。两者语义不同——`expiresAt` 是无条件到期，`probationUntil` 是「被用到即取消」——但淘汰动作相同。

淘汰写 review-log：`actions: [{ target: "MEMORY.md", action: "expire", entries: N }]`。

#### D9 提炼 prompt 必须同步改，否则代码白改

**这是 L1 里权重最大的一半。** 现在的 prompt 教的是「Be conservative / 空数组是正确的」，光放宽代码，模型仍然不会产出 medium。要把三档用**正面的、面向组织知识的例子**重新定义（`MEMORY_OPS_RULES`，`extraction.ts:31-42`）：

- **high** = 没有它未来回合会出错的硬约束（不可违反的规则、会造成返工的前提）。
- **medium** = 团队/项目的日常运作知识：谁负责哪块、群里术语的默认含义、发布与命名惯例、流程要先过谁、客户联系人。**没有它不会立刻出错，但知道了明显更省事。**
- **low** = 一次性进度、临时状态、可以从文件里重新读到的内容。

并把「空数组是正确的」从绝对律改为有条件：不要硬凑，但**不要仅仅因为「下一回合没它也能过」就扣下团队运作知识**。

**不把「试用期」这个概念告诉提炼 prompt。** 模型的职责是诚实标定 necessity/confidence，后果由 runtime 承担——告诉它「反正会过期」只会让标定变松。这与本仓库一贯的分工一致：模型报告，runtime 裁决。

#### D10 与 L2 的边界（回应评审「L1 必须排在 L2 之后」）

评审明确写着：1.3（放宽写入闸门）**必须排在 1.1（召回统计接入衰减）之后**，否则只是把 MEMORY.md 变成垃圾场。这条担心是对的，本 spec 的处理不是无视它，而是**把 L2 里 L1 真正依赖的那一小块——条目级 use-it-or-lose-it——作为 L1 的一部分一起交付**，且只作用于 probationary 条目。

仍然留在 L2 待办、本 spec **不做**的：

- `recallCount` / `lastRecalledAt` 参与 recall 排序打分；
- 对全部 `trust: "inferred"` 条目的 90 天普适衰减/降级。

那两条影响面更大、会改变既有 durable 条目的命运，需要 recall eval（路线图 0.2）先建成硬门槛才能判断是升是降。

## 实施清单

**建议顺序：先 L1 后 G1**（L1 改动更小、见效更快，且与 G1 无依赖）。两部分各自独立通过 `npm run check`。

### 第一批：L1

| 文件 | 改动 |
|---|---|
| `src/memory/promotion.ts` | `shouldAutoWriteMemory` → `classifyMemoryWrite`；新增 `MemoryWriteTier`、`MEMORY_PROBATION_WRITE_CONFIDENCE = 0.9`、`MAX_PROBATION_WRITES_PER_RUN = 5` |
| `src/memory/extraction.ts` | `MEMORY_OPS_RULES` 三档定义重写（D9）；`toMemoryOp` 增 tier 入参，probationary stamp `probationUntil`，durable stamp `probationUntil: null` |
| `src/memory/consolidation.ts` | `runInlineConsolidation` 按档分流、施加 per-run 上限；`InlineConsolidationResult` 区分 `appendedDurableEntries` / `appendedProbationaryEntries`，review-log 相应分列 |
| `src/memory/metadata.ts` | `MemoryEntryMetadata.probationUntil`、`MemoryWriteMetadataInput.probationUntil?: string \| null`；**`syncMemoryMetadata` 的逐字段重建必须带上它**（漏写＝每次召回都丢）；`recordMemoryRecall` 在既有写里清标 |
| `src/memory/probation.ts`（新） | 常量、`probationDeadline`、`collectExpiredEntryIds`（含 `expiresAt`）、`expireMemoryEntries` |
| `src/memory/files.ts` | `applyChannelMemoryOps` 的 `skippedDuplicate` 分支对已存在条目清标（需 contentHash→entryId 映射）；`ApplyMemoryOpsResult` 增 `promotedFromProbation` |
| `src/memory/maintenance-gates.ts` | `StructuralMaintenanceMaterial.expiredEntryCount`、`StructuralMaintenanceGateDecision.runProbationExpiry`；两条 deny 计入 |
| `src/memory/maintenance-jobs.ts` | 淘汰步骤前置于 cleanup；review-log 记 `action: "expire"` |
| `src/memory/commands.ts` | `/memory status` 增 `Probationary: N（最早到期 …）`；`/memory list` 标注试用期；`/memory show` 展示 `probationUntil` |
| `src/playbooks/memory-and-learning.md` | 增一段：后台自动写入的非关键记忆有 30 天试用期，期间被用到即转正，从未被用到则失效且**可被重新学到**；用户明说要记住的条目不受此约束 |

### 第二批：G1

| 文件 | 改动 |
|---|---|
| `src/tasks/ledger.ts` | `taskContractSegment` 终点含 Plan（D1）；`TaskPlanStep`/`TaskPlanSummary` 与解析器；`TaskLedgerEntry.plan`；`toEntry` 解析；`renderStandardTaskBody` 支持可选 plan；`startTaskCycle` 重置 plan；`TaskSkeletonInput.plan` |
| `src/tools/task-manage/schema.ts` | `create` 增 `plan`；`progress` 增 `planSteps` |
| `src/tools/task-manage/shared.ts` | plan 段渲染/插入（含 Current Cycle 前的自动插入）、planSteps 补丁应用、delta 文案生成 |
| `src/tools/task-manage/create.ts`、`lifecycle.ts` | create 播种；progress 应用补丁并把 delta 追加到 note |
| `src/runtime/task-driver.ts` | capsule 增 plan 行；`taskFingerprint` **不变**，注释点名 plan 被排除的理由（D5） |
| `src/memory/task-digest.ts` | digest 行增 `plan n/m · @Px` |
| `src/runtime/task-commands.ts` | `/tasks doctor` 两条漂移检查 |
| `src/playbooks/task-planning.md` | 何时写 Plan（预计 ≥5 步或跨 ≥3 次唤醒）、粒度（3–9 步、每步有可验证产出）、**Plan vs `nextAction` vs Manual 的分工**：Plan 是步骤阶梯，`nextAction` 是当前步骤内的下一个动作，Manual 是跨周期沉淀的方法 |
| `src/playbooks/task-driving.md` | 每次唤醒先读 Plan 当前步；步骤状态用 `progress` 的 `planSteps` 更新；重新规划要显式改写并在 note 里说明理由 |

### 文档

| 文件 | 改动 |
|---|---|
| `docs/events-and-tasks.md` | 正文标准段增加 Plan（可选段）、语法与契约段边界说明 |
| `docs/architecture.md` | 记忆域「单一提炼路径 + 一道置信度闸门」一节改写为两档闸门 + 试用期闭环；任务域补 Plan 层 |
| `CHANGELOG.md` | 两条用户可见行为变化 |

## 验收

### 必须通过

- `npm run check` 全绿；`npm run deadcode` 无孤儿（`shouldAutoWriteMemory` 被替换后不得残留）。
- 两批改动各自独立成立。

### 需要新增的测试

**G1**

1. **契约哈希不变量（最关键的一条）**：给一个已记录 PASS 的任务补写 `## Plan`，`taskBodyHash` 逐字节不变，`done` 不被拒；随后改动 Goal 则照常失效。
2. **fingerprint 不含 plan（防绕过治理器的回归钉）**：仅改变 plan 步骤状态、其余不变的两次唤醒，`taskFingerprint` 相同，futile 计数照常累加。
3. plan 解析：四种标记、缺 id 的手写行、`→ dod:` 引用、非标准正文（无 Plan 段）返回 undefined。
4. `current` 推导：第一个 `[ ]` 或 `[!]`；全 done 时为 undefined；`[~]` 不计入 total。
5. `progress` 的 planSteps：改状态、改文案、追加新步骤、delta 文案进入 note；无 Plan 段时自动插入且契约哈希不变。
6. `startTaskCycle` 重置 plan 且保留 `[~]`。
7. `/tasks doctor` 报告未覆盖的 DoD 项与无效的 dod 引用。

**L1**

8. `classifyMemoryWrite` 四组边界：high/0.85、medium/0.90、medium/0.89、low/1.0。
9. **`supersede`/`invalidate` 永不进试用期**：medium + 0.95 的 supersede 被拒。
10. per-run 上限：一次 consolidation 返回 8 条 medium 时只写 5 条。
11. `probationUntil` 跨 `syncMemoryMetadata` 存活（模拟一次召回引发的 sync）。
12. 召回转正：`recordMemoryRecall` 后 `probationUntil` 被清除。
13. 重复 add 转正、durable supersede 转正。
14. 淘汰：到期条目被 `invalidate`（**不写墓碑**，可被重新写入）；未到期条目不动；`expiresAt` 到期同样被清。
15. gate：仅有过期条目、无 cleanup/folding 需求时 structural-maintenance 仍放行。

### 需要更新的测试

`test/memory-promotion.test.ts`（`shouldAutoWriteMemory` 全量替换）、`test/memory-maintenance-{gates,jobs,scheduler}.test.ts`、`test/integration/memory-lifecycle.test.ts`、`test/task-ledger.test.ts`、`test/task-manage.test.ts`、`test/task-driver.test.ts`、`test/task-commands.test.ts`、`test/context.test.ts`。

### 建议紧随其后（不在本 spec）

路线图 0.2 的**记忆 recall eval 升级为 required**。L1 放宽入口后，「学多了还是学脏了」没有 eval 只能靠体感判断；`evals/gates.json` 里 `M-recall-02`/`M-recall-03` 目前是 `report-only`。

## 风险与残余敞口

1. **试用期误淘汰。** 缓解四层：用 `invalidate` 而非 `forget`（可重新学到）、`applyChannelMemoryOps` 在有 removal 时自动备份（`files.ts:340`）、写 review-log、`/memory list` 显示到期日可提前干预。残余：用户不看 `/memory` 就不会预先察觉。
2. **medium 泛滥导致 MEMORY.md 膨胀。** 缓解：0.9 阈值 + 每轮 5 条 + 30 天淘汰 + `MEMORY_CLEANUP_LENGTH_THRESHOLD`（5000 字符）本就会更早触发 LLM cleanup。**真实敞口是无法量化**——没有 recall eval 就无法判断精确率是升是降，故上文把 0.2 列为紧随项。
3. **模型标定漂移。** 评审盲区之一：`necessity` 的含义随模型而变，换 sidecar 模型可能让 medium 的产出量突变。缓解：`/memory status` 暴露 probationary 存量与转正情况，异常可见；阈值是代码常量，调整需发版（这是有意的，避免变成用户要猜的旋钮）。
4. **Plan 与 DoD 的双清单认知负担。** 模型可能把 DoD 逐条抄成 Plan。缓解：playbook 明确分工 + doctor 的覆盖检查会暴露 1:1 抄写（每步恰好对一项、无编排信息）。但不强制。
5. **plan 步骤可被虚勾。** 与 DoD 同源问题，**刻意不防**：真实证据仍由 effect-ledger 把关。关键是不让虚勾换来治理豁免——由 D5 保证。
6. **`task_manage` 的 schema 继续变大。** 已有 17 个可选字段（跨全部 action 共用一张表），再加两个。可接受，但下一次再要加字段前应当先考虑拆分动作面。

## 不做什么

- **不动 `taskFingerprint`、`attemptDelayMs` 三档退避、`FUTILE_WAKE_LIMIT`**（D5）。
- **不新增任何暂停条件**；G3 的「futile 到 2 次派发反省回合」是后续 spec 的地盘，本 spec 只留下 `TaskPlanSummary.current` 这个测量点。
- **不让 `done` 校验 Plan 完成度。** DoD 是契约，Plan 是手段；用手段卡收尾会造出第二个验收门。
- **不把 Plan 加入 `STANDARD_TASK_SECTIONS`**，不对存量任务报「缺段」。
- **不动 `control.nextAction`。** 它与 Plan 是不同粒度，靠 playbook 划清而非删除。
- **不做 G4**（attempt 滚动窗口 + 全局 spend guard）：那是三份审查共同确认的最大卡点，但需要单开 spec，且涉及 spec 036 D1 欠下的债。
- **不做 L2 余下部分**（召回统计参与打分、全量 inferred 衰减）、**L3**（跨频道晋升）、**L4**（skill 晋升）、**L5**（语义召回）、**L6**（召回效果反馈）。
- **不新增 `settings.json` 键**：两个阈值与 30 天窗口都是算法参数，遵循 spec 035 的判据。
