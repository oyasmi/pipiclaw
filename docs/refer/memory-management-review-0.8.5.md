# Pipiclaw 记忆管理模块深入评审（v0.8.5）

> 评审日期：2026-07-13  
> 评审基线：`62d3be5`，`package.json` 版本 `0.8.5`  
> 范围：`src/memory/`、记忆工具、`ChannelRunner` 集成、运行时调度、配置、相关测试与设计文档  
> 方法：静态代码审阅、调用链追踪、测试与覆盖率验证、公开一手资料对标  
> 本报告只做评审与建议，不包含实现改动。

## 1. 结论先行

Pipiclaw 的记忆模块已经达到“可靠的文件型生产实现”水平，但尚未达到“领先的 Agent 记忆系统”水平。

它最强的部分不是记忆检索算法，而是运行时工程：分层清楚、写入原子化、同频道串行、边界前固化、后台任务有确定性门禁、失败有退避、冷频道无需复活完整 Agent、写入与消费有审计入口。这些能力明显高于一般个人 Agent 项目，也让后续升级有很好的地基。

它目前的上限主要受四件事限制：

1. **增量维护游标只用于“是否运行”的 gate，没有真正限制送给模型的素材范围。** durable consolidation 和 growth review 会反复复盘整段当前会话，增加重复写入、冲突与成本。
2. **长期记忆仍是弱结构 Markdown。** 虽然已有 entry id 和 add/supersede/invalidate，但召回仍以 section 为单位，缺少来源、主体、有效期、信任级别、敏感级别与 tombstone 等关键语义。
3. **遗忘与安全语义不闭环。** `forget` 只删 `MEMORY.md` 的一个 bullet，原文仍留在备份、review log、HISTORY、context/log 中，还可能被后续 consolidation 重新写回来；外部工具结果和敏感信息也可能直接进入自动记忆。
4. **质量缺少测量闭环。** 单元测试证明机制能跑，但没有证明“该记的记住、不该记的不记、需要时找得到、过时后不再用”。当前没有 capture precision、retrieval recall@k、冲突更新、拒答、遗忘复活率等产品级指标。

综合评级：**7.0/10，处于“工程成熟、认知质量中等”的阶段。**

- 对单进程、频道数有限、以中文团队协作为主的自托管部署：已经可用，而且可靠性不错。
- 对长期高频使用、多成员群聊、敏感业务信息、数月历史与可验证个性化：还需要一轮以“正确性、安全、评测”为中心的升级。
- 下一阶段不宜继续增加第五种后台 job；应先让现有四条链路共享同一套增量素材、结构化记录、写入政策与指标。

## 2. 评审范围与验证结果

### 2.1 实现规模

`src/memory/` 当前有 22 个 TypeScript 文件，共 5,416 行。主要能力包括：

- `SESSION.md / MEMORY.md / HISTORY.md` 三层工作记忆；
- 首轮 durable bootstrap 与逐轮 relevance recall；
- 中文词法切分、意图加权与可选模型 rerank；
- compaction、`/new`、shutdown 边界前固化；
- session refresh、durable consolidation、growth review、structural maintenance 四类后台 job；
- stable entry id 与 add/supersede/invalidate 写语义；
- `session_search` 冷存储检索；
- `memory_manage save/search/forget` 显式工具；
- 原子写、共享串行队列、备份、history archive、review log、usage ledger。

### 2.2 验证结果

执行环境：Node `v22.21.0`、npm `10.9.4`。

- `npm run typecheck`：通过。
- 记忆域定向测试：24 个测试文件、118 个测试，全部通过。
- 记忆域定向覆盖率：
  - `src/memory` statements/lines：**83.16%**
  - branches：**75.26%**
  - functions：**92.74%**
  - `src/tools/memory-manage.ts` lines：**92.07%**
- 全仓覆盖率运行：717 个测试中 715 个通过、2 个失败：
  - `prompt-resource-loader.test.ts` 受宿主环境额外 `dws` skill 污染；
  - `usage-ledger.test.ts` 未读到预期 sidecar ledger entry。

记忆模块测试本身全部通过。两个全仓失败不构成本次记忆功能回归证据，但说明测试对全局 skill/ledger 状态的隔离仍需加强。

## 3. 当前架构画像

```text
用户消息
  │
  ├─ 首轮：channel/workspace MEMORY.md 有界快照
  ├─ 每轮：SESSION/MEMORY/HISTORY 词法召回 + 可选 rerank
  ├─ 每轮：任务摘要
  ▼
主 Agent 上下文
  │
  ├─ session refresh ───────────────> SESSION.md
  ├─ boundary / idle consolidation ─> MEMORY.md + HISTORY.md
  ├─ growth review ─────────────────> MEMORY.md + workspace skills
  └─ 原始 session/log ──────────────> context.jsonl / log.jsonl
                                            │
                                            └─ session_search（显式冷检索）

后台 scheduler：
session-refresh → durable-consolidation → growth-review → structural-maintenance
（单频道每 tick 最多成功运行一个 job；所有写路径共享频道串行队列）
```

这套分层的方向是对的：工作态、持久事实、阶段摘要、原始证据没有混成一个大文件；普通 turn 不扫描冷存储；长期文件保持人类可读。

