# 记忆子系统评审的修复实施计划

- 日期：2026-08-24
- 依据：`docs/reviews/2026-08-24-memory-subsystem.md`（下称"评审"）
- 基线：`39a307a`
- 分批原则：**每批独立通过 `npm run check`，每批都能单独回滚**。第一批是纯修复（不引入新概念），第二批起才动打分与语义。

---

## 0. 先说四件必须先知道的事

### 0.0 P0 的正确修法是**删除**，不是收窄——因为工具输出根本进不了提炼输入

评审 §1.1 建议里我写的是"删掉这个条件"，这里补上判断依据，因为这是本批唯一一处会被质疑"是不是在拆安全机制"的改动。

`hasExternalToolContent` 想防的是"不可信的工具输出污染 durable memory"。但提炼输入在更早的一层就已经不含工具输出了：

```ts
// src/memory/extraction.ts:238
serializeConversation(sanitizeMessagesForMemory(request.messages))

// src/memory/transcript.ts:56
buildStandardMessages(messages).filter((message) => message.role !== "toolResult")
```

而且这条不变量**已经被测试钉住**了：`test/memory-transcript.test.ts:76`，"drops tool results and redacts secrets before memory workers see them"。

也就是说：提炼模型**从来看不到任何 tool 输出**。它能看到的只有 assistant 自己的正文——那是模型自己的话，不是工具的话。如果连模型自己的正文都不可信，那么自动记忆整体不成立，封杀一个窗口也救不了。

所以这个布尔量是**冗余的第二道锁，锁的是一扇已经砌死的墙**，代价是把整个写入路径关掉。删。

同时删掉 `MemorySourceWindow.hasExternalToolContent` 字段本身（而不是留着不用）——留一个没有消费者的字段正是评审反复批评的形态。

**这条不变量的真正护栏**是 `memory-transcript.test.ts:76`，比布尔量更强也更可测。在 `extraction.ts` 的 `runMemoryExtraction` 上方加一行注释指向它，让下一个人知道"为什么这里不需要额外过滤"。

### 0.1 召回打分是"绝对证据制"，这决定了 query 扩展可以**免费**做

`scoreCandidate` 用的是 `evidence.mass`（命中 token 的特异性加权累加），**不按 query 长度归一**（`recall.ts:95-101` 有长注释解释为什么）。

推论：**往 query 里追加 token 只能增加某些候选的分数，不可能降低任何候选的分数。** 所以第二批的 query 扩展不存在"稀释"风险，唯一的风险是引入本轮不相关的匹配。这个风险用一个判据就能消掉——**只在当前 query 自己不可能过线时才扩展**（见 §2.1）。如果打分是覆盖率制，这个方案就不成立。

### 0.2 第二批之前必须先有召回门禁，这是 spec 037 自己定的规矩

spec 037 D10 明确写着：`recallCount` 参与排序这一类改动"影响面更大、会改变既有 durable 条目的命运，需要 recall eval（路线图 0.2）先建成硬门槛才能判断是升是降"。

现状：`M-recall-04`（10 问公司运作知识 quiz，fixture 与 `recallQuiz` grader 都已就绪）**不在 `evals/gates.json` 里**，`M-recall-02`（语义召回探针）是 `quarantine`。也就是说这道门槛至今没建成。

**第二批的第 0 项就是把它建起来**，否则后面三项打分改动全是盲改。

### 0.3 优先"接上"已经算出来的东西，而不是新增采集

第一批和第二批里有相当一部分工作量是"把已经存在的值接到消费者上"，不是新增字段：

| 已存在但无生产消费者 | 接到哪 |
|---|---|
| `InlineConsolidationResult.appendedDurableEntries` / `appendedProbationaryEntries` | review-log（§1.2）——**只有测试在读，生产日志里从来没出现过** |
| `MemoryReviewLogEntry.suggestions` / `candidates` | 无写入方，删（§1.6） |
| `MemoryEntryMetadata.recallCount` / `queryFingerprints` / `recallByDay` | 召回打分（§2.2） |
| `MemoryPromotionCandidate.necessity` | 落盘进 metadata，再接召回打分（§2.2） |

**只有 `necessity` 需要新增一个持久化字段**，其余都是接线。

---

## 1. 第一批：解封与可见性

改动集中在 5 个文件，不引入任何新概念，不改任何打分逻辑。

### 1.1 删除 `hasExternalToolContent` 写入封杀（P0）

**`src/memory/consolidation.ts:272-277`**

```diff
 	let appliedMemoryOps = 0;
-	if (
-		(durableCandidates.length > 0 || acceptedProbationary.length > 0) &&
-		!options.sourceWindow?.hasExternalToolContent
-	) {
+	if (durableCandidates.length > 0 || acceptedProbationary.length > 0) {
```

**`src/memory/source-window.ts`**：删除 `MemorySourceWindow.hasExternalToolContent` 字段、`hasToolResult()` 函数、两处赋值（`:76`、`:104`）。

