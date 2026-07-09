# Pipiclaw 深度 Review 报告

| 字段 | 值 |
|------|------|
| 状态 | 调研 / 评审文档 |
| 评审日期 | 2026-07-09 |
| 评审基线 | `master` @ `6c2f616`（v0.7.6） |
| 适用范围 | 全项目架构、可靠性、记忆子系统、工具层、测试与工程质量（**功能与可用性优先**） |
| 评审方法 | 五路并行子系统精读（记忆 / 并发与可靠性 / 安全 / 编排与工具 / 测试与质量）+ 自读脊柱文件（`channel-runner.ts`、`bootstrap.ts`、`index.ts`、spec 021 design/review） |
| 关联文档 | [pipiclaw-vs-hermes.md](./pipiclaw-vs-hermes.md)、[hermes-learning-insights.md](./hermes-learning-insights.md)、[spec 021 review](../specs/021-toolset-enhancement/review.md) |

> **评审范围说明**：本轮按决策**暂缓安全类问题**，聚焦功能正确性与可用性。命令守卫绕过、SSRF、凭据泄露、PATH/审计/confinement 等纯安全发现已从本报告移除，留待后续专门的安全加固轮次。因此本报告的「严重度」仅衡量**功能/可靠性/可用性**影响，不代表完整风险评估。下文若某条同时涉及安全与正确性，仅保留其正确性/可用性面向。

---

## 0. 一句话结论

> 这是一份**工程纪律很高、方向想得很清楚**的项目；但它的实现**与自己的定位发生了局部倒挂**——最该稳的「可靠性底座」（钉钉传输持久化、进程级资源回收、热路径成本）恰恰是最弱的地方，而它刻意收敛的「成长闭环」虽然骨架搭对了（suggestion-first），却有三根支柱是半坏的。问题高度集中、可修，没有系统性烂尾。

如果只看一张表，看 §1 的严重度清单；如果只做三件事，看 §7 的 P0/P1/P2。

---

## 1. 严重度总览（先看这张表）

| # | 级别 | 主题 | 位置 | 摘要 |
|---|:---:|---|---|---|
| **C1** | 🔴 严重 | 可靠性 | `runtime/dingtalk.ts:566,599` | **钉钉 socket 断线期间的消息永久丢失**，无缓冲/重放/webhook 兜底。核心可靠性承诺在重连窗口内不成立 |
| **H1** | 🟠 高 | 可靠性 | `runtime/dingtalk.ts:427,481` | 重连依赖对 SDK 私有字段的 `Reflect.set` 变异，SDK 升级可让重连永久静默失效，且无回归测试 |
| **H2** | 🟠 高 | 持久化 | `shared/atomic-file.ts:9` | "原子写"未 `fsync`，掉电可损坏 `channel.json`/`settings.json`/维护态——所有人都在信任的文件 |
| **H3** | 🟠 高 | 并发/数据完整性 | `subagents/tool.ts:176` | 上下文子代理可直接 `write`/`edit` 父频道的 `MEMORY.md`，**未经串行队列**，与后台 consolidation 竞态写坏 durable 记忆 |
| **H4** | 🟠 高 | 容量 | `agent/runner-factory.ts:5` | 频道 runner 永不淘汰，每个常驻 `AgentSession`+文件句柄，多频道长跑必然 OOM/被迫重启 |
| **H5** | 🟠 高 | 热路径 | `agent/channel-runner.ts:288` + `memory/recall.ts:546` | 中文输入几乎每轮触发**模型 rerank**（最长 8s），加在 prompt 前同步路径上，直接违背「低热路径成本」北极星 |
| **H6** | 🟠 高 | 可靠性 | `runtime/dingtalk.ts:752` | 用户消息队列**无上限**（事件队列限 5），followUp 重排可无限堆积，刷屏=长时间卡死/OOM |
| **H7** | 🟠 高 | 正确性 | `agent/channel-runner.ts:266` | 预防性压缩只按裸用户消息估 token，但 recall/digest/bootstrap 是**之后**拼进去的，可导致它本该防止的上下文溢出 |
| M1–M21 | 🟡 中 | 多处 | 见 §3 | 半死连接被长回合掩盖、ACK 后 fire-and-forget 丢消息、`setConversationMeta` 热路径同步非原子写、FSWatcher 无 error 处理、croner 无 protect、`/stop` 竞态、`SessionResourceGate` 重载竞态、`ChannelStore` 同步 I/O、无全局 LLM 反压、`seedIntentCandidates` 死代码、`session_search` 冷存储先被淘汰、recall 截断无续读指示、两套 `hasMeaningfulMessages`、SOUL/AGENTS 无大小上限、非 Anthropic 模型 key 回退错、grep 对子代理不可达、失败子代理用量漏计、grep 缓冲全量 stdout（OOM）、空尾回合卡死、`web_fetch` offset 越界空返回等 |
| L1–L6 | ⚪ 低 | 多处 | 见 §3 | `resolveInitialModel` 非确定性、`review-log` 轮转 `slice(-0)` 边界、folded-history recency boost 恒 0、`waitForTasks` 定时器未清、cleanupTimer/sweeper shutdown 未显式停、`MemoryCandidateStore.invalidate` 竞态等 |

