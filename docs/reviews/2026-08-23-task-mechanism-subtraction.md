# tasks 机制减法方案

- 日期：2026-08-23
- 基线：`b655636`（0.9.1-beta.1）
- 前置：[`2026-08-23-delegation-and-task-chain.md`](./2026-08-23-delegation-and-task-chain.md)（问题清单）。本文是**处理方案**，不是新一轮问题清单。
- 性质：评审输入。落地应另起 spec。

---

## 0. 结论先行

按"砍掉预算 + 砍掉兼容包袱 + `waitingFor` 去授权化"这三条线索往下拉，会发现它们**不是三件事，而是同一条依赖链上的三个位置**。顺着拉完，`control` 块从 **37 个叶子字段降到 11 个**，`src/tasks` + `task-manage` + `runtime/task-*` 约 **5370 行减少约 700 行**，`/tasks doctor` 的 28 条规则减少约 9 条，并且——这是最值得说的——**上一份报告里的 P0（verify wake 卡死）不是被"修好"，而是被"删掉"**：它的根因是两种停泊语义争抢同一条唤醒通道，而减法之后其中一种不再存在。

减法的顺序很重要，因为大部分收益来自连锁反应，而不是逐个字段的删除。

---

## 1. 减法判准

在开始列清单之前先立四条判准，否则减法会退化成品味之争。一个字段/机制满足任意一条就该被砍：

1. **写了没人读**——纯粹的账目。
2. **有两个权威**——同一事实在两处存储并互相校验；校验代码本身就是它不该存在的证据。
3. **模型在猜数字**——把一个模型无法可靠估计的量做成模型可写的字段。这条是 CLAUDE.md 里"`settings.json` 只接受产品意图，数值阈值是代码常量"那条规则的自然延伸：**同一条规则应该对模型可写的 control 块同样成立**。
4. **靠事后巡检维持的不变式**——如果 doctor 需要一条规则来保证 A 和 B 一致，那说明写入路径允许写出不一致，应该改构造而不是加检查。

判准 3 是这次减法的主线：`maxAttempts`、`priority`、`usage.tokens/costUsd/wallTimeMinutes` 全部命中它。

---

## 2. 主线：砍掉预算，会掉下来一大片

这是本方案的核心论证，其余都是它的推论。

### 2.1 现状

```
budget: { maxAttempts }
usage:  { attempts, tokens, costUsd, costKnown, wallTimeMinutes }
```

- `tokens` / `costUsd` / `costKnown` / `wallTimeMinutes` **唯一的消费者是 `/tasks stats`**（`src/runtime/task-commands.ts:428-431,465-469`）——一个人工命令的展示。而 `src/usage/ledger.ts` + `/usage` 已经是权威的用量账本。这是判准 1 + 判准 2 双杀。
- `maxAttempts` 默认 12，而一次委派往返约消耗 2 个 attempt、一次独立验收再加 2。委派驱动的任务**在完成前必然撞治理器**（上一份报告 §4.3）。这是判准 3。

### 2.2 连锁反应

关键洞察：**`attemptGeneration` / `wakeHandoff` / `rollbackWakeTaskActivation` / `finishWakeTaskActivation` 这一整套并发机制，唯一的存在理由是保证 attempt 计数器的准确性。**

顺着看：

```
finishTaskAttempt 写什么？
  usage.tokens/costUsd/costKnown/wallTimeMinutes  ← 砍
  usage.attempts 的 silent 退款                    ← 随预算砍
  lastFinishedAt / lastOutcome / blockedReason     ← 见 §3
⇒ finishTaskAttempt 无事可做，删除
⇒ result.generation 的"陈旧写入保护"失去保护对象
⇒ attemptGeneration 删除
⇒ ChannelEvent.taskAttemptGeneration 删除（channel-event.ts:40、bootstrap.ts:724,758,790、task-driver.ts:219）
⇒ wakeHandoff 的 6 个字段（previousLastOutcome/previousBlockedReason/previousLastStartedAt/generation/...）失去回滚对象
⇒ rollbackWakeTaskActivation / finishWakeTaskActivation / isMatchingWakeHandoff / WakeTaskTransitionHooks 删除
⇒ activateWaitingTaskAndClaimAttempt 退化成已经存在的 activateWaitingTask
⇒ claimTaskAttempt / releaseTaskAttemptClaim 删除
```

