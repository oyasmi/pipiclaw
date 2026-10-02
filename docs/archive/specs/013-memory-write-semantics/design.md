# Memory Write Semantics 设计方案

| 字段 | 值 |
|------|------|
| 分支 | `master` |
| 状态 | DRAFT |
| 日期 | 2026-07-04 |
| 关联 spec | `docs/specs/009-memory-growth-and-recall/design.md`, `docs/specs/010-memory-maintenance-scheduler/design.md` |
| 关联实现 | `src/memory/files.ts`, `src/memory/consolidation.ts`, `src/memory/post-turn-review.ts`, `src/memory/candidates.ts` |

---

## 背景

当前频道 `MEMORY.md` 的写入是 **纯追加**（`appendChannelMemoryUpdate`）：

1. 没有更新/失效语义。用户改主意、任务完成后，旧条目只能靠周期性的 `cleanupChannelMemory` 整体重写来清理。矛盾条目会并存数小时到数天，recall 时按词法得分随机命中，行为不可预测。
2. `cleanupChannelMemory` 用一次 LLM 输出 **整体替换** 全文件，没有备份、没有缩水保护。某次 LLM 输出异常（只剩几行）就会永久抹掉多周积累的记忆。原子写只防半截文件，不防坏内容。
3. `HISTORY.md` 折叠是有损的，且上一次折叠的结果会参与下一次折叠，远期记忆无限模糊化。

## 目标

在 **保持 `MEMORY.md` / `HISTORY.md` 是人类可读、用户可审计的 Markdown** 前提下（这是现有系统的优点，不引入独立数据库），给写入端加上：

1. 条目稳定身份（entry id），为 supersede/invalidate/去重/召回统计打基础。
2. consolidation 输出从 `memoryEntries: string[]` 升级为操作语义 `memoryOps`（add / supersede / invalidate）。
3. cleanup / fold 的缩水保护与写前备份。
4. history 折叠时把原始块归档到 `HISTORY.archive.md`（纯追加，可被 `session_search` 检索），避免反复有损折叠。

## 非目标

- 不引入 embedding / 向量库。
- 不做 per-entry 独立召回索引（候选粒度仍是 section）。检索友好性通过 **prompt 要求写自包含、关键词丰富的 bullet** 实现，而不是新增 `description` 字段——避免半成品数据。per-entry 索引留给后续 P3/P4。

---

## 设计

### 条目身份

条目渲染格式：

```
- <content> <!--id:m-a1b2c3d4-->
```

- id = `m-` + 8 位随机 hex，写入时生成。
- HTML 注释对人不可见、对现有 `splitH2Sections` / bullet 解析无害（`session.ts` 已有 `stripHtmlComments` 先例）。
- 存量无 id 的旧条目：`parseChannelMemoryEntries` 用 `m-` + sha1(section+content) 合成 **确定性 id**，模型可在同一次 prompt 内引用；被 supersede 时补上真 id，存量文件随使用自然迁移，**无需一次性迁移脚本**。
- recall 注入与候选展示前 **剥离 id 注释**，模型永远看不到 `<!--id-->`。

### 操作语义

```ts
type MemoryOp =
  | { op: "add"; content: string }
  | { op: "supersede"; targetId: string; content: string }
  | { op: "invalidate"; targetId: string; reason?: string };
```

`applyChannelMemoryOps(channelDir, ops)` 采用 **行级编辑**（而非全量重建），以保留 `MEMORY.md` 中的任意 markdown（H1 头、章节 prose）：

- `supersede` / `invalidate`：定位携带 `targetId` 的 bullet 行（或存量条目按内容精确匹配），就地替换 / 删除。
- `add`：收集为一个新的 `## Update <ISO>` 块，追加到文件末尾。
- 防御：`targetId` 不存在的 supersede 降级为 add，invalidate 直接跳过；两者都记入 `memory-review.jsonl`。

consolidation 的 prompt 会 **带 id** 展示当前 `MEMORY.md`，并指示：内容与已有条目矛盾用 `supersede`，过时用 `invalidate`，全新才 `add`；每个 bullet 必须自包含、关键词丰富（利于后续词法召回）。

### cleanup / fold 护栏

写前备份：`rewriteChannelMemory` / `rewriteChannelHistory` 覆盖前把旧内容存到 `channelDir/.memory-backups/<name>-<ISO>.md`，保留最近 5 代（`.` 目录不进 session corpus 扫描）。

缩水保护（在 `cleanupChannelMemory` 内，拿得到 old+new 时判断）：新结果满足任一条件则 **拒绝写入**、记 review log、走既有 `failureBackoffUntil`：

- 新内容长度 < 旧内容 `shrinkGuardMinRatio`（默认 0.4）且旧内容 > 2000 字符；
- 解析出的条目数 < 旧条目数的一半（invalidate 语义落地后，正常清理不应一次砍半）。

阈值进 `PipiclawMemoryMaintenanceSettings`，因为"激进清理是否合理"因部署而异。

### history 归档

`foldChannelHistory` 折叠前，把被折叠的原始 section 追加到 `channelDir/HISTORY.archive.md`（纯追加、永不重写），作为可读的完整历史留存，避免反复有损折叠导致远期记忆永久模糊。

archive 不进 recall 候选（`candidates.ts` 只读固定四个文件）；也暂不接入 `session_search`——corpus 只扫描 `.jsonl`，而被折叠块的原始对话本就在 `log.jsonl` 冷存储里，`session_search` 已能检索到底层记录，因此把 `.md` archive 塞进 corpus 收益低、模型不匹配（corpus 是 role-based transcript）。archive 主要作为磁盘上的安全网与人工审计入口。

---

## 兼容性

- 旧 `MEMORY.md`（无 id、无 backups 目录）照常工作：解析合成确定性 id，首次 supersede 时补真 id。
- `appendChannelMemoryUpdate` 保留（供未接入 ops 的调用方与 P2-1 memory_save 降级路径使用），内部改为给条目附 id。
- 所有写入仍走 `channel-maintenance-queue` 共享串行队列，不新增竞争面。

## 测试

- ops 应用：add / supersede / invalidate / 坏 targetId 降级 / 存量无 id 条目按内容匹配。
- 缩水保护触发与不触发各一例；备份文件生成且保留上限为 5。
- fold 后 `HISTORY.archive.md` 含原始 section 原文。
- 端到端：consolidation 产出 supersede 时旧条目被替换而非并存。