> 与 spec 021 自审（`review.md`）的关系：该文档已捕获并修复 B1（job 时长）、B2（grep 拦截）、G1（forget 审计）、G4（matchCount）、R2（sweeper）；并诚实记录了 R1（孤儿进程，跨平台风险暂不修）、D2/D3（T3 交付为「地板」）。本报告**不重复**这些已结案项。

---

## 2. 项目的目标与定位（评审基准）

要把评审讲清楚，必须先锚定 Pipiclaw 想成为什么——否则「问题」无从谈起。

**一句话定位**（综合 README / AGENTS.md / 两份 Hermes 文档）：

> Pipiclaw 是一个**钉钉优先的长期协作 runtime**，基于 `pi-coding-agent`，刻意回答「agent 如何长期**稳定**地工作」，而不是「agent 如何越来越强」。

由此派生的几条**自我承诺**，也是本报告的评审尺子（安全本轮暂缓，不列入）：

1. **可靠性优先**：CLAUDE.md 原文——「queueing, reconnection, persistence, and memory maintenance are higher priority than cosmetic refactors」。
2. **低热路径成本**：分层文件记忆 + 受控召回，热路径「不为也许以后会用到的东西付费」。
3. **显式作用域**：workspace / channel / session 冷存储，三层清晰，拒绝「全局隐式大脑」。
4. **成长闭环（受控扩展）**：procedural skill、冷路径 session_search、suggestion-first post-turn reviewer、压缩前 promotion——但**不得打穿**上述边界。

**关键判断**：用这几把尺子量下来，实现与承诺的吻合度是**不均匀**的——

| 承诺 | 实现吻合度 | 说明 |
|------|:---:|------|
| ① 可靠性优先 | ⚠️ **偏低** | 传输层持久化、进程级资源回收是最弱的两处，恰是 ① 的核心 |
| ② 低热路径 | ⚠️ **偏低** | 中文每轮 rerank、recall/digest/bootstrap 每轮重发、SOUL/AGENTS 无上限 |
| ③ 显式作用域 | ✅ **良好** | workspace/channel/session 分层干净，串行队列不变量被严肃对待 |
| ④ 成长闭环（受控） | 🟡 **骨架对、支柱半坏** | suggestion-first 做对了；但 seedIntentCandidates 死、session_search 冷存储先淘汰、promotion 未单独实现 |

**核心洞察**：Pipiclaw 把差异化赌在「稳定可控」，但工程投入恰好**倒挂**——成长类功能（记忆成长、skills、session search、task ledger）是最成熟的，而稳定类底座（传输持久化、资源回收、热路径纪律）是最薄弱的。这不是「还没做」，而是「在稳定性这条最该重的线上欠了债」。

---

## 3. 严重问题详述

### 🔴 C1 — 断线期间的消息永久丢失（核心可靠性承诺悬空）

**位置**：`src/runtime/dingtalk.ts:566-597`（收到即 ACK）、`:599-706`（`doReconnect`，1s 起步指数退避到 30s）、`:673-677`（close → scheduleReconnect）。

**问题**：钉钉 Stream 模式**不重投递**。socket 掉线后进入 close→backoff→reconnect 窗口（可达数十秒），期间服务端接受的用户消息**永远到不了这里**——没有 WS 可到达、没有 webhook/拉取兜底、没有持久化入站队列。用户看到的是「已读不回」。叠加 M1（半死连接被长回合掩盖）和 M2（ACK 后 fire-and-forget，处理抛错也丢），最坏是一个长回合期间数小时静默丢消息。

**为什么是严重**：项目把自己定义为「长期稳定工作」的 runtime，可靠性是第一承诺（CLAUDE.md 原文）。而传输层——它的核心面——在最基本的「不丢消息」上没有答案。

**修复方向**：把入站消息当**持久资产**——ACK 前先落 `jsonl-appender` 入站日志，单独 replayer 消费；或并行启用钉钉 HTTP webhook 作第二入站路径（Stream 为主、webhook 兜底）。最低限度：向频道暴露「自 T 起断连」状态，让用户知道消息可能丢。

### 🟠 H1 — 重连依赖未文档化的 SDK 私有变异

**位置**：`runtime/dingtalk.ts:427-479`（`markClientDisconnected`/`clearClientSocketReference` 用 `Reflect.set` 改 `connected`/`registered`/`reconnecting`/`socket`）、`:481-507`（`connectWithTimeout` 再 `connect()`）、`:533-564`（client 全程复用，重连不重建）。