**`src/memory/extraction.ts`**，在 `runMemoryExtraction` 上方补注释：

```ts
/**
 * ...
 * Tool output never reaches this prompt: `sanitizeMessagesForMemory` drops every `toolResult`
 * message before serialization (`transcript.ts`), an invariant pinned by
 * `test/memory-transcript.test.ts` ("drops tool results ... before memory workers see them").
 * That is why no additional untrusted-content filter is applied here — a window-level one used to
 * exist and silently discarded every durable write from any tool-using conversation.
 */
```

**测试改动**：

| 文件 | 改动 |
|---|---|
| `test/memory-source-window.test.ts:41-49` | 删掉 "marks windows containing tool results as externally sourced" 用例（断言的字段没了） |
| `test/memory-consolidation-ops.test.ts:69` | 删掉 `hasExternalToolContent: false` |
| `test/memory-consolidation-ops.test.ts` | **新增**用例："writes durable memory from a window that contains tool results"——source window 的 `entries`/`messages` 里放一条 `role: "toolResult"`，断言 MEMORY.md 里出现该条目。这是这次回归的钉子 |

**风险**：无。删掉的是一层被上游更强不变量覆盖的冗余检查，且新增用例把不变量的两端都钉住。

### 1.2 review-log 记录真实的三段数，让"候选被丢弃"不可能再隐身（P0 配套）

§1.1 之所以能活这么久，根因不是那一行 `if`，是**它失败时日志里什么都没有**。即使删掉那行，下一次出现同类问题仍然会隐身。所以这一项和 §1.1 是**同一次提交**的两半。

**`src/memory/maintenance-jobs.ts:302-306`**

```diff
 					: {
-							actions: [{ target: "MEMORY.md", action: "append", entries: result.appendedMemoryEntries }],
+							actions: [
+								{
+									target: "MEMORY.md",
+									action: "append",
+									entries: result.appendedMemoryEntries,
+									durableCandidates: result.appendedDurableEntries,
+									probationaryCandidates: result.appendedProbationaryEntries,
+								},
+							],
```

**`src/memory/lifecycle.ts:311-313`**——现在 `appendedMemoryEntries === 0` 时**一条 action 都不写**，改成"有候选就写"：

```diff
-		if (result.appendedMemoryEntries > 0) {
-			actions.push({ target: "MEMORY.md", action: "append", entries: result.appendedMemoryEntries });
+		const candidateCount = result.appendedDurableEntries + result.appendedProbationaryEntries;
+		if (candidateCount > 0 || result.appendedMemoryEntries > 0) {
+			actions.push({
+				target: "MEMORY.md",
+				action: "append",
+				entries: result.appendedMemoryEntries,
+				durableCandidates: result.appendedDurableEntries,
+				probationaryCandidates: result.appendedProbationaryEntries,
+			});
 		}
```

改完之后，评审 §1.1 描述的那个状态会在日志里长这样，一眼可见：

```json
{"reason":"memory-checkpoint-job","actions":[{"target":"MEMORY.md","action":"append","entries":0,"durableCandidates":3,"probationaryCandidates":1}]}
```

**测试**：`test/memory-maintenance-jobs.test.ts` 补一条断言——写入被 `applyChannelMemoryOps` 全部去重时，review-log 里 `durableCandidates > 0` 而 `entries === 0`。

### 1.3 cleanup：守卫顺序修正 + 用户条目 must-keep + 记录被删的 id（P1）

三处，都在 `src/memory/consolidation.ts`。

**(a) 守卫顺序：条目数守卫不该被小文件豁免。** 现状是 `before.length < 2000` 直接 `return false`，**排在条目数检查之前**，于是"4 个短 Update 块 ≈ 300 字符"这个 cleanup 最常见的触发形态完全不设防——而它正好是 `shouldCleanupChannelMemory` 的第二个触发条件。

```diff
 function isCleanupResultTooSmall(currentMemory, nextMemory, guard): boolean {
 	const before = normalizeText(currentMemory);
 	const after = normalizeText(nextMemory);
 	const beforeEntries = parseChannelMemoryEntries(before).length;
 	const afterEntries = parseChannelMemoryEntries(after).length;
 	if (beforeEntries > 0 && afterEntries === 0) return true;
-	if (before.length < Math.max(0, guard.cleanupShrinkGuardMinChars)) return false;
-	if (after.length < before.length * Math.max(0, Math.min(1, guard.cleanupShrinkGuardMinRatio))) {
-		return true;
-	}
-	return beforeEntries > 0 && afterEntries * 2 < beforeEntries;
+	// Entry-count guard applies at every file size. The char threshold below exists so a tiny
+	// file is not judged on byte ratio, but "four short Update blocks" is exactly the shape
+	// cleanup fires on and it sits under that threshold — letting the char escape short-circuit
+	// the entry guard left the most common cleanup input completely unprotected.
+	if (beforeEntries >= 4 && afterEntries * 2 < beforeEntries) return true;
+	if (before.length < Math.max(0, guard.cleanupShrinkGuardMinChars)) return false;
+	return after.length < before.length * Math.max(0, Math.min(1, guard.cleanupShrinkGuardMinRatio));
 }
```