## 4. 分项能力评分

| 维度 | 评分 | 判断 |
|---|---:|---|
| 分层与生命周期 | 8.5/10 | SESSION/MEMORY/HISTORY/冷存储职责明确，边界固化完整 |
| 并发与持久化可靠性 | 8.5/10 | 原子写、fsync、共享单频道队列、备份、退避都做得扎实；跨进程仍无锁 |
| 写入语义与冲突处理 | 6.5/10 | 已有 stable id 和 ops，但 post-turn 仍纯 append，cleanup 会丢 id，缺少 tombstone/provenance |
| 召回相关性 | 6.0/10 | 中文词法和意图加权实用，但粒度过粗、无阈值、rerank 无法拒绝全部候选 |
| 冷历史检索 | 5.5/10 | 当前频道隔离正确、零额外依赖；但仍是每次读文件后全量线性评分，不是真正索引 |
| 遗忘、隐私与安全 | 4.5/10 | 有 prompt framing 和频道隔离，但 forget 不彻底、无防复活、无 secret/PII/trust policy |
| 成本与扩展性 | 6.0/10 | gate、idle 调度和 usage ledger 很好；重复整段复盘与线性 session search 抵消了一部分优势 |
| 可观测性 | 6.5/10 | review log、usage ledger、`/context` 已具备；缺少 recall/capture 成效指标 |
| 测试与可维护性 | 8.0/10 | 覆盖面广、纯 gate 易测；缺少长期质量、安全与增量语义场景测试 |

## 5. 已经做得很好的部分

### 5.1 文件分层清晰且符合 Pipiclaw 定位

`SESSION.md` 保存当前工作态，`MEMORY.md` 保存 durable facts，`HISTORY.md` 保存阶段摘要，JSONL 保存完整冷历史。这个设计适合 DingTalk 长期频道：人类能审计，runtime 能按需注入，也不会因为引入向量数据库而让文件资产失去解释力。

尤其值得保留的是：

- workspace memory 与 channel memory 作用域分离；
- 冷存储不进入普通 turn 的自动 recall；
- skills 被当作 procedural memory，而非塞进 declarative memory；
- task ledger 独立于 memory，避免把精确待办降格成自然语言记忆。

### 5.2 边界前固化不是“事后尽力而为”

[`lifecycle.ts`](../../src/memory/lifecycle.ts) 在 compaction、new session、shutdown 前主动刷新/固化；shutdown 还覆盖了只有 tool output、没有最终 assistant turn 的情况。这比只依赖每轮后台总结更可靠。

### 5.3 写入可靠性强

[`files.ts`](../../src/memory/files.ts) 和 [`atomic-file.ts`](../../src/shared/atomic-file.ts) 的组合具备：

- 唯一临时文件；
- 文件 fsync；
- 原子 rename；
- 最佳努力目录 fsync；
- rewrite 前保留最近 5 份备份；
- history folding 前保存原始 archive；
- 单进程内所有频道记忆写共用同一个 keyed serial queue。

这是一套真实的持久化设计，不是“调用 `writeFile` 就算完成”。

### 5.4 已经开始处理记忆回声污染

[`transcript.ts`](../../src/memory/transcript.ts) 会在记忆 worker 读取 transcript 前剥离 runtime 注入的 recall/bootstrap/task blocks，避免旧记忆被再次总结成新记忆。这是很关键、也很容易被忽略的细节。

### 5.5 维护成本有确定性门禁

四类 job 都先经过纯函数 gate，再决定是否调用 LLM；scheduler 对频道做轮转且限制并发；离线频道通过轻量磁盘上下文恢复，不创建完整 Runner。这个方向与 Codex 当前“空闲后再生成、余额过低可跳过”和 OpenClaw 的 thresholded promotion 思路一致。

### 5.6 stable id 与操作语义是正确的中间台阶

[`files.ts:144`](../../src/memory/files.ts) 已有 `add / supersede / invalidate`，旧条目没有 id 时还能通过稳定 hash 过渡。这让后续 provenance、召回统计、冲突更新、tombstone 都有落点，不必推倒 Markdown 存储。

## 6. 关键发现（按优先级）

### P0-1：维护游标没有限制实际复盘素材，导致重复处理整段会话

证据：

- durable job 用 `entriesSince(..., lastConsolidatedEntryId)` 计算 `newEntries`，但只拿它做 gate 和 batch size；真正调用 `runInlineConsolidation` 时仍传入完整 `input.sessionEntries`（[`maintenance-jobs.ts:251`](../../src/memory/maintenance-jobs.ts)）。
- growth review 同样计算 `newEntries`，但 signal scan 与 `runPostTurnReview` 都使用完整 `input.messages`（[`maintenance-jobs.ts:317`](../../src/memory/maintenance-jobs.ts)）。
- `runInlineConsolidation` 仅按“最近一次 compaction 边界”裁剪，而不是按 `lastConsolidatedEntryId` 裁剪（[`consolidation.ts:336`](../../src/memory/consolidation.ts)）。
- compaction handler 明明收到 `messagesToSummarize`，但同时传入非空 session entries 后，worker 会优先使用 session entries，可能把本应保留的 recent tail 一起固化。

