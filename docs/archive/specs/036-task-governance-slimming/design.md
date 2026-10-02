> **当前语义已由 [038 Task Autonomy State v2](../038-task-autonomy-state-v2/design.md) supersede。** 本文中的策略字段与生命周期口径属于 Task v1 历史契约。

# 任务治理瘦身：把预算、worktree、关系图删掉，把验收收敛成一件事

| 字段 | 值 |
|------|------|
| 状态 | IMPLEMENTED（R3a `ffa0a17`、R3b `4f31748`、R3c-1 `64e824f`、R3c-2 `f3b62ed`） |
| 日期 | 2026-07-25 |
| 前置 | 019 task-ledger、022 native-task-driver、023 governed-task-loops、027 native-task-recurrence、029 task-lifecycle-simplification、032 subagent-adoption、034 subagent-invocation-surface |
| 来源 | `docs/refer/pipiclaw-slimming-round2-2026-07-25.md` R3a/R3b/R3c；产品定位裁决＝**无人值守模式** |
| 关联实现 | `src/tasks/*`、`src/tools/task-manage/*`、`src/runtime/task-driver.ts`、`src/runtime/task-commands.ts`、`src/subagents/tool.ts`、`src/shared/task-ledger.ts`、`src/memory/task-digest.ts`、`docs/events-and-tasks.md` |
| 预期净删除 | 估计约 1,900–2,600 行；**实测 −395 行**，差距归因见第 9 节 |

## 背景

`pipiclaw-slimming-round2-2026-07-25.md` 度量出：任务治理域是 **4,229 行 / 17 文件 / 6 目录**，是系统里最大的一块「活复杂度」。同时它指出一个此前未记录的事实——**治理的守护状态是内存态**（`task-driver.ts:235` 的 `attempts` Map、`effect-ledger.ts` 的 `counts` Map，重启即失效）。也就是说，系统付了完整的治理代码成本，却没有换到跨重启的治理保证。

用户裁决：**任务机制保留，方向正确；但删掉不必要的复杂度**。具体口径：

- R3a（预算 / 双账本）：按提案执行。
- R3b（worktree）：按提案执行。
- R3c：`parent`/`dependsOn` 关系图**删除**；`verification` **保留但适当简化**。

同时裁定产品定位为 **无人值守模式**。

## D0 定位前提：无人值守模式对本 spec 的三条约束

「无人值守」= 容器 / OS 级隔离在**执行器边界**兜底，而不是靠状态机里的字段兜底。由此：

1. **`externalApproval` 全部保留，本 spec 一个字段都不动。** 它是唯一的人工闸门。执行前授权边界（deep review P0-1）是后续独立 spec 的事，本 spec 不预支、也不削弱它。
2. **`verification` 保留并被强化其核心**：无人值守意味着没有人复核产出，**防自证**（agent 不能自己写一个 "passed"）比有人值守时更重要。因此本 spec 删的是验收的**冗余形态**，不是验收本身。
3. **删 worktree 不等于删隔离。** `isolation: worktree` 给的是 git 工作树隔离——同一台主机、同一文件系统、同一网络。它从来不是安全边界，只是并行分支的工作流便利。无人值守要的隔离由执行器边界提供，与本项无关。

一条必须显式记录的**残余风险**（见第 8 节）：R3a 删掉 token/成本/墙钟三维预算后，per-task 成本上限只剩 `maxAttempts`。无人值守下这是真实敞口，但正确的解法是**全局支出闸**而不是 per-task 预算（50 个各自达标的任务照样能烧穿月度预算）。核实 `src/usage/` 只有 `ledger.ts` + `render.ts`、**没有任何 cap/guard**，所以这是一个已存在的缺口，本 spec 不引入它、也不假装 per-task 预算填上了它。

## 病根的准确表述

不是「任务字段太多」，而是**四条界线画错了**。

1. **预算按错误的粒度做成本控制。** `maxTokens`/`maxCostUsd`/`maxWallTimeMinutes` 是 per-task per-cycle 的，而成本是全局的。它们既拦不住总量，又要求用户为每个任务猜三个数值。核实其消费面**极度收敛**：仅 schema 3 处 + `assertCostBudgetAvailable` 一个前置检查 + `taskBudgetViolation` 集中判定，删除几乎是局部手术。

