# 记忆子系统评审报告

- 日期：2026-08-24
- 范围：`src/memory/**`（29 个文件 / 6,642 行）、`src/tools/memory-manage.ts`、`src/tools/session-search.ts`，以及它们在 `src/agent/channel-runner.ts`、`src/settings.ts`、`src/playbooks/memory-and-learning.md`、`evals/cases/*` 上的接缝
- 基线：`39a307a`（0.9.1-beta.2 之后）
- 性质：评审输入，不是设计记录。落地应另起 spec 或按 §5 的顺序分批改。
- 与既有材料的关系：spec 037 的 L1（两档写入 + 试用期）已实现；其 D10 明确留给 L2/L3 的部分**至今没有承载文档**——`docs/refer/` 已在 `56dd02e` 清空，那份 2026-07-31 的长程自主评审只剩 spec 037 引用中的转述。本报告在 §3 重建这条线。

---

## 0. 总体判断

**分层是对的，而且是这个子系统最值钱的资产。** 五层文件（SESSION / MEMORY / HISTORY / 冷存储 / workspace 共享）职责不重叠；`maintenance-gates.ts` 把"要不要花钱"和"花钱干什么"彻底分开，纯函数、可测试、gate 不放行零 LLM 成本；`extraction.ts` 把三条曾经各写各 prompt 的固化路径收敛成一条；`sidecar-worker.ts` 是所有记忆 LLM 调用的唯一出口，带超时/重试/记账。`recall.ts` 从"覆盖率制"改成"证据制"是一次真正的认知修复——它修的是"用户说得越详细召回越少"这种反直觉行为，而不是调参。这些都不该动。

**但整个子系统当前处在一个尴尬的状态：写入端被一条无人知晓的短路封死，读出端采集了大量信号却不消费。**

具体说：

1. **`consolidation.ts:276` 的 `!hasExternalToolContent` 让"任何含 tool 调用的对话窗口一条 durable memory 都不写"**，而且**零日志、零 review-log、零测试覆盖**（§1.1）。这是本次最重的一条：它在事实上作废了 spec 037 花整节篇幅修的 L1 闸门，把系统重新压回"只有用户明说'记住'才有记忆"的状态——正是 spec 037 判定为"结构性地学不会一家公司日常运作知识"的那个状态。
2. **`recallCount` / `lastRecalledAt` / `recallByDay` / `queryFingerprints` 四个字段全项目只有 `/memory status` 一个消费者**（§2.1）。spec 037 D3 亲自写下"采集了却没有任何消费者正是评审 L2 批评的那个错误，不能在修 G1 时重犯"——这句话现在适用于记忆域自己。
3. **召回的最后一道关口是"模型返回空数组即本轮零记忆"**，没有 top-1 兜底（§1.2）。对一个用户最常见抱怨是"它忘了我说过的话"的系统，这个 fail-closed 的方向选反了。

按"健壮而直接、不要精巧而脆弱"的标准，本次**没有**发现需要拆掉的过度设计。`maintenance-gates` 的 thunk 物料、`MemoryCandidateStore` 的 fingerprint 缓存、`MemoryActivityRecorder` 的可结合折叠批处理，这三处复杂度都买到了对应的正确性或成本。唯一"复杂度没买到东西"的是 `/memory pending` 整条链路（§1.5）。

---

## 1. 实现层缺陷（可验证，按影响排序）

### 1.1 **P0** — 含 tool 结果的窗口一条自动记忆都不写，且完全不可观测

```ts
// src/memory/consolidation.ts:273-278
if (
    (durableCandidates.length > 0 || acceptedProbationary.length > 0) &&
    !options.sourceWindow?.hasExternalToolContent
) {
    ... applyChannelMemoryOps(...)
}
```

`hasExternalToolContent` 来自 `source-window.ts:76/104`：

```ts
hasExternalToolContent: hasToolResult(messages)   // messages 里任意一条 role === "toolResult"
```

而 `SessionMessageEntry.message` 就是原始 `AgentMessage`（`pi-coding-agent/dist/core/session-manager.d.ts:23`），`AgentMessage` 包含 `role: "toolResult"`（`pi-ai/dist/types.d.ts:304`，本仓库 `shared/type-guards.ts:13` 也把它列为标准角色）。

**推论**：只要一个固化窗口里出现过**任何一次工具调用**——`read`、`bash`、`web_search`、`task_manage`，乃至 `memory_manage` 本身——这个窗口的全部 memoryOps 就被整体丢弃。