`src/tasks/store.ts:103-358` 这 **256 行**几乎整段消失，只留下一个约 20 行的 `activateWaitingTask`。这是整个 tasks 层最难懂、测试最重、也最容易出错的一段代码——它服务的对象是一个"模型在猜的数字"。

### 2.3 那用什么止损

预算砍掉后，止损全部落到**定性判断**上，而这些机制**已经存在且已经在跑**：

| 止损 | 性质 | 现状 |
|---|---|---|
| `deadline` | 用户真实意图，硬期限 | 已有（`taskBudgetViolation` 的另一半） |
| 连续 3 次唤醒无外部可见 effect | 证据驱动 | 已有（`FUTILE_WAKE_LIMIT` + `effect-ledger.ts`） |
| 单周期唤醒次数天花板 | 失控兜底，**代码常量、模型不可见不可调** | 新增 |

第三条是唯一新增的东西，而且建议**放在 driver 的进程内存里**（复用已有的 `this.attempts` map），与 `futileCount` 完全同构——`task-driver.ts` 的注释已经明确接受了"重启会重置这两个计数器，代价最多是多一轮耐心"这个权衡。这样它不进 control 块、不进磁盘、不需要 claim、不需要 generation，也就不会把刚砍掉的那条依赖链拉回来。

> 如果评审认为失控兜底必须持久化，退而求其次：control 里留**一个**单调计数器 `wakes`（无 `budget` 对象、无 `maxAttempts`、无退款、无 generation 守卫——单调计数器的陈旧写入是无害的）。这仍然砍掉 250 行里的 240 行。但首选是进程内存。

### 2.4 成本可见性怎么补回来

`/tasks stats` 提供的唯一真实价值是"这个任务花了多少钱"。建议：**给 `UsageLedger` 的记录加一个可选 `taskId` 字段**（它已经有 `channelId` / `kind` / `runId`），由 bootstrap 在 task-driver 回合结束时带上。于是 `/usage` 能按 task 聚合，账目留在账本里，任务文件里不再有账目。

`/tasks stats` 整个命令删除（`renderUsageLine` + `taskStats` 共 62 行 + 子命令分支）。

---

## 3. 逐项清单

### 3.1 砍（判准明确，无争议）

| 项 | 位置 | 判准 | 说明 |
|---|---|---|---|
| `usage.tokens/costUsd/costKnown/wallTimeMinutes` | `control.ts` | 1,2 | 唯一读者是 `/tasks stats`；权威账本是 `usage/ledger.ts` |
| `budget.maxAttempts` + `usage.attempts` | `control.ts` | 3 | 模型猜数字；与委派节奏冲突 |
| `attemptGeneration` / `wakeHandoff` / 回滚机制 | `store.ts:103-358` | — | §2.2 的连锁产物 |
| `lastOutcome` / `lastStartedAt` / `lastFinishedAt` | `control.ts` | 1 | 自己的注释就写着"telemetry, not a lifecycle state"；driver 的 `taskFingerprint` 刻意排除它 |
| `provenance` | `control.ts:42-46,172-182` | 1 | **纯死代码**：`createdAt` 在 `shared.ts:80` 被写入一次，`createdBy`/`sourceMessageId` 永远是 undefined，三者**全部无人读取** |
| `priority`（4 值枚举） | `control.ts`, `ledger.ts:1126` | 3 | 只影响 `readActiveTasks` 的初始排序，而 driver 的 `lastDispatchedTaskId` 轮转随即覆盖它。排序改用 deadline/wake |
| `recurrence` | frontmatter | 1 | 自述"Human annotation only"，与 `schedule` 重复，却混进了 `taskFingerprint`（`task-driver.ts:113`） |
| `blockedReason` | `control.ts` | 2 | 与 `nextAction` / Current Cycle 最新条目三重重叠；唯一实质读取在 legacy 分支和回滚里，两者都要删 |
| `/tasks stats` | `task-commands.ts:424-485` | — | 见 §2.4 |

