# Memory Maintenance Scheduler 实现计划

| 字段 | 值 |
|------|------|
| 分支 | `master` |
| 状态 | DRAFT |
| 日期 | 2026-04-19 |
| 设计文档 | [design.md](/Users/oyasmi/projects/pipiclaw/docs/specs/010-memory-maintenance-scheduler/design.md) |

---

## 实施原则

spec 010 不是在 spec 009 旁边再加一套 memory job，而是要把 spec 009 中 turn 附近的即时 LLM 触发改造成内置后台维护模型。

实施时必须遵守：

1. 旧即时触发链要清理干净，不能和 scheduler 双跑。
2. 所有 LLM sidecar 调用前必须有本地 gate；gate 不通过时不得调用 LLM。
3. 所有 memory 文件写入必须走同一 channel 串行队列。
4. 内置 scheduler 不使用 `workspace/events/`，不调用 `bot.enqueueEvent()`。
5. compaction、`/new`、shutdown 前的边界保存继续保留。
6. 后台任务失败不能影响用户 turn。
7. 低置信、blocked、skipped 都要进入 `memory-review.jsonl` 或日志，便于审计。

---

## 当前实现需要清理的点

### 1. `MemoryLifecycle` 仍承担太多后台职责

当前 [MemoryLifecycle](/Users/oyasmi/projects/pipiclaw/src/memory/lifecycle.ts) 同时负责：

1. session memory threshold refresh
2. idle consolidation timer
3. idle 后 background maintenance
4. post-turn review 调度
5. durable memory queue

spec 010 要保留它的 turn/session event hooks，但把后台 LLM work 移出。

保留：

1. `noteUserTurnStarted()`
2. `noteToolCall()`
3. `noteCompletedAssistantTurn()`
4. compaction / `/new` / shutdown 前的 preflight consolidation

移出或改造：

1. turn 后 threshold session refresh 不能直接 sidecar
2. 60 秒 idle consolidation 不能直接 sidecar
3. idle 后不能联动 cleanup/folding
4. post-turn review 不能在 turn 后直接 sidecar

### 2. `runBackgroundMaintenance()` 被 idle 和 compaction 链路直接调用

当前 [runBackgroundMaintenance](/Users/oyasmi/projects/pipiclaw/src/memory/consolidation.ts) 可能触发：

1. memory cleanup sidecar
2. history folding sidecar

spec 010 后它只能由 structural maintenance job 在文件阈值通过后调用，不能由 idle 链路直接调用。

### 3. post-turn review 已经有能力，但触发时机不对

当前 [post-turn-review.ts](/Users/oyasmi/projects/pipiclaw/src/memory/post-turn-review.ts) 可以复用，但调用方要从 `MemoryLifecycle` 移到 scheduler 的 `Growth Review Job`。

### 4. review log helper 可复用

[review-log.ts](/Users/oyasmi/projects/pipiclaw/src/memory/review-log.ts) 保留，scheduler skip / action / failure 都继续写这里。

---

## 目标文件概览

### 新增文件

| 文件 | 作用 |
|------|------|
| `src/memory/channel-maintenance-queue.ts` | 统一 per-channel memory job 串行队列 |
| `src/memory/maintenance-state.ts` | hidden state 读写、重建、dirty/counter 更新 |
| `src/memory/scheduler.ts` | 内置 MemoryMaintenanceScheduler |
| `src/memory/maintenance-gates.ts` | 四类 job 的本地 gate 和 skip reason |
| `src/memory/maintenance-jobs.ts` | session refresh / durable consolidation / growth review / structural maintenance job |
| `test/memory-maintenance-state.test.ts` | hidden state 测试 |
| `test/memory-maintenance-gates.test.ts` | no-LLM gate 测试 |
| `test/memory-maintenance-scheduler.test.ts` | scheduler start/stop/concurrency 测试 |
| `test/memory-maintenance-jobs.test.ts` | 四类 job 触发与跳过测试 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `src/memory/lifecycle.ts` | 从直接执行后台 LLM 改为 mark dirty；保留边界保存 |
| `src/memory/consolidation.ts` | 导出或拆分 cleanup/folding 本地阈值判断，供 structural job 使用 |
| `src/memory/post-turn-review.ts` | 支持 batch review 输入范围和 digest notice |
| `src/memory/review-log.ts` | 如需要增加 skip reason 类型，不改变文件格式 |
| `src/settings.ts` | 新增 `memoryMaintenance`，调整 `memoryRecall.rerankWithModel` 支持 `"auto"` |
| `src/tools/config.ts` | 保持 `sessionSearch.summarizeWithModel=false` 默认，不需要迁移到 tools config |
| `src/runtime/bootstrap.ts` | 启动/停止 MemoryMaintenanceScheduler |
| `src/agent/channel-runner.ts` | 向 lifecycle 注入 dirty recorder / active state 信息 |
| `src/agent/prompt-builder.ts` | 文档性说明：memory maintenance 是后台内置，不是 events |
| `docs/configuration.md` | 配置说明 |
| `docs/deployment-and-operations.md` | hidden state、维护日志、排障说明 |