影响：

- 同一偏好、决策或 open loop 被多次提取；
- prompt 虽要求去重，但模型不是确定性去重器；
- growth signal 一旦在旧 transcript 中出现，此后每次 review 都会继续命中；
- sidecar 输入和成本随当前 session 增长；
- shutdown/boundary/scheduler 三条链容易对同一素材重复工作。

建议：建立唯一的 `MemorySourceWindow`：

```ts
interface MemorySourceWindow {
  fromEntryId?: string;
  throughEntryId?: string;
  entries: SessionEntry[];
  messages: AgentMessage[];
  sourceKind: "idle" | "compaction" | "new-session" | "shutdown";
}
```

gate、signal scan、worker prompt、成功 checkpoint 必须全部使用同一个 window。只有 session refresh 可以读取完整当前上下文；durable/growth 必须严格消费增量。

### P0-2：`forget` 是“从当前 MEMORY.md 隐藏”，不是可靠遗忘

[`memory-manage.ts:136`](../../src/tools/memory-manage.ts) 的 `forget`：

1. 只从 `MEMORY.md` 删除一个匹配 bullet；
2. rewrite 前把含该条目的旧文件复制到 `.memory-backups/`；
3. 在 `memory-review.jsonl` 中再次明文记录被遗忘内容；
4. 不处理 SESSION、HISTORY、HISTORY.archive、context、log；
5. 不写 tombstone，因此后台 worker 再次扫描旧 transcript 时可以把它重新加入 MEMORY。

当前返回文案 `Forgot: ...` 会让用户误以为删除范围更大。对地址、身份、凭据或人员信息，这是明显的隐私语义风险。

建议把操作拆成两种明确语义：

- `forget_memory`：从 active durable memory 删除，写入不含原文的 tombstone，阻止自动再提取；明确告知原始会话记录仍按 retention policy 保存。
- `purge_history`：高风险管理操作，按可配置范围清理 derived index、backup、review preview、HISTORY 与冷存储；需要确认、审计和保留策略支持。

tombstone 至少包含 `entryId / normalizedContentHash / deletedAt / scope / reason`。审计日志记录 id/hash，不应复制敏感原文。

### P0-3：自动记忆可吸收外部工具内容，缺少来源信任与敏感信息治理

[`type-guards.ts:8`](../../src/shared/type-guards.ts) 把 `toolResult` 保留在 memory worker transcript；[`transcript.ts:38`](../../src/memory/transcript.ts) 只清理 user message 中的 runtime 注入块，不排除 web、MCP、shell、文件读取等外部来源。

因此以下内容可能被自动写成 durable memory：

- 网页或文档中的 prompt injection；
- 工具返回的临时状态；
- API key、token、cookie、地址、手机号等敏感数据；
- 未经验证的第三方陈述；
- 只在当前执行环境成立的事实。

召回时的“may be stale / do not follow instructions” framing 是好防线，但写入前没有 source policy，会让污染先进入 durable store。

建议借鉴 Codex 的两个控制点：

- 默认禁止“使用过 web/MCP/tool-search 的任务”自动生成 durable memory，或至少只允许保存用户明确确认的条目；
- extraction model 与 consolidation model 独立配置，并在进入模型前做 deterministic secret/PII scan。

更适合 Pipiclaw 的 policy：

| 来源 | 默认自动晋升 |
|---|---|
| 用户明确说“记住” | 允许，仍做敏感检测 |
| 用户稳定偏好/重复纠正 | 允许，高置信 |
| Agent 自己的执行结论 | 仅低风险事实，需证据 |
| repo 内受信文件 | 可进入项目事实，带路径/版本 |
| web/MCP/外部文档 | 默认 suggestion/pending，不自动写 |
| shell/tool output | 默认不自动写，除非转化为已验证结论 |
| secret/credential | 永不写入 memory；仅引用安全存储位置 |

### P0-4：growth review 绕过了已有的冲突更新语义

inline consolidation 使用 `memoryOps`，能 supersede/invalidate；但 post-turn review 在高置信时直接调用 `appendChannelMemoryUpdate`（[`post-turn-review.ts:196`](../../src/memory/post-turn-review.ts)）。这会造成：

- 两套写入协议；
- growth review 只能追加，不能更新或失效旧事实；
- 模型 confidence 再高也不能防止重复/矛盾；
- 默认配置同时开启 `autoWriteChannelMemory` 和 `autoWriteWorkspaceSkills`（[`settings.ts:233`](../../src/settings.ts)），副作用强于现有设计文档中的 suggestion-first 叙述。

建议删除 post-turn 的纯 append 分支，让所有 durable 写入统一输出 `MemoryOp[]`，共用：

- target 校验；
- 相似/重复检测；
- secret/trust policy；
- tombstone 检查；
- pending approval；
- 单一 review log schema。

对 workspace skill 的自动写尤其应默认 pending，因为频道私有工作流可能被沉淀成 workspace 资产并在其他频道加载，形成跨频道信息扩散。

`memory_manage save` 也总是生成 `add`，传入的 `kind` 只用于返回文案，没有持久化；用户明确纠正旧偏好时仍可能得到两个冲突 bullet。显式工具应增加 `update/supersede`，或者在 save 前做唯一相似项检测并要求模型确认。