2. **双账本是同一事实的两份副本。** `usage`（当前 cycle）与 `lifetimeUsage`（非重置审计）在 `claimTaskAttempt`/`releaseTaskAttemptClaim`/`finishTaskAttempt` 三处**逐字段同步累加/回退**（`store.ts:108-109,126-127,153-167`）。任何一处漏改就是静默不一致，而收益只是 `/tasks stats` 多一行展示。

3. **关系图把「个人待办」做成了「项目管理」。** `parent`/`dependsOn` 拉出了：环检测（`shared.ts:203-247`，父链 + 依赖 DFS 两套）、依赖就绪判定（`store.ts:241-278`，内含第三套环检测）、死锁图检测（`task-commands.ts:189-212,623-638`，第四套）、done/skip/cancel 的子任务闸门（`lifecycle.ts:108-113,211-216,246-251`）。**四套环检测**服务于一个个人 Agent 的待办列表。更糟的是 `terminalDependencyReason`（`task-driver.ts:210-217`）靠**对错误文案做字符串匹配**来判定依赖是否终局——这是把语义编码进了人类可读字符串。

4. **验收有两种形态，其中一种是自证。** `verification.mode: "evidence" | "independent"`：
   - `independent` = 独立 verifier 子代理产出 attestation 文件，`done` 时重新校验 → **真验收**。
   - `evidence` = `done` 时由 maker 自己写 `status: "passed"`（`lifecycle.ts:149-157`）→ **自证**，且与 `appendCompletionEvidence` 已经写进 body 的 Summary/Evidence **完全重复**。

   两种形态共用一个字段名，导致默认值散落且互相矛盾。核实存在 **4 个不一致的默认**：

   | 位置 | 默认 |
   |---|---|
   | `createDefaultTaskControl(mode = "independent")` | independent |
   | `renderTaskSkeleton`：`?? "evidence"`（create 路径） | evidence |
   | `applySet`：`createDefaultTaskControl("evidence")`（修复路径） | evidence |
   | `parseTaskControl`：`enumValue(..., "independent")`（读盘回退） | independent |
   | `renderStandardTaskBody`：`?? "independent"`（正文渲染） | independent |

   同一个任务，走 create 得到 `evidence`，正文却渲染 `Mode: independent`，控制块被重新解析时又回退成 `independent`。这不是配置灵活，是 bug 农场。

此外核实出三个**只写不读**的 attestation 字段：`outputHash`、`agent`、`model`（`verification.ts:54-59`）。三者都在读取时做了严格校验（`:87-92`，含一次 64 位 hex 正则），但**从不参与任何判定或展示**——`verifyTask` 只比对 `taskId`/`workspaceChanged`/`bodyHash`/`subjectHash`，`assertVerificationAttestationMatches` 只比对 `taskId`/`verdict`/`bodyHash`，`/tasks doctor` 只比对 `taskId`/`verdict`。

## 设计

### R3a — 预算与账本

#### D1 预算收缩为单一 `maxAttempts`

```ts
export interface TaskBudget {
	maxAttempts: number;   // 保留：唯一 per-task 止损
}
```

删除 `maxTokens` / `maxCostUsd` / `maxWallTimeMinutes`。`taskBudgetViolation` 相应收缩为 **deadline + attempts** 两条：

```ts
export function taskBudgetViolation(control: TaskControl, nowMs: number): string | undefined {
	if (control.deadline) { /* 逾期判定，不变 */ }
	if (control.usage.attempts >= control.budget.maxAttempts) { /* 不变 */ }
	return undefined;
}
```

连带删除 `assertCostBudgetAvailable`（`shared.ts:26-36`）与 `TaskManageToolOptions.costTrackingAvailable`（`types.ts:60`）及其在 `registry.ts:229` 的 `hasKnownModelPricing(...)` 注入——那段逻辑存在的唯一理由是 `maxCostUsd` 需要定价元数据。

**`usage` 完整保留**（attempts/tokens/costUsd/costKnown/wallTimeMinutes）：它仍是 `/tasks stats` 的数据源，也是 `maxAttempts` 的判定依据。**删的是预算（enforcement），不是计量（observability）。**

#### D2 删除 `lifetimeUsage` 双账本

