# Task 自主执行与状态机 v2：删除审批链，收敛为工作、等待、休眠

| 字段 | 值 |
|------|------|
| 状态 | IMPLEMENTED |
| 日期 | 2026-08-04 |
| 前置 | 019 task-ledger、022 native-task-driver、023 governed-task-loops、024 task-loop-v2、027 native-task-recurrence、029 task-lifecycle-simplification、031 wake-layer-hardening、036 task-governance-slimming、037 plan-carrier-and-memory-probation |
| 产品裁决 | Task 表示持续委托；删除所有 task-level external approval，不再要求用户逐动作或逐周期授权 |
| 关联实现 | `src/tasks/*`、`src/tools/task-manage/*`、`src/runtime/task-{driver,commands}.ts`、`src/agent/{commands,effect-ledger}.ts`、`src/memory/task-digest.ts`、`src/playbooks/*` |
| 关联文档 | `docs/events-and-tasks.md`、`docs/runtime-playbooks.md`、`docs/configuration-reference.md`、相关历史 specs 与 `docs/refer/*` 当前性说明 |

## 1. 决策摘要

本 spec 对 Task 做两项相互配套的结构性简化：

1. **完整删除 task approval。** 删除 `sideEffects`、`externalApproval`、`approvalBy`、`approvedAt`、`approvalBodyHash`，删除 `/tasks approve` 命令及 `done` 的审批门禁，不保留命令别名、兼容提示或隐式 `run` 行为。
2. **把活动任务状态收敛为三个阶段。** `status` 只保留 `active | waiting | sleeping`；暂停不再是一种阶段，而是正交的 `enabled: boolean`。一次性任务完成或取消后立即归档，不再以 `done` / `cancelled` 留在活动状态机中；周期任务闭环后进入含义明确的 `sleeping`。

独立验收继续保留，但 `verifying` 不再是一种 Task 生命周期状态。Verification 是质量事实，Task status 是调度事实；两者必须正交。

新的产品语义是：

> 用户创建 Task，表示授权 Pipiclaw 在任务目标、可用工具、凭据权限与安全配置允许的范围内持续自主执行，直到任务完成、取消或被暂停。Task 不再重复询问是否允许执行外部动作。

因此 Task 只回答四个问题：

- 现在是否有工作可做；
- 如果没有，在等什么、何时再看；
- 周期任务何时开启下一轮；
- 自动执行是否被停止。

它不再承担通用审批系统、权限系统或项目管理系统的职责。

## 2. 背景：为什么不是继续修 approval

### 2.1 Approval 不是实际动作边界

当前 `externalApproval` 主要在 `task_manage done` 时检查。它可以阻止任务被标记完成，却不能从工具执行层阻止 Agent 更早地调用 bash、git、发送、发布或部署能力。实际外部动作如果已经发生，`done` 再拒绝只是制造一个无法闭环的台账，并没有撤销动作。

同时，Agent 虽然不能把 `externalApproval` 直接写成 `granted`，却能通过 `task_manage` 将其显式改为 `not-required`。这说明 approval 的真实定位一直是防误操作提示，而不是不可绕过的 authority boundary。继续加 hash、cycle、refresh、resume 和 dispatch 规则，会提高状态机复杂度，却仍不能把它变成真正的工具权限边界。

**裁决：不再维护这层不完整的安全感。** 外部能力是否可用由工具注册、凭据范围、`security.json`、command/path/network guard 和外部平台权限决定；Task 只负责驱动与恢复。

### 2.2 Approval 与周期自动化目标冲突

周期任务的价值是无人值守地重复完成一类工作。逐周期 `/tasks approve` 把每周一次的自动流程重新变成每周一次的人工仪式；如果改成长期豁免，又会引入 standing approval、scope、revocation、继承和审计等另一套权限系统。

新语义直接以任务目标区分流程：

- “每周生成并发布周报”意味着自动发布；
- “每周生成草稿并等待我反馈”意味着生成后进入 `waiting`；
- 是否允许访问仓库、群聊或部署环境，由 Task 之外的长期能力配置决定。

无需再用一个通用 approval 字段表达本来就应写进 Goal / DoD / Manual 的工作流差异。

### 2.3 Approval 已经污染等待、治理和周期状态

当前流程为了同时保留 independent PASS 和等待用户审批，要求任务停留在 `verifying` 并设置未来 `wake`。`wake` 到期后如果用户仍未审批，driver 会重复唤醒 LLM；连续三次无进展后治理器将一个正常等待人的任务误判为停滞并暂停。

更严重的是：

- `/tasks approve` 只写 control，不完成、不恢复、不派发；
- driver fingerprint 不把 approval 视为进展；
- `approve` 看到旧 `granted` 会直接返回旧记录，即使 hash 已经过期；
- 第一个周期由 `active + wake` 启动，不经过后续周期的 control reset，旧授权可能进入首轮执行。

这些不是某一处分支的 bug，而是一个事实被错误拆成“状态、授权、等待和唤醒”四套机制后的系统性结果。删除 approval 并重新画状态边界，比修补所有交叉分支更可靠。

### 2.4 六个状态混合了三种不同维度

当前六态实际混合了：