这条规则同时作用在四条固化路径上（`compaction` / `new-session` / `shutdown` 走 `buildCompactionMemorySourceWindow` 或 `buildIncrementalMemorySourceWindow`，idle checkpoint 走后者），**没有任何一条能豁免**。对一个 coding assistant 而言，"这一段对话里一次工具都没用过"是少数派；对钉钉群里的闲聊窗口才是多数派。

**三条加重情节**：

1. **完全静默。** 被丢弃时 `appendedDurableEntries` 仍然记录 `durableCandidates.length`（>0），但 `appendedMemoryEntries = 0`。于是：
   - `maintenance-jobs.ts:302` 写的 review-log 是 `actions: [{target:"MEMORY.md", action:"append", entries: 0}]`，`skipped` 里只有置信度不足的候选，**被封杀的高置信候选一条都不在**；
   - `lifecycle.ts:281` 的 `recordConsolidationReview` 因为 `appendedMemoryEntries === 0` 直接不 push 任何 action，连 0 都不写。

   也就是说 `docs/architecture.md:229` 那句"每次固化写 review-log（可审计）"在这条路径上不成立，而 `memory-review.jsonl` 恰恰是文档指定的**第一现场**（`docs/memory.md` 最后一节）。
2. **零测试覆盖。** 全仓库只有两处引用：`test/memory-consolidation-ops.test.ts:69` 显式写死 `hasExternalToolContent: false`（即绕过），`test/memory-source-window.test.ts:48` 只断言这个 flag 会被置位、不断言它的后果。行为 eval 也漏了——`M-recall-03` / `M-maint-01` 用的 `warmupTurns`（`evals/cases/helpers.ts:106-116`）全是纯问答，**一次工具都不调**，所以整个 eval 门禁跑在这条短路的豁免侧。
3. **引入时没有留下理由。** `git show ba345a7`（"fix(memory): close phase 0 correctness and safety gaps"）只加了这个条件，没有注释、没有 commit body。从上下文推测意图是"外部工具内容可能是注入载体，不该进 durable memory"——但这个担心已经由三道更精确的机制覆盖了：`sanitizeMessagesForMemory` 把 toolResult 整条过滤掉（`transcript.ts:56`，模型压根看不到工具输出）、`MEMORY_INPUT_SAFETY_RULES` 的数据边界声明、以及 `classifyMemoryWrite` 的两档置信度闸门。用一个覆盖整个窗口的布尔量再封一遍，是**用最钝的工具解决一个已经被解决的问题**。

**建议**：删掉这个条件。工具输出已在 `sanitizeMessagesForMemory` 里被剥离，模型的提炼输入里没有它；真要保留一层保险，正确粒度是"候选内容与被剥离的 tool 输出高度重合时降级"，而不是"窗口里有工具就整窗作废"。改完必须补一条 eval：一个用了 `read`/`bash` 的窗口跑一次 `runMemoryMaintenance` 后 MEMORY.md 有新条目——这条如果早就存在，本缺陷不会活到今天。

---

### 1.2 **P1** — rerank 返回空数组即本轮零记忆，没有 top-1 兜底

```ts
// src/memory/recall.ts:640-646
const selectedIds = new Set(result.output);
if (selectedIds.size === 0) {
    return [];
}
```

而 rerank 的系统提示词明确鼓励这个输出（`recall.ts:60`：`If nothing is clearly useful, return an empty array.`）。

三个因素叠加让它比看上去更容易触发：

- **rerank 触发得很频繁。** `MIN_MATCH_EVIDENCE = 2.5`，而一个 ≥4 字符的英文 token 命中 content 就是 `3 × 1.0 × damping ≈ 3`——单个内容词即可入围。于是 shortlist 经常超过 `maxInjected = 5`，`shouldUseModelRerank` 的 auto 模式只在"本地有明显赢家"时才跳过，实际上大多数轮次都会真的发起这次 LLM 调用。
- **3 秒超时对国内 provider 偏紧**（`recall.ts:87`）。超时走 `abortWorker()` → reject → catch → fail-open 到本地排序，功能正确；但 `recordSidecarUsage` 只在成功路径调用（`sidecar-worker.ts:224`），**超时的那次调用是花了钱且不进账本的**，`/usage` 的 sidecar 行系统性偏低。
- 失败 fail-open（返回全部候选），空数组 fail-closed（返回零）。**同一个函数里两种失败方向相反**，而更差的那个方向留给了"模型正常应答但判断保守"这个最常见的情况。