保留 50% 而不是收到 25%：cleanup 的本职就是去重合并，硬收比例会让它反复被拒 → 走 backoff → 记忆不清理反而无限增长。**"重要的东西不能丢"这一半交给 (b) 的 id 白名单**，比比例更精确。

**(b) 用户明说要记的条目进 must-keep 名单，prompt 与校验器双保险。**

```ts
// cleanupChannelMemory 内，构造 prompt 之前
const metadata = await readMemoryMetadata(options.channelDir);
const mustKeepIds = parseChannelMemoryEntries(currentMemory)
	.map((entry) => entry.id)
	.filter((id) => metadata.entries[id]?.sourceType === "user");

const prompt = [
	mustKeepIds.length > 0
		? `These entries were saved on the user's explicit instruction and MUST appear verbatim in the output: ${mustKeepIds.join(", ")}`
		: "",
	`Current MEMORY.md:\n${clipText(currentMemory, MEMORY_CLEANUP_INPUT_MAX_CHARS, { headRatio: 0.5 })}`,
].filter(Boolean).join("\n\n");
```

`validateCleanupSchema` 增加一条（它已经在做 id 集合校验，加这条几乎零成本）：

```ts
const missing = mustKeepIds.filter((id) => !ids.has(id));
if (missing.length > 0) return `cleanup output dropped user-saved entries: ${missing.join(", ")}`;
```

失败走既有的 `MemoryCleanupRejectedError`，消息末尾已经带 "Retry cleanup while preserving the MEMORY.md schema and ids."——符合 AGENTS.md 的"错误要带下一步指令"。

**(c) 记录被删的 id。** `cleanupChannelMemory` 的返回值从 `boolean` 改成显式结果（AGENTS.md：显式类型优于布尔）：

```ts
export interface MemoryCleanupResult {
	rewritten: boolean;
	droppedEntryIds: string[];
}
```

`maintenance-jobs.ts` 相应写进 review-log：

```ts
...(cleanup.rewritten
	? [{ target: "MEMORY.md", action: "rewrite", droppedEntryIds: cleanup.droppedEntryIds }]
	: []),
```

顺手补上 (a) 里出现的 `MEMORY_CLEANUP_INPUT_MAX_CHARS`（评审 §1.3(c)：现在整份 MEMORY.md 无裁剪进 prompt）。取 `24_000` 与 `extraction.ts` 的 8000/28000 量级对齐即可。

**测试**（`test/memory-consolidation-ops.test.ts` 或新建 `test/memory-cleanup-guard.test.ts`）：
1. 6 条短条目 / 总长 < 2000 字符，cleanup 输出只剩 2 条 → 被拒（这条在今天会通过，是本项的回归钉）；
2. 输出丢掉一条 `sourceType: "user"` 的条目 → 被拒，错误消息含该 id；
3. 正常收敛（8 条去重成 6 条）→ 通过，且 `droppedEntryIds` 长度为 2。

### 1.4 rerank 返回空数组时保留本地 top-1（P1）

**`src/memory/recall.ts:641-643`**

```diff
 		const selectedIds = new Set(result.output);
 		if (selectedIds.size === 0) {
-			return [];
+			// The reranker only ever runs on a shortlist that already cleared MIN_MATCH_EVIDENCE,
+			// so "nothing is relevant" is a judgement call over candidates with real lexical
+			// evidence behind them. Injecting one extra item costs a few hundred units; injecting
+			// nothing costs the turn its memory — and "it forgot what I told it" is this
+			// subsystem's most common complaint. Floor at the local top pick.
+			log.logEvent("debug", "memory.recall.rerank.empty", "Reranker selected nothing; keeping local top-1", {
+				fields: { shortlist: candidates.length },
+			});
+			return candidates.slice(0, 1);
 		}
```

**为什么是 top-1 而不是 top-N**：这是一个"两种失败方向不对称"的选择题，不是调参。保留 1 条把最坏情况从"本轮零记忆"变成"本轮多一条可能无关的记忆"，而 `maxInjected = 5` 的其余 4 格仍然由重排的判断支配。

**同一函数里的 fail 方向也要统一**：`catch` 分支返回全部候选（fail-open），空数组返回零（fail-closed），方向相反且更差的那个留给了最常见的情况。改完之后两条都是"至少给一条"。

**测试**：`test/memory-recall.test.ts` 新增——mock `runSidecarTask` 返回 `{"selectedIds":[]}`，`rerankWithModel: true`，断言 `items.length === 1` 且是本地最高分那条。

### 1.5 sidecar 用量在 abort / error 路径也记账（P1）

**`src/memory/sidecar-worker.ts:213-224`**

```diff
 		if (lastMessage.stopReason === "error" || lastMessage.stopReason === "aborted") {
+			// Record before throwing: a timed-out or aborted rerank still consumed provider tokens.
+			// Skipping it made every timeout invisible spend — `/usage`'s sidecar line was
+			// systematically low by exactly the calls we were paying for and discarding.
+			recordSidecarUsage(task, lastMessage);
 			throw new Error(lastMessage.errorMessage || `Sidecar task "${task.name}" failed`);
 		}