| 维度 | 当前表达 |
|---|---|
| 是否能推进 | `active` / `waiting` |
| 是否在做质量检查 | `verifying` |
| 是否允许自动运行 | `paused` |
| 是否已离开活动台账 | `done` / `cancelled` |

Verification 是质量维度，pause 是启停维度，archive 是存储位置；它们都不该与“当前工作阶段”竞争同一个 `status` 枚举。

## 3. 目标与非目标

### 3.1 目标

1. 删除 task approval 的全部持久化、命令、工具、门禁、提示词和文档表面。
2. 活动任务只保留 `active | waiting | sleeping` 三个可互斥阶段，每个阶段对应唯一 driver 行为。
3. 用 `enabled` 表达用户暂停与 governor stop，暂停前的阶段、wake 和 schedule 不丢失。
4. 第一次和后续周期 occurrence 使用完全相同的 runtime 开周期路径。
5. Waiting 是事件驱动的等待，不用 LLM 轮询模拟用户或后台信号。
6. 保留 durable independent verification，但使其与 Task 调度状态正交。
7. 一次性完成/取消立即归档；周期完成/跳过进入 `sleeping`。
8. 把外部动作的风险控制迁移到能力边界、幂等执行、止损和审计，而不是另造审批替代品。
9. 对 v1 存量任务提供确定性、保守、可审计的数据迁移，但不保留 `/tasks approve` 命令兼容。

### 3.2 非目标

- 不实现 standing approval、approval scope、审批人角色或审批撤销；approval 整个概念退出 Tasks。
- 不承诺抵御 hostile agent。Task Markdown 仍可由 Agent 编辑；真正安全边界属于工具与执行环境。
- 不在本 spec 内设计通用 RBAC、群成员权限或 DingTalk 审批流。
- 不移除 independent verification、attestation、contract hash 或 Git artifact subject 校验。
- 不删除 attempt budget、deadline、effect ledger、durable dispatch 或 governor。
- 不把 Tasks 扩展成 DAG、父子任务图或项目管理系统。
- 不合并 Events 与 Tasks；event 仍是无状态时间/传感器原语，task 仍是有状态工作循环。
- 不改变 at-least-once 投递语义；外部动作必须通过幂等检查适应重放。

## 4. D0：新的责任边界

### 4.1 Task creation 就是持续委托

一旦 Task 被创建，driver 可以在其 Goal / DoD / Manual 描述的范围内自主调用已经暴露给 Agent 的工具。周期 Task 的后续 occurrence 继承同一委托，不要求额外确认。

Task 创建信息应保留来源审计：

```ts
interface TaskProvenance {
	createdBy?: string;
	createdAt?: string;
	sourceMessageId?: string;
}
```

该信息回答“谁在何时委托了这项长期自动化”，不构成运行时审批门。若当前 transport 无稳定 `sourceMessageId`，字段可缺省；不得为填字段伪造值。

### 4.2 用户反馈是任务流程，不是授权

需要人类审阅时，Goal / DoD / Manual 必须明确写成“准备草稿并等待反馈”。Agent 在到达该步骤后把任务置为 `waiting`，用户普通回复就是外部信号。系统不提供特殊 approve 命令。

### 4.3 能力策略不进入 Task 状态

以下边界继续存在，但不写进 Task：

- 工具是否注册、是否启用；
- command/path/network guard；
- workspace 写入范围；
- Git、DingTalk、部署平台和其他连接器的凭据与权限范围；
- 外部系统自身的 allowlist、幂等 key、环境保护和审计。

不得以 `risk: high`、`requiresApproval: false`、`autonomy: standing` 等新字段把 approval 换一个名字放回 Task。

## 5. D1：活动状态机收敛为三态

### 5.1 Canonical status

活动目录 `tasks/*.md` 中只允许：

```ts
export type TaskStatus = "active" | "waiting" | "sleeping";
```

调度语义：

| status | 含义 | driver 行为 |
|---|---|---|
| `active` | 当前有具体工作可推进 | 在 `enabled` 且通过 budget/deadline/退避门禁时派发 |
| `waiting` | 当前在等外部条件 | 不自行推进；有 wake 则到点转 active，无 wake 则等外部信号 |
| `sleeping` | 周期 occurrence 已闭环，等待下一轮 | 仅允许 recurring task；wake 到点由 runtime 开新周期并转 active |

一次性任务不使用 `sleeping`。完成或取消后立即移入 `tasks/archive/`，活动扫描不再看到它。

### 5.2 Archive outcome 不是活动状态

归档文件记录：

```ts
export type TaskArchiveOutcome = "completed" | "cancelled";
```

推荐归档 frontmatter：

```yaml
---
outcome: completed
closedAt: 2026-08-04T18:00:00+08:00
---
```

归档文件不再需要一个可被 driver 解释的 `status`。`/tasks show` 和 `/tasks archive` 根据文件所在目录及 `outcome` 展示结果。

### 5.3 状态不变量

合法组合必须在统一写路径中构造出来：

| status | `wake` | `schedule` | 约束 |
|---|---|---|---|
| active | 无 | 可有 | 现在可推进；未来时间不能藏在 active 中 |
| waiting | 无或合法时间 | 可有 | 无 wake＝信号等待；有 wake＝定时等待 |
| sleeping | 合法未来时间 | 必有合法 cron | wake 必须是 schedule 的下一 occurrence |