### P0-5：growth review 失败会被当作成功 checkpoint，丢失重试机会

[`post-turn-review.ts:294`](../../src/memory/post-turn-review.ts) 捕获 worker/apply 错误后返回一个 `skipped` result，不再抛出；调用方 [`maintenance-jobs.ts:365`](../../src/memory/maintenance-jobs.ts) 无法区分“正常没有候选”和“review 执行失败”，仍然会：

- 更新 `lastGrowthReviewAt`；
- 把 `lastReviewedEntryId` 推进到最新 entry；
- 清零 review counters；
- 清除 failure backoff；
- 把 job 记为 `ran`。

这意味着一次临时模型/网络/parse 失败会永久跳过该批素材。建议返回判别联合类型：

```ts
type PostTurnReviewRunResult =
  | { status: "applied"; result: PostTurnReviewApplyResult }
  | { status: "empty"; result: PostTurnReviewApplyResult }
  | { status: "failed"; error: string };
```

只有 `applied/empty` 才推进 cursor；`failed` 必须保留 cursor 并进入统一 backoff。

### P1-1：召回粒度是 section，不是 entry

[`candidates.ts:117`](../../src/memory/candidates.ts) 把一个 `##` section 构造成一个候选。即使 `MEMORY.md` 每个 bullet 已经有稳定 id，召回仍无法：

- 只注入命中的那一条；
- 对单条记忆做 recall count / last recalled；
- 对同一 section 内的冲突条目独立排序；
- 在预算不足时保留最相关 bullet。

一个关键词命中可能把整个 `## Preferences` 或 `## Update` 块注入。若单个 item 大于总预算，[`recall.ts:602`](../../src/memory/recall.ts) 会一个都不放，只返回“有 N 条被省略”的提示。

建议把 channel-memory candidate 细化到 bullet 级，候选 id 直接使用 `m-*`；SESSION 可继续按 section，HISTORY 可先按 block。渲染时再把相邻同源条目合并，兼顾检索精度与可读性。

### P1-2：rerank 无法表达“全部不相关”，本地召回也没有最低阈值

[`recall.ts:418`](../../src/memory/recall.ts) 只要有一个 token 重合就保留候选，没有最低 score/coverage；当候选数不超过 `maxInjected` 时完全不会 rerank。

更具体的逻辑错误在 [`recall.ts:525`](../../src/memory/recall.ts)：reranker 按 prompt 合法返回空数组表示“没有明显相关项”，代码却回退到原始候选。于是模型只能选，不能拒绝。

建议：

1. `selectedIds: []` 作为成功的 abstention；只有 timeout/parse/error 才回退本地排序。
2. 引入按 source 校准的最低分和最低 query coverage。
3. 对一词弱命中、常见项目词、只命中 path 的候选默认不注入。
4. 记录 `candidateCount / injectedCount / topScore / abstained / rerankUsed`，为阈值校准提供数据。

### P1-3：first-turn bootstrap 与 per-turn recall 重复注入相同 durable memory

[`channel-runner.ts:328`](../../src/agent/channel-runner.ts) 先执行 recall，再在首轮注入最多 3,000 字符的 channel/workspace memory snapshot（[`bootstrap.ts:75`](../../src/memory/bootstrap.ts)）。同一条 durable fact 可能同时出现在两个 block，最高占用约 8,000 字符并被双重加权。

建议二选一：

- 首轮只注入一个很小的 memory index/identity capsule，详细事实仍走 recall；或
- 首轮先构造 bootstrap，recall 排除已经包含的 entry id。

另应在 prompt 真正提交成功后再清除 `firstTurnMemoryBootstrapPending`。当前在 preventive compaction 和 provider prompt 之前就置为 false，准备阶段失败后同 session 重试会丢首轮 bootstrap。

### P1-4：cleanup 仍是一次不透明的全文件模型重写

现有 shrink guard 与备份值得肯定，但仍有缺口：

- 原文件小于 2,000 字符时，极端缩水不受 ratio guard 保护；
- prompt 没要求保留 `<!--id:m-*-->`，cleanup 后稳定 id 很可能全部丢失；
- 没校验 H1、允许 section、bullet schema、重复 id、空内容、敏感内容；
- 模型可能把 imperative text 或解释性段落写进 durable memory；
- 一次 rewrite 同时承担去重、归类、失效与改写，失败面过大。

建议把 cleanup 改为“计划 + 应用”：worker 返回 `MemoryOp[]` 与可选 `moveSection`，runtime 做确定性应用。若保留全文 rewrite，至少要求每条原 id 在输出中“保留、显式 invalidate 或 merge 映射”三选一，并做 schema lint 后才写。

### P1-5：`session_search` 是线性扫描，不是可扩展检索

当前实现每 30 秒缓存一次 corpus；缓存 miss 时读最多 15 个 JSONL 文件、解析最多 5,000 documents，再对所有文档做 token set 打分（[`session-corpus.ts:286`](../../src/memory/session-corpus.ts)、[`session-search.ts:202`](../../src/memory/session-search.ts)）。主要问题：

