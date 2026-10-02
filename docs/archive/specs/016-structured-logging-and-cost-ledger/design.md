# 结构化日志与成本账本 设计方案

| 字段 | 值 |
|------|------|
| 分支 | `runtime-observability`（建议） |
| 状态 | DRAFT |
| 日期 | 2026-07-04 |
| 关联实现 | `src/log.ts`, `src/agent/channel-runner.ts`, `src/agent/session-events.ts`, `src/memory/sidecar-worker.ts`, `src/runtime/bootstrap.ts`, `src/paths.ts`, `src/settings.ts` |
| 前置 | 批次 C（`fix(runtime): harden transport & runtime`）已修复 HTTP 超时、文件权限，并引入 `/status` 传输层命令模式 |

---

## 背景

Pipiclaw 是长期运行的守护进程，但可观测性停留在交互式工具的水平：

1. **日志只有彩色 console**。`src/log.ts` 全部输出到 stdout，无级别、无结构、无落盘。跑在 systemd/docker 下时，排障只能靠截获 stdout；历史不可查询，"昨天那个 channel 为什么卡住"无从回答。
2. **成本只打一行就丢**。每轮结束 `logUsageSummary` 在 console 打一次即消失。三类 LLM 开销的可见度：
   - 主轮（assistant 消息）：console 有记录，不持久。
   - 子代理：并入 `runState.totalUsage`，另有 `store.logSubAgentRun` 落 jsonl（但混在 channel 目录里，非记账口径）。
   - **记忆 sidecar：完全不可见**。`sidecar-worker.ts` 只取 `extractAssistantText`，`lastMessage.usage` 被丢弃。session 刷新、durable 整合、recall 重排、session_search 摘要、growth review 全部走这条路——一条持续烧钱的暗流。
3. 没有 `/usage` 查询，没有预算护栏。对一个挂在群里 7×24 的 agent，"这个月花了多少、哪个 channel 花的"是运维刚需。

两者共享同一块基建——`STATE_DIR` 下的 JSONL 追加 + 轮转——因此合并为一个 spec，分阶段落地。

## 目标

1. `log.ts` 引入 **sink 层**：console sink 保持现有输出**逐字节不变**；新增可选 file sink，把每条日志作为结构化 JSONL 落盘，带级别过滤和大小轮转。现有调用点**零改动**。
2. **成本账本**：三个发射点（主轮 assistant-only、子代理逐次、sidecar 逐任务）写入月度 JSONL；不变式：**所有条目金额可直接加总，无重复计数**。
3. `/usage` 传输层命令：今日 / 近 7 日 / 本月，按 channel × kind × model 聚合。
4. （Phase 3）**预算护栏**：settings 配置每日预算，80% 软警告、100% 拒绝新 run。

## 非目标（记为后续）

- OTel / metrics / tracing 导出。sink 抽象为其留位，但不实现。
- console 输出格式的任何改动（人读体验是现有资产）。
- 事件历史（`state/events/history.jsonl`）迁移到新 appender——它已有自己的写入路径，可后续采用。
- Web dashboard / 图表。
- per-request 细粒度记账。账本以 turn / subagent-run / sidecar-task 为最小单元。
- per-channel 独立预算（先做全局口径，字段设计预留）。

---

## 设计

### 共享基建：`src/shared/jsonl-appender.ts`

```ts
interface JsonlAppenderOptions {
  path: string;              // 或 pathFor: (now: Date) => string（月度分文件用）
  maxSizeBytes?: number;     // 超限触发轮转；月度文件可不设
  maxRotations?: number;     // 保留 .1 .. .N
  mode?: number;             // 默认 0o600
}
interface JsonlAppender {
  append(record: unknown): Promise<void>;
}
```

- **串行化**：内部复用 `src/shared/serial-queue.ts`，每个 appender 一条队列，`fs.appendFile` 单条追加 `JSON.stringify(record) + "\n"`。
- **轮转**：沿用 `store.ts` `rotateIfNeeded` 的 rename 模式；size 在内存计数（初始化 stat 一次），避免每条 stat。
- **失败策略**：追加失败仅 console warn（同一 appender 节流为一次），**绝不向调用方抛错**——可观测性基建不能反噬业务路径。
- 目录 lazy `mkdir`；文件默认 `0o600`（日志含用户消息片段，与批次 C 的权限口径一致）。