写入规则：

- 将 active 设置为未来 wake，自动规范为 waiting；
- waiting 的 wake 到期时，runtime 先原子写 `active + clear wake`，再 dispatch；
- sleeping 的 wake 到期时，runtime 先打开新 cycle、重置周期数据、写 active，再 dispatch；
- sleeping 缺失或损坏 wake 时，runtime 用 schedule 零 token 自愈；
- sleeping 缺失/损坏 schedule 是结构错误，不得猜测成 active；由 doctor 报告并停止自动运行；
- unreadable frontmatter 延续既有 fail-open 修复原则，但必须进入明确的 repair wake，不得把损坏文件当作一个正常 occurrence 执行外部动作。

## 6. D2：暂停改为正交的 enabled

Frontmatter 新增：

```yaml
enabled: true
```

缺省按 `true` 读取，以兼容手写文件和 v1 任务。暂停只做：

```text
enabled: true → false
```

不得改 status、不得清 wake、不得重算 schedule。恢复只把 enabled 改回 true。

这使以下场景都能保持原意：

```yaml
# 暂停一个正在工作的任务
status: active
enabled: false

# 暂停一个等用户回复的任务
status: waiting
enabled: false

# 暂停一个睡到下周的周期任务
status: sleeping
enabled: false
schedule: 0 9 * * 1
wake: 2026-08-10T09:00:00+08:00
```

Control 中用结构化 stop 信息替代 `pausedBy`：

```ts
interface TaskStop {
	by: "user" | "governor";
	reason: string;
	at: string;
}
```

- `enabled: true` 时不得保留 `stop`；
- `/tasks pause` 写 `by: user`；
- governor 写 `by: governor` 和确定性原因；
- `/tasks resume` 清 stop，但保留 status/wake/schedule；
- `/tasks run` 是有意的强制推进：启用任务、转换 active、清 waiting wake；对 sleeping task 则显式提前打开一个新周期。

## 7. D3：周期任务以 sleeping 表达闭环

### 7.1 创建

创建带 `schedule` 的 Task 时：

```yaml
status: sleeping
enabled: true
schedule: 0 9 * * 1
wake: <next occurrence>
```

创建不等于开始第一个 cycle。`control.cycleId` 保持空；Current Cycle 可以保留标准占位内容，但第一次开周期时不得把占位内容写成一条虚假的 closed history。

### 7.2 开周期

每一次 occurrence，包括第一次，都走同一个 runtime 操作：

1. 校验 `sleeping + enabled + schedule + due wake`；
2. 生成以 occurrence 为来源的稳定 cycle id；
3. 第一次运行：初始化 Current Cycle，不归档创建占位；
4. 后续运行：将上一 closed cycle 的可见记录折进 History；
5. 重置本周期 usage、verification、DoD/Verification checkbox 和 Plan 的周期状态；
6. 清 wake、写 status active；
7. claim attempt 并派发普通 `[TASK_DRIVER]` 回合。

cycle id 应优先绑定 schedule occurrence，而不是 runtime 实际恢复日期。daemon 周一停机、周二补跑时，cycle 仍代表周一的 occurrence；显示中可以另记 `openedAt`。这使 at-least-once dedupe、历史标题和错过周期诊断使用同一业务身份。

### 7.3 完成与跳过

`complete` 对 recurring task：

- 写入 summary/evidence；
- 标记本 cycle closed；
- status 置 sleeping；
- 用统一时间规则写下一 occurrence wake；
- 清理 task-owned 临时 events；
- 文件留在 active tasks 目录。

`skip`：

- 记录 reason；
- 不伪造 DoD 完成或 completion evidence；
- 关闭当前 occurrence；
- 进入 sleeping 并计算下一 wake。

不再使用 `done + schedule` 表达睡眠。

### 7.4 过期未完成

如果下一个 cron occurrence 到来时当前任务仍是 active 或 waiting，旧 cycle 优先：不并发开启新 cycle、不自动覆盖 Current Cycle。driver/doctor 报告 missed occurrence；Agent 必须完成、skip 或 cancel 当前 cycle 后，统一时间规则才计算未来下一次 occurrence。

## 8. D4：Waiting 只由真实信号恢复

### 8.1 两种 waiting

```text
waiting + wake     = 定时等待
waiting + no wake  = 信号等待
```

建议在 control 中增加仅用于诊断的：

```ts
type TaskWaitingFor = "time" | "user" | "job" | "verification" | "external-signal";
```

规则：

- 有 wake 时 `waitingFor` 必须为 `time` 或 `external-signal`；
- 无 wake 时不得为 `time`；
- `blockedReason` 继续保存人类可读的具体对象和条件；
- `waitingFor` 只帮助 runtime/doctor 找到恢复源，不构成新的生命周期状态。

### 8.2 恢复源

- wake 到点：runtime 转 active 并 dispatch；
- background job 完成：job manager 针对 taskId 转 active 并 dispatch；
- verification 完成：verification handler 写 verdict、转 active 并 dispatch；
- `/tasks run`：显式强制 active 并 dispatch；
- 用户普通消息：消息本身进入 Agent 回合；若与任务相关，Agent 用 progress 将对应 waiting task 恢复为 active。普通闲聊不得批量点燃本频道全部 waiting tasks。