⚠️ `priority` 和 `/tasks stats` 是**用户可见**的删除（`/tasks set <id> priority`、`/tasks stats`）。这两项需要你点头，其余都是内部结构。

### 3.2 收（两个权威 → 一个权威）

**`verification` 从 7 字段收到 3 字段。**

现状：`{required, status, runId, evidence, bodyHash, checkedAt, subjectHash}` 全部是 `.verifications/<hash>.json` 的镜像，而代码自己已经承认镜像不可信——`lifecycle.ts:122` 的注释写得很清楚："The mirrored control field is writable task metadata, so it must not decide whether freshness is checked."。于是 `complete` 同时读镜像和 attestation，再互相校验（`assertVerificationAttestationMatches` 比对 `attestation.bodyHash === verification.bodyHash`）。**这是典型的判准 2 + 判准 4。**

改成：

```
verification: { required, runId, status }   // status 是纯展示缓存，永不作为门禁
```

`complete` / `verify` / doctor 一律以 attestation 文件为唯一权威：按 `runId` 读盘 → 校验 `taskId` / `verdict` / `bodyHash` 新鲜度 / `subjectHash` 新鲜度。镜像漂移这一整类检查（doctor 里 2 条）随之消失，换成 1 条"attestation 缺失或不匹配"。

顺带把上一份报告 §2.1 的缺口一并补上：**`verificationStrength` 进 `control.verification`**（或干脆只从 attestation 读，连缓存都不留）。这不是加字段，是把一个已经算好、已经落盘、却在半路断掉的事实接通。

### 3.3 删掉一个流程：`request-verification`

这是本方案里最大的单点简化，也是 P0 的真正解法。

现状的验收链路有**两条停泊语义在竞争同一条唤醒通道**：`waitingFor: "verification"`（request-verification 写的）和 `waitingFor: "external-signal"`（委派 wake 唯一认的）。上一份报告 §1.1 已实测证明这条链路在异步验收下必然死锁，而且两个方向都堵死。

与其修，不如问：**`request-verification` 到底提供了什么？**

1. 校验 DoD checklist 全部勾选 → 可以移到 `verify` / `complete`；
2. 把任务停泊成 `waiting + waitingFor: verification` → **正是死锁的来源**；
3. 通过 `dispatchVerification` 回调入队一个 TASK_VERIFY 回合，让模型在那个回合里派验收 subagent → 但模型完全可以在**当前**回合直接派，然后按普通委派停泊。

第 3 点的唯一额外价值是"即使当前回合崩溃，验收也已经被持久排队"。但如果不做 request-verification，任务保持 `active`，driver 会重新唤醒它——等价的可靠性，零额外机制。

**建议删除**：`task_manage request-verification` action、`createTaskVerificationEvent`、`TASK_VERIFY` 事件类型、`requestVerificationTask`（含它那段"派发失败要原子回滚任务文件"的补丁逻辑，`verification.ts:44-64`）、`dispatchVerification` 回调（**穿透 5 个文件 12 处**：`channel-runner` → `runner-factory` → `tools/index` → `tools/registry` → `task-manage/types` → `task-manage/verification`）、`waitingFor` 枚举里的 `"verification"` 值、以及 `transitions.ts` 的对应表项。

**新流程**（回合数不变，机制少一层）：

```
1. 模型完成 DoD → subagent purpose=verify + taskId  → 按普通委派停泊
2. 验收 run 结束 → 完成 wake 唤醒本频道（与所有委派同一条通道）
3. 模型 task_manage verify <runId> → 读 attestation → 写 verdict → active
4. complete 时再次以 attestation 为准复核
```