- `maxChunks` 并不限制评分候选数，只在最终 `slice` 时与 1-5 的 result limit 取最小值，默认 80 基本没有性能意义；
- cache key 漏掉 `maxCharsPerChunk`，30 秒内变更 chunk size 会返回旧裁剪结果；
- context、session、log 可能包含同一消息，结果不去重；
- 读取整文件，历史增长后 I/O 和 CPU 线性增长；
- 只有 set overlap，没有 BM25、phrase、field weighting、分页与 query expansion；
- 结果最多 5 条，无法 offset 继续。

短期先修参数语义与去重；中期借鉴 Hermes，建立每频道 SQLite FTS5 派生索引。SQLite 只做可重建索引，不替代 JSONL source of truth。中文可用 trigram/CJK tokenizer；如果评测证明语义漏召回明显，再增加可选 embedding hybrid，而不是先上向量库。

### P1-6：缺少真正的版本、主体、时效和行动边界

当前 entry 只有 `id/content/section/timestamp`。长期团队记忆至少还需要：

```ts
interface MemoryMetadata {
  id: string;
  kind: "fact" | "preference" | "decision" | "constraint" | "open-loop" | "lesson";
  scope: "channel" | "user" | "workspace";
  subjectId?: string;
  ownerId?: string;
  sourceEntryIds: string[];
  sourceType: "user" | "agent" | "repo" | "tool" | "web";
  trust: "explicit" | "verified" | "inferred" | "untrusted";
  createdAt: string;
  updatedAt: string;
  validFrom?: string;
  expiresAt?: string;
  status: "active" | "superseded" | "invalidated" | "forgotten";
  sensitivity: "normal" | "personal" | "secret";
}
```

OpenClaw 的“action-sensitive memory”值得直接借鉴：权限、临时约束、handoff、到期条件、可行动时间与 authority 不能只保存事实本身。否则“等待审批后再改”在数天后可能退化成“去改”。

不建议马上把这些字段全塞进 Markdown 正文。可先增加可重建 sidecar metadata 文件，并只把必要字段以 HTML comment 保存在 entry 附近；Markdown 仍是人类可读主视图。

### P1-7：跨进程一致性没有保护

当前队列只在单进程内有效。文档已明确 daemon 与 TUI 同时使用同一 app home 会竞态。由于 memory writes 是 read-modify-write，即使最终 rename 原子，两个进程仍可能互相覆盖。

建议在写入目录增加 advisory file lock 或 compare-and-swap revision：读取时记录文件 hash/revision，写前验证；冲突则重新读取、重放 ops。不要只给 `writeFileAtomically` 加锁，因为冲突发生在“读—算—写”整个事务范围。

### P2-1：SESSION sticky section 的失效语义过于脆弱

`resolved` 要求模型复制旧条目的精确文字，再用规范化字符串全局删除。模型轻微改写就无法清除；同一句话若同时出现在 decisions 和 constraints，可能一起被清除。

建议给 SESSION item 也加短 id，`resolvedIds` 精确失效；或者至少按 section + key 删除。SESSION 可以继续是模型生成的工作态，不必上完整 durable metadata。

### P2-2：review log 记录很多无价值 skip，缺少真正的效果数据

scheduler 每 tick 可能为同一频道连续写 4 条 gate skip，长时间空闲会制造 I/O 与日志噪声；另一方面真正需要的 recall hit、注入后是否使用、写入后是否再召回、条目被 supersede 的原因却没有记录。

建议：

- gate skip 只在 reason 变化、首次出现或聚合时间窗结束时写；
- 增加 entry-level recall stats；
- 将 memory sidecar cost 与 action/accepted/recalled 关联；
- review log 的敏感 preview 默认截断或 hash；
- 提供 `/memory status`：容量、活跃条目、pending、最近失败、索引 freshness、近 30 天成本。

### P2-3：user scope 值得做，但隐私规则必须先于实现

当前 channel scope 对群聊很安全，但同一用户在 DM 与多个群中没有连续画像。Hermes/Claude/Codex 都存在某种用户或项目级持久层，不过 Pipiclaw 是企业 IM，多参与者语境更复杂。

建议先写单独 spec，明确：

- 哪些内容可进入 user memory；
- 群聊中由谁的发言触发、归属谁；
- user memory 在群聊是否可召回，默认建议不注入私人偏好；
- 管理员、本人、群成员各自可见/可删范围；
- 离职、账号合并、跨 workspace 如何处理。

规则明确前，不建议直接实现 `workspace/users/<id>/MEMORY.md`。

## 7. 与成熟 Agent 的对标及可借鉴点

### 7.1 Hermes Agent

Hermes 当前官方文档体现出四个值得借鉴的设计：

1. **硬容量预算。** `MEMORY.md` 与 `USER.md` 分别有明确字符上限，写满时工具报错并给出下一步，而不是无限追加或静默截断。
2. **记忆与用户画像分层。** environment/lessons 与 user preference 分开，避免一个混合大文件。
3. **FTS5 冷会话检索。** 完整 session 存 SQLite，搜索约为毫秒级且不需要 LLM；这是 Pipiclaw `session_search` 最自然的升级路线。
4. **写入审批与可见通知。** memory/skill 写入可 stage，用户可 pending/diff/approve/reject；后台 review 还能使用单独的低成本模型。