**问题**：设计是「复用一个 `DWClient`，靠变异私有字段逼它重连」。但 `DWClient.connect()` 在这些内部变异后是否真的重开 socket，**没有任何公开契约保证**。SDK 一旦改字段名或让 `connect()` 在「自认为已连」时变 no-op，重连就**永久静默失败**：`getSocket()` 永远 null，循环重试同一个坏 client。多处理程 `Reflect.set` callsite 都是耦合点。**没有测试模拟真实传输掉线并断言投递恢复。**

**修复方向**：把 SDK 当黑盒——重连时**新建** `DWClient` + 重新 `registerCallbackListener`，替换 `this.client`，而非变异内部态。补一条集成测试：杀底层 socket → 断言重连后发的消息被处理。并加启动自检：期望的私有字段缺失时大声告警。

### 🟠 H2 — 「原子写」未 fsync

**位置**：`shared/atomic-file.ts:9-22`（`writeFile` 后 `rename`，无 `fsync`）。

**问题**：write-temp-then-rename 给了**目录项**的原子性，但 temp 文件的**数据**没落盘。Linux 上 `rename` 返回后掉电，重命名后的文件可能是零长或半截——损坏的正是 `channel.json`/`settings.json`/维护态这些「所有人都在信任」的文件。项目声称的「atomic-file (write-temp-then-rename)」只有原子性的**表象**，没有它暗示的**持久性**保证。

**修复方向**：`writeFile` 后、`rename` 前 `datasync()`/`fsync()` temp 文件；rename 后再 fsync 父目录（Linux 全持久化）。这是小、独立、高 ROI 的修复，应最先落地——它直接保卫其余系统信任的文件。附带：启动时清扫残留 `${path}.${pid}.${uuid}.tmp` 孤儿文件。

### 🟠 H3 — 子代理直改父频道记忆文件，与 consolidation 竞态写坏 durable 记忆

**位置**：`subagents/tool.ts:176-201`（`buildSubagentTools` 以父 `channelDir` 为根构造 `write`+`edit`）；`subagents/discovery.ts:9`（`ALLOWED_SUB_AGENT_TOOLS` 含 write/edit）；`prompt-builder.ts:150`（主 agent 被告知不要直改 `MEMORY.md`/`HISTORY.md`，要走 `memory_manage`）。

**问题（数据完整性面向）**：主 agent 编辑频道记忆的**唯一合规路径**是 `memory_manage`，它经共享串行队列（与 lifecycle/maintenance-jobs 同队列），这正是 CLAUDE.md 明令保护的不变量。但子代理**从没收到这条规则**（`buildSubAgentTask` 只注入运行时上下文+任务），而 `memory_manage` 又被正确地从子代理收走了（`availableToSubagents: false`）。结论：子代理触碰记忆的**唯一**路径就是 `write`/`edit` 的 read-modify-write（`edit.ts:187`），**完全绕过串行队列**。

**场景**：一个 `contextual` 子代理被派任务，后台 consolidation 正在写 `MEMORY.md`。子代理的 `edit` 与 consolidation 并发 read-modify-write 同一文件 → 后写者覆盖先写者 → **durable 记忆条目丢失**。这与威胁模型无关，纯是合法子代理工作时的数据损坏竞态——对一个以记忆为核心的产品是实打实的功能正确性问题。

**修复方向**：把「运行时管理的记忆文件（`MEMORY.md`/`HISTORY.md`/`SESSION.md`）」从子代理 `write`/`edit` 的可达范围中排除（一条 confinement 规则，效仿「嵌套用结构而非 prompt 防止」的范式），或让子代理对记忆的写也走同一串行队列；最低限度把「不要直改记忆文件」指令注入 `buildSubAgentTask`。前者更可靠。

### 🟠 H4 — 频道 runner 永不淘汰

**位置**：`agent/runner-factory.ts:5`（`channelRunners = new Map`，只建不删）；`runtime/bootstrap.ts:633-650`（首接触即建）；`resetRunner` 仅 shutdown 时调。

**问题**：每个曾经发过消息的 `channelId`（每个 DM/群）都 spawn 一个 `ChannelRunner`，常驻 `AgentSession`、`SessionManager`（打开的 `context.jsonl` 句柄）、`ModelRegistry`、`MemoryLifecycle`、事件订阅、内存消息历史，全进程生命周期保留。加很多群、很多 DM 用户 → 内存与文件句柄稳步增长直到 OOM/重启。文档自承「known bottleneck」，但对一个 reliability-first 的长程 runtime，这是**会触发重启的泄漏**。

**修复方向**：LRU/空闲淘汰策略——runner 空闲 > N 分钟、无在途回合、无待办记忆作业时，先 flush 记忆再从 Map 淘汰；下次消息到达时重建（频道目录+文件持久化，状态不丢）。把模块级 `managers` Map（job-manager）和 job 记录的淘汰挂到同一策略上。