-
-		recordSidecarUsage(task, lastMessage);
+		recordSidecarUsage(task, lastMessage);
```

`recordSidecarUsage` 在 `!usage.cost` 时已经自己 early-return，所以没有 usage 的错误路径不会写脏数据。超时路径上 `Promise.race` 已经先 reject，但 `runPromise` 仍在后台跑完（`void runPromise.catch(() => {})`），记账会稍晚落账本——这是可接受的，账本本来就是异步聚合。

**顺带**：`memory-recall-rerank` 的 `usageContext` 目前不带 `correlationId`（`recall.ts:632`），而 review-log / source window 都在用 correlation id 串成本。补一个 `correlationId: \`recall:${channelId}:${当前 turn 的窗口标识}\`` 意义不大（召回不产出 review-log 条目），**这一条不做**，避免为了对称而对称。

**测试**：`test/sidecar-worker.test.ts` 补一条——`stopReason: "aborted"` 且带 usage 时，ledger 收到一条 `kind: "sidecar"` 记录，且函数仍然抛错。

**改完之后再决定要不要动 3s 超时。** 评审 §1.2 建议提到 6s，但在账本能看见超时开销之前那是拍脑袋。正确顺序是：先让超时可见（本项）→ 跑一周看 `/usage` 里 `memory-recall-rerank` 的调用数与成功率 → 再决定是放宽超时还是收紧 rerank 触发条件。**本批不改超时值。**

### 1.6 `/memory pending` → `/memory recent`（P1）

评审给了删/接两个选项。**选"接"**，因为：(a) 死代码要删的部分（`suggestions` 的 sha256 指纹、`slice(-50)` 分页）和要新增的部分（读 review-log 的 actions）是同一段代码的两种用法，一次改完；(b) 它同时解掉评审 §2.7 的"用户没有信任面"——后台学到/删掉了什么，用户问得出来。

**`src/memory/review-log.ts`**：删除 `MemoryReviewLogEntry.suggestions` 与 `candidates`（两者**都没有任何写入方**，前者是 §1.5 的死链路，后者连读取方都没有），并同步简化 `gateSkipOnly` 判据。

**`src/memory/commands.ts`**：`readPendingSuggestions` → `readRecentMemoryActions(channelDir, sinceMs)`，读同一个文件，改读 `entry.actions`：

```ts
interface RecentMemoryAction {
	timestamp?: string;
	reason: MemoryReviewReason;
	target?: string;
	action?: string;
	entries?: number;
	droppedEntryIds?: string[];
	entryId?: string;   // user-forget 的 action 形状不同，容忍解析
}
```

- `/memory recent` 渲染最近 7 天的 `MEMORY.md` 类动作，按时间倒序，最多 30 条；
- `/memory status` 把 `- Pending suggestions: N` 换成 `- Last 7d: +A written / -B dropped / -C expired`（A = append 的 `entries` 累加，B = `droppedEntryIds` 长度累加 + forget 条数，C = `action: "expire"` 的 `entries` 累加）；
- `renderUsage()` 的用法提示同步改。

**测试**：`test/memory-commands.test.ts`（现 52 行）补两条——写入一段合成 review-log 后 `/memory recent` 能列出 append/rewrite/expire 三类；`/memory status` 的 7 日汇总数字正确。

### 1.7 新增 eval：含工具调用的窗口必须能写出 durable 记忆

这是本批唯一的行为层护栏。**没有它，§1.1 一定会以另一种形式复发**——现有 4 条记忆用例全部跑在 `warmupTurns` 上，而那 8 条 warmup 话题一次工具都不调（`evals/cases/helpers.ts:107-116`），整个门禁跑在缺陷的豁免侧。

**`evals/fixtures/memory/release-window.md`**（新建，任意几行团队笔记即可）

**`evals/cases/regression.ts`**：

```ts
{
	id: "M-write-04",
	suite: "regression",
	source: "2026-08-24 memory review §1.1: any window containing a toolResult silently discarded every durable memory op",
	description:
		"A hard constraint stated in the same window as a real tool call reaches MEMORY.md through background " +
		"consolidation. Every pre-existing memory case ran on tool-free warmup turns, which is why a blanket " +
		"suppression of tool-bearing windows went unnoticed. The turn is phrased so the model has no reason to " +
		"call memory_manage — the write has to come from the consolidation path, not the explicit one.",
	definitionFile,
	fixtures: ["memory/release-window.md"],
	setup: async (ctx) => copyFixture(ctx, "memory/release-window.md", "dm_eval/notes/release-window.md"),
	budget: { maxWallMs: 300_000, maxTurns: 12 },
	script: [
		{
			kind: "user",
			text: "帮我看下 notes/release-window.md 写了什么，两句话总结就行。另外提一句，我们所有发布现在必须放在周四晚上，这是运维那边卡死的硬性规定。",
		},
		...warmupTurns(1),
		{ kind: "runMemoryMaintenance" },
	],
	graders: [
		tracePredicate(
			"tool-was-actually-used",
			(ctx) => ctx.trace.some((event) => event.kind === "tool-call" && event.tool === "read"),
			"the window must contain a real toolResult for this probe to mean anything",
		),
		toolCallCount("no-explicit-save", "memory_manage", 0),
		fileContains("durable-write-survived-tool-window", "MEMORY.md", /周四/),
	],
},
```