---

## Phase 1: 抽出串行队列和维护状态

目标：先建立 scheduler 所需基础设施，不改变用户可见行为。

### Task 1.1 新增 channel maintenance queue

文件：

```text
src/memory/channel-maintenance-queue.ts
```

接口：

```ts
export interface ChannelMemoryQueue {
	run<T>(channelId: string, job: () => Promise<T>): Promise<T>;
}

export function createChannelMemoryQueue(): ChannelMemoryQueue;
export function getDefaultChannelMemoryQueue(): ChannelMemoryQueue;
```

要求：

1. 同一 `channelId` 串行执行。
2. 不同 channel 可并行，但后续 scheduler 用 `maxConcurrentChannels` 控制。
3. job throw 后队列必须继续可用。
4. 不使用全局 mutable promise 散落在多个类中。

迁移：

1. `MemoryLifecycle` 内部 `durableMemoryQueue` 替换为 `ChannelMemoryQueue`。
2. 不改变现有测试语义。

验收：

1. 同 channel job 顺序执行。
2. job 失败后后续 job 仍执行。
3. 不同 channel 不互相阻塞。

### Task 1.2 新增 hidden maintenance state

文件：

```text
src/memory/maintenance-state.ts
```

接口建议：

```ts
export interface MemoryMaintenanceState {
	channelId: string;
	dirty: boolean;
	lastActivityAt?: string;
	eligibleAfter?: string;
	lastSessionRefreshAt?: string;
	lastDurableConsolidationAt?: string;
	lastGrowthReviewAt?: string;
	lastStructuralMaintenanceAt?: string;
	turnsSinceSessionRefresh: number;
	toolCallsSinceSessionRefresh: number;
	turnsSinceGrowthReview: number;
	toolCallsSinceGrowthReview: number;
	lastConsolidatedEntryId?: string;
	lastReviewedEntryId?: string;
	failureBackoffUntil?: string | null;
}

export function getMemoryMaintenanceStatePath(appHomeDir: string, channelId: string): string;
export async function readMemoryMaintenanceState(appHomeDir: string, channelId: string): Promise<MemoryMaintenanceState>;
export async function writeMemoryMaintenanceState(appHomeDir: string, state: MemoryMaintenanceState): Promise<void>;
export async function updateMemoryMaintenanceState(
	appHomeDir: string,
	channelId: string,
	update: (state: MemoryMaintenanceState) => MemoryMaintenanceState
): Promise<MemoryMaintenanceState>;
```

存储路径：

```text
<APP_HOME>/state/memory/<channelId>.json
```

要求：

1. atomic write。
2. state 缺失时返回默认 state。
3. JSON 损坏时 warning 并重建默认 state。
4. 状态文件不是 memory source，不进入 recall。

验收：

1. 缺失 state 可创建。
2. 损坏 state 不抛到主流程。
3. update 并发不破坏 JSON。

### Task 1.3 生命周期只记录 dirty

修改：

```text
src/memory/lifecycle.ts
```

新增注入项：

```ts
recordMemoryActivity?: (event: MemoryActivityEvent) => Promise<void> | void;
isChannelActive?: () => boolean;
```