`TaskControl.lifetimeUsage` 整体删除。`store.ts` 三处双写收敛为单写；`/tasks stats` 的 lifetime 行（`task-commands.ts:353-359`）与汇总（`:389`）改为只报当前 cycle。

对一次性任务，`usage` 本来就等于 lifetime；对周期任务，跨 cycle 的历史留在 body 的 History 段落里——那是人类可读、可审计、且不需要两个计数器保持一致的载体。

### R3b — worktree

#### D3 删除任务持有的 worktree，子代理去掉 `isolation`

`TaskWorktree` 类型、`TaskControl.worktree`、`TaskControlPatch.worktreePath/worktreeBranch` 全部删除；`resetTaskControlForCycle` 里的 worktree 重置随之消失。

`src/subagents/tool.ts` 删除 `isolation` 参数、worktree 创建/复用/回收整段（约 `:250-360`）与 `recordTaskWorktree`。子代理调用面 **15 → 14 参数**（`subagentSchema` 现有 15 项：label / agent / name / task / systemPrompt / tools / model / effort / context / paths / purpose / taskId / isolation / returns / thinkingLevel）。

**明确保留 `purpose` 与 `taskId`**：它们服务于验收（D5），与 worktree 无关。原 round2 报告的 R3b 曾提议一并删除 `purpose: verify`，那是建立在「R3c 删除 verification」的前提上；用户裁定保留 verification，**该项相应撤销**——这是本 spec 相对 round2 报告的一处有意偏离。

需要子代理在独立检出上工作时，由用户在宿主侧自行 `git worktree add` 并把路径作为普通工作目录传入，不再由任务台账持有其身份。

### R3c-1 — 关系图

#### D4 删除 `parent` / `dependsOn`

`TaskControl.parent`、`TaskControl.dependsOn`、`TaskControlPatch` 对应字段、`taskIds()` 解析器全部删除。连带删除：

| 删除对象 | 位置 |
|---|---|
| `validateTaskRelations`（父链环检测 + 依赖 DFS 环检测） | `tools/task-manage/shared.ts:196-248` |
| `unfinishedChildren` | `tools/task-manage/shared.ts:279-289` |
| `dependencyState`（含第三套环检测） | `tasks/store.ts:241-278` |
| `terminalDependencyReason`（字符串匹配判定） | `runtime/task-driver.ts:210-217` |
| driver 的依赖门控 2 处 | `runtime/task-driver.ts:388,422` |
| `done` 的依赖闸门 + 子任务闸门 | `tools/task-manage/lifecycle.ts:102-113` |
| `skip`/`cancel` 的子任务闸门 | `tools/task-manage/lifecycle.ts:211-216,246-251` |
| `relationCycles` + 死锁图检测 | `runtime/task-commands.ts:189-212,512-519,623-638` |
| parent/depends 展示 | `runtime/task-commands.ts:244-245`、`memory/task-digest.ts:51` |

**四套环检测归零。** 任务之间的先后关系改由人类可读的方式表达：在 body 的 Manual/Goal 里写明「先做 X」，或用 `wake` 排开时间。个人 Agent 不需要一个可被静态验证的依赖 DAG。

### R3c-2 — 验收（保留并简化）

#### D5 `mode` 二元 → `required` 布尔，删除自证形态

```ts
export interface TaskVerification {
	/** 是否要求独立 verifier 出具 attestation 才能 done。 */
	required: boolean;
	status: "pending" | "passed" | "failed";
	runId?: string;
	evidence?: string;
	/** 契约段（Goal/DoD/Manual/Verification）哈希，见下方命名说明。 */
	bodyHash?: string;
	checkedAt?: string;
	subjectHash?: string;
}
```

- `mode: "independent"` → `required: true`；`mode: "evidence"` → `required: false`。
- **删除 `done` 里的自证写入分支**（`lifecycle.ts:147-158`）。`required: false` 的任务，`done` 依旧强制要求 `summary` + `evidence` 并写入 body 的 Completion Evidence——**证据没有丢失，只是不再伪装成一次「验收通过」**。
- `VERIFICATION_MODES` 常量、`TaskVerificationMode` 类型、`TaskControlPatch.verificationMode` → `verificationRequired?: boolean`。
- **默认值统一为一处**：`createDefaultTaskControl(requiresVerification = false)`，create/repair/读盘回退/正文渲染全部取同一个来源。第 4 项病根的 4 个矛盾默认归一。
- 正文渲染（`task-ledger.ts:264-278`）的 `Mode: <mode>` 行改为仅在 `required` 时输出一行 `Independent verification: required`，否则不输出该行。