**建议**：空数组时保留本地排序的 top-1（或 top-2），并把这次"reranker 判定全部无关"记进 debug 日志；rerank 超时也应记账（把 `recordSidecarUsage` 移到 finally 或在 abort 路径补记）。超时值从 3s 提到 5–6s 更贴近真实 provider 的 JSON 补全延迟——它反正在关键路径上只能"少注入"，放宽超时不会带来正确性风险。

---

### 1.3 **P1** — cleanup 的收缩守卫允许每轮腰斩，且不记录删了什么

```ts
// src/memory/consolidation.ts:324-332
if (beforeEntries > 0 && afterEntries === 0) return true;          // 只拦"清空"
if (before.length < guard.cleanupShrinkGuardMinChars) return false; // < 2000 chars 完全不设防
if (after.length < before.length * 0.4) return true;               // 字符维度
return beforeEntries > 0 && afterEntries * 2 < beforeEntries;      // 条目维度：允许删到一半
```

`shouldCleanupChannelMemory` 的触发条件是 `≥ 5000 chars` **或** `≥ 4 个 Update 块`（`consolidation.ts:190-195`）。一个日常使用的频道每几次固化就会攒够 4 个 Update 块，于是 cleanup 每 6 小时一次的 structural-maintenance 几乎每次都会跑。**每次允许合法地删掉一半条目**，而且：

- `validateCleanupSchema` 只校验"不许发明新 id、不许重复 id"，**不校验保留率**；
- review-log 只写 `{target:"MEMORY.md", action:"rewrite"}`，**不写删了哪几个 id**；
- `.memory-backups/` 只留 5 份，`MEMORY_BACKUP_KEEP = 5`——连续 5 次 cleanup 后原始内容不可恢复。

这是一条**慢性侵蚀通道**：没有任何一次操作看起来异常，但一个长寿频道的 durable memory 会被 LLM 反复重写逐步磨掉，而用户和运维都看不到发生了什么。它与 §1.1 的组合尤其难受——写入端被封死、清理端照常运行，净效应是 MEMORY.md 单调收缩。

**建议**：三件小事，都不需要新概念。(a) cleanup 前后做 id 集合 diff，把被删的 id 写进 review-log 的 `skipped`（`{target:"MEMORY.md", action:"drop", entryIds:[...]}`），这是零成本的可审计性；(b) 守卫从"允许删一半"收紧到"单次最多删 25%，且被删条目里不得含 `sourceType: "user"`"——用户明说要记的东西不该被后台 LLM 悄悄删掉；(c) cleanup 的 prompt 目前把 `currentMemory` 全文无裁剪塞进去（`consolidation.ts:349`），补一个上限 clip。

---

### 1.4 **P1** — 召回统计只写不读

`MemoryEntryMetadata` 采集了四个信号：`recallCount`、`lastRecalledAt`、`recallByDay`（90 天滚动）、`queryFingerprints`（最近 32 个查询指纹）。全仓库消费者：

```
src/memory/commands.ts:67,85,87,90   ← 仅 /memory status 的展示
```

`recall.ts` 的打分函数（`scoreCandidate`）用的是：词法证据 × (1 + (priority + intentBoost + recencyBoost)/100)。**没有一项使用召回历史。**

这正是 spec 037 D3 亲手写下的反模式：

> 本可以加一个 `control.plan.revision` 计数器，但它没有消费者——而「采集了却没有任何消费者」正是评审 L2 批评的那个错误，不能在修 G1 时重犯。

`queryFingerprints` 尤其可惜：它保存的是"哪些不同的问法命中过这条记忆"，这是**判断一条记忆是不是真的在被用**的最强信号（比 `recallCount` 强——后者会被同一个人反复问同一句刷高），而且已经在磁盘上了。

**建议**（这是 L2 的最小可交付版本，不需要等语义检索）：把 `recallCount` 与 `queryFingerprints.length` 以对数形式接进 `structuralScore`，与 `priority` 同一量级；给 `lastRecalledAt` 超过 90 天的 `sourceType: "agent"` 条目一个温和降权（不是删除）。改动局限在 `scoreCandidate` 一个函数里，风险可控——但必须先有 §5 里说的召回 eval 门禁才能判断是升是降。

---

### 1.5 **P2** — `/memory pending` 是一条永久为空的死链路

`readPendingSuggestions`（`commands.ts:27-43`）扫 `memory-review.jsonl` 里的 `entry.suggestions`。`MemoryReviewLogEntry` 确实声明了 `suggestions?: unknown[]`（`review-log.ts:29`），但**全仓库没有任何一处写它**——两个 grep 都只命中 commands.ts 自己的读取端。