driver 不得周期性唤醒 `waiting + no wake` 去“看看用户是否回复”。需要轮询的外部条件应使用合理 wake，或优先使用 periodic event + preAction 作为零 token sensor。

## 9. D5：Verification 保留，但退出状态机

### 9.1 持久化事实不变

保留：

- `verification.required`；
- pending / passed / failed；
- verifier runId；
- contract body hash；
- checkedAt / evidence；
- Git artifact subject hash；
- 磁盘 attestation 的防伪重校验。

删除的是 `status: verifying`，不是验收能力。

### 9.2 新流程

`candidate` 重命名为更准确的 `request-verification`（tool action 可采用 schema 友好的 `request-verification` 或 `request_verification`，实施时统一一种，不保留双拼法）：

1. 从 active 调用；
2. 检查 DoD/Verification checklist；
3. 写 `verification.status = pending`；
4. 将任务置 `waiting`、`waitingFor = verification`、无 wake；
5. 直接创建 durable checker dispatch，不依赖普通 TaskDriver 扫描碰巧挑中；
6. verifier attestation 被导入后写 passed/failed；
7. runtime 将任务恢复 active 并排入一次普通 task wake；
8. PASS 后 `complete` 重新校验 attestation、contract hash 与 artifact subject。

如果 verifier dispatch 无法入队，操作必须回滚 waiting，或留下可由 doctor 重派的 durable record；不得制造无人会唤醒的 parked task。

### 9.3 验收默认值

删除 `sideEffects` 后，不再存在“external 自动开启 verification”的隐式规则。Verification 默认 `required: false`，由任务性质显式选择：代码、配置、可重复检查的产物可开启；纯提醒、沟通、主观写作不应默认支付 checker 成本。

## 10. D6：删除 Approval 的完整表面

### 10.1 持久化与类型

从 `TaskControl`、patch、parser、renderer 和 cycle reset 删除：

```text
sideEffects
externalApproval
approvalBy
approvedAt
approvalBodyHash
```

删除：

- `TaskSideEffects`；
- `invalidateTaskApproval`；
- approval contract hash 判定；
- external → verification required 的派生；
- cycle reset 中的 grant → required 逻辑；
- doctor 的 missing/stale approval 检查；
- task list/digest/stats 的 effects/approval 展示。

`taskBodyHash` 和 `taskContractSegment` 继续存在，唯一消费者改为 independent verification。所有注释必须删除“同时绑定 approval”的陈旧表述。

### 10.2 Agent 工具

从 `task_manage` schema 删除：

```text
control.sideEffects
control.externalApproval
```

从 `done` 删除所有外部授权门禁。`done` / `complete` 只检查：

- acceptance checklist；
- required verification 与 attestation；
- artifact/contract 新鲜度；
- summary/evidence；
- 状态与周期不变量。

### 10.3 `/tasks` 命令

完整删除：

```text
/tasks approve <id>
```

要求：

- parser 不再识别 `approve`；
- help、busy command list、examples 和 command metadata 不再展示；
- handler 和 `approver` 参数删除；
- 发送旧命令时按普通未知 `/tasks` action 返回当前 usage；
- 不保留 deprecation reply；
- 不别名到 `/tasks run`、`resume` 或其他动作；
- 不读取或刷新旧 approval 数据。

数据迁移兼容不等于命令兼容：v1 文件可以被 reader 识别并升级，但用户操作面从发布该版本起只有新语义。

## 11. D7：TaskControl v2

本次同时改变持久化字段和状态语义，应将 control version 提升到 2，而不是继续靠忽略键堆叠隐式迁移。

建议结构：

```ts
interface TaskControlV2 {
	version: 2;
	priority: "low" | "normal" | "high" | "critical";
	deadline?: string;
	nextAction?: string;
	blockedReason?: string;
	waitingFor?: "time" | "user" | "job" | "verification" | "external-signal";
	budget: { maxAttempts: number };
	usage: TaskUsage;
	verification: TaskVerification;
	attemptGeneration: number;
	lastOutcome: TaskOutcome;
	lastStartedAt?: string;
	lastFinishedAt?: string;
	cycleId?: string;
	stop?: TaskStop;
	provenance?: TaskProvenance;
}
```

本 spec 不强行把 usage/telemetry 拆到第二个文件。单文件仍是 Task 的恢复真相，避免引入 Markdown 与 sidecar JSON 双写漂移。以后如要把 telemetry 移出，可独立立项并以消费面证明收益。

`lastOutcome` 明确仍是 runtime telemetry，不参与 status 转移。它不能重新长成第二台状态机。

## 12. D8：统一转移与动作

### 12.1 生命周期矩阵