来源：[Hermes Persistent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/)、[Hermes Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)、[Hermes Skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/)。

不建议照搬：全局 agent home、默认跨项目用户画像、外部 memory provider 大矩阵。Pipiclaw 的 channel/workspace 边界更适合钉钉。

### 7.2 OpenClaw

OpenClaw 的最新 memory 体系比单一 `MEMORY.md` 更接近完整知识生命周期：

- compact curated `MEMORY.md` + daily working notes + 可审阅 `DREAMS.md`；
- FTS5/BM25 + vector hybrid，CJK trigram，失败时可退回 keyword-only；
- optional MMR diversity 与 temporal decay；
- compaction 前 silent memory flush，可为该 turn 指定独立本地模型；
- dreaming promotion 同时使用 score、recall frequency、query diversity gate；
- action-sensitive memory 记录权限、时效、owner 与 safe-to-act 条件；
- wiki layer 进一步加入 claims/evidence/contradiction/freshness，但不取代基础 recall backend。

来源：[OpenClaw Memory Overview](https://docs.openclaw.ai/concepts/memory)、[Builtin Memory Engine](https://github.com/openclaw/openclaw/blob/main/docs/concepts/memory-builtin.md)、[Memory Configuration](https://docs.openclaw.ai/reference/memory-config)。

最值得 Pipiclaw 采用的是：**entry-level recall stats + query diversity + action boundary + keyword-first hybrid fallback**。不建议第一步就引入 dreaming/wiki/plugin 复杂度。

### 7.3 Claude Code

Claude Code 把两类持久信息分得很清楚：

- `CLAUDE.md`：用户/项目/组织写的规则与指令；
- auto memory：Claude 从纠正、偏好、构建/调试经验中生成的本地项目记忆。

auto memory 采用“`MEMORY.md` 是小索引，topic files 按需读取”的结构；启动只加载前 200 行或 25KB；同 repo 的 worktrees 共享；用户可通过 `/memory` 查看、关闭、编辑或删除。Claude 文档还明确说明 memory 是上下文，不是硬策略，真正的强制约束应放 hook/settings。

来源：[Claude Code Memory](https://code.claude.com/docs/en/memory)。

可借鉴点：

- 把 MEMORY.md 从“所有事实正文”逐步变成 compact index；
- 详细 debugging/architecture/topic memory 按需读取；
- 明确 memory 与 enforceable policy 的边界；
- 提供用户可见的 memory browser 与开关。

### 7.4 Codex

Codex 当前公开文档同样强调分层：`AGENTS.md` 放必须持续生效的团队指导，memories 只是 helpful recall，skills 承载可复用流程。Local memories：

- 默认关闭，按 task 控制“可使用旧记忆”和“可贡献新记忆”；
- 跳过 active/short-lived session；
- 空闲足够久才后台生成；
- 对生成字段做 secret redaction；
- 可在 rate-limit 余额低时跳过；
- 可禁止使用过 MCP/web/tool search 的任务进入记忆生成；
- extraction model 与 consolidation model 可独立指定；
- memory store 包含 summary、durable entry、recent input 与 supporting evidence。

来源：[Codex Memories](https://learn.chatgpt.com/docs/customization/memories)、[Codex Customization](https://developers.openai.com/codex/concepts/customization)、[Codex AGENTS.md](https://developers.openai.com/codex/guides/agents-md)、[Codex Skills](https://developers.openai.com/codex/build-skills)。

这对 Pipiclaw 最有价值的不是产品开关，而是两个原则：

1. **记忆生成与记忆使用是两项独立授权。**
2. **外部上下文与 secrets 必须在自动记忆前经过政策过滤。**

## 8. 推荐的目标架构

保持 file-first，不引入进程外服务；把 SQLite 仅作为可重建索引。

```text
                     ┌───────────────────────────┐
                     │ Canonical evidence        │
                     │ context/log/session JSONL │
                     └─────────────┬─────────────┘
                                   │ exact incremental window
                                   ▼
┌───────────────┐       ┌───────────────────────────┐
│ deterministic │──────>│ Capture policy            │
│ signals       │       │ source/trust/secret/PII   │
└───────────────┘       └─────────────┬─────────────┘
                                     │ MemoryOp proposal
                            ┌────────▼────────┐
                            │ pending/approve │
                            │ or auto-apply   │
                            └────────┬────────┘
                                     ▼
              ┌────────────────────────────────────────┐
              │ Human-readable memory                 │
              │ SESSION.md / MEMORY.md / HISTORY.md   │
              │ + metadata/tombstone sidecar          │
              └──────────────────┬─────────────────────┘
                                 │ rebuildable
                  ┌──────────────┴──────────────┐
                  ▼                             ▼
        ┌──────────────────┐          ┌──────────────────┐
        │ entry recall     │          │ session index    │
        │ lexical/hybrid   │          │ SQLite FTS5      │
        └────────┬─────────┘          └────────┬─────────┘
                 └───────────┬─────────────────┘
                             ▼
                 threshold → diversity → rerank
                             │
                    evidence-bearing context
```

设计原则：

1. JSONL transcript 是证据，不是普通记忆。
2. Markdown 是可审计主视图，不依赖数据库才能恢复。
3. SQLite/embedding 都是可删除重建的派生索引。
4. 所有 durable 写入只走一个 `MemoryOp` 协议。
5. 每个 op 必须能回答：谁说的、从哪里来、何时有效、是否敏感、替代了谁。
6. retrieval 必须能 abstain；“没找到”优于注入弱相关噪声。
7. policy/permission 不放 memory；任务/提醒不放 memory；procedure 优先放 skill。

## 9. 分阶段路线图

### Phase 0：先修正确性与安全闭环（1-2 周，最高优先级）

- 让 durable/growth 真正只消费 `entriesSince(cursor)`；compaction 只消费 `messagesToSummarize`。
- signal scan 改为扫描同一个增量 window。
- post-turn review 改为 `MemoryOp[]`，移除纯 append 自动写路径。
- reranker 空数组表示 abstain；增加最低 score/coverage。
- `forget` 增加 tombstone，修改返回文案与审计内容，防历史复活。
- 自动记忆默认排除 external tool/web 内容；增加 secret scanner。
- cleanup 输出做 id/schema lint，小文件同样设置绝对最小保护。
- 修 `session_search` cache key、`maxChunks` 语义与重复文档。

验收标准：

- 同一增量 batch 在 scheduler + shutdown + compaction 组合下只处理一次；
- 删除后的条目不会从旧 transcript 自动复活；
- rerank 返回空不会注入候选；
- 含 mock API key 的 tool result 永不进入 MEMORY/SESSION/HISTORY；
- 自动 growth 不再产生无 target 的重复 append。

### Phase 1：entry-level memory 与可观测性（2-4 周）

- channel MEMORY 候选细化到 entry id；
- metadata sidecar：kind/subject/source/trust/time/status/sensitivity；
- recall stats：count、last recalled、query fingerprint/diversity；
- bootstrap 与 recall 基于 entry id 去重；
- `/memory status/list/show/pending` 管理面；
- review log 降噪并关联 sidecar cost。

验收标准：

- recall 输出可追溯到具体 entry 与 source session entry；
- 能统计 30 天每类 job 的“成本 / 新增有效条目 / 后续被召回次数”；
- 大 section 中只注入命中的 bullet。

### Phase 2：冷历史索引与可选混合召回（3-6 周）

- 每频道 SQLite FTS5 增量索引，JSONL 为 source of truth；
- message 去重、role/time/source filter、offset pagination；
- CJK trigram/BM25；
- 先用离线评测决定是否加 embedding；
- 若加 embedding，保留 keyword-only fallback，增加 MMR 与 selective temporal decay；
- memory/topic files 可按需索引，但 evergreen durable memory 不做时间衰减。

验收标准：

- 历史量增大 100 倍后，search p95 不随 JSONL 总大小线性增长；
- code symbol/error string 的 keyword recall 不退化；
- 中文改写问题的 recall@5 有可测提升；
- 索引删除后可从 JSONL/Markdown 完整重建。

### Phase 3：作用域、审批与长期治理（4-8 周，独立 spec）

- memory generation/use 两个独立开关；
- personal/sensitive/workspace skill 写入 pending approval；
- user-scope 隐私模型与群聊可见性；
- retention/purge policy；
- 可选独立 extract/consolidation 模型与 quota gate；
- action-sensitive metadata 与到期清理。

这一阶段不应与 Phase 0 混在一个大 PR 中。

## 10. 评测体系：从“代码覆盖率”升级到“记忆效果覆盖率”

建议建立 `test/memory-eval/`，使用固定模型输出 fixture 做 pipeline 测试，再用可选真实模型 job 做离线基准。

### 10.1 核心指标

| 阶段 | 指标 |
|---|---|
| Capture | precision、recall、重复率、敏感信息泄漏率、错误来源晋升率 |
| Update | supersede accuracy、冲突并存率、过期条目残留率 |
| Retrieval | recall@1/3/5、precision@k、MRR、abstention accuracy、冗余率 |
| Answer | grounded answer accuracy、错误记忆依赖率、引用证据正确率 |
| Forget | active removal、derived index removal、resurrection rate（目标 0） |
| Performance | p50/p95 latency、每轮注入 chars/tokens、sidecar cost、索引大小 |
| Operations | failed job rate、backoff time、stale index duration、跨进程冲突率 |

### 10.2 必测场景

1. 中文同义改写与英文 code symbol 混合查询。
2. 用户偏好从 A 改为 B，旧值必须失效。
3. 临时约束到期，不得永久影响未来 turn。
4. 多成员群聊中，A 的偏好不能被当成 B 的偏好。
5. web/tool result 含 prompt injection，不得写入 durable memory。
6. tool output 含 API key/手机号/地址，必须拦截或 pending。
7. `forget` 后经历 restart、cleanup、compaction、growth review，条目不得复活。
8. 一个 section 有 100 条 bullet，只召回相关一条。
9. 查询前提错误时，系统应 abstain/纠正，不应硬找弱相关 memory。
10. 同一 batch 经 idle、shutdown、compaction 多路径，只产生一次有效 op。
11. JSONL 数月增长后 session search 的延迟与内存上限。
12. workspace skill 自动晋升不得携带 channel 私密内容。

### 10.3 外部 benchmark 的使用方式

可借用 [LongMemEval](https://arxiv.org/abs/2410.10813) 的五类能力：信息提取、多 session 推理、时间推理、知识更新、拒答；再参考 [LongMemEval-V2](https://arxiv.org/abs/2605.12493) 的环境状态、workflow、gotcha 与 premise awareness。

不要只追 leaderboard。Pipiclaw 必须额外维护中文、钉钉群聊、多主体、权限边界、工具污染、遗忘防复活这组自有测试，因为它们比通用双人对话 benchmark 更贴近真实风险。

## 11. 不建议做的事情

- 不要把所有记忆迁到外部 SaaS/provider；会破坏 channel 边界、可审计性与离线恢复。
- 不要立刻引入独立 vector service；先做 entry 粒度、FTS5 和评测。
- 不要新增更多后台 job；把现有 job 的输入、写协议、policy、metrics 收敛为共享组件。
- 不要把任务/提醒继续塞进 open-loop memory；精确 future work 应由 task/event 系统承担。
- 不要让 LLM 自报 confidence 成为唯一自动写门槛；应结合来源、用户显式性、重复纠正、敏感等级与召回价值。
- 不要把 AGENTS/SOUL/security policy 当作可被自动 memory promotion 修改的内容。
- 不要声称“forget”实现了数据删除，除非冷存储、备份、索引和审计的 retention 都被明确处理。

## 12. 最终判断

Pipiclaw 的记忆模块不是“做得不够多”，而是已经到了该从能力堆叠转向质量收敛的节点。

最值得肯定的是，它已具备成熟系统才会有的运行时骨架：显式分层、可靠写入、边界固化、后台门禁、频道隔离、冷上下文和审计。最需要警惕的是，这套骨架目前让人产生了比内容质量更高的安全感：worker 仍在重复看整段历史，召回仍是 section 级弱匹配，自动写仍有双协议，forget 仍可能复活，外部内容仍能污染 durable store。

如果只做三件事，推荐顺序是：

1. **修正增量 window，并统一所有 durable 写入为 MemoryOp。**
2. **补齐 tombstone、来源信任、secret/外部上下文 policy。**
3. **把召回细化到 entry，建立效果指标，再决定 FTS5/embedding。**

完成这三步后，Pipiclaw 会从“可靠地维护几份记忆文件”升级为“能解释为什么记、为什么找、为什么删、为什么信”的记忆系统；这才是长期团队 Agent 真正的记忆管理水平。

## 附录 A：主要代码入口

- [`src/memory/lifecycle.ts`](../../src/memory/lifecycle.ts)：边界生命周期与 shutdown flush
- [`src/memory/maintenance-jobs.ts`](../../src/memory/maintenance-jobs.ts)：四类后台 job
- [`src/memory/maintenance-gates.ts`](../../src/memory/maintenance-gates.ts)：确定性门禁
- [`src/memory/consolidation.ts`](../../src/memory/consolidation.ts)：durable ops、cleanup、history folding
- [`src/memory/session.ts`](../../src/memory/session.ts)：SESSION refresh 与 sticky merge
- [`src/memory/recall.ts`](../../src/memory/recall.ts)：词法 scoring、intent、rerank、render
- [`src/memory/candidates.ts`](../../src/memory/candidates.ts)：四类候选构造与缓存
- [`src/memory/session-search.ts`](../../src/memory/session-search.ts)：冷历史评分
- [`src/memory/session-corpus.ts`](../../src/memory/session-corpus.ts)：JSONL corpus 构造
- [`src/memory/files.ts`](../../src/memory/files.ts)：Markdown 文件与 MemoryOp 应用
- [`src/memory/post-turn-review.ts`](../../src/memory/post-turn-review.ts)：memory/skill promotion
- [`src/tools/memory-manage.ts`](../../src/tools/memory-manage.ts)：save/search/forget 工具
- [`src/agent/channel-runner.ts`](../../src/agent/channel-runner.ts)：逐轮 prompt 集成

## 附录 B：外部一手资料

- [Hermes Agent — Persistent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/)
- [Hermes Agent — Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)
- [Hermes Agent — Skills System](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/)
- [OpenClaw — Memory Overview](https://docs.openclaw.ai/concepts/memory)
- [OpenClaw — Builtin Memory Engine](https://github.com/openclaw/openclaw/blob/main/docs/concepts/memory-builtin.md)
- [OpenClaw — Memory Configuration Reference](https://docs.openclaw.ai/reference/memory-config)
- [Claude Code — How Claude remembers your project](https://code.claude.com/docs/en/memory)
- [Codex — Memories](https://learn.chatgpt.com/docs/customization/memories)
- [Codex — Customization](https://developers.openai.com/codex/concepts/customization)
- [Codex — Custom instructions with AGENTS.md](https://developers.openai.com/codex/guides/agents-md)
- [Codex — Build skills](https://developers.openai.com/codex/build-skills)
- [LongMemEval (ICLR 2025)](https://arxiv.org/abs/2410.10813)
- [LongMemEval-V2](https://arxiv.org/abs/2605.12493)