**`evals/gates.json`**：`"M-write-04": { "gate": "required", "minPass": "2/3" }`，`trials: 3`。2/3 而不是 3/3——固化依赖模型把这条判成 `necessity: high` + `confidence ≥ 0.85`，偶发的标定波动应该被报告而不是当成产品回归（与 `M-write-03` 同样的理由）。

### 第一批测试与文档改动清单

| 文件 | 动作 |
|---|---|
| `test/memory-source-window.test.ts` | 删 1 条用例 |
| `test/memory-consolidation-ops.test.ts` | 改 1 处 fixture，加 1 条用例 |
| `test/memory-cleanup-guard.test.ts` | 新建，3 条用例 |
| `test/memory-recall.test.ts` | 加 1 条用例 |
| `test/memory-maintenance-jobs.test.ts` | 加 1 条断言 |
| `test/memory-commands.test.ts` | 加 2 条用例 |
| `test/sidecar-worker.test.ts` | 加 1 条用例 |
| `evals/cases/regression.ts` + `evals/gates.json` + fixture | 新增 M-write-04 |
| `docs/memory.md` | 修正五层表的"是否自动进入对话"列（SESSION.md / HISTORY.md 都是召回候选源）；`/memory pending` → `/memory recent` |
| `docs/architecture.md §6.2` | 删掉不再存在的 `hasExternalToolContent` 相关表述（若有）；补一句"工具输出在 `sanitizeMessagesForMemory` 就被剥离，是提炼输入的可信边界" |
| `CHANGELOG.md` | 两条用户可见变化：含工具调用的对话现在会正常进入长期记忆；`/memory recent` |

---

## 2. 第二批：召回质量

### 2.0 前置（必须先做）：把召回门禁建起来

1. **`M-recall-04` 进 `evals/gates.json`**。它已有 fixture（`company-30d-{memory,history}.md`）、已有 `recallQuiz` 双指标 grader（recall / precision 分开算，"我不知道"计 recall miss 但不计 precision miss）。先跑一轮拿到当前基线数字，按基线**下方一档**设门槛（不要按期望值设，那会让第一次改动就红）。
2. **新增 `M-recall-05`：多轮指代**。这是 §2.1 的直接被测面，现在完全没有覆盖：

```
turn 1: 我们发布现在固定在周四晚上，代号 THURSDAY-GATE。
...warmupTurns(3)
turn 5: 上次说的那个发布安排，代号是什么来着？只回答代号。
```

turn 5 的实词只有"发布/安排/代号"，全是低特异性 token，**今天必然召回失败**。先以 `report-only` 落地拿基线，§2.1 落地后再提 `required`。

3. **`M-recall-02`（纯语义、无词法重叠）保持 `quarantine`。** 它是第三/四批之后才可能转绿的探针，不该进门禁。

**没有这三步，本批后面三项一律不做。**

### 2.1 弱查询时借用上一轮用户消息

**判据**（这是本项的全部精妙之处，其余是接线）：

```ts
// src/memory/recall.ts
/**
 * A query whose own tokens cannot reach MIN_MATCH_EVIDENCE can never retrieve anything on its
 * own — a deictic follow-up ("那个方案后来怎么定的") is all stop-words and low-specificity
 * fragments. Only then is it worth borrowing the previous user turn. When the current message
 * *can* clear the bar by itself, expansion changes nothing about which candidates pass, because
 * scoring is absolute evidence mass rather than query-length-normalized coverage — so this
 * predicate is the whole safety argument: expansion is invisible except exactly where recall
 * would otherwise return empty.
 */
function hasWeakQuerySignal(queryTokens: string[]): boolean {
	return queryTokens.reduce((sum, token) => sum + tokenSpecificity(token), 0) < MIN_MATCH_EVIDENCE;
}
```

**接线**（`src/agent/channel-runner.ts:463`）：新增 `RecallRequest.contextQuery?: string`，由 runner 提供上一条用户消息：

```ts
const recall = await recallRelevantMemory({
	query: clippedInput,
	contextQuery: findPreviousUserText(this.session.messages),
	...
});
```

`findPreviousUserText` 必须走 `stripInjectedMemoryContext`（`transcript.ts:16`）——否则借来的是上一轮**注入的召回文本**，会形成"召回自己召回过的东西"的正反馈回声，这正是 `transcript.ts` 顶部注释警告的那类 bug。放在 `recall.ts` 里实现并复用该函数。