`verify` 的前置条件从"任务必须 `waitingFor === "verification"`"（`verification.ts:84`，正是死锁的另一半）改成"attestation 的 `taskId` 必须等于本任务"——**这个绑定本来就更强**：它来自 runtime 写的 attestation 文件和 run 记录，而不是模型写在 frontmatter 里的一个字符串。

### 3.4 `waitingFor` 去授权化（承接上一份报告 §4.1）

删掉 `"verification"` 之后，`waitingFor` 还剩 `time | user | job | external-signal`。继续按上一份报告的建议把它的**授权身份**摘掉：唤醒决策改为"**这个已 settle 的 run/job 的 `taskId` 指向本任务**"，而不是"任务文件里那个字符串恰好等于 `external-signal`"。

于是 `activateWaitingTask(channelDir, id)` 不再需要 `expectedWaitingFor` 参数，`waitingFor` 退回纯展示/诊断——与它自己的类型注释（`schema.ts:111`："Diagnostic recovery source; it does not create a new lifecycle status"）和 `docs/events-and-tasks.md:413` 的说法终于一致。

doctor 里围绕 `waitingFor` × `wake` 组合的 **3 条规则**（`task-commands.ts:664,672,694`）合并成 1 条：**停泊了、但 runtime 侧没有任何在跑的 run/job 指向它**——这同时补上了上一份报告 §3.2 指出的看门狗缺失，而且比现在的 `hasDurableWaitingSource` 严格（现在它把 `waitingFor: verification` 无条件当作有效恢复源，`task-commands.ts:757`）。

### 3.5 兼容包袱一次性了结（承接 §4.4）

现有兼容层：

- `RETIRED_TASK_CONTROL_KEYS`（13 项）+ `retiredTaskControlKeys` + `describeDroppedTaskRelations` + doctor 里对应的 1 条规则
- `normalizeStoredStatus` 的 legacy 映射（9 个分支）+ `wasLegacyEscalated`
- `parseTaskControl` 的 v1 分支、`pausedBy` → `stop` 转换、`parseVerificationRequired` 的 `mode === "independent"`、`normalizeLegacyOutcome`
- `TaskFrontmatter.rawStatus` / `rawControl` 两个只为 doctor 存在的字段，以及 `ledger.ts:417-437` 的读时状态规范化
- `task-migration.ts`（149 行）

**关键事实**：迁移已经是 marker 门控的一次性动作（`bootstrap.ts:1051` 的 `state/task-migration.done`）。也就是说，**任何跑过一次迁移的安装上，上面这一整套读时兼容都已经是冗余的**——它只为"手工改回旧格式的文件"和"marker 置位后拷进来的旧 workspace"服务，而代价是永久的。

**建议**：

1. `control.version` 升到 **3**，同一次改动里落地 §3.1–§3.4 的字段变更；
2. 迁移改成**版本门控而非 marker 门控**：扫到 `control.version < 3` 就迁移，无论 marker 是否置位。这比现在严格更好——自愈、幂等、对"事后拷进来的旧 workspace"同样有效，并且让 marker 文件本身可以删掉；
3. 迁移落地后，**删除全部读时兼容**。旧格式在读取时直接 `readable: false` fail-open（这条机制已经存在），由 doctor 引导用户跑 `/tasks doctor`；
4. 一个发布周期后删除 `task-migration.ts` 的 v1→v2 部分，只保留 v2→v3。

---

## 4. 砍完之后的 control 块