`MemoryActivityEvent` 包含：

1. `kind: "user-turn-started" | "tool-call" | "assistant-turn-completed" | "boundary"`
2. `channelId`
3. `timestamp`
4. latest entry id if available

改动：

1. `noteUserTurnStarted()` 更新 activity / eligibleAfter。
2. `noteToolCall()` 更新 dirty 和 tool counters。
3. `noteCompletedAssistantTurn()` 更新 dirty 和 turn counters。
4. 不在这些方法中直接启动 post-turn review。
5. 不在这些方法中直接启动 session threshold refresh。
6. idle timer 不直接跑 LLM。

保留：

1. compaction 前 refresh/consolidation
2. `/new` 前 refresh/consolidation
3. shutdown flush

验收：

1. 普通 assistant turn 后不调用 `runRetriedSidecarTask()`。
2. tool call 后不调用 `runRetriedSidecarTask()`。
3. compaction 前仍调用必要 sidecar。

---

## Phase 2: Gate 层，先保证 no-LLM skip

目标：所有 scheduler job 在调用 LLM 前都有可测试的本地判断。

### Task 2.1 新增 maintenance gates

文件：

```text
src/memory/maintenance-gates.ts
```

核心类型：

```ts
export type MaintenanceJobKind =
	| "session-refresh"
	| "durable-consolidation"
	| "growth-review"
	| "structural-maintenance";

export interface MaintenanceGateDecision {
	allowed: boolean;
	skipReason?: string;
	jobKind: MaintenanceJobKind;
}
```

每类 gate：

```ts
export function shouldRunSessionRefresh(input: SessionRefreshGateInput): MaintenanceGateDecision;
export function shouldRunDurableConsolidation(input: DurableConsolidationGateInput): MaintenanceGateDecision;
export function shouldRunGrowthReview(input: GrowthReviewGateInput): MaintenanceGateDecision;
export function shouldRunStructuralMaintenance(input: StructuralMaintenanceGateInput): MaintenanceGateDecision;
```

要求：

1. gate 函数必须纯本地，不读 LLM。
2. gate 可以读取已加载的 file stats / counters / entry metadata，但不得 sidecar。
3. 每个 deny 分支必须返回稳定 `skipReason`。

### Task 2.2 Session Refresh gate

允许条件：

1. `sessionMemory.enabled`
2. `dirty`
3. `now >= eligibleAfter`
4. channel inactive
5. not in backoff
6. turn/tool counter 达阈值
7. 有新 session entry 或 meaningful messages

skip reason 枚举建议：

1. `disabled`
2. `clean`
3. `not-idle-yet`
4. `channel-active`
5. `backoff-active`
6. `threshold-not-met`
7. `no-new-session-entry`
8. `no-meaningful-material`

测试必须断言：这些 skip reason 下不会调用 LLM。

### Task 2.3 Durable Consolidation gate

允许条件：

1. `dirty`
2. `now >= eligibleAfter`
3. channel inactive
4. interval elapsed
5. not in backoff
6. 有 `lastConsolidatedEntryId` 后的新 meaningful exchange
7. 达到最小批量阈值，或超过最长等待时间
8. growth review 没有覆盖同一 entry range

skip reason：

1. `clean`
2. `not-idle-yet`
3. `channel-active`
4. `interval-not-elapsed`
5. `backoff-active`
6. `no-new-entry`
7. `no-meaningful-exchange`
8. `batch-threshold-not-met`
9. `covered-by-growth-review`

### Task 2.4 Growth Review gate

允许条件：

1. `memoryGrowth.postTurnReviewEnabled`
2. `dirty`
3. `now >= eligibleAfter`
4. channel inactive
5. interval elapsed
6. not in backoff
7. turn/tool counter 达 review 阈值
8. 有 `lastReviewedEntryId` 后的新 meaningful material
9. 本地 heuristic 检测到 promotion 信号

本地 heuristic 文件：

```text
src/memory/promotion-signals.ts
```

信号：