**一处有意的行为增强（服务无人值守定位）**：当 `sideEffects: "external"` 时，`verification.required` 默认为 `true`。理由——无人值守下，会改动外部系统的任务恰恰是最需要独立复核的那类，而它本来就已经因 `externalApproval` 进入人工闸门，多一次 verifier 运行的边际成本可接受。用户仍可显式设 `verificationRequired: false` 覆盖。

#### D6 attestation 瘦身

`VerificationAttestation` 删除 `outputHash`、`agent`、`model` 三个只写不读字段及其读取校验（`verification.ts:20,54-59,87-92`）；`writeVerificationAttestation` 的入参与 `subagents/tool.ts:963-974` 的调用点同步收缩。

保留并**不动**的防伪核心：`version`、`runId`、`taskId`、`verdict`、`checkedAt`、`bodyHash`、`evidence`、`workspaceChanged`、`subjectHash`，以及 `done` 时的 `assertVerificationAttestationMatches` 重校验。attestation 文件是**磁盘上的独立事实**，任务 Markdown 由 agent 的 write/edit 可写——这条重校验正是防止手写 "passed" 的那道门，无人值守下必须保留。

#### D7 `subjectHash` 保留，统一失败语义

**保留**（考虑过删除，结论是不删）：它是唯一覆盖**代码产物**的时效性检查——`bodyHash` 只覆盖任务文档的契约段，无法发现「verify 通过后 agent 又改了代码再 done」。无人值守下这个窗口恰恰无人盯防，34 行 + 若干 git 子进程的成本相对其防护价值是划算的。

**但修掉它的失败语义不一致**：生产侧 `workspaceSubjectHash` 读不到 git 时 `catch → undefined`（fail-open），消费侧 `verifyTask:76-87` 却在 attestation 带 `subjectHash` 而当前读不到时抛错（fail-closed）。统一为：**两端都 fail-closed** —— attestation 记录了 subject 就必须能复算，否则要求重跑验收。理由是 fail-open 的一侧会让「不在 git 仓库里跑」静默降级掉整条检查。

#### 命名：`bodyHash` 保持不变（考虑过重命名，结论是不改）

该字段实际存的是**契约段**哈希（`store.ts:31-33` 的 `taskBodyHash` 调 `taskContractSegment`），叫 `bodyHash` 名不副实，`control.approvalBodyHash` 同理。但重命名持久化键意味着存量任务读不到旧键 → 验收与审批被静默作废 → 需要重新验收/重新审批。**为一个命名准确性去作废用户已有的审批，不划算。** 保持键名，在类型上补注释说明其真实语义。

### D8 迁移：读时忽略 + `/tasks doctor` 报告退役键

沿用 `control.ts:150-155` 已确立的模式（`control.isolation` 就是这么退役的）与 spec 035 的 `RETIRED_SETTINGS_KEYS` 先例：

- **解析器忽略未知键**，存量任务文件照常可读，下一次写入自然落成新格式。**无需迁移脚本、无需双轨。**
- 新增 `RETIRED_TASK_CONTROL_KEYS = ["parent","dependsOn","budget.maxTokens","budget.maxCostUsd","budget.maxWallTimeMinutes","lifetimeUsage","worktree","verification.mode"]`，由 **`/tasks doctor` 逐任务报告**：哪些任务的控制块仍带退役键、具体是哪几个。

这一步不可省：`parent`/`dependsOn` 被忽略意味着**用户曾表达的执行顺序约束被静默丢弃**。任务本身不会丢（文件还在、状态还在），但顺序意图会丢，必须让用户看得见。`verification.mode: "evidence"` 被读成 `required: false`、`"independent"` 读成 `true`，属于无损映射，报告为信息级即可。

## 实施清单

按 R3a → R3b → R3c 顺序提交，**每一步独立通过 `npm run check`**。

### R3a（预算与账本）