### 🟠 H5 — 中文几乎每轮触发模型 rerank（热路径成本倒挂）

**位置**：`agent/channel-runner.ts:288`（`autoRerank: HAN_REGEX.test(clippedInput)`）；`memory/recall.ts:546-570`（`shouldUseModelRerank`：`candidates.length > maxInjected` 即 12>5 时触发）；`:71`（`MEMORY_RECALL_RERANK_TIMEOUT_MS = 8_000`）；`settings.ts:187-193`（默认 `maxCandidates:12, maxInjected:5, rerankWithModel:"auto"`）。

**问题**：钉钉优先的受众压倒性是中文，`autoRerank` 对**任何**含汉字输入硬编码为 true。记忆层一旦充实，`candidates > maxInjected`（12>5）几乎必然成立，于是大多数中文回合在 prompt 前同步路径上**多一次 LLM 调用**（最长 8s）——直接违背「低热路径成本」北极星，且让「recall 默认开」变得不敢信任。

**修复方向**：把 `autoRerank` 改为 opt-in 或频率门控（仅 `memorySensitiveQueryIntent` 命中、或 per-channel 冷却）；或把 rerank 移出关键路径（prompt 在 rerank 决策时已存在，可后置异步）。配合调高 `HIGH_CONFIDENCE_SCORE`/`CLOSE_SCORE_DELTA`。

### 🟠 H6 — 用户消息队列无上限

**位置**：`runtime/dingtalk.ts:730-750`（`enqueueEvent` 在 `size()>=5` 拒绝）vs `:752-763`（`enqueueStreamMessage` 永远入队）；`:1275-1279`（busy 时普通消息按 followUp 重排）。

**问题**：频道忙时普通消息默认 `busyMessageDefault`（常为 "followUp"）→ 返回 `requeue` → 再 `enqueueStreamMessage`，每次重排都压到**无上限**的 `ChannelQueue`。用户粘贴大量消息或脚本灌入 → 队列无限增长 → 每项又串行跑完整回合 → 频道长时间卡死、进程 OOM。事件路径刻意限了 5，用户路径没限，**不一致**。

**修复方向**：把同样的有界策略（上限+超限丢弃带告警，或上限+对发送方反压）应用到 `enqueueStreamMessage`；区分「首个 followUp」与「洪水」。

### 🟠 H7 — 预防性压缩的 token 估算是低估

**位置**：`agent/channel-runner.ts:266`（压缩检查）vs `:279/:302/:313`（recall/task digest/bootstrap 在检查**之后**拼接）。

**问题**：`maybeRunPreventiveCompactionForIncomingText` 只拿裸用户消息（裁到 12k）估 token。紧接着 prepend recall（`maxChars`，可达数千）、task digest、首回合 bootstrap（`FIRST_TURN_MEMORY_SNAPSHOT_MAX_CHARS`=3000）——这些**都没计入** `incomingTokens`。

**场景**：频道坐在 ~72% 窗口，发短消息 → 压缩被跳过（投影 <75%）→ recall+digest+bootstrap 把实际回合推过 100% → 触发 SDK 级上下文溢出——而 `shouldFallback` 正确地拒绝重试溢出，回合**直接死**。守卫要防的，恰恰发生了。

**修复方向**：先算完整 `promptText`，再在其上做压缩决策；或至少把 rendered recall/digest/bootstrap 的字符数加进 `incomingTokens` 再决策。

---

## 4. 中等问题（按主题归并）

> 限于篇幅压缩，每条给「位置 + 一句话 + 方向」。均来自子系统精读，锚点行号已核对。