```jsonc
// 现状：37 个叶子字段
{ version, priority, deadline, nextAction, blockedReason, waitingFor,
  budget: { maxAttempts },
  usage: { attempts, tokens, costUsd, costKnown, wallTimeMinutes },
  verification: { required, status, runId, evidence, bodyHash, checkedAt, subjectHash },
  attemptGeneration, lastOutcome, lastStartedAt, lastFinishedAt, cycleId,
  stop: { by, reason, at },
  provenance: { createdBy, createdAt, sourceMessageId },
  wakeHandoff: { kind, resourceId, dispatchId, generation,
                 previousLastOutcome, previousBlockedReason, previousLastStartedAt } }

// v3：11 个叶子字段
{ version: 3,
  deadline,                                  // 用户意图，硬期限
  nextAction,                                // 下一步；停泊时说明等什么
  waitingFor,                                // 纯展示：time | user | job | external-signal
  verification: { required, runId, status }, // status 是展示缓存，永不作门禁
  cycleId,
  stop: { by, reason, at } }
```

对应地，frontmatter 去掉 `recurrence`，`TaskFrontmatter` 去掉 `rawStatus` / `rawControl`。

**规模估算**（保守）：

| 位置 | 现状 | 减少 |
|---|---|---|
| `src/tasks/store.ts` | 403 | ~230 |
| `src/tasks/control.ts` | 400 | ~180 |
| `src/runtime/task-commands.ts` | 903 | ~85 |
| `src/tasks/ledger.ts` | 1226 | ~50 |
| `src/tools/task-manage/verification.ts` | 178 | ~60 |
| `src/tasks/transitions.ts` | 106 | ~25 |
| 跨层管线（bootstrap / channel-event / task-wake / task-driver / registry / runner-factory） | — | ~70 |
| **合计** | **5373** | **~700（13%）** |

外加对应的测试删除（`task-control.test.ts`、`durable-dispatch.test.ts`、`bootstrap-structured-wake.test.ts`、`task-driver.test.ts` 中围绕 generation/handoff/usage 的部分）。

**但真正的收益不是行数，是概念数**：模型要理解的 control 字段从 37 降到 11；doctor 从 28 条规则降到约 19 条；停泊语义从 5 种降到 4 种且不再有授权含义；"attempt 是什么、什么时候退款、generation 守卫在防什么"这一整套只有读过 spec 029/031/038 才能推理的知识，直接从系统里消失。

---

## 5. 与上一份报告的关系

减法**不是**在修 bug 之外的另一件事——三个 P0/P1 里有两个被减法直接溶解：

| 上一份报告 | 本方案 |
|---|---|
| §1.1 verify wake 卡死（P0） | **溶解**：`request-verification` 与 `waitingFor: verification` 一并删除（§3.3），死锁的两半都不存在了 |
| §1.2 wake 静默丢弃（P0） | **溶解**：激活不再 claim attempt，"激活失败"退化为无害的 no-op，bootstrap 不再需要 `!claimed.activated → return` 这条分支 |
| §2.1 `verificationStrength` 断链（P1） | 在 §3.2 收敛 verification 权威时顺手接通 |
| §3.2 停泊任务无看门狗 | 在 §3.4 合并 doctor 规则时补上，且比现在严格 |
| §4.3 attempt 预算与委派节奏冲突 | **溶解**：预算不存在了 |

上一份报告里**不被减法覆盖、必须单独修**的是安全类的三项：§2.2（verify 保留 `bash` + 非 git 目录 fail-open）、§2.3（符号链接绕过项目边界）、§2.5/§2.4（不可信输出围栏 / 环境变量）。这些属于委派链路，不属于 tasks 机制。

---

## 6. 分阶段落地

每一阶段结束时系统都是自洽可发布的。

**阶段 1 — 纯删除，无行为变化**（最低风险，先做）
- `provenance`（死代码）
- `recurrence`
- `/tasks stats` + `usage.tokens/costUsd/costKnown/wallTimeMinutes`（先给 `UsageLedger` 加 `taskId`，再删命令）

**阶段 2 — 预算连锁**（收益最大的一步）
- 删 `budget` / `usage.attempts` / `lastOutcome` / `lastStartedAt` / `lastFinishedAt` / `blockedReason`
- 连锁删除 `finishTaskAttempt` / `claimTaskAttempt` / `releaseTaskAttemptClaim` / `attemptGeneration` / `wakeHandoff` / 回滚机制 / `taskAttemptGeneration`
- driver 内存态失控兜底常量
- **必须先补的测试**：一个长程委派任务在没有 attempt 预算时，仍然会被 futile-wake 治理器在 3 次无 effect 唤醒后停下