### 结构化日志：`src/log.ts` 演进

**关键约束**：`log.ts` 被所有模块（含启动最早期）import，此时 settings 尚未加载。方案是延迟配置：

- 模块内 `let fileSink: FileSink | null = null`，默认 console-only（即现状，天然安全）。
- `log.configureLogging(settings)` 由 `bootstrap()` 在加载 settings 后调用一次；env `PIPICLAW_LOG_LEVEL` / `PIPICLAW_LOG_FILE=0|1` 优先级高于 settings（并在 configure 之前即生效，覆盖启动早期）。
- 每个现有 `logX` 函数内部组装 `LogRecord` 后 `emit(record)`——**结构在 log.ts 内部从既有参数组装**（`logToolStart` 已经拿到 ctx/toolName/label/args），调用点不动：

```ts
interface LogRecord {
  ts: string;                          // ISO 带时区偏移
  level: "debug" | "info" | "warn" | "error";
  event: string;                       // "tool_start" | "tool_end" | "thinking" | "response" | "usage" | "system" | ...
  channelId?: string;
  userName?: string;
  message: string;                     // 主文本（语义与 console 一致，无颜色/缩进）
  details?: string;                    // 截断后的详情
  fields?: Record<string, unknown>;    // toolName / durationMs / isError / usage 等
}
```

- **console sink**：现有 formatting 代码原样搬入，输出不变。**file sink**：按 level 过滤后交 appender。
- 落盘路径：`STATE_DIR/logs/runtime.jsonl`，大小轮转（默认 5MB × 3）。runtime 日志的查询场景是"最近发生了什么"，大小轮转足够；不做日期分文件（那是账本的需求）。
- `paths.ts` 增加 `LOG_STATE_DIR`。
- settings 新增段（沿 `Partial<> + DEFAULT` 惯例）：

```json
"logging": {
  "level": "info",
  "file": { "enabled": true, "maxSizeBytes": 5000000, "maxFiles": 3 }
}
```

`file.enabled` 默认 **true**：守护进程默认落盘的价值大于新文件出现的意外感，文档注明。

### 成本账本：`src/usage/ledger.ts`（新域）

```ts
interface UsageLedgerEntry {
  ts: string;
  channelId: string;
  kind: "turn" | "subagent" | "sidecar";
  model: string;                       // provider/id（formatModelReference）
  label?: string;                      // subagent label / sidecar task name
  usage: { input; output; cacheRead; cacheWrite; total };
  cost:  { input; output; cacheRead; cacheWrite; total };
}
```

- 文件：`STATE_DIR/usage/usage-YYYY-MM.jsonl`。**按月分文件**＝天然留存策略＋查询范围收敛（`pathFor(now)` 由 appender 支持）。`paths.ts` 增加 `USAGE_STATE_DIR`。
- 单例 `getUsageLedger()`（单进程 runtime，进程级单例合理）；测试可注入基路径。
- `cost.total <= 0` 的条目不落盘（无 API 计费的本地场景不产生噪音）。

**三个发射点（不变式的由来）**：

1. **主轮（assistant-only）**：`session-events.ts` 的 `mergeAssistantUsage` 同时累进新增的 `runState.assistantUsage`（**不含**子代理；`totalUsage` 维持现口径继续供 console summary 使用）。`channel-runner.run()` 的 finally 处 `ledger.record({ kind: "turn", usage: assistantUsage, model: 实际成交模型 })`。
2. **子代理**：`session-events.ts` 的 `subAgentDetails` 分支已拿到完整 usage/model/label → 追加一条 `kind: "subagent"`。
3. **sidecar**：`SidecarTask` 增加可选 `usageContext?: { channelId: string }`；`runSidecarTask` 结束时从 `lastMessage.usage` 读取并 `record({ kind: "sidecar", label: task.name })`。所有调用方（`session.ts` / `consolidation.ts` / `recall.ts` / `session-search.ts` / `post-turn-review.ts` 等，均已握有 channelId）一行式补传。**未传时以 `channelId: "(untracked)"` 落盘并 warn**——让漏点在账本里显式可见，而不是静默丢失。