| 文件 | 改动 |
|---|---|
| `src/tasks/control.ts` | `TaskBudget` 仅留 `maxAttempts`；删 `TaskControl.lifetimeUsage`、`TaskControlPatch` 三个预算字段；`createDefaultTaskControl` 去 `lifetimeUsage`；`parseTaskControl` 去三处 `optionalPositive` 与 `lifetimeUsage` 解析；`applyTaskControlPatch` 去三处 `patchPositive`；`taskBudgetViolation` 收缩为 deadline+attempts；`patchPositive` 若无引用则删除 |
| `src/tasks/store.ts` | `claimTaskAttempt`/`releaseTaskAttemptClaim`/`finishTaskAttempt` 去掉全部 `lifetimeUsage` 读写（约 8 处） |
| `src/tools/task-manage/schema.ts` | 去 `maxTokens`/`maxCostUsd`/`maxWallTimeMinutes` |
| `src/tools/task-manage/shared.ts` | 删 `assertCostBudgetAvailable` |
| `src/tools/task-manage/create.ts`、`lifecycle.ts` | 去 `assertCostBudgetAvailable` 调用 |
| `src/tools/task-manage/types.ts` | 删 `costTrackingAvailable` |
| `src/tools/registry.ts:229` | 去 `costTrackingAvailable` 注入。**`hasKnownModelPricing` 保留**——`channel-runner.ts:1304` 仍在用，不会成为孤儿 |
| `src/runtime/task-commands.ts` | `/tasks stats` 去 lifetime 行与汇总 |

### R3b（worktree）

| 文件 | 改动 |
|---|---|
| `src/tasks/control.ts` | 删 `TaskWorktree`、`TaskControl.worktree`、patch 两字段、解析块、`resetTaskControlForCycle` 的 worktree 重置、`applyTaskControlPatch` 的 worktree 块 |
| `src/tools/task-manage/schema.ts` | 去 `worktreePath`/`worktreeBranch` |
| `src/subagents/tool.ts` | 删 `isolation` schema 项、worktree 创建/复用/回收段（约 `:250-360`）、`recordTaskWorktree`、run context/result 上的 worktree 字段；**保留 `purpose`、`taskId`** |
| `src/runtime/task-commands.ts:247` | 去 branch 展示 |

### R3c-1（关系图）

| 文件 | 改动 |
|---|---|
| `src/tasks/control.ts` | 删 `parent`、`dependsOn`、patch 两字段、`taskIds()`；`validateTaskId` 若仅剩 parent 用途则删除 |
| `src/tasks/store.ts` | 删 `dependencyState` |
| `src/tools/task-manage/shared.ts` | 删 `validateTaskRelations`、`unfinishedChildren` |
| `src/tools/task-manage/create.ts`、`lifecycle.ts` | 去 `validateTaskRelations` 调用；`done` 去依赖闸门与子任务闸门；`skip`/`cancel` 去子任务闸门 |
| `src/runtime/task-driver.ts` | 去 `dependencyState` 两处调用、删 `terminalDependencyReason` |
| `src/runtime/task-commands.ts` | 删 `relationCycles`、死锁图检测、doctor 的关系校验、parent/depends 展示 |
| `src/memory/task-digest.ts:51` | 去 depends 展示 |
| `src/tools/task-manage/schema.ts` | 去 `parent`/`dependsOn` |

### R3c-2（验收）

| 文件 | 改动 |
|---|---|
| `src/tasks/control.ts` | `TaskVerification.mode` → `required: boolean`；删 `TaskVerificationMode`、`VERIFICATION_MODES`；`createDefaultTaskControl(requiresVerification = false)`；patch 改 `verificationRequired`；`sideEffects: "external"` ⇒ 默认 `required: true` |
| `src/tasks/verification.ts` | attestation 删 `outputHash`/`agent`/`model` 及其校验；`writeVerificationAttestation` 入参收缩 |
| `src/tools/task-manage/verification.ts` | `candidate`/`verify` 改写 `required`；`subjectHash` 失败语义统一为 fail-closed |
| `src/tools/task-manage/lifecycle.ts` | **删 `done` 的 evidence 自证分支**；独立验收判定改用 `required`；`skip` 的 verification 重置改用 `required` |
| `src/tools/task-manage/schema.ts` | `verificationMode` → `verificationRequired: boolean`，描述重写 |
| `src/shared/task-ledger.ts` | `renderStandardTaskBody` 的 `verificationMode` → 布尔；`Mode:` 行改为条件输出 |
| `src/runtime/task-driver.ts:138-142` | verification 指令改用 `required` |
| `src/runtime/task-commands.ts` | 展示与 doctor 校验改用 `required` |
| `src/subagents/tool.ts:963-974` | 调用点去 `agent`/`model`/`output` 参数 |