**可靠性 / 并发**
- **M1 半死连接被长回合掩盖**（`dingtalk.ts:640`）：30s keepalive 仅在 `elapsed>90s && !activeMessageProcessing` 时强制重连；长回合期间 `activeMessageProcessing` 恒真，强制重连被无限推迟。方向：liveness 与 active processing 解耦（在途回合用 HTTP 投递卡片，不依赖 WS）。
- **M2 ACK 后 fire-and-forget，处理抛错也丢**（`dingtalk.ts:566`）：先 ACK + dedup 标记，再异步处理；处理抛错→消息已 ACK 且被去重→永久丢。方向：ACK 移到成功 enqueue 之后；dedup 键基于成功派发而非收到。
- **M3 `setConversationMeta` 热路径同步非原子写**（`dingtalk.ts:1335`）：每条入站消息 `mkdirSync`+`writeFileSync`；崩溃截断→`JSON.parse` 失败→该频道「No conversation metadata」无法完成在途回复；且同步 I/O 阻塞事件循环。方向：走 `writeFileAtomically` 并异步化。
- **M4 FSWatcher 无 error 处理、无自愈**（`events.ts:265`）：ENOSPC（inotify 上限）/目录移除/平台错误时抛未处理错误；watcher 死后 one-shot/periodic 事件**永久静默停发**，无重连无告警。方向：`.on("error")` + 退避重 `start()`；周期性 re-`scanExisting()`。
- **M5 croner 无 `protect`，周期事件可重叠**（`events.ts:562`）：`preAction`(bash) 在频道队列外执行，间隔短于执行时长时并发跑、副作用竞态。方向：`{ timezone, protect: true }`。
- **M6 `/stop` 与 followUp 重排的竞态**（`dingtalk.ts:752/658`）：已返回 `requeue` 即将重排的 busy 分支，可能在 `clearPending` 之后把任务加回。方向：`enqueueStreamMessage` 内查 stopping 标志并丢弃。
- **M7 `SessionResourceGate` 重载竞态**（`session-resource-gate.ts:27` + `channel-runner.ts:462`）：prompt 一结束（`activePromptCount==0`）就 `flushPendingRefresh`，可能抢在 runner 读 `session.messages`/记用量之前 `reload()`；若 reload 抛错还会把成功 prompt 误判为 `stopReason:"error"`。方向：reload 推迟到「回合完全 settle」信号后；reload 错误绝不冒泡成 run 错误。
- **M8 `ChannelStore.rotateIfNeeded` 在异步队列里做同步 I/O**（`store.ts:126`）：`statSync`/`renameSync` 阻塞事件循环、轮转错误被吞。方向：换 `fs/promises` 异步；轮转失败 warn。
- **M9 无全局 LLM 限流/反压**：多频道+后台 consolidation+sidecar+子代理并发打 provider，无共享并发上限；fallback 是反应式非主动节流，可对限流 provider 持续重试风暴。方向：全局 per-provider token bucket/并发限制，429 指数退避。

**记忆 / 成长闭环**
- **M10 `seedIntentCandidates` 是死代码**（`recall.ts:430-482`）：意图召回的增长特性**永不产出**——它只对 `scored` 里没有的候选做意图提升，但候选缺席的唯一原因是零词重叠，而它复查的是 `scoreCandidate` 已测字段的子集，必然仍零重叠→`continue`。退化成重排+切片。无测试引用它。方向：对意图候选去掉 `matchedTokens.size>0` 自相矛盾的守卫，按 intent+priority+recency 评分。
- **M11 `session_search` 冷存储先被淘汰**（`session-corpus.ts:286-312`）：按读序累积（context→log→log.1→session 文件），`slice(-maxDocuments)` 留 session 文件、丢冷存储——而 session_search 正是冷路径恢复工具。现有测试只填 `log.jsonl`，测不到多源淘汰。方向：按文档时间戳跨源 oldest-first 淘汰，或给 context/log 源预留最低槽位。
- **M12 session-search 单槽全局缓存**（`session-search.ts:176`）：只缓存一个 channelDir 的语料 30s；两频道交替搜索每次全重建；且写入不失效，30s 内可能返回过期结果。方向：按 channelDir 的有界 LRU Map + 按文件 mtime 指纹（效仿 `MemoryCandidateStore`），而非墙上时钟 TTL。
- **M13 recall 截断无续读指示**（`recall.ts:595`）：clip 时静默 `break`，`</runtime_context>` 闭合无「[- N more omitted; 用 memory_manage search]」——违反 AGENTS.md 的截断规约。方向：早 break 时追加尾注。
- **M14 两套语义不同的 `hasMeaningfulMessages`**（`consolidation.ts:212` 计 ≥2 任意角色 vs `maintenance-jobs.ts:101` 要求 user+assistant 都有）：同命名异语义，喂同一 consolidation 管线，让 idle-skip 判断难以推理。方向：合并为一个显式参数的共享 helper。
- **M15 SOUL.md/AGENTS.md 进系统提示无上限**（`workspace-resources.ts:19/36`）：`readFileSync().trim()` 无截断，进**系统**提示、每轮付费、永不压缩。失控的 AGENTS.md 静默吃固定且增长的窗口。方向：head-clip 到 8–16KB，超限发 config diagnostic。