1. 长期偏好：`以后`, `默认`, `记住`, `偏好`
2. 决策：`决定`, `确认`, `采用`, `不再`
3. 流程：`流程`, `步骤`, `规范`, `checklist`, `每次`
4. open loop：`后续`, `待办`, `需要跟进`
5. repeated tool/workflow patterns

skip reason：

1. `disabled`
2. `clean`
3. `not-idle-yet`
4. `channel-active`
5. `interval-not-elapsed`
6. `backoff-active`
7. `threshold-not-met`
8. `no-new-entry`
9. `no-promotion-signal`

### Task 2.5 Structural Maintenance gate

允许条件：

1. channel inactive
2. interval elapsed
3. not in backoff
4. `MEMORY.md` 超 cleanup 阈值，或 `HISTORY.md` 超 folding 阈值

必须把 cleanup 和 folding 分开判断：

```ts
interface StructuralMaintenanceGateDecision {
	allowed: boolean;
	runMemoryCleanup: boolean;
	runHistoryFolding: boolean;
	skipReason?: string;
}
```

skip reason：

1. `channel-active`
2. `interval-not-elapsed`
3. `backoff-active`
4. `memory-under-threshold`
5. `history-under-threshold`
6. `nothing-to-maintain`
7. `empty-template-files`

验收：

1. `MEMORY.md` 未超过阈值时不调用 cleanup sidecar。
2. `HISTORY.md` 未超过阈值时不调用 folding sidecar。
3. 两者都未超过阈值时 structural job 完全无 LLM。

---

## Phase 3: 内置 Scheduler

目标：建立独立 runtime service，不依赖 events 文件。

### Task 3.1 新增 MemoryMaintenanceScheduler

文件：

```text
src/memory/scheduler.ts
```

接口：

```ts
export interface MemoryMaintenanceSchedulerOptions {
	appHomeDir: string;
	workspaceDir: string;
	getChannelIds: () => string[];
	getChannelDir: (channelId: string) => string;
	isChannelActive: (channelId: string) => boolean;
	getModel: (channelId: string) => Model<Api> | null;
	resolveApiKey: (model: Model<Api>) => Promise<string>;
	getSettings: () => {
		sessionMemory: PipiclawSessionMemorySettings;
		memoryGrowth: PipiclawMemoryGrowthSettings;
		memoryMaintenance: PipiclawMemoryMaintenanceSettings;
	};
	emitNotice?: (channelId: string, notice: string) => Promise<void>;
	refreshWorkspaceResources?: (channelId: string) => Promise<void>;
}

export class MemoryMaintenanceScheduler {
	start(): void;
	stop(): void;
	runOnce(now?: Date): Promise<void>;
}
```

要求：

1. `start()` 可重复调用但只启动一次。
2. `stop()` 停止 timers/crons，不等待新 job。
3. `runOnce()` 方便测试。
4. `memoryMaintenance.enabled=false` 时不启动 timers。
5. 不创建 `workspace/events` 文件。
6. 不调用 DingTalk bot enqueue。

### Task 3.2 channel 枚举

需要 scheduler 知道哪些 channel 有维护状态。

来源优先级：

1. runtime store 当前已知 channel
2. workspace 下已有 channel 目录
3. hidden state 目录已有 state 文件

实现建议：

```ts
export function discoverMemoryMaintenanceChannels(workspaceDir: string, stateDir: string): string[];
```

只接受合法 channel 目录：

1. `dm_*`
2. `group_*`

跳过：

1. `events`
2. `skills`
3. `sub-agents`
4. 普通 workspace 文件

### Task 3.3 调度策略

第一版不必复杂 cron，可以用一个 interval tick：

```text
每 60 秒 tick
```

tick 内根据各 job interval 判断是否运行。

优点：

1. 简单可测
2. 不需要为每个 channel 建 cron
3. stop 容易
4. 后续可替换为 Cron

要求：

1. 每次 tick 最多处理 `maxConcurrentChannels`
2. 同一 channel 一次 tick 中最多运行一个 LLM job，避免连续打满
3. job 优先级：
   - session refresh
   - durable consolidation
   - growth review
   - structural maintenance
4. 如果一个高优先级 job 运行了，低优先级 job 延后到下一 tick