于是 `/memory status` 永远显示 `Pending suggestions: 0`，`/memory pending` 永远返回"No pending suggestions."。用户看到这两行会合理推断"没有待确认的记忆建议"，而真实含义是"这个功能不存在"。

这条链路还带着一个 sha256 指纹生成器和 `slice(-50)` 分页——**复杂度没有买到任何东西**，符合 AGENTS.md 要删的形态。

**建议**：二选一，不要留中间态。要么删掉 `suggestions` 字段、`readPendingSuggestions`、`/memory pending` 和 status 里那一行；要么给它接上真实来源——最自然的来源是 §1.3 建议里 cleanup 删掉的条目，和 `classifyMemoryWrite` 拒掉但 `confidence ≥ 0.8` 的边缘候选，让用户可以捞回来。后者才是这个 UI 原本想做的事。

---

### 1.6 **P2** — 每轮召回在关键路径上做两次 `entries.json` 全量读改写

```ts
// src/memory/recall.ts:801-804
if (recalledEntryIds.length > 0) {
    await syncMemoryMetadata(request.channelDir, metadataEntries);   // 无条件 writeFileAtomically
    await recordMemoryRecall(request.channelDir, recalledEntryIds, query);  // 又一次读改写
}
```

`syncMemoryMetadata` 末尾无条件 `writeFileAtomically`（`metadata.ts:171`），即使这次调用什么都没改。`writeFileAtomically` 是 write-temp + rename，两次 fsync 级别的开销。两个调用都在 `recallRelevantMemory` 的 `await` 链上，也就是**每一轮用户消息都要为此等两次串行的原子写**。

对比 `MemoryActivityRecorder`（`maintenance-state.ts:262-330`）——那里为了同一个问题写了一整套可结合的折叠批处理和 debounce，注释里明确点名"每次 tool call 一次读改写、两次 fsync"是不可接受的。同样的判断没有应用到召回路径。

**建议**：(a) `syncMemoryMetadata` 在 next 与 current 深度相等时跳过写入（一次 JSON.stringify 比较即可）；(b) 把召回路径的两次调用合并成一次——`recordMemoryRecall` 本来就要读改写，把 reconcile 顺带做了；(c) 更彻底的做法是把召回统计的写入挪到 turn 结束后的 fire-and-forget（它不影响本轮结果），只在 `flushForShutdown` 时保证落盘。

---

### 1.7 **P2** — `HISTORY.archive.md` 无界增长且每次全量读写

```ts
// src/memory/files.ts:465-476
const existing = await readOptionalTextFile(path);   // 读全文
await writeFileAtomically(path, `${...}${renderedBlock}\n`);  // 写全文
```

这个文件的定位是"折叠前的原始块，永不重写"（注释：`so nothing is permanently blurred by repeated folds`），因此**没有任何轮转、上限或清理**。每次 `foldChannelHistory` 都是一次 O(n) 读 + O(n) 写，累计 O(n²)。一个跑了一年的活跃频道，这个文件会成长到几十 MB，而它**不在任何检索路径上**——`buildHistoryCandidates` 只读 `HISTORY.md`，`session-corpus` 的 `IGNORED_JSONL_FILES` 不含它（它是 .md，压根不被扫），所以它是纯粹的只写归档。

**建议**：改成 append-only（`appendFile`，不读全文），并加上和 `review-log.ts` 同款的 1MB 轮转（`HISTORY.archive.md.1`）。或者更简单：既然冷存储 `context.jsonl` 已经有全量原文，这个归档的边际价值存疑，可以考虑直接删掉。

---

### 1.8 **P2** — metadata 与 MEMORY.md 之间存在竞态降级窗口（可自愈，但会瞬时错报）

`syncMemoryMetadata` 的第三个循环会把"metadata 里 active 但不在本次 activeEntries 里"的条目标成 `invalidated`（`metadata.ts:159-164`）。而召回路径传入的 `activeEntries` 来自 `MemoryCandidateStore` 的**缓存快照**，且中间隔着一次最长 3 秒的 rerank。

时序：后台 job 通过 gate（此刻频道 idle）→ 开始 20s 的 extraction → 用户发消息，`isBusy()` 变 true 但 job 已在跑 → 召回读到旧的 MEMORY.md → rerank 3s → job 写入新条目 X 并 sync（X = active）→ 召回的 sync 用旧快照落地 → **X 被标成 `invalidated`，但它的 bullet 还在 MEMORY.md 里**。