**编排 / 工具可用性**
- **M16 `getApiKeyForModel` 对所有 provider 回退 `ANTHROPIC_API_KEY`**（`api-keys.ts:14`）：非 Anthropic 模型拿到 Anthropic key → 401，错误文案还指向「设对应 provider 环境变量」（但代码从没查过任何 provider 变量）。**功能性 bug**：用 OpenAI/Google/OpenRouter 模型时配置稍错就报迷惑性 401。方向：provider→env 映射（`OPENAI_API_KEY`/`GOOGLE_GENERATIVE_AI_API_KEY`/`OPENROUTER_API_KEY`…），仅 `provider==="anthropic"` 才回退 ANTHROPIC。
- **M17 grep 对子代理不可达**（`registry.ts:124` vs `discovery.ts:9`）：grep 标 `availableToSubagents:true` 但不在 `ALLOWED_SUB_AGENT_TOOLS`，子代理拿不到，被迫退回无界 `bash grep`（正是 grep 工具要消灭的模式）。方向：把 grep 加入白名单（无状态只读，本就 sub-agent-safe）。
- **M18 失败子代理的用量漏计**（`session-events.ts:140` + `tool.ts` throw 路径）：子代理 throw 时无 `details`，`mergeSubAgentUsage` 被跳过，真实计费的 partial 用量永远不到 `totalUsage`/ledger；`/usage` 系统性低估最贵的失败委派。方向：throw 前把累计 usage 带上，或至少先记 ledger。
- **M19 grep 缓冲全量 stdout 再截断**（`grep.ts:229`）：JS 塑形在 shell grep 跑完、全 stdout 入内存之后；松 pattern + 大 workspace 可数百 MB 才触发 30s 超时——进程级 OOM 风险（不只是上下文风险）。方向：把字节/行上限下推到 shell（`head -c`/早停），或流式带强上限。
- **M20 空尾回合静默丢弃**（`session-events.ts:295`）：assistant 无 tool 结果且最终文本空 → 不设 finalOutcome → 交付分支都不触发 → 卡在「thinking…」卡片。方向：把空终态当显式 outcome（投「(no output)」或并入 silent）。
- **M21 `web_fetch` offset 越界空返回无续读**（`web-fetch.ts:49`）：offset≥body.length 返回空串无指示，模型易循环。方向：返回「Reached end of page (N). No more content.」

**低（L，择要）**
- L1 `resolveInitialModel` 取 `available[0]` 无确定性保证（`models/utils.ts:126`），registry 重载顺序变就可能静默换默认模型；方向：按 provider/id 稳定排序。
- L2 `review-log` 轮转 `slice(-0)` 边界（1 行超长永不轮转）+ 吞非 ENOENT 错（`review-log.ts:37`）；无测试覆盖。
- L3 folded-history 块把 heading 当 timestamp→`Date.parse` 得 NaN→recency boost 恒 0（`candidates.ts:168`）；应传真实 ISO 时间戳。
- L4 `waitForTasks` 的 `Promise.race` 胜出后 setTimeout 未 clear（`bootstrap.ts:544`），manual 重启会拖到最长 45s 定时器。
- L5 `ChannelStore.cleanupTimer`/job sweeper shutdown 时未显式停（unref 兜底，卫生问题）；方向：暴露 `dispose()` 并在 shutdown 调用。
- L6 `MemoryCandidateStore.invalidate` 与在途 load 竞态可服务一轮过期 recall（下次自愈）；可加注释或在 commit 前复查指纹。

---

## 5. 横切主题（比单条 bug 更重要的结构性观察）

把发现往上抽，**重复出现的模式**才是真正值得决策者看的：

### 主题 A：「先建后不收」——进程级资源管理缺席
永不淘汰的 runner（H4）、永不裁剪的 job 记录、无上限用户队列（H6）、无全局 LLM 反压（M9）、模块级 `managers` Map 永不清。**都是同一形状：无限创建、永不回收。** 一条统一的「空闲淘汰策略 + 有界队列 + 共享 provider 限流器」就能把「长到重启」变成「负载下稳态」——这正是长程钉钉 runtime 需要的。

### 主题 B：「边界算对了输入，但算错了对象」——安全网静默失效
预防性压缩用裸消息估 token（H7）、失败子代理用量漏计（M18）、job 运行态 duration 返绝对时间戳（spec 021 已修的 B1）、recall 截断无指示（M13）、grep matchCount 过报（spec 021 已修的 G4）。**同一类 off-by-an-input bug：边界存在，但拿错的输入算，于是安全网该兜的兜不住，且测试全绿。** 这是最阴险的一类——因为门禁绿得理直气壮。

### 主题 C：「热路径被『也许有用』侵蚀」——北极星被悄悄违背
中文每轮 rerank（H5）、recall/digest/bootstrap 每轮重发进 user turn、SOUL/AGENTS 无上限（M15）。项目最强调「低热路径成本」，但记忆充实后，普通中文回合的 prompt 前同步路径上叠了可达 8s 的 LLM + 数千字符每轮重发。**「成长」正在反向吃掉「稳定快」。**

### 主题 D：脊柱文件是最大的测试盲区 + 唯一 god-method
`run-queue.ts` 8% 覆盖（且 catch 把错误吞成 warning，正是最该测的）、`channel-runner.ts` 33.7% 覆盖且含 ~270 行 god-method `run()`。**架构文档把它俩点名抬为脊柱，测试却把它们当黑盒绕过。** 二者应**结对**攻坚：给 `createRunQueue` 补单测（错误吞没+顺序+drain），把 `run()` 拆成 `prepareTurn/executeTurn/finalizeTurn` 再各测。