### Task 3.4 runtime bootstrap 接入

修改：

```text
src/runtime/bootstrap.ts
```

接入点：

1. 创建 `EventsWatcher` 后创建 `MemoryMaintenanceScheduler`
2. `startServices !== false` 时启动
3. shutdown 时 `scheduler.stop()`

注意：

1. scheduler stop 要早于 runner shutdown flush，避免新增 job。
2. shutdown flush 仍由 runner/lifecycle 处理。

验收：

1. runtime 启动时 scheduler start。
2. runtime shutdown 时 scheduler stop。
3. `startServices=false` 不启动 scheduler。

---

## Phase 4: 四类 scheduled jobs

目标：把真正的工作从 lifecycle 移到 job 层。

### Task 4.1 Session Refresh Job

文件：

```text
src/memory/maintenance-jobs.ts
```

函数：

```ts
export async function runSessionRefreshJob(input: SessionRefreshJobInput): Promise<MaintenanceJobResult>;
```

步骤：

1. 读取 state。
2. 收集当前 session entry metadata。
3. 调 `shouldRunSessionRefresh()`。
4. gate deny：写 skip log，不调用 LLM。
5. gate allow：调用 `updateChannelSessionMemory()`。
6. 成功：更新 `lastSessionRefreshAt`、counters、entry id。
7. 失败：设置 backoff。

验收：

1. gate deny 时 sidecar mock 未调用。
2. gate allow 时只调用 session memory sidecar。
3. 成功后 counters 清零。

### Task 4.2 Durable Consolidation Job

函数：

```ts
export async function runDurableConsolidationJob(input: DurableConsolidationJobInput): Promise<MaintenanceJobResult>;
```

步骤：

1. 读取 state。
2. 读取 session entries since `lastConsolidatedEntryId`。
3. 调 `shouldRunDurableConsolidation()`。
4. gate deny：写 skip log，不调用 LLM。
5. gate allow：调用 `runInlineConsolidation({ mode: "idle" })`。
6. 成功：更新 `lastDurableConsolidationAt`、`lastConsolidatedEntryId`。
7. 若 `appendedMemoryEntries === 0`，仍更新时间但保留 dirty 视情况。

必须删除旧行为：

1. `MemoryLifecycle.scheduleIdleConsolidation()` 不能再调用 `runInlineConsolidation()`。
2. idle timer 只能 mark eligible，或完全由 state 的 `eligibleAfter` 替代。

### Task 4.3 Growth Review Job

函数：

```ts
export async function runGrowthReviewJob(input: GrowthReviewJobInput): Promise<MaintenanceJobResult>;
```

步骤：

1. 读取 state。
2. 读取 session entries since `lastReviewedEntryId`。
3. 本地 promotion signal scan。
4. 调 `shouldRunGrowthReview()`。
5. gate deny：写 skip log，不调用 LLM。
6. gate allow：调用 `runPostTurnReview()`。
7. direct actions 成功后更新 `lastGrowthReviewAt`、`lastReviewedEntryId`。
8. notices 合并成 digest 后发送。

必须删除旧行为：

1. `MemoryLifecycle.schedulePostTurnReviewIfDue()` 不再调用 `runPostTurnReview()`。
2. turn 后只更新 state counters。

### Task 4.4 Structural Maintenance Job

函数：

```ts
export async function runStructuralMaintenanceJob(input: StructuralMaintenanceJobInput): Promise<MaintenanceJobResult>;
```

步骤：

1. 读取 `MEMORY.md` / `HISTORY.md` stats。
2. 调 `shouldRunStructuralMaintenance()`。
3. gate deny：写 skip log，不调用 LLM。
4. cleanup allow：调用 memory cleanup。
5. folding allow：调用 history folding。
6. 成功：更新 `lastStructuralMaintenanceAt`。
7. 失败：设置 backoff。

需要从 [consolidation.ts](/Users/oyasmi/projects/pipiclaw/src/memory/consolidation.ts) 拆出或导出：

1. memory cleanup threshold 判断
2. history folding threshold 判断
3. cleanup runner
4. folding runner

注意：