### 迁移与文档

| 文件 | 改动 |
|---|---|
| `src/tasks/control.ts` | 新增 `RETIRED_TASK_CONTROL_KEYS` |
| `src/runtime/task-commands.ts` | `/tasks doctor` 报告携带退役键的任务 |
| `docs/events-and-tasks.md`（619 行） | 删除预算三维、worktree、parent/dependsOn 章节；验收章节改写为单一独立验收 + `required` 开关 |
| `docs/sub-agents.md` | 去 `isolation` 参数说明 |
| `docs/architecture.md` | 更新任务域描述 |
| `CLAUDE.md` / `AGENTS.md` | 若提及被删机制则同步 |

## 验收

### 必须通过

- `npm run check` 全绿（当前基线：110 测试文件 / 882 测试）。每个子步骤（R3a / R3b / R3c-1 / R3c-2）单独成立。
- `npm run deadcode`：删除后不得留下孤儿导出。已核实的预期结果：

  | 符号 | 删除后 |
  |---|---|
  | `patchPositive`（`control.ts:332`） | 仅服务三维预算 → **孤儿，删除** |
  | `taskIds`（`control.ts:171`） | 仅服务 `dependsOn` → **孤儿，删除** |
  | `validateTaskId`（`control.ts:187`） | 三处调用（`:231,350,352`）全在删除范围 → **孤儿，删除** |
  | `optionalPositive`（`control.ts:134`） | `maxAttempts` 仍在用（`:222`）→ **保留** |
  | `hasKnownModelPricing` | `channel-runner.ts:1304` 仍在用 → **保留** |
  | `artifact-subject.ts` | `subjectHash` 保留（D7）→ **保留** |

### 需要更新的测试

`test/task-control.test.ts`、`test/task-manage.test.ts`、`test/task-driver.test.ts`、`test/task-commands.test.ts`、`test/task-ledger.test.ts`、`test/subagent-phase1.test.ts`、`test/e2e/tasks-lifecycle.test.ts`、`test/behavior-eval-harness.test.ts`。

### 需要新增的测试

1. **退役键读取**：含 `parent`/`dependsOn`/`worktree`/`lifetimeUsage`/三维预算的存量任务文件可正常解析，未知键被忽略，下一次写入落成新格式。
2. **`/tasks doctor` 退役键报告**：上述文件被逐项报告，且 `parent`/`dependsOn` 的报告文案明确说明「顺序约束已不再生效」。
3. **`mode` 无损映射**：`"evidence"` → `required: false`，`"independent"` → `required: true`。
4. **自证分支已死**：`required: false` 的任务 `done` 后，`control.verification.status` 保持 `pending`，而 body 的 Completion Evidence 正常写入。
5. **防伪链未被削弱**（回归）：手写 `verification.status = "passed"` 但磁盘无匹配 attestation 时，`done` 仍被拒。
6. **external 默认 required**：`sideEffects: "external"` 创建的任务默认 `verification.required === true`，显式 `verificationRequired: false` 可覆盖。
7. **`subjectHash` fail-closed**：attestation 带 `subjectHash` 而当前目录非 git 检出时，`verify` 与 `done` 均拒绝。

### 指标（对齐 round2 报告第 7 节）

| 指标 | 改前 | 目标 | **实测** |
|---|---:|---|---|
| 环检测实现份数 | 4 | 0 | **0 ✅** |
| 验收形态数 | 2（含自证） | 1 | **1 ✅** |
| `verification` 默认值定义点 | 5（相互矛盾） | 1 | **1 ✅** |
| 子代理调用参数 | 15 | 14 | **14 ✅** |
| `TaskBudget` 字段数 | 4 | 1 | **1 ✅** |
| attestation 字段数 | 12 | 9 | **9 ✅** |
| `TaskControl` 顶层字段数 | 22 | ≤ 12 | **18 ❌** |
| 任务域代码行数 | 4,229 | ≈ 1,900–2,300 | **3,963 ❌** |
| `src/` 总行数 | 32,499 | — | **32,104（−395）** |