| 动作 | from | to / 结果 |
|---|---|---|
| create one-shot | none | active |
| create recurring | none | sleeping + next wake |
| progress | active / waiting | active 或 waiting |
| request-verification | active | waiting（verification signal） |
| verification-result | waiting（verification） | active |
| complete one-shot | active | archive/completed |
| complete recurring | active | sleeping + next wake |
| skip | active / waiting，recurring only | sleeping + next wake |
| cancel | active / waiting / sleeping | archive/cancelled |
| pause | any live status, enabled | status 不变，enabled=false |
| resume | any live status, disabled | status 不变，enabled=true |
| run | active / waiting | active + immediate dispatch |
| run | sleeping | 提前开新 cycle → active + dispatch |
| wait-due | waiting | active + dispatch |
| cycle-due | sleeping | open cycle → active + dispatch |
| governor-stop | active（或 deadline 违规的 current waiting） | status 不变，enabled=false |

`complete` 原则上只从 active 发生。一个 waiting task 如果已经满足完成条件，应先由真实恢复信号转 active，再完成；这让 waiting 的含义保持“现在不能行动”，避免从停泊态偷偷闭环。

### 12.2 工具 action 面

建议最终保留：

```text
create
progress
set              # repair/admin，不作为正常 checkpoint 替代品
request-verification
verify            # 导入 durable attestation
complete
skip
cancel
list
```

可以在实现时将旧 `done` 重命名为 `complete`。若选择重命名，内部与 schema 一次切换，不长期保留两套 action；这是 Agent 工具而非用户手输命令，随 runtime prompt/playbook 同版本发布即可。

## 13. D9：Driver 与 governor

### 13.1 Actionable 判定

```text
enabled=false                    → never dispatch
status=active                    → backoff/governance 后可 dispatch
status=waiting + future wake     → sleep until wake
status=waiting + no wake         → parked, never driver-poll
status=waiting + due wake        → runtime 转 active，再 dispatch
status=sleeping + future wake    → sleep until next occurrence
status=sleeping + due wake       → runtime open cycle，再 dispatch
```

Driver event capsule不再包含 approval，也不再产生 checker-only `verifying` 分支。Verification checker 使用专属 durable dispatch；普通 driver 只面对 active task。

### 13.2 Futile governor

连续无进展计数只适用于实际派发过的 active attempts：

- waiting/sleeping 不被派发，因此不会积累 futile；
- task status、enabled、cycle、verification verdict、wake 和真实 effect 变化都应正确打断旧 attempt 的无进展链；
- 单纯 progress note / Plan checkbox 仍不能伪造成 effect；
- 达到限制后写 `enabled=false + stop(by=governor)`，status 保持 active；
- resume 保留 status，run 可强制清等待并推进。

### 13.3 升级通知确定化

当前 governor 通过一个额外 LLM escalation turn 生成用户说明，模型可能把 grant、resume、complete 的关系解释错。新实现应让 runtime 根据结构化 reason 渲染确定性通知，至少覆盖：

- attempt budget exhausted；
- deadline exceeded；
- N consecutive active attempts with no effect；
- invalid sleeping schedule/wake。

通知必须给出真实可执行的恢复动作，不让 LLM 推断状态机。例如：

```text
任务 weekly-report 已停止自动执行：连续 3 次 active 唤醒无可见进展。
当前阶段：active；周期：cycle-2026-08-03。
继续：/tasks resume weekly-report
立即执行：/tasks run weekly-report
不再需要：让 Agent cancel 该任务。
```

这不是新的聊天能力，而是把 deterministic governor 的结果保持 deterministic。

## 14. D10：外部动作的替代保障

删除 approval 会明确增加“任务无需最后一次人工确认即可对外执行”的能力。这是产品裁决，不应在风险章节里含糊处理。相应保障必须放在能真正生效的位置。

### 14.1 幂等是第一要求

TaskDriver 与 durable dispatch 是 at-least-once。每一个可重放外部动作必须按以下形状实现：

```text
读取外部真实状态
→ 计算稳定 operation/dedupe id
→ 已完成则不重复
→ 未完成才执行
→ 再读真实状态验证
→ checkpoint operation id 与结果
```

典型要求：

- Git push 前检查目标 commit/ref；
- 发消息使用业务 dedupe key，或在 task cycle 记录平台 message id；
- 发布/部署使用 version/release id；
- 修改外部记录前比较期望版本或 ETag；
- crash 发生在“动作成功、checkpoint 之前”时，重放必须通过外部查询发现已完成。

Playbook 必须把幂等检查从建议提升为所有 task-driven external action 的硬纪律。

### 14.2 能力最小化

- 凭据只授予 Task 实际需要的仓库、群、环境和 API scope；
- connector/tool 配置承担长期 allowlist；
- command guard 继续拒绝危险命令；
- path/network guard 的覆盖范围必须如实记录，尤其不得宣称它们自动约束任意 bash 子进程；
- 不需要的发送、部署、网络或 shell 工具不要注册给 Agent。

### 14.3 止损与审计

保留 per-task `maxAttempts` 和 deadline；继续推进全局 token/cost cap。外部动作成功后必须把稳定结果标识写进 Current Cycle / completion evidence，并进入 channel log/context 的正常审计链。

建议新增 `/tasks pause-all` 属后续小型增强：它是无人值守系统的 kill switch，不阻塞本 spec 主体落地。

## 15. 存量迁移

### 15.1 迁移原则

- v1 reader 继续可读；任何成功写入都输出 v2；
- 迁移走既有 per-task mutation lock 和原子写；
- 不运行外部动作、不自动完成任务；
- 不保留 approval 命令兼容；
- 迁移必须幂等，可在启动扫描与显式 migration 中重复调用；
- 无法安全推断时保守停留并给出 next step，不猜用户意图。