后果：X 进不了 `recordMemoryRecall`（只处理 active），因此**永远无法从试用期转正**；也进不了 `collectExpiredEntryIds`（同样只看 active），因此**永远不会过期**——成为僵尸条目。好消息是下一次任意 reconcile（`applyChannelMemoryOps` 开头、`/memory` 命令、下一轮召回）会把它按 activeEntries 重新写回 active，所以能自愈。

**建议**：召回路径不该承担 reconcile 职责——它拿的本来就是可能过期的缓存。把 `syncMemoryMetadata` 从 `recallRelevantMemory` 里去掉（与 §1.6 的建议合流），reconcile 留给写路径和 `/memory` 命令。

---

### 1.9 **P3** — 两处一致性小问题

- **`session-search` 还在用被 recall 抛弃的覆盖率归一。** `scoreDocument`（`session-search.ts:186`）算 `coverage = matchedTokens / queryTokens.length`。这正是 `recall.ts:95-101` 长注释里详细批判、并已改掉的那个反模式。这里 `matchedTokens * 1.4` 是主项、`coverage * 2` 只是配料，所以危害小得多，但两个检索器用相反的打分哲学是一处会长期制造困惑的不一致。
- **tombstone 的 `sourceEntryIds` 连坐过宽。** 自动写入的 `sourceEntryIds` 是**整个窗口**的 entry id 列表（`consolidation.ts:280`）；用户 forget 其中一条时，tombstone 把这一整串都记下来（`files.ts:265-272`），此后任何 `sourceEntryIds` 与之相交的 op 都被整体拒绝（`files.ts:236-238`）。因为窗口游标是单调推进的，实际重叠只发生在同窗重放（这恰好是想要的幂等），所以现状危害有限；但这是一条"按窗口连坐"的规则伪装成"按条目防复活"，一旦将来窗口策略变成重叠滑窗就会立刻变成 bug。建议把 tombstone 的 `sourceEntryIds` 收窄为该条目真实的来源子集，或者干脆只依赖 contentHash。

---

## 2. 结构性缺口（对照业界标杆）

前一节都是"实现没兑现设计"。这一节是"设计本身缺一块"。

### 2.1 只有闸，没有轮 —— 这个判断至今成立

spec 037 引用的那份评审的结论句是"**只有闸（gate/guard/governor/budget/confidence bar），没有轮（feedback loop）**"。一年后回看，记忆域的闸更多了（两档置信度、试用期、per-run 上限、收缩守卫、schema 校验、gate 六连），**轮只落地了一个半**：

| 闭环 | 状态 |
|---|---|
| 试用期：写入 → 被召回 → 转正 / 未被用 → 淘汰 | ✅ 已实现（spec 037 D7/D8），设计漂亮，边际 I/O 为 0 |
| 召回统计 → 影响排序 | ❌ 只采集不消费（§1.4） |
| 召回质量 → 反哺提炼（"这条记忆写得让人搜不到，下次换个写法"） | ❌ 不存在 |
| 用错记忆 → 记录 → 降权 | ❌ 不存在（没有负反馈信号，只有"被注入"这一个正信号） |

值得强调的是：**当前唯一的正反馈信号"被注入过一次"是很弱的**。`recordMemoryRecall` 记录的是"进了 prompt"，不是"被用上了"。一条被注入 20 次但每次模型都无视它的记忆，和一条真正驱动了回答的记忆，在统计上完全一样。业界对这个问题的处理是引入**使用证据**：Letta/MemGPT 让 agent 显式调用 memory 工具（调用本身就是证据），Generative Agents 的 retrieval score 里 importance 是模型对记忆本身打的分而非检索副产物。Pipiclaw 有一个现成的、几乎零成本的证据源没有用——**主 agent 在回答里是否复述了被注入条目的关键词**，这可以在 turn 结束后本地算，不需要 LLM。

### 2.2 没有跨频道晋升 —— 与"数字员工"的产品定位直接冲突

四层记忆全部按频道隔离，唯一的跨频道层 `workspace/MEMORY.md` 明确是**管理员手工维护**（`docs/memory.md`：与之相对，频道级的……不要手工编辑）。这意味着：

> "报销要先过陈昊签字"这件事，在 DM 里学到之后，在项目群里依然是未知的。要让它跨频道生效，只能由管理员手动抄进 `workspace/MEMORY.md`。

隔离本身是对的（私聊内容不该泄漏到群里，这是刻意的安全属性）。但**"隔离"和"没有晋升通道"是两件事**。ChatGPT 的 memory、Claude 的 CLAUDE.md 层级（enterprise → project → user）、Letta 的 shared memory blocks，都在"每个会话有自己的上下文"之上留了一条**受控的**上行通道。