> 不变式：Σ(所有 entry.cost.total) = 进程真实总开销，无重复计数（turn 不含 subagent，subagent 单记，sidecar 独立）。以契约测试锁定。

**查询**：`summarizeUsage({ sinceDays | month })` 流式读当月文件（跨月窗口读两个文件），聚合 by channelId × kind × model。ledger 另维护**进程内当日累计**（启动时 lazy 扫当月文件重建当日值）→ 预算检查 O(1)，不在热路径读盘。

### `/usage` 命令

- `commands.ts` 增加 `"usage"`；路由与 `/status` 完全同构（`DingTalkHandler.handleUsageCommand`，busy/idle 两态可用，不占 run 队列）。
- `/usage`（默认今日+本月摘要）、`/usage 7d`、`/usage month`。输出：本 channel 与全局的 cost 合计、kind 分解、top 模型。

### Phase 3：预算护栏

- settings：

```json
"usage": { "dailyBudgetUsd": 0, "warnRatio": 0.8 }
```

`dailyBudgetUsd: 0` = 禁用（默认）。全局口径；per-channel 预算字段预留为后续。

- 检查点：`bootstrap.ts` `handleEvent` 在 `runner.run` 之前调 `ledger.getTodaySpendUsd()`：
  - `>= warnRatio × budget` 且当日首次跨越 → 本轮照常执行，附带一条 `respondInThread` 软警告。
  - `>= budget` → 拒绝新 run，`sendPlain` 说明并提示 `/usage`；`/stop` `/status` `/usage` `/events` 不受限。
- 记忆维护 sidecar 是否受限：默认**不受限**（金额小、长期价值高），但 `maintenance-gates.ts` 预留 budget gate 的接入点，settings 加 `usage.limitMaintenance`（默认 false）。

## 测试

- **jsonl-appender**：追加与换行完整性、size 轮转与保留数、并发 append 串行性、append 失败不抛且 warn 节流。
- **log file sink**：`configureLogging` 后各 `logX` 落盘字段断言；level 过滤；env 覆盖 settings；未 configure 时纯 console（现状回归）。
- **ledger**：三类 record 字段完整；**无重复计数契约**（模拟一轮含子代理：turn.usage 不含 subagent usage）；`summarizeUsage` 聚合与月切换；`(untracked)` 路径。
- **口径回归**：`session-events` 的 `assistantUsage` / `totalUsage` 双累计正确性。
- **/usage** 渲染（busy/idle 两态路由，同 /status 的测试模式）。
- **预算**：超限拒绝、软警告当日仅一次、budget=0 零行为变化。

## 落地阶段

| 阶段 | 内容 | 可独立合入 |
|------|------|-----------|
| Phase 1 | jsonl-appender + log.ts sink 层 + `settings.logging` | ✅（`file.enabled=false` 时零行为变化） |
| Phase 2 | ledger 三发射点 + `/usage` 命令 | ✅ |
| Phase 3 | 预算护栏 | ✅（默认禁用） |

## 风险与权衡

- **热路径 I/O**：ledger 每轮 1–3 条、日志 file sink 每工具调用 1–2 条，异步串行追加，量级 ~1MB/天，可忽略。
- **日志含用户文本片段**：0600 + 文档提示；不做脱敏（本地文件，与 log.jsonl 同威胁模型）。
- **sidecar `usageContext` 靠调用方传**：以 `(untracked)` 显式暴露遗漏；review 时 grep `runSidecarTask` 调用点核对。
- **`totalUsage` 与账本口径差异**（console 含子代理、turn 条目不含）：在 `logUsageSummary` 输出中补一行 `(incl. sub-agents)` 消除歧义。
