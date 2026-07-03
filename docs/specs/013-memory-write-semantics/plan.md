# Memory Write Semantics 实现计划

| 字段 | 值 |
|------|------|
| 分支 | `master` |
| 状态 | DONE |
| 日期 | 2026-07-04 |
| 设计文档 | [design.md](/Users/oyasmi/projects/pipiclaw/docs/specs/013-memory-write-semantics/design.md) |

---

## 实施原则

1. `MEMORY.md` / `HISTORY.md` 保持人类可读、用户可审计的 Markdown；结构藏在行内注释里，不引入数据库。
2. 所有写入仍走 `channel-maintenance-queue` 共享串行队列，不新增竞争面。
3. 备份是安全网而非前置条件：备份失败不得阻塞记忆写入。
4. 存量文件零迁移脚本：解析合成确定性 id，首次 supersede 时补真 id。
5. LLM 输出异常不得覆盖好记忆：cleanup 有缩水保护 + 写前备份。

## 改动清单

### `src/settings.ts`
- `PipiclawMemoryMaintenanceSettings` 增加 `cleanupShrinkGuardMinRatio`（默认 0.4）、`cleanupShrinkGuardMinChars`（默认 2000）。

### `src/memory/files.ts`
- 条目行格式 `- <content> <!--id:m-xxxxxxxx-->`；`generateMemoryEntryId` / `stableMemoryEntryId`（sha1 合成）/ `stripMemoryEntryIdComment`。
- `parseChannelMemoryEntries`：只解析 **H2 section 内** 的 bullet（H1 头部的模板描述性 bullet 不算条目）。
- `applyChannelMemoryOps`：行级 add / supersede / invalidate；坏 targetId 的 supersede 降级为 add、invalidate 跳过；有 mutation 时写前备份。
- `appendChannelMemoryUpdate` 改为给条目附 id（保留供 post-turn / memory_save 降级路径使用）。
- `rewriteChannelMemory` / `rewriteChannelHistory`：写前 `backupBeforeRewrite`（`.memory-backups/<name>-<ts>.md`，保留最近 5 代，best-effort）。
- `appendChannelHistoryArchive` + `getChannelHistoryArchivePath`：折叠前归档原始块到 `HISTORY.archive.md`。

### `src/memory/consolidation.ts`
- boundary/idle prompt 输出 schema 从 `memoryEntries: string[]` 升级为 `memoryOps`（add/supersede/invalidate），并带 `historyBlock`。
- prompt 展示当前 MEMORY.md 条目（含 id）供模型引用；要求条目自包含、关键词丰富。
- `parseConsolidationResponse` 兼容旧 `memoryEntries` 形状（映射为 add ops）。
- `runInlineConsolidation` 通过 `applyChannelMemoryOps` 落地。
- `cleanupChannelMemory` 增加可选 `guard` 参数与 `isCleanupResultTooSmall` 检查；触发时抛 `MemoryCleanupRejectedError`（走既有 failure backoff）。
- `foldChannelHistory` 折叠前调用 `appendChannelHistoryArchive`。

### `src/memory/candidates.ts`
- `buildCandidate` 剥离条目 id 注释，模型在 recall 注入里看不到 `<!--id-->`。

### `src/memory/maintenance-jobs.ts`
- structural job 把 `cleanupShrinkGuardMin*` 传给 `cleanupChannelMemory`。

## 测试

- `test/memory-write-ops.test.ts`：add/supersede/invalidate/坏 targetId 降级/legacy 匹配/备份保留上限/纯 add 不备份/history 归档。
- `test/memory-consolidation-ops.test.ts`：consolidation 应用 supersede、兼容旧 memoryEntries、缩水保护触发/放行。
- 现有 memory 套件（lifecycle/jobs/gates/scheduler/files/recall/session）全绿；6 处测试 fixture + e2e setup 补齐两个新 maintenance 字段。

## 后续（非本 spec）

- per-entry 检索索引（`description` → searchText）与召回使用统计（recall-stats）依赖本 spec 的条目 id，放到 P3。
- `HISTORY.archive.md` 接入 `session_search` 暂缓（底层对话已在 `log.jsonl` 冷存储可检索）。
