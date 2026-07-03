# Memory Follow-ups 规划（P3）

| 字段 | 值 |
|------|------|
| 分支 | `master` |
| 状态 | PLANNED（未实现） |
| 日期 | 2026-07-04 |
| 前置 | spec 013（条目 id、write ops）已合入 |

本文档是 memory review 后 P3 档的规划项。P3-1 / P3-2 依赖 spec 013 的条目 id（已具备）；P3-3 / P3-4 为独立规划。均未实现，按需单独开 PR。

---

## P3-1 sidecar 小模型（成本优化，独立）

**动机**：所有 memory sidecar 任务（inline consolidation、session refresh、recall rerank、post-turn review、cleanup、history folding）当前都用主模型。这些是典型的小模型场景（Haiku 级），主模型跑它们是浪费。对齐 Claude Code「后台任务用小模型」的做法。

**改动**：
- `PipiclawMemoryMaintenanceSettings` 增加 `sidecarModel?: string`（provider:modelId 或裸 modelId，解析规则复用现有 `getAvailableModels()` / `models.json`）。默认不配 → 沿用主模型，行为不变。
- 在构造各 sidecar 调用的 `ConsolidationRunOptions` / `PostTurnReviewOptions` / recall rerank 请求处，把 `model` 从主模型换成解析后的 sidecar 模型；`resolveApiKey` 不变（已按 model 解析 key）。
- 落点集中在 `maintenance-jobs.ts`（consolidation/session/growth/structural 的 `makeRunOptions`）、`recall.ts`（rerank 的 `request.model`）、`lifecycle.ts`（边界 consolidation 的 `getModel`）。建议加一个 `resolveSidecarModel(settings, availableModels, fallbackModel)` 统一解析。

**风险**：spec 013 新的 `memoryOps` schema 对小模型的 JSON 稳定性需先验证；建议 sidecar 模型切换在 013 稳定运行一段时间后再上，并保留主模型兜底（sidecar 模型解析失败时回退）。

**测试**：`resolveSidecarModel` 的解析/回退单测；配置了 sidecarModel 时 consolidation 调用带该 model 的断言。

---

## P3-2 召回使用统计 → 反哺 cleanup（依赖条目 id）

**动机**：cleanup 决定去留时看不到「哪条记忆被召回过、多近」。有了 spec 013 的稳定条目 id，可以做最朴素的 salience / 衰减。

**改动**：
- `recallRelevantMemory` 命中 channel-memory 候选后，把 `{id, ts}` 追加到 `channelDir/recall-stats.jsonl`（fire-and-forget，不阻塞 turn；失败静默）。候选 id 目前是 `source:slug:ts` 形式，需要映射到 MEMORY.md 的条目 id——两种做法：(a) 让 channel-memory 候选粒度细化到「每条 bullet 一个候选」并带条目 id；(b) 先按 Update 块粒度统计，精度较粗但零改造。建议先 (b)，观察数据再决定是否上 (a)。
- `cleanupChannelMemory` 的 prompt 附上每个 Update 块 / 条目的 `recallCount` 与 `lastRecalledAt`，指示「高频/近期召回条目慎删」。
- `recall-stats.jsonl` 需在 `session-corpus.ts` 的 `IGNORED_JSONL_FILES` 里排除（否则会被 session_search 当 transcript）。

**测试**：recall 命中后 stats 文件追加；cleanup prompt 含统计摘要；corpus 忽略该文件。

**注意**：(a) 粒度细化与 P4 的 per-entry 检索索引是同一件事，可合并做。

---

## P3-3 user-scope 记忆层（独立，建议单独 spec 015）

**动机**：记忆现在按 channel 隔离，同一用户在 DM 与群里是两套人格记忆；用户级偏好无归宿（workspace MEMORY.md 是 admin 手工管理）。ChatGPT / Claude 的记忆都是 user-scope。

**要点（需在 spec 里定清楚再动手）**：
- 存储：以 DingTalk userId 为 key，`workspace/users/<id>/MEMORY.md`，复用 spec 013 的 write ops 与 id。
- 召回：`candidates.ts` 增加 `user-memory` 源，priority 介于 `channel-session` 与 `channel-memory` 之间。
- 沉淀：growth review / memory_save 的 target 增加 `user-memory`。
- **隐私边界（阻塞项）**：群聊里 A 的偏好不该以 B 的名义存，也不该在 B 的 turn 里召回 A 的私有记忆。需要先定「归属规则」——谁触发、存到谁名下、群内可见性——再实现。不建议在规则明确前抢跑。

---

## P3-4 embedding 混合检索（明确暂不做）

P0-3（recency 修复）+ spec 013（自包含、关键词丰富的条目写入）落地后，先用 review-log / recall-stats 观察召回命中率。当前量级下「词法 + 好条目 + rerank」大概率够用；不够时再上本地 `sqlite-vec` 混合检索，避免为不存在的问题引入依赖与运维面。

---

## 依赖关系

```
P3-1  独立，可随时做（建议 013 稳定后）
P3-2  依赖 013 条目 id；(a) 粒度细化与 P4 合并
P3-3  独立，先出 spec 015 定隐私规则
P3-4  观察指标后再决定，默认不做
```