Pipiclaw 现在缺的不是通道本身，而是**判定规则**。可以做得很保守而不牺牲隔离：

- 只有 `kind: "preference" | "constraint"` 且 `sourceType: "user"`（即用户明说的）才有资格；
- 需要在 **≥2 个不同频道**被独立学到过同一 contentHash（跨频道重复出现本身就是"这不是私事"的证据）；
- 晋升是**提案**而非自动写入——正好接上 §1.5 里那条空着的 `/memory pending` 链路，让管理员一条命令批准。

这条的优先级判断：它是 spec 037 D10 里明确列为"L3 跨频道晋升才是产品定位的分水岭"的那一条。**但它必须排在 §1.1 之后**——在自动写入被封死的前提下讨论跨频道晋升没有意义，因为频道里根本没有自动学到的东西可晋升。

### 2.3 检索是纯词法的，没有语义层，也没有查询扩展

`recall.ts` 是一个做得相当细的词法检索器：中英文分词、中文三元组补偿贪心分词的破碎、token 特异性加权、文档频率衰减、意图段位提升、精确子串加成。`docs/memory.md` 也诚实地写明了它的边界："完全换一套说法"会漏。`M-recall-02` 就是为这个盲区专门写的 capability probe，且被标为 `quarantine`（预期失败）。

两条现实的改进方向，**不必上向量库**：

1. **查询扩展**。当前 query 只有 `clippedInput` 一条消息（`channel-runner.ts:464`）。用户说"那这个怎么办"时，recall 拿到的 token 全是停用词，必然空手而归。最便宜的修法是把**上一轮的用户消息**或 SESSION.md 的 `Current State` 拼进 query（只用于打分，不进 prompt）——零 LLM 成本，直接解掉"多轮指代"这一整类漏召回。
2. **别名/同义映射作为一等公民**。`memory_manage save` 的描述已经要求"keyword-rich sentence, written so future keyword search can find it"——这是把语义问题外包给了写入方的措辞。可以更进一步：`add` 时让提炼 prompt 额外产出 2–3 个 `aliases`，只进 `searchText` 不进 `content`（`MemoryCandidate` 已经有 `searchText` 与 `content` 分离的设计，基础设施是现成的）。这是"用写入端的一次性成本换读出端的每轮召回率"，性价比远高于给每轮加一次 embedding 调用。

真要上语义层，参照系是 mem0（extraction + 向量检索 + LLM 冲突消解）和 Zep/Graphiti（时序知识图）。但在**没有召回 eval 硬门禁**之前上这个，无法判断是升是降——见 §5。

### 2.4 冲突与时效不是一等公民，被推给了用户

`docs/memory.md` 里有这么一段：

> **改主意时说"忘掉旧的"，而不是补一条新的。** 两条互相矛盾的记忆都留着，之后召回哪条就成了掷骰子。

这是把系统的责任写进了用户手册。具体缺口：

- **`memory_manage save` 只会 `add`，永远不会 `supersede`**（`memory-manage.ts:143-155`）。用户先后说"用 npm"和"以后默认用 pnpm"，得到的是两条并列的、时间戳不同的 active 条目。去重只按 contentHash 精确匹配，语义矛盾完全不检测。
- **自动提炼路径有 `supersede`/`invalidate`，但模型看到的是被 clip 到 8000 字符的**全量**条目列表**（`extraction.ts:230`），不是"与本次候选相似的条目"。条目一多，模型就找不到该 supersede 谁。mem0 的做法正好相反：先按语义检索出 top-k 相似记忆，只把这几条给模型看，然后让它输出 ADD/UPDATE/DELETE/NOOP——**决策集小，判断才准**。
- **没有双时间。** Zep/Graphiti 的核心资产是 bi-temporal（fact 何时成立 / 何时失效，与何时被记录分开）。Pipiclaw 只有 `createdAt`/`updatedAt`（记录时间），没有"这条事实的有效期"。"Q3 的发布窗口是周四"这种带天然时效的事实，只能靠人去 forget。

**最小可行修法**（不引入向量库）：`memory_manage save` 在写入前跑一次现成的 `recallRelevantMemory`（`allowedSources: ["channel-memory"]`，rerank off——这条路径 `search` op 已经在用了），命中 ≥1 条高分条目时**不直接写**，而是抛 `RecoverableToolError` 把命中的条目和 id 交给模型，让它自己决定是 add 还是应该改用一个新的 `supersede` op。这完全符合 AGENTS.md 那条"能被模型自己修的就用 `RecoverableToolError`"。