`contextQuery` **只参与打分，不进 prompt**，也不进 `recordMemoryRecall` 的 query 指纹（指纹要反映用户真实问法）。

**测试**：`test/memory-recall.test.ts` 三条——弱查询 + contextQuery 命中；强查询 + contextQuery 时结果与不带 contextQuery **逐条相同**（证明零副作用）；contextQuery 里含 `<runtime_context>` 块时被剥离。

### 2.2 召回统计与 necessity 接入排序

**(a) `necessity` 落盘**。`MemoryEntryMetadata` 与 `MemoryWriteMetadataInput` 各加一个可选字段，`toMemoryOp`（`extraction.ts:175`）在 `metadata` 里带上 `necessity: candidate.necessity`，`syncMemoryMetadata` 的逐字段重建**必须带上它**（`probationUntil` 有过同样的坑，spec 037 实施清单里专门点了名）。`schemaVersion` 不变——可选字段，旧文件读进来是 `undefined`，走默认。

**(b) 打分接线**。`recallRelevantMemory` 里读一次 metadata（每轮 1 次读；同批 §2.3 会减掉 2 次写，净收益为正）：

```ts
const metadata = await readMemoryMetadata(request.channelDir);
const statsFor = (entryId?: string) => (entryId ? metadata.entries[entryId] : undefined);
```

`scoreCandidate` 的 `structuralScore` 增加一项：

```ts
const USAGE_BOOST_MAX = 6;
const STALE_PENALTY = 2;
const STALE_AFTER_DAYS = 90;
const NECESSITY_BOOST = { high: 4, medium: 1, low: 0 } as const;

function computeMemoryUsageBoost(record: MemoryEntryMetadata | undefined, nowMs: number): number {
	if (!record) return 0;
	// Distinct query fingerprints matter more than raw count: one person asking the same thing
	// twenty times is one recurring need, twenty different phrasings is a fact the channel keeps
	// bumping into from different directions.
	const used = Math.min(
		USAGE_BOOST_MAX,
		1.5 * Math.log2(1 + record.recallCount) + 1.5 * Math.log2(1 + record.queryFingerprints.length),
	);
	const stale =
		record.sourceType === "agent" && isOlderThanDays(record.lastRecalledAt ?? record.createdAt, STALE_AFTER_DAYS, nowMs)
			? STALE_PENALTY
			: 0;
	return used - stale + (NECESSITY_BOOST[record.necessity ?? "low"] ?? 0);
}
```

**量级是刻意小的，要写进注释**：`structuralScore` 以 `score = evidence × (1 + structuralScore / 100)` 参与，当前范围约 4–34；本项最多再加 10，也就是**最多 +10% 的乘数**。它是**决胜局裁判，不是主裁判**——词法证据仍然决定谁能入围。这样定的理由有两条：(i) "被召回过"这个信号本身很弱（它记录的是"进了 prompt"，不是"被用上了"，见评审 §2.1）；(ii) 富者愈富的正反馈必须被上限压住。**真正的权重要等 §2.0 的门禁跑出数字之后再调**，本项先落地管道 + 一个保守权重。

**用户条目不吃 stale 惩罚**（`sourceType === "agent"` 才罚）：用户明说要记的东西没被问起，不是它该被降权的理由。

**测试**：`test/memory-recall.test.ts` 补两条——两条词法证据完全相同的候选，`recallCount` 高的排前面；`sourceType: "user"` 且 180 天未召回的条目排序不受惩罚。

### 2.3 metadata 写入瘦身 + 去掉召回路径的 reconcile 职责

**(a) 删掉召回路径的 `syncMemoryMetadata`**（`recall.ts:802`，紧邻的 `recordMemoryRecall` 保留）。

召回拿的是 `MemoryCandidateStore` 的缓存快照，用一个可能过期的集合去 reconcile，是评审 §1.8 那个"条目在文件里、metadata 却是 invalidated"竞态的唯一来源。而 reconcile 本来就有稳妥的归属：`applyChannelMemoryOps` 开头做一次、`rewriteChannelMemory` 结束做一次、`/memory` 命令做一次——**所有写路径都覆盖了**，召回这条只读路径不该承担它。

删掉之后 `recordMemoryRecall` 会跳过没有 metadata 记录的条目（它只处理 `status === "active"`）。这只影响历史遗留的、从未经任何写路径的条目，`/memory status` 跑一次即可补齐。

**(b) `syncMemoryMetadata` 无变化时不写盘**：

```ts
const nextEntries = { ... };
if (updates.length === 0 && JSON.stringify(nextEntries) === JSON.stringify(current.entries)) {
	return current;   // updatedAt 不是变更信号，不为它付一次原子写
}
```

`recordMemoryRecall` 里已经有一个同款的 `changed` 早退（`metadata.ts:203`），这是把同一个判断补到姊妹函数上。

**净效果**：每轮用户消息从"2 次 entries.json 原子写 + 0 次读"变成"1 次读 + 1 次写（且只在真的有召回时）"。