**阶段 3 — 验收链路**
- 删 `request-verification` / TASK_VERIFY / `dispatchVerification`
- `verify` 的绑定改为 attestation `taskId`
- verification 收到 3 字段，attestation 成为唯一权威，接通 `verificationStrength`
- **必须先补的测试**（上一份报告 §1 就欠着）：外部 `purpose=verify` run → 完成 wake 唤醒 → `task_manage verify` → `complete` 全链路

**阶段 4 — `waitingFor` 去授权化 + doctor 合并**
- 唤醒授权改用 run/job 记录的 `taskId`
- 3 条 waitingFor 规则合并为 1 条停泊看门狗

**阶段 5 — 兼容清算**
- `version: 3` + 版本门控迁移
- 删除全部读时兼容 + `priority`
- 一个发布周期后删 `task-migration.ts` 的 v1→v2 部分

**阶段 6 — playbook 与文档**
- `task-planning.md`：删掉 `maxAttempts` / `priority` 段落；`waitingFor` 改述为"记录用，不影响恢复"；`blockedReason` 合并进 `nextAction`
- `task-driving.md`：验收一节按新流程重写（无 request-verification）；`waitingFor` 两形态一节简化
- `agent-delegation.md`：§4.2 的"置 `waiting` + `waitingFor=external-signal`"改成"停泊即可，runtime 按 run 记录认领"，与 `task-driving.md` 的冲突随之消失
- `docs/events-and-tasks.md`：frontmatter 契约、状态机表、验收流程三节重写

---

## 7. 我不建议砍的东西

诚实的反面清单，避免减法过头。

- **`status` 三态（active / waiting / sleeping）**。看上去 `waiting` 可以用"active + 未到的 wake"表达、`sleeping` 可以用"recurring + 已闭环"表达，但这三者对应三种真实不同的 driver 行为（派发 / 不轮询 / 等 cron），转换表也只有十几行。合并只会把判断从表里挪进散落的条件式。**留。**
- **`## Plan` 段落**（spec 037）。它带来解析器、patch 应用、capsule 字段、agenda 字段、2 条 doctor 漂移检查、2 个 schema 字段。"手段 vs 目的"的区分是真实的，但**是否值这个代价是个可测量的问题，不是可争论的问题**：抽样 20 个真实任务，如果 Plan 步骤与 DoD 条目大体 1:1，就说明 Plan 只是 DoD 的复述，应当删除并让 DoD 承担；如果 Plan 明显更细、更常变动，就留。**先测量，别拍脑袋。**
- **`set` 与 `progress` 两个 action 的重叠**。`progress` 强制要 `note`，`set` 不要——修元数据不应该被迫编一条进展记录。**留。**
- **`escalateTask` + 治理器回执 + `/tasks resume`**。这是唯一的人工恢复路径，且是确定性零 token 的。**留。**
- **`MAX_INLINE_TASK_HISTORY_*` 截断、`readActiveTasks` 缓存、`mutation-lock`**。都是在为有界上下文和正确性付费，不是为概念复杂度付费。**留。**
- **`deadline`**。它长得像预算，但它是用户意图的直接表达，模型不需要估计任何东西。**留，而且砍掉 `maxAttempts` 之后它更重要。**

---

## 8. 一句话总结

这次减法的主张不是"tasks 机制太复杂"，而是**"tasks 机制里最复杂的那部分，服务的是一个模型本来就估不准的数字"**。把那个数字拿掉，围绕它建起来的 claim / generation / handoff / rollback / 退款 / 巡检会自己塌掉；而止损能力不降反升，因为剩下的两条（deadline 与证据驱动的 futile-wake）本来就是真正在起作用的那两条。