### 2.5 重要性只用于写入闸门，不进召回排序

`necessity`（high/medium/low）和 `confidence` 是提炼时最有信息量的两个信号，它们被 `classifyMemoryWrite` 消费一次之后就**丢弃了**——`MemoryEntryMetadata` 存了 `kind`，但没存 necessity/confidence，召回打分里也没有 `kind` 的位置（只有 `inferPriority` 按 sectionHeading 猜的粗粒度优先级，`candidates.ts:74-88`）。

Generative Agents 那条被反复验证的公式是 `score = recency + importance + relevance`。Pipiclaw 有 recency（`computeRecencyBoost`）、有 relevance（词法证据）、**importance 那一项被扔在写入端**。

**建议**：`MemoryEntryMetadata` 增记 `necessity`；`inferPriority` 对 channel-memory 从"按段落标题猜"改成"按 metadata.kind + necessity 查表"。这是一处几行的改动，但它把一个已经花钱算出来的信号接进了每轮召回。

### 2.6 子代理无法写记忆，且父 agent 的转述也写不进去

`memory_manage` 的 `availableToSubagents: false`（`tools/registry.ts:190`）。这是一个可以理解的边界决定（子代理不该越过主 agent 直接改频道记忆）。但组合起来看有问题：子代理把结论返回给主 agent → 主 agent 的这一轮窗口里有一条 `subagent_manage` 的 **toolResult** → §1.1 的短路生效 → 这一整个窗口的自动固化被丢弃。

于是"派一个子代理去调研 → 得到结论 → 结论进不了长期记忆"是当前的默认行为。修掉 §1.1 之后这条自然消解，但值得单独记一笔，因为它说明 §1.1 的影响面比"coding 场景"更宽。

### 2.7 后台维护完全静默，用户没有信任面

`M-maint-01` 的 grader 之一就是 `noDeliveriesAfterStep("maintenance-is-silent", ...)`——静默是被测试钉住的**刻意设计**。方向没错（后台不该打扰用户），但当前的补偿手段只有一个 per-channel 的 `memory-review.jsonl`，而且要用户自己去磁盘上翻。

对比一下这个系统本身的定位——它要成为"一个入职一个月的数字员工"。一个真实员工在学到东西时会说一声。当前的用户体验是：**系统悄悄记了什么、悄悄删了什么、悄悄拒了什么，用户全程无感**，直到某天它答错了才发现。`/memory status` 是唯一的窗口，但它只给聚合数字（active 条数、召回次数），不给"最近学到了什么"。

**建议**（低成本）：`/memory status` 增加"最近 7 天新增/淘汰"两行，直接从 review-log 的 action 里聚合；`/memory list` 支持 `--recent`。不需要主动推送，但需要让用户问得出来。

---

## 3. 文档与实现漂移

| 位置 | 文档说 | 实际 |
|---|---|---|
| `docs/memory.md` 五层表，SESSION.md 行 | 是否自动进入对话：**否**，按需读取 | `SESSION.md` 是 recall 的候选源，且 `inferPriority` 给它**全系统最高优先级**（current state = 18，channel-memory 最高才 11）。它每轮都可能被注入 |
| `docs/memory.md` 五层表，HISTORY.md 行 | 是否自动进入对话：**否**，按需读取 | 同上，`buildHistoryCandidates` 把 folded 块 + 最近 8 块都作为候选 |
| `docs/architecture.md:229` | 每次固化写 review-log（可审计） | §1.1 的封杀路径不写任何 action（连"被封杀"都不写） |
| `docs/architecture.md:230` | 两档写入 + 试用期（spec 037 完整描述） | 描述准确，但在含工具窗口上**整条不生效**——文档描述的是设计，实现被 §1.1 短路 |
| `docs/memory.md` | `memory-review.jsonl` 是排查自动写回行为的**第一现场** | 对最重要的那类失败（§1.1）第一现场是空的 |

前两条是最容易误导人的：一个照文档配置的管理员会以为 SESSION.md 不占 turn 预算，而实际上它在 1800 units 的召回配额里享有最高优先级、最容易被选中。

---

## 4. 值得肯定、不要动的部分

评审报告容易只写问题，这里明确圈出几处**已经做对、后续改动不要破坏**的设计：