### 15.2 状态映射

| v1 | v2 |
|---|---|
| active | status active, enabled true |
| waiting | status waiting, enabled true；保留合法 wake |
| verifying + PASS | status active, enabled true；保留 verification |
| verifying + pending/failed | status active, enabled true；下一回合按 verification 数据恢复/重试 |
| paused | status active, enabled false，stop 从 pausedBy/blockedReason 构造 |
| done + schedule | status sleeping, enabled true，规范化下一 wake |
| done one-shot（活动目录异常残留） | archive/completed |
| cancelled（活动目录异常残留） | archive/cancelled |

旧 paused 已经清除了 pause 前 wake/status，无法可靠恢复原阶段，因此映射为 `active + disabled` 是有意的保守选择；resume 后会重新检查真实产物，不伪造 sleeping/waiting。

### 15.3 Approval 字段

v1 approval/sideEffects 字段在解析时读取但不进入 v2 control；迁移审计可以记录“retired fields removed”，下一次写盘完全删除。

对 v1 `waiting` 任务，不根据自由文本猜它是否只在等待审批，也不自动转 active。迁移在 Current Cycle 追加一次有界说明或在 doctor 中报告：

```text
This v1 task remains waiting after task approval was retired. Review the external condition;
use /tasks run <id> if no real condition remains.
```

这样不会因升级自动重做一个可能已经成功的 push/send/deploy。`verifying + PASS` 可安全映射 active，因为该状态的旧主路径就是验收后等待收尾；Agent 醒来仍必须先检查外部真实状态以保证幂等。

### 15.4 Body 与历史

- 旧 `done` recurring 的 Current Cycle/History 继续由统一 cycle transformation 处理；
- 首次 v2 sleeping task 的占位 Current Cycle 不写入虚假历史；
- approval 人名/时间不再留在 control。已有审计事实仍存在于冷日志和 Git 历史，不为删字段篡改正文；若正文中已有人工审批记录，视为普通历史文本保留。

## 16. 命令与展示面

### 16.1 `/tasks`

保留：

```text
/tasks
/tasks show <id>
/tasks archive
/tasks pause <id>
/tasks resume <id>
/tasks run <id>
/tasks set <id> ...
/tasks stats [id]
/tasks doctor
```

删除 `/tasks approve` 后同步更新：命令 parser、help、busy-mode allowlist、agent command metadata、examples、DingTalk/TUI 帮助和所有测试快照。

### 16.2 展示

`/tasks` 与 `<task_agenda>` 至少展示：

- active / waiting / sleeping；
- disabled 标记与 stop reason；
- waitingFor 与 wake；
- recurring schedule 与 next occurrence；
- current/last cycle id；
- verification required/status；
- attempts/deadline/priority/nextAction。

不再展示 effects/approval。

推荐示例：

```text
- weekly-report — 周报 · sleeping · next 2026-08-10 09:00 · last cycle cycle-2026-08-03
- release-note — 发布说明 · waiting(user) · no wake · 等用户反馈草稿
- fix-ci — 修复 CI · active · verification passed · attempts 4/12
- deploy-staging — 部署 staging · active · disabled(governor: 3 futile attempts)
```

### 16.3 Doctor

删除 approval 检查，新增/调整：

- active 带 future wake；
- waitingFor 与 wake 组合非法；
- waiting 无 wake 且没有已知 job/verifier/user signal 来源；
- sleeping 无 schedule、wake 缺失、wake 不是 schedule occurrence；
- enabled 与 stop 不一致；
- recurring current cycle 越过新 occurrence 未闭环；
- v1 control/retired approval 字段仍在盘；
- required verification 的 attestation/hash/subject 漂移；
- archived outcome 缺失或活动目录存在 archived document。

每条必须携带模型或用户可直接执行的 Next step。

## 17. 文档、Playbook、Prompt 与 Eval 更新

本 spec 的实现不以“代码和测试通过”为完成；所有对外与 runtime 内置知识必须同批更新，避免模型继续执行已经删除的审批仪式。

### 17.1 当前用户文档

必须更新至少：

- `docs/events-and-tasks.md`：心智模型、frontmatter 契约、状态机、周期示例、driver、命令、完整周报流程、异常恢复；
- `docs/runtime-playbooks.md`：目录与触发说明；
- `docs/configuration-reference.md`：Tasks 能力、安全责任边界及任何 approval 文案；
- README / deployment / security 文档中经全文检索命中的 task approval、六态、done recurring 描述；
- 命令帮助、示例配置和架构图。

最终文档必须明确：Task 创建即持续委托、外部动作不再逐次授权、风险由能力配置与幂等约束承担。

### 17.2 Runtime playbooks

必须逐份审查并更新：