---

## 6. 成长闭环评估（对照 Hermes 路线图）

April 的 `hermes-learning-insights.md` 给了三条优先级（procedural skill / cold-path session_search / suggestion-first reviewer）。当前实现状态：

| 闭环支柱 | 设计意图 | 实现状态 | 评价 |
|---|---|---|---|
| **post-turn reviewer** | suggestion-first，不自动写 | ✅ **做对了** | 自动写需同时满足「setting flag + 置信度≥0.85(memory)/0.9(skill) + necessity==="high"」，否则只产出 suggestion。这是项目要的安全设计。skills 跨频道可见是 by design（workspace 级过程记忆），contamination 风险低可接受。 |
| **procedural skill** | 可读/写/修补/审计 | 🟡 **可用，命名不统一** | `skill_manage` 已支持 list/view/create/patch/write_file。但用 `action` 而非 `op`，是 manage 工具族里唯一异类（spec 021 G3，团队判定不修）。 |
| **cold-path session_search** | 显式工具、不进热路径、focused summary | 🟡 **半坏** | 工具存在且 score-gated，**但**语料淘汰把冷存储先丢（M11，恰是它该挖的）、单槽全局缓存跨频道抖动且不随写失效（M12）。这条支柱**部分功能性失效**。 |
| **recall 意图召回** | 意图命中即可召回（不依赖词面重叠） | 🔴 **死代码** | `seedIntentCandidates` 永不产出（M10）。意图召回是 aspirational only。 |
| **压缩前 promotion** | compaction/new-session 前提取 durable/skill/drop 候选 | ⚪ **未单独实现** | 边界 consolidation 负责了 durable 写，但没有独立的「promote before we lose this」候选提取。是 open item 非 bug。 |
| **memory_manage（forget/invalidate）** | 用户「忘掉 X」闭环、串行化、可审计 | ✅ **已闭环** | forget 经共享串行队列、写审计行（spec 021 G1 已修）、多命中不猜列候选。 |

**结论**：成长闭环的**安全姿态**（suggestion-first、串行化、可审计）是对的，忠实于「不打穿边界」的哲学——这是值得肯定的。但闭环的**有效性**有三处缺口（seedIntentCandidates 死、session_search 半坏、promotion 未建），意味着「成长」在当前形态下**沉淀效率低于设计预期**。按 Hermes 文档的判断框架（增强长期协作/保持显式作用域/不增热路径/可审计可回滚），这三处修复都高分，应进路线图。

---

## 7. 演进方向（路线图，按优先级分波）

> 原则：**先还稳定性债（项目差异化所在），再修有效性缺口，最后扩能力。** 每波可独立上线、独立回滚。安全加固不在本轮范围。

### Wave 0 — 守住底线（小、独立、高 ROI，应最先）
1. **H2**：`atomic-file` 加 `fsync`（+ 父目录 fsync + 启动清扫孤儿 tmp）。保卫所有人信任的文件。
2. **H3**：把「运行时记忆文件」从子代理 `write`/`edit` 可达范围排除（或注入 SOP 规则），杜绝 durable 记忆竞态损坏。
3. **M3/M8**：`setConversationMeta` 走原子异步写；`rotateIfNeeded` 异步化。

### Wave 1 — 修复核心可靠性承诺
1. **C1**：入站消息持久化（ACK 前落 jsonl 日志 + replayer）或 webhook 第二入站路径；最低限度暴露断连状态。
2. **H1**：重连改「新建 DWClient」而非变异私有态；补「杀 socket→断言投递恢复」集成测试；启动自检期望私有字段。
3. **H6**：用户消息队列有界（对齐事件的 5）+ 洪水反压。
4. **M1/M2/M4/M5/M6/M7**：liveness 与 active processing 解耦；ACK 移到成功 enqueue 后；FSWatcher 加 error 处理 + 自愈；croner 加 `protect`；`/stop` 设同步 stopping 标志；`SessionResourceGate` reload 推迟到回合 settle。
5. **H7**：压缩决策改用完整 promptText。

### Wave 2 — 进程级资源管理（把「长到重启」变「稳态」）
1. **H4**：runner 空闲淘汰（drain 记忆→drop→重建）；挂上 job-manager Map 与 job 记录的淘汰。
2. **M9**：全局 per-provider token bucket/并发限流 + 429 退避，所有 LLM 调用者（turn/consolidation/sidecar/subagent）过同一限流器。
3. **L5**：模块级单例（store cleanupTimer、job sweeper）补 `dispose()` 并在 shutdown 调用。