**测试**：`test/memory-metadata.test.ts` 补一条——连续两次 `syncMemoryMetadata` 传入相同 entries，第二次不改变文件 mtime。

---

## 3. 第三批：冲突消解与时效

### 3.1 `memory_manage save` 的冲突检测（评审 §2.4）

**问题**：用户先后说"用 npm"和"以后默认 pnpm"，得到两条并列 active 条目；去重只按 contentHash 精确匹配。文档现在把这个责任写给了用户（"改主意时说'忘掉旧的'"）。

**改法**：`save` 在写入前复用**已经在 `search` op 里跑着的**那条召回管道：

```ts
async function save(args: MemoryManageArgs) {
	...
	if (!args.supersedes) {
		const { items } = await recallRelevantMemory({
			query: trimmed,
			allowedSources: ["channel-memory"],
			maxCandidates: 3, maxInjected: 3, maxChars: 1200,
			rerankWithModel: false,       // 与 search op 一致：确定性点查，不额外花钱
			...
		});
		const similar = items.filter((item) => item.entryId && item.score >= SAVE_CONFLICT_SCORE);
		if (similar.length > 0) {
			throw new RecoverableToolError(
				`Nothing was saved yet. This channel already stores ${similar.length} similar entr${...}:\n` +
				similar.map((item) => `- ${item.entryId}: ${item.content}`).join("\n") +
				`\nRe-issue the save with "supersedes" set to the entry id this replaces, ` +
				`or to "none" if both facts are true at the same time.`,
			);
		}
	}
	// supersedes === "none" → 普通 add；否则 → { op: "supersede", targetId: args.supersedes }
}
```

schema 增一个可选字段：

```ts
supersedes: Type.Optional(Type.String({
	description:
		'For save, only after this tool reported a similar existing entry: the entry id being replaced, ' +
		'or "none" to keep both.',
})),
```

**不会死循环**：第一次调用无 `supersedes` → 报冲突；第二次带上 → 直接执行，不再查重。这正好落在 AGENTS.md 那条"模型能自己修的就用 `RecoverableToolError`"上。

**`SAVE_CONFLICT_SCORE` 怎么定**：必须偏高（宁可漏报也不要每次 save 都打断），建议从 `HIGH_CONFIDENCE_SCORE = 8` 起步，并在 `M-write-03`（长中文单次 save）上验证不会被误触发——那条用例的 grader 里有 `toolCallCount("single-shot-save", "memory_manage", 1)` 和 `noFailedToolResult`，**误触发会直接把它打红**，是现成的护栏。

### 3.2 提炼 prompt 从"看全量条目"改成"看相似条目"

**问题**（评审 §2.4）：`renderMemoryEntriesForPrompt` 把**全部**条目 clip 到 8000 字符喂给模型，让它自己找该 supersede 谁。条目一多，`supersede`/`invalidate` 就形同虚设——这也是 MEMORY.md 只增不减、只能靠 cleanup 兜底的根因之一。

**改法**：`runMemoryExtraction` 里，当条目数超过阈值（比如 40）时，不再全量渲染，而是用**本次窗口的转写文本**当 query 跑一次词法召回，只把 top-N（比如 20）条目 + 全部 `sourceType: "user"` 条目渲染进 prompt，并在 prompt 里说明"这是与本段对话最相关的条目，不是全部"。

条目数少时保持全量——避免为小频道引入无谓的间接层。

**这一项要等 §2.0 的门禁，且要单独观察 `M-recall-04` 的 precision 分量**：喂给模型的条目变少，理论上 supersede 的准确率上升、遗漏上升，方向不确定，必须实测。

### 3.3 明确不做：事实有效期（bi-temporal）

评审 §2.4 提到 Zep/Graphiti 的双时间模型（fact 何时成立 / 何时失效，与何时被记录分开）。**本轮不做**：

- 它需要提炼 prompt 额外产出 `validFrom`/`validUntil`，而模型对这两个值的标定质量完全未知；
- `probationUntil` 已经提供了一种"到期"语义，再加一种会让 `/memory` 的状态空间从 4 态涨到 8 态；
- 没有消费者设计——按评审自己的标准，这就是"采集了却没有消费者"。

要做的前置是先有一个能测出"系统答了过期事实"的 eval（`M-recall-04` 的 precision 分量是雏形），再谈。

---

## 4. 第四批：跨频道晋升（需要独立 spec）

这一批**不在本计划的实施范围内**，只给出形状和必须先回答的问题，因为它是一次安全边界的改动，不该在实现里顺手决定。

**形状**（评审 §2.2）：三条合取的保守规则 + 提案而非自动写入

1. 资格：`kind ∈ {preference, constraint}` 且 `sourceType === "user"`；
2. 证据：同一 `contentHash` 在 **≥2 个不同频道**被独立学到；
3. 落地：写成提案，进 §1.6 建好的 `/memory recent` 同源面（新增 `/memory promote list|approve <id>`），由管理员批准后写入 `workspace/MEMORY.md`。