- `task-planning.md`：删除 sideEffects/approval；周期任务创建为 sleeping；需要人工反馈写入目标并用 waiting；
- `task-driving.md`：只驱动 active；waiting/sleeping 不轮询；enabled/stop 恢复；
- `task-closeout.md`：删除全部 approval 章节；保留 verification、complete/skip/cancel；重点加入外部动作幂等闭环；文件名可保留，因为 closeout 仍存在；
- `task-delegation.md`：waitingFor=job/signal 以及恢复源；
- `outbound-media.md`：删除“先批后发”，改为 task scope + dedupe/message-id + evidence；
- `background-jobs.md`、`event-scheduling.md`：核对 waiting/sensor 分工；
- 所有含 `task-closeout` 索引、触发词和交叉引用的 playbook metadata。

Playbook 测试应断言：运行时知识中不存在 `/tasks approve`、`externalApproval`、`sideEffects: external`、`status: verifying`、`done + schedule` 等退役口径。

### 17.3 System prompt 与工具描述

更新：

- `src/agent/prompt/sections.ts` 的 task 安全/恢复常驻规则；
- `src/agent/commands.ts` 的 `/tasks` metadata；
- `task_manage` schema description、action 列表与错误 next step；
- task driver capsule 与 escalation 文本；
- task digest 的状态/字段渲染；
- `RecoverableToolError` 示例中任何 approval 指令。

Prompt 不应再泛称“不要绕过 approval gate”；应改为“不要扩大任务范围；所有外部动作先检查真实状态并保持幂等”。

### 17.4 历史 specs 与 refer 文档

历史设计和评审是决策记录，不应重写成仿佛当时从未存在 approval。处理方式：

- 在 023、024、029、036、037 等仍可能被当成当前设计依据的 spec 顶部或相关章节增加“本段已被 038 supersede”的显眼说明；
- 023 的 external approval、029 的六态/approval、036 D0“approval 全部保留”、037 的 approval hash 描述明确指向本 spec；
- `docs/refer/*` 保留原始评审事实，仅在索引或当前结论处标注后续状态，不篡改历史发现；
- 全仓 `rg` 检查退役词，逐条分类为“当前文档必须删除”或“历史文档必须加 superseded 注解”。

### 17.5 Behavior eval

- 删除/替换 `S-approval-*` case 与 grader/gate；
- 新增 task autonomy case：明确要求周期自动发送/发布时不得凭空索要 `/tasks approve`；
- 新增 scope fidelity case：Task 不得借自主执行扩大 Goal 中的目标、渠道或环境；
- 新增 external idempotency replay case：动作成功但 checkpoint 前 crash，恢复后不重复；
- 新增 waiting signal case：等待用户时不轮询、不触发 futile governor；
- 新增 recurring first-cycle case：首轮与续轮使用同一 cycle open 语义。

## 18. 实施拆分

概念上是一次 Task v2 变革，实现上分成可独立审查的两批。两批必须在同一发布系列完成；不长期支持半新半旧产品语义。

### R1：删除 approval

1. control/types/parser/patch/reset 删除 approval + sideEffects；
2. task_manage schema、create、done、doctor、digest 删除消费面；
3. `/tasks approve` parser/handler/help 直接删除；
4. playbook/prompt/current docs 同步删除审批仪式；
5. v1 reader 忽略退役字段，write 输出 control v2；
6. 单测/eval 覆盖“external work 无 approval gate”。

R1 完成后，即使 R2 尚未合并，现有六态也不得再引用 approval。

### R2：状态机 v2

1. 三态 + enabled + archive outcome 类型和统一转移；
2. create recurring → sleeping；
3. waiting due 与 sleeping due 的 runtime 原子转换；
4. verification 专属 dispatch，删除 verifying；
5. pause/resume 保留原阶段；
6. complete/skip/cancel 与 archive 改造；
7. governor 只治理 active attempts，并确定性通知；
8. v1 状态迁移、doctor 与全部可见面；
9. 文档、playbook、历史 superseded 注解和 eval 收尾。

每批非平凡改动至少运行 `npm run typecheck` 与 `npm run test`；最终运行 `npm run check` 和相关 behavior eval。

## 19. 测试矩阵

### 19.1 Approval 删除

1. 新建任务的 v2 control 不含五个 approval/sideEffects 字段；
2. tool schema 不接受这些字段；错误明确给出新下一步；
3. complete 不检查 approval；
4. `/tasks approve` 被解析为 unknown action，不产生写盘或 dispatch；
5. list/stats/digest/doctor 不展示或判断 approval；
6. v1 granted/required/not-required 三种文件均可读，写回后字段消失；
7. task contract hash 仍正确约束 verification。

### 19.2 三态与 enabled

1. 三个 live status 的 actionable 行为逐项测试；
2. disabled 的 active/waiting/sleeping 均零 dispatch；
3. pause/resume 不改 status/wake/schedule；
4. run waiting 清 wake 并立即派发；
5. run sleeping 显式开新 cycle；
6. active + future wake 写入时规范成 waiting；
7. waiting due 先落盘 active 再 dispatch；
8. sleeping due 先落盘 cycle reset/active 再 dispatch；
9. sleeping 坏 wake 自愈，坏 schedule 停止并诊断。

### 19.3 周期

1. create recurring → sleeping，创建时不派发；
2. 首次 due 不产生虚假 History；
3. complete → sleeping + next occurrence；
4. skip → sleeping，不伪造 evidence；
5. 下轮 due 重置 DoD/Plan/verification/usage；
6. daemon 跨 occurrence 停机只补一轮，cycle id 绑定原 occurrence；
7. active/waiting 旧 cycle 未闭环时不并发开新轮；
8. cancel sleeping → archive/cancelled。