### Wave 3 — 热路径纪律 + 有效性缺口
1. **H5**：rerank 改 opt-in/频率门控/移出关键路径；调高 high-confidence 阈值。
2. **编排**：把 durable/bootstrap 记忆路由进 system-prompt override（缓存、不每轮重发），而非 user turn。
3. **M15**：SOUL.md/AGENTS.md head-clip + 超限 diagnostic。
4. **M10**：修 `seedIntentCandidates`（去自相矛盾守卫），让意图召回真正生效；补 recall 三处缺失测试（`shouldUseModelRerank`/`renderRecallResult` 截断/intent-seeding）。
5. **M11/M12**：`session_search` 按时间戳跨源淘汰 + 按 channel 的 LRU+mtime 缓存。
6. **M13**：recall 截断加续读尾注。
7. **promotion**：compaction/new-session 前加显式候选提取阶段（durable/skill/drop）。

### Wave 4 — 脊柱测试 + 质量锁
1. **主题 D**：`run-queue.ts` 单测（错误吞没+顺序+drain）；把 `channel-runner.run()` 拆 `prepareTurn/executeTurn/finalizeTurn` 并各测。
2. 补 §4 列出的边界用例（grep 行截断/单文件 200 上限；jobs 真实进程级集成测试，覆盖孤儿清理与无人轮询超时——含 spec 021 暂缓的 R1）。
3. **质量锁**：重新启用 Biome `noExplicitAny`/`noNonNullAssertion`（当前 0 real `as any`/2 个 `!`，干净，应锁住）。
4. **M14/M16/M17/M18/M19/M20/M21**：合两套 `hasMeaningfulMessages`；provider-aware key 解析；grep 加子代理白名单；失败子代理带用量；grep 字节上限下推；空尾回合显式 outcome；web_fetch 越界提示。

### 长期方向（战略，非本轮）
- **多实例/水平扩展**：`docs/scaling-and-concurrency.md` 已写「>30 活跃频道建议多实例」。Wave 2 的资源管理落地后，单实例稳态上限会更清晰，再据此定水平拆分线。
- **可观测性**：把 §5 的几个「静默失效」主题（消息丢失、重连失败、watcher 死、限流风暴）变成 `--status`/日志里可见的健康信号——「静默」是当前可靠性问题里最伤人的特性。
- **（安全加固，留待后续专门轮次）**

---

## 8. 工程质量与纪律（值得肯定的部分）

报告以问题为主，但必须诚实记录**做对的地方**——否则结论会失真：

- **领域边界干净**：runtime/agent/memory/subagents/tools/security/web 分层清晰，近期 `d65fde1` 主动去重去死代码，knip 全净。
- **类型卫生顶级**：全仓 **0 个真 `as any`**（唯一的在 `read.ts:171` 注释里）、**0 个 suppression 注释**（`@ts-ignore`/`biome-ignore`）、**2 个非空 `!`**。`as unknown as` 仅 4 处且都有理由（含 1 处 `_baseToolsOverride` 私有字段访问，已文档化+运行时告警）。
- **测试快且绿**：597 用例 / 91 文件，~5s；spec 021 自审 + triage + 修复的纪律（B1/B2/G1/G4/G7/R2 实修，R1/D2/D3 诚实记录不修理由）。
- **并发原语可靠**：run-queue 的 per-channel 串行 + `/steer`/`/stop` 注入、`SerialQueue`/共享 `channel-maintenance-queue` 防 lifecycle-vs-maintenance 竞态、`handleEvent` 的同步 `running=true` 关 busy 路由竞态——**均已验证正确**。
- **记忆变更串行化 + 原子写 + 畸形文件防御**：数据完整性底子好。
- **成长闭环的安全姿态对**：suggestion-first、串行化、可审计，忠实于「不打穿边界」。
- **战略思考水准高**：两份 Hermes 文档（取舍克制、非目标清单堪称范本）、spec 021 design 的「想清楚为什么不抄」——这是高级工程判断力。

一句话：**这是一个被认真对待的项目，问题集中在少数几条线，不是系统性烂尾。** 修完 Wave 0–2，它就能真正兑现「长期稳定工作」的差异化承诺。

---

## 附：评审边界与置信度

- **本轮范围**：功能正确性 / 可靠性 / 可用性 / 工程质量。**安全类问题已按决策整体暂缓**，不在本报告计分。
- **子系统精读、锚点行号已核对**：C1/H1–H7、§4 全部 M/L。其中 C1（断线丢消息）、H1（重连私有态变异）、H4（runner 不淘汰）、H5（中文 rerank）逻辑确凿、风险明确；H2（fsync 缺失）是 `atomic-file.ts` 源码直读确认；H3（子代理记忆竞态）是串行化不变量的直接违反。
- **与团队自审的关系**：spec 021 `review.md` 已结案的项（B1/B2/G1/G4/G7/R2 已修；R1 孤儿进程因跨平台风险暂不修；D2/D3 T3 范围收窄已记录）本报告**不重复计为问题**，仅在相关处引用。R1 建议作为 T3 鲁棒性独立后续（含一条最小真实进程级集成测试）。