**必须先回答的三个问题**：

- **私聊 → 群的方向是否允许？** 规则 2 的"≥2 个频道"能挡住单一私聊泄漏，但两个私聊之间的共同事实晋升到 workspace 后，群里也能看见。这是产品决策，不是实现细节。
- **contentHash 精确匹配够不够？** 同一事实的两种措辞哈希不同，规则 2 会失效；而放宽到语义匹配就把第三批的检索能力变成了安全边界的一部分。
- **晋升后原频道条目怎么办？** 保留会造成双份、召回时重复注入；删除会让频道失去局部上下文。倾向保留 + 召回时按 `entryId`/`contentHash` 去重（`bootstrap` 与 `recall` 之间已有 `excludedCandidateIds` 的去重先例）。

**前置**：第一批必须先落地。在自动写入被封死的前提下讨论跨频道晋升没有意义——频道里根本没有自动学到的东西可晋升。

---

## 5. 随手清理（不占批次，可搭任意一批）

| 项 | 位置 | 说明 |
|---|---|---|
| `HISTORY.archive.md` 改 append-only + 轮转 | `files.ts:465` | 现在每次折叠都全量读+全量写（O(n²)）且无上限。改 `appendFile`；超过 4MB 时 rename 成 `.1`（覆盖旧的），最多两代。**不要删这个文件**——它保存的是第一代 LLM 摘要，`context.jsonl` 里没有 |
| `session-search` 的覆盖率归一 | `session-search.ts:186` | `coverage = matched / queryTokens.length` 是 `recall.ts` 已经废弃并写了长注释批判的打分法。这里 `matchedTokens * 1.4` 是主项所以危害小，但两个检索器用相反哲学会长期制造困惑。改成与 recall 一致的证据制，或至少在注释里说明为什么这里保留 |
| tombstone `sourceEntryIds` 收窄 | `files.ts:283` | 现在存的是**整个窗口**的 entry id，是"按窗口连坐"伪装成"按条目防复活"。当前危害有限（窗口游标单调推进），但窗口策略一旦变成重叠滑窗就立刻是 bug。收窄成该条目真实来源，或只依赖 contentHash |
| `MEMORY_BACKUP_KEEP` 从 5 提到 10 | `files.ts:72` | §1.3 之后 cleanup 的破坏力已经受控，但备份是最后一道网，5 份在 6 小时一次的节奏下只覆盖 30 小时 |

---

## 6. 每批验收

**通用**：`npm run check` 全绿（含 knip——§1.1 / §1.6 删字段后不得留孤儿导出）。

| 批次 | 额外验收 |
|---|---|
| 一 | `M-write-04` 三次试跑至少 2 次绿；手工跑一个用了 `read` 的真实频道，`memory-review.jsonl` 里能看到 `durableCandidates` 与 `entries` 两个数 |
| 二 | `M-recall-04` 不低于第 2.0 步记录的基线；`M-recall-05` 从红转绿并提为 `required`；`/usage` 的 sidecar 行包含超时的 rerank 调用 |
| 三 | `M-write-03` 仍然绿（冲突检测未误触发，见 §3.1）；`M-recall-04` 的 precision 分量不下降 |
| 四 | 独立 spec 定义 |

**每批都要更新 `CHANGELOG.md`**，且第一批那条要写清楚用户可感知的变化：**含工具调用的对话现在会正常进入长期记忆**。这是一次行为回归的修复，不是新特性，用户需要知道"以前它为什么记不住"。

---

## 7. 明确不做

按评审"没有发现需要拆掉的过度设计"的结论，以及 AGENTS.md"健壮而直接"的标准，以下几条**刻意不做**，写下来是为了防止后续讨论重开：

1. **不为记忆引入向量库 / embedding 检索。** 在 §2.0 的门禁跑出数字之前无法判断是升是降；而 §2.1（query 扩展）与 §3.2（相似条目喂 prompt）用现成的词法管道就能吃掉大部分收益。要做也应该是一次独立 spec，且必须先证明词法路线的天花板已经到了。
2. **不新增任何"闸"。** 评审的核心批评是"只有闸没有轮"，§1.3 的 must-keep 是给现有闸门补一条白名单（收缩其误伤面），不是新增判据。任何"再加一道置信度/预算/阈值"的提案本轮一律拒绝。
3. **不把 `necessity`/`confidence` 阈值放进 `settings.json`。** spec 035 已经把这一类退役为代码常量（`RETIRED_SETTINGS_KEYS`），§2.2 的新权重同属算法参数。
4. **不给 rerank 加 correlationId 串账。** 召回不产出 review-log 条目，串了也没有对端，是为对称而对称（见 §1.5 末段）。
5. **不动 `MemoryLifecycle` 的边界固化时机、`ChannelMemoryQueue` 单例、试用期的三条转正路径、以及 "supersede/invalidate 永不进试用期" 这条不变量。** 这四处是评审 §4 明确圈出的"复杂度买到了正确性"的部分，任何改动都要单独论证。