1. 不能直接调用当前 `runBackgroundMaintenance()` 后再让它内部决定，因为测试必须能断言未超过阈值时 sidecar 不会被调用。
2. 可以保留 `runBackgroundMaintenance()` 作为 wrapper，但 scheduler job 应该先做显式 gate。

---

## Phase 5: Recall 和 session_search 成本收敛

目标：减少 turn 开头和工具使用中的额外 LLM。

### Task 5.1 recall rerank 支持 `"auto"`

修改：

```text
src/settings.ts
src/memory/recall.ts
src/agent/channel-runner.ts
```

类型：

```ts
rerankWithModel: boolean | "auto";
```

默认：

```ts
"auto"
```

`auto` LLM 触发条件：

1. candidates 数量 > 0
2. local top score 不够高
3. top candidates 分数接近
4. query 有历史/偏好/决策/纠错意图
5. prompt budget 允许

skip 时：

1. 使用 local scoring 结果。
2. 不调用 rerank sidecar。
3. debug log 可记录 `rerank skipped: local confidence high`。

测试：

1. no candidates 不调用 LLM。
2. high local confidence 不调用 LLM。
3. ambiguous candidates + history query 才调用 LLM。

### Task 5.2 session_search summary 保持默认 no LLM

当前 `sessionSearch.summarizeWithModel=false` 默认合理，保留。

补强：

1. query 为空时即使配置 true 也不 summary。
2. 无结果时不 summary。
3. top result preview 足够短时不 summary。
4. summary failure backoff。

测试：

1. empty query no LLM。
2. no result no LLM。
3. short result no LLM。
4. explicit long result + enabled 才 LLM。

---

## Phase 6: 配置和文档

### Task 6.1 settings

修改：

```text
src/settings.ts
```

新增：

```ts
export interface PipiclawMemoryMaintenanceSettings {
	enabled: boolean;
	minIdleMinutesBeforeLlmWork: number;
	sessionRefreshIntervalMinutes: number;
	durableConsolidationIntervalMinutes: number;
	growthReviewIntervalMinutes: number;
	structuralMaintenanceIntervalHours: number;
	maxConcurrentChannels: number;
	failureBackoffMinutes: number;
}
```

默认：

```ts
{
	enabled: true,
	minIdleMinutesBeforeLlmWork: 10,
	sessionRefreshIntervalMinutes: 10,
	durableConsolidationIntervalMinutes: 20,
	growthReviewIntervalMinutes: 60,
	structuralMaintenanceIntervalHours: 6,
	maxConcurrentChannels: 1,
	failureBackoffMinutes: 30,
}
```

同时调整：

1. `memoryGrowth.minTurnsBetweenReview = 12`
2. `memoryGrowth.minToolCallsBetweenReview = 24`
3. `memoryRecall.rerankWithModel = "auto"`
4. `sessionSearch.summarizeWithModel = false`

### Task 6.2 docs

更新：

1. `docs/configuration.md`
2. `docs/deployment-and-operations.md`
3. spec 009 可加一句“触发时机由 spec010 调整”

内容：

1. memory maintenance 是内置后台任务
2. 不依赖 `workspace/events/`
3. hidden state 路径
4. 四类 job 默认频率
5. 如何关闭 scheduler
6. token cost 调优建议
7. no-LLM gate 原则

---

## Phase 7: 清理旧实现和一致性检查

目标：确保没有两套触发链并存。

必须删除或改造：

1. `MemoryLifecycle` 中 turn 后直接 post-turn review。
2. `MemoryLifecycle` 中 threshold 直接 session refresh。
3. `MemoryLifecycle` 中 60 秒 idle 直接 consolidation。
4. idle 后联动 `runBackgroundMaintenance()`。
5. scheduler 外部任何 structural maintenance 直接触发点。

必须保留：

1. compaction 前 session refresh。
2. compaction 前 boundary consolidation。
3. `/new` 前 session refresh。
4. `/new` 前 boundary consolidation。
5. shutdown flush。
6. explicit user tool `session_search`。
7. explicit user tool `skill_manage`。

一致性检查：