`npm run check` 通过，`npm run deadcode` 无孤儿，110 测试文件 / 880 测试（净 +2）。`test/runtime-stop.test.ts` 在全量并行下偶发失败、单独运行通过，且在本 spec 之前的基线上同样失败——是 deep review 已记录的 logger/并行隔离竞态，非本次引入。

### 两项未达标的归因（如实记录）

**`TaskControl` 18 而非 ≤12。** 这个目标与本 spec 自己的 D0-1 相互矛盾，立项时没有察觉。删掉的 4 个顶层字段（`parent`、`dependsOn`、`lifetimeUsage`、`worktree`）之外，剩下的 18 个里有 5 个属于审批链（`sideEffects`、`externalApproval`、`approvalBy`、`approvedAt`、`approvalBodyHash`），而 D0-1 明确规定审批链一个字段都不动。要落到 12 必须动审批链，那是下一个 spec 的地盘。**结论：目标数字应作废，不是实现欠账。** 真正被压缩的是嵌套结构：`TaskBudget` 4→1、attestation 12→9。

**行数 −395 而非 −1,900。** 估算把 `task-ledger.ts`(742) 与 `task-commands.ts`(721) 整体计入"任务治理域"，但两者绝大部分是正文渲染、历史折叠、frontmatter 解析和 `/tasks` 展示面，与被删的治理语义无关，删除触及不到。此外本次**新增**了 D8 的退役键机制（`RETIRED_TASK_CONTROL_KEYS`、`retiredTaskControlKeys`、`describeDroppedTaskRelations`、`rawControl`）以及仓库风格要求的解释性注释，抵掉了一部分。单文件净删最大的是 `subagents/tool.ts` −127、`task-manage/shared.ts` −78、`task-commands.ts` −61、`store.ts` −46。

这条经验对后续几轮有直接价值：**round2 报告第 3 节"行数不是好指标"的结论在这里再次成立。** 本轮真正的收益是 4 套环检测归零、验收从 2 种形态收敛到 1 种、5 个矛盾默认收敛到 1 个——这些都不体现在行数上。后续 R4 的估算应当按"消费面"而不是"所在文件总行数"来做。

## 风险与残余敞口

1. **无人值守下无成本上限（已知敞口，本 spec 不解决）。** 删除三维预算后，per-task 只剩 `maxAttempts`（默认 12）兜底。核实 `src/usage/` 无任何 cap。**建议紧随其后立项「全局支出闸」**：按天/按月的 token 与成本上限，触顶后暂停 TaskDriver 派发并通知用户。这是无人值守模式的必要配套，且是比 per-task 预算正确得多的位置。

2. **顺序约束静默丢失。** 由 D8 的 doctor 报告缓解，但用户仍需人工把关键顺序改写进 body 或 `wake`。**建议实施时在 doctor 报告里直接列出被丢弃的边**（`A → B`），而不只说「存在退役键」。

3. **`done` 门槛下降。** 删掉依赖/子任务闸门后，一个「父任务」可以在其「子任务」之前 done。这是关系图删除的直接后果，属预期内的能力收缩。

4. **worktree 用户需改工作流。** 依赖 `isolation: worktree` 的既有用法要改为宿主侧手工建 worktree。影响面应当很小（该参数需 `taskId` 且需在 git 仓库内），但发版说明必须点名。

5. **不要在同一批次里顺手改 `externalApproval`。** 它与 P0-1 执行前授权强相关，属于下一个 spec 的地盘；本 spec 若动它会让两边都难以回归。

## 不做什么

- **不动 `externalApproval`**（D0-1）。
- **不动 recurrence / `cycleId` / `resetTaskControlForCycle`**：spec 027/029 刚落地，与本次目标正交。
- **不动 `usage` 计量**：删的是预算不是计量。
- **不动 `effect-ledger` 与 governor 的内存态**：它是「治理不持久」的证据，但改它属于 R4 统一 Wake 的范围。
- **不合并三套唤醒源**：那是 R4。
- **不拆大文件**：`task-commands.ts`(721)、`task-driver.ts`(526) 会在本 spec 后显著变小，拆分留到 R6，避免删完再拆两遍。