1. **`maintenance-gates.ts` 的 thunk 物料契约。** 物料以 `() => T` 传入、廉价检查全部前置，加上 `scheduler.ts` 里那个"乐观物料只会让谓词更宽松、永不误跳"的证明性注释——这是整个仓库里成本控制做得最干净的一处。
2. **试用期的挂载点选择（spec 037 D7）。** 转正搭在 `recordMemoryRecall` 本来就要做的那次写里，边际 I/O 为 0；淘汰用 `invalidate` 而非 `forget`（不留墓碑，同一事实以后还能重新学到）——这个区分抓得非常准。
3. **`classifyMemoryWrite` 里"supersede/invalidate 永不进试用期"这条不变量。** 一条会过期的操作去覆盖/删除一条永久条目，过期时会造成净数据丢失。这是本子系统最重要的安全性质，任何改动都要保住。
4. **`transcript.ts` 的注入上下文剥离。** 防的是"召回的记忆被重新总结进 MEMORY.md"这种自我强化回声——这类 bug 一旦发生极难诊断，提前防住是有远见的。
5. **`memory-manage.ts:97-127` 那段关于流式 JSON 尾部截断的长注释和 `rejectMissingArgument`。** 从现象（中文长值 + OpenAI 兼容 provider）追到机制（`parseStreamingJson` 宽松解析 → 参数被持久化 → 模型读回自己的残缺调用 → 无限循环），再到"必须响亮失败而不是温和 no-op"的结论。这是这个仓库工程质量的样本。
6. **`ChannelMemoryQueue` 的进程级单例。** CLAUDE.md 和 architecture.md 都反复强调"不要内联"——这个约束是对的，`lifecycle` 与 `maintenance-jobs` 争写同一批文件是很容易被后来者无意破坏的。

---

## 5. 建议的落地顺序

分四批，每批独立通过 `npm run check`，且**第一批必须最先做**——它之后其余判断才有意义。

### 第一批：解封 + 让失败可见（P0/P1，改动最小）

| 项 | 文件 | 说明 |
|---|---|---|
| 删除 `hasExternalToolContent` 写入封杀 | `consolidation.ts:276`、`source-window.ts` | §1.1；`sanitizeMessagesForMemory` 已剥离工具输出，防注入不缺这一层 |
| 补 eval：含工具调用的窗口能写出 durable 条目 | `evals/cases/regression.ts` | 这条如果早就存在，§1.1 活不到今天 |
| cleanup 的 id diff 写进 review-log | `consolidation.ts` | §1.3(a) |
| rerank 空数组保留 top-1；超时也记账 | `recall.ts:642`、`sidecar-worker.ts` | §1.2 |
| `/memory pending` 二选一（删或接上真实来源） | `commands.ts`、`review-log.ts` | §1.5 |

### 第二批：召回质量（需要先有门禁）

**前置**：把 `M-recall-04`（10 问公司运作知识 quiz，已有 fixture 与 `recallQuiz` grader）从当前状态提为 `required` 门禁，并补一条"多轮指代"用例。**在没有这道门禁之前，任何召回打分改动都是盲改。**

| 项 | 说明 |
|---|---|
| 查询扩展：把上一轮用户消息 / SESSION.md Current State 拼进打分 query | §2.3(1)，零 LLM 成本，解掉整类多轮漏召回 |
| 召回统计接入排序（`recallCount` + `queryFingerprints` 多样性） | §1.4 = L2 的最小交付 |
| `necessity`/`kind` 接入 `inferPriority` | §2.5，importance 归位 |
| 召回路径的 metadata 写优化 + 去掉 reconcile 职责 | §1.6 + §1.8 一并处理 |

### 第三批：冲突消解与时效

| 项 | 说明 |
|---|---|
| `memory_manage save` 写入前查重，命中相似条目时抛 `RecoverableToolError` 让模型选 add/supersede | §2.4，符合仓库既有错误契约 |
| 提炼 prompt 从"看全量条目"改成"看检索出的相似条目" | §2.4，决策集变小，supersede 判断才准 |
| cleanup 守卫收紧 + 保护 `sourceType: "user"` 条目 | §1.3(b) |
| 别名 / `searchText` 扩展 | §2.3(2) |

### 第四批：跨频道晋升（产品分水岭，最后做）

按 §2.2 的三条保守规则设计，**走提案而非自动写入**，落在 §1.5 重建的 pending 链路上。这一批需要独立 spec，且需要明确回答"隔离边界在哪里可以被穿透"这个安全问题——不该在实现里顺手决定。

### 随时可做的清理（不占批次）

- `HISTORY.archive.md` 改 append-only + 轮转（§1.7）
- `session-search` 的 coverage 归一与 recall 对齐（§1.9）
- tombstone `sourceEntryIds` 收窄（§1.9）
- `docs/memory.md` 五层表的"是否自动进入对话"列修正（§3）