1. `MemoryLifecycle` 只负责 event hooks、dirty record、boundary save。
2. `MemoryMaintenanceScheduler` 只负责后台 scheduled jobs。
3. `maintenance-gates.ts` 是 LLM 调用前唯一 gate 来源。
4. `maintenance-jobs.ts` 不能绕过 gate 调 sidecar。
5. 所有 skip reason 可测试。

---

## 端到端验证计划

最低验证：

```bash
npm run typecheck
npm run test
npm run check
```

分阶段验证：

### Phase 1 / 2

```bash
npm run test -- memory-maintenance-state memory-maintenance-gates memory-lifecycle
```

重点：

1. turn 后不调用 LLM。
2. boundary 仍调用 LLM。
3. gate deny 不调用 sidecar。

### Phase 3 / 4

```bash
npm run test -- memory-maintenance-scheduler memory-maintenance-jobs
```

重点：

1. scheduler start/stop。
2. no dirty skip。
3. active channel skip。
4. backoff skip。
5. max concurrency。

### Phase 5

```bash
npm run test -- memory-recall session-search
```

重点：

1. auto rerank 不滥用 LLM。
2. session_search summary 不滥用 LLM。

### 最终

```bash
npm run check
```

如改动影响 runtime start/stop：

```bash
npm run test -- runtime-context runtime-stop bootstrap
```

---

## 风险与控制

### 风险 1: memory 更新变慢

控制：

1. `SESSION.md` 边界刷新保留。
2. scheduler 默认 10 分钟 session refresh。
3. `/new`、compaction、shutdown 不受 scheduler 关闭影响。

### 风险 2: 后台任务和用户 turn 抢模型

控制：

1. channel active gate。
2. `minIdleMinutesBeforeLlmWork`。
3. `maxConcurrentChannels=1` 默认。
4. sidecar failure backoff。

### 风险 3: 两套触发链并存

控制：

1. Phase 7 做专项清理。
2. 测试断言 turn 后不直接 sidecar。
3. grep 检查 direct calls：
   - `runPostTurnReview(`
   - `runInlineConsolidation(`
   - `runBackgroundMaintenance(`
   - `updateChannelSessionMemory(`

### 风险 4: no-LLM gate 被绕过

控制：

1. jobs 必须先调用 gate。
2. tests mock sidecar 并断言未调用。
3. gate deny path 写 skip reason。

### 风险 5: hidden state 损坏

控制：

1. 读失败重建默认 state。
2. warning 但不阻塞 runtime。
3. state 不作为权威 memory source。

---

## 建议 PR 切分

### PR 1: Maintenance State And Queue

包含：

1. channel maintenance queue
2. hidden state helper
3. lifecycle dirty record 基础注入
4. tests

不包含 scheduler job。

### PR 2: Gates And Hot Path Cleanup

包含：

1. maintenance gates
2. lifecycle 移除 turn 后 direct LLM
3. idle 改 dirty/eligible
4. cleanup/folding 从 idle 链路移除
5. no-LLM tests

### PR 3: Internal Scheduler

包含：

1. MemoryMaintenanceScheduler
2. bootstrap start/stop
3. channel discovery
4. concurrency
5. tests

### PR 4: Scheduled Jobs

包含：

1. session refresh job
2. durable consolidation job
3. growth review job
4. structural maintenance job
5. review log skip/action
6. tests

### PR 5: Recall/Search Cost Controls And Docs

包含：

1. recall rerank `"auto"`
2. session search summary gates
3. settings docs
4. operations docs
5. final `npm run check`

---

## 完成定义

spec 010 完成时必须满足：

1. 普通 turn 结束不会直接触发 post-turn review sidecar。
2. 普通 turn 结束不会在 60 秒后直接触发 durable consolidation sidecar。
3. cleanup/folding 只由 structural maintenance job 在阈值满足时触发。
4. 四类 scheduler job 都有 no-LLM gate tests。
5. `workspace/events/` 中没有任何内置 memory job 文件。
6. 用户删除 `workspace/events/` 不影响 memory maintenance。
7. `memoryMaintenance.enabled=false` 后 scheduler 不运行，但边界保存仍有效。
8. `npm run check` 通过。