### 19.4 Verification

1. request-verification 从 active 进入 waiting(signal) 并产生 durable checker dispatch；
2. checker 入队失败不遗留无人唤醒的 waiting；
3. PASS/FAIL 恢复 active；
4. PASS 后普通 progress/Plan 变动规则不变；
5. contract/artifact 改动仍使 PASS 失效；
6. 手写 passed、缺 attestation、错 taskId/runId 均不能 complete；
7. 无 verification 的任务不产生额外 checker turn。

### 19.5 Waiting、governor 与恢复

1. waiting 无 wake 数小时零 dispatch、零 futile；
2. waiting 有 wake 到点仅恢复一次；
3. job/verifier 完成只唤醒所属 task；
4. 普通闲聊不点燃无关 waiting tasks；
5. 三次 active 无 effect → enabled false、status active；
6. governor 通知由 runtime 确定性渲染，不启动诊断 LLM turn；
7. deadline 对 active/current waiting 生效，对 sleeping 不生效；
8. budget attempt 只由真实 active dispatch 消耗。

### 19.6 外部动作重放

至少提供一个 fake external service e2e：第一次调用成功后在 checkpoint 前模拟 crash；durable replay 后 Agent 查询真实状态，外部 request count 仍为 1，随后正常 complete/sleep/archive。

## 20. DoD

1. `rg` 在当前源码、当前用户文档、playbooks、prompt、tool schema 中找不到 `/tasks approve`、`externalApproval`、`approvalBodyHash`、`approvalBy`、`approvedAt`、Task `sideEffects`；历史 specs/refer 中的命中均有明确 superseded/current-status 语境。
2. `/tasks approve` 不再是命令，不保留 handler、别名、兼容回执或隐式 dispatch。
3. 活动目录只写 `active | waiting | sleeping`；`enabled` 独立控制自动执行。
4. 一次性 completed/cancelled 全部归档，活动 driver 不消费 archive outcome。
5. 周期任务创建即 sleeping；第一次与后续 due 共用一条 cycle-open 实现。
6. pause/resume 不丢失 active/waiting/sleeping、wake 或 schedule。
7. waiting 无 wake 不轮询；job、verification、用户或 `/tasks run` 是明确恢复源。
8. verification 无专属 Task status，原有 attestation/hash/subject 防伪链保持完整。
9. governor 只对 active attempt 计算 futile，并以 deterministic runtime receipt 通知。
10. v1 task 可确定性迁移到 v2；迁移不执行外部动作且重复运行结果一致。
11. `docs/events-and-tasks.md`、runtime playbooks、prompt/tool descriptions、命令帮助和 behavior eval 与新语义一致。
12. 外部动作 crash/replay e2e 证明幂等恢复，重复调用次数为 1。
13. `npm run check` 全绿，Task 相关 behavior eval 达到 required gate。

## 21. 风险与接受的取舍

### 21.1 删除最后一次人工确认

任务可以在用户不在线时发送、push、发布或部署。这是本 spec 的目标行为，不是遗漏。用户需要人工审阅时，应把等待反馈写进任务目标；管理员需要限制能力时，应收紧工具、凭据和安全配置。

### 21.2 Prompt injection 与 scope drift

删除 approval 后，来自仓库、网页或外部消息的恶意内容可能诱导 Agent 扩大动作范围。Approval 原本也不能在工具层阻止这种行为，但过去可能提供一次偶然的人类观察窗口。新系统必须依靠输入不可信原则、最小能力、scope fidelity eval 和真实 guard；不得以“之前有 approval”掩盖 bash 等旁路。

### 21.3 迁移中的 waiting 无法完全推断

v1 没有机器可读的“等待审批/等待用户/等待外部系统”区分，不能安全自动唤醒所有 waiting。保留 waiting 并由 doctor/迁移 note 指示 review 是有意的保守迁移；新 v2 用 `waitingFor` 避免继续产生同类歧义。

### 21.4 新增 enabled 与 waitingFor 看似增加字段

字段数量不是目标；独立维度不应强塞进 status。`enabled` 删除 paused 的恢复信息丢失，`waitingFor` 让 parked task 有可诊断恢复源。两者换掉的是状态组合和特殊分支，而不是用更少字符伪装更简单。

### 21.5 Deterministic escalation 需要 runtime 投递面调整

TaskDriver 当前通过 synthetic agent turn 通知用户。改为 runtime receipt 需要新增一个不经过 LLM 的通知回调或结构化事件消费面。这是值得支付的一次性成本：治理器的事实与恢复命令不应由模型临场解释。

## 22. 最终心智模型

```text
Task = 可恢复的持续工作

status:
  active   现在做
  waiting  等真实信号
  sleeping 周期闭环，等下一轮

enabled:
  true     允许自动运行
  false    保留原阶段并停止

archive:
  completed | cancelled

verification:
  可选、独立、可防伪的质量事实

approval:
  不存在
```

一句话总结：

> **Task 管恢复与节奏，Verification 管质量，Security 管能力；用户创建 Task 即持续委托，不再逐动作审批。**
