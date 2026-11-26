# OpenMausBot 记忆与检索：借鉴评估与方案

日期：2026-11-26
输入：[openmausbot-memory-and-retrieval-input.md](./openmausbot-memory-and-retrieval-input.md)（下称“输入文档”）
依据：OpenMausBot `server/{cjk-search,recall,memory-capture,memory-fact-checks,message-db}.ts` 源码；Pipiclaw `src/memory/` 源码；[spec 050](../specs/050-memory-v2/design.md)；本机 `~/.pipiclaw` 真实数据实测（脚本在本次会话的 scratch 目录，未入库）。
状态：已改写为 [spec 072](../specs/072-transcript-search-index/design.md)，以 spec 为准。

用途：作为 spec 072 的设计输入，可直接改写为 `design.md`。

---

## 0. 结论

| 输入文档的方向 | 判断 | 一句话理由 |
|---|---|---|
| A. `node:sqlite` FTS5 派生索引 + CJK bigram | **采纳，优先级最高，但目标要改** | 真正的问题是 `session_search` **只能看到工位最近一部分冷存储**，而且越用看到的比例越小，速度慢只是次要问题。输入文档没有指出这一点 |
| B. frontmatter `aliases` | **暂不采纳** | 索引会在首轮整份注入，同义改述由主模型自己匹配；别名在写入时只能猜，查询时让模型自己给同义词更准。复议条件见 §4 |
| C. 反思反幻觉校验 | **只采纳其中的“标识符锚点核验”**；逐字 evidence 字段与疑问/假设句过滤不采纳 | Pipiclaw 的事实大多来自工具输出而非用户原话；“如果……就……”恰恰是最有价值的长期规则写法；实测的主要失败模式是把阶段性状态写成记忆，`durability` 门控今天已经处理 |
| D. 每轮自动预召回 | **不采纳** | spec 050 D1 已基于评测退役每轮召回；预召回带来的噪音、历史副本问题依旧存在；索引溢出已有 D4 分层与 condense 处理 |
| （输入文档未提）注入信封污染冷存储 | **采纳，随 A 一并修** | 当前语料 24% 的 user 文档带运行时注入块，占 user 文本 57% 的字符 |
| （输入文档未提）`roleFilter: ["tool"]` 失效 | **采纳，随 A 一并修** | pi 的工具结果角色是 `toolResult`，被归一成 `unknown`，`tool` 过滤永远为空 |

一句话：**借 OpenMausBot 的检索引擎来扩大冷存储覆盖、提高质量，它的召回产品形态不照搬**。OpenMausBot 是陪伴型助手（事实来自“这个人”说的话，记忆按主题文件存放，不会全部进上下文）；Pipiclaw 是研发交付运行时（事实来自工作过程，记忆一事一文件，索引首轮全量注入）。两者的检索底座可以共用，写入纪律与注入形态不能照搬。

---

## 1. 输入文档之外核实的事实

### 1.1 `session_search` 覆盖率：真实瓶颈

`buildSessionCorpus` 有两道硬上限：会话 JSONL 只读 mtime 最新的 `maxFiles = 12` 个（[session-corpus.ts](../../src/memory/session-corpus.ts#L295-L327)），整个工位最多 `5,000` 个文档（[同文件](../../src/memory/session-corpus.ts#L42-L43)）。`log.jsonl` 只保留 1 份轮转（[channel/store.ts](../../src/channel/store.ts#L96-L101)），完整历史只存在于会话 JSONL 中。

在本机 `desk-default` 上实测（默认设置）：

| 指标 | 数值 |
|---|---|
| 会话 JSONL 文件 / 有文本的消息 / 字符 | 67 个 / 7,523 条 / 1,708 万 |
| 进入语料的文档 | 5,000（顶到上限）：context 2,513、log 1,516、**session 仅 911**、task 60 |
| 语料最早时间 vs. 数据最早时间 | **2026-07-21** vs. **2026-04-14**（约 3 个月不可检索） |
| 超过 20k 扫描上限的消息 | 158 条（语料内 38 条被截断） |
| 语料构建 / 首次查询 / 缓存内查询 | 248 ms / 约 1.3 s / 约 40 ms |

`desk-qiyuan` 数据量较小（20 个文件、1,486 条消息），仍在上限以内。**问题会随使用时间线性恶化**：工位用得越久，`session_search` 能看到的比例越低，工具却仍回答“没有匹配”。性能方面，首次查询约 1.3 s，可以接受，不是主要矛盾。

### 1.2 冷存储语料被注入信封污染

主 agent 的 user 消息在落盘时带着 `<memory_bootstrap>`、`<task_agenda>`，以及历史上的 `<runtime_context>`、`<runtime_turn_context>`、`<durable_memory_snapshot>` 等注入块。`memory/transcript.ts` 已有 `stripInjectedMemoryContext`，但 `session-corpus.ts` **没有调用它**。实测语料中 1,575 个 user 文档有 379 个（24%）带注入块，这些文档的字符占 user 文本的 57%。结果是检索时经常命中注入进去的记忆索引副本，而不是用户真正说过的话。

### 1.3 FTS5 原型（同一份 `desk-default`，全量、无上限）

Node 22.21 自带 SQLite 3.50.4，FTS5、`contentless_delete` 均可用；`import "node:sqlite"` 会打印一次 `ExperimentalWarning`。

| 变体 | 文档 | 构建 | 库大小 | 查询 |
|---|---|---|---|---|
| v1：照搬当前提取规则 | 12,864 | 4.0 s | 72.9 MB | 2.5–23 ms |
| v2：剥离注入块、不索引 thinking、工具结果截 4k、精确去重 | 7,260（去重 5,732） | **2.1 s** | **33.6 MB** | **4–10 ms** |

覆盖面对比：`"daily-workspace-git-save"` 能命中 2026-04-14 和 07-19 的原始记录，当前实现最早只到 08-11；`"上次那个语音输入法 ASR 加载的问题怎么修的"` 直接命中 2026-09-10 的原始排查对话。原型也暴露出两点：开发对话需要自己的虚词表（`上次/之前/问题/怎么/如何`，OpenMausBot 的虚词表偏日常闲聊），并且同一工具输出会重复出现，必须做规范化去重。

### 1.4 反思写入的真实失败模式

`desk-default/memory-review.jsonl` 历史上共有 18 次 agent `add`，其中约一半属于阶段性状态，例如 `pipiclaw-review-p1-notification-recovery`、`barback-review-p2-windows-regressions`、`quota-list-review-p2-calculation-errors`、`daily-news-briefing-restored`、`voice-typer-macos-asr-loading-fix`、`dots-triage-fix-20261018`。这些条目**都有充分的原文依据**，只是不具备长期性。逐字 evidence 校验拦不住它们；今天（`ffba769`）加入的 `durability: stable|state` 门控才是对症处理。review-log 不记录条目内容，因此“编造标识符”的发生率无法从日志直接测出。§3.3 的锚点核验是按设计哲学补上的一个低成本不变量，不是针对已观测到的事故。

---

## 2. 逐项判断

### A. 派生全文索引：采纳

适用的原因是，它在不触碰任何一条既有原则的前提下解决 §1.1 和 §1.2：

- **真相源不变**：Markdown / JSONL 仍是唯一真相；索引可以随时删除并重建。spec 050 §7 拒绝的是“用数据库**存**记忆”（理由是 `cat`/编辑器/`git diff`），D13 已经预留了“未来换 FTS5，两者一起换”。派生索引与这两条都不冲突。
- **零依赖**：`node:sqlite` 随 Node ≥22.13 提供，FTS5 已编译在内。
- **CJK 处理**：`U+200B` 单字切分 + 查询侧重叠 bigram 短语，比 FTS5 自带的 `trigram` 分词更适合中文（trigram 对 2 字词无能为力，而中文高频词多为 2 字），也比我们手维护的 273 词词表更通用。

需要修正输入文档的三处：

1. 目标先是**全量覆盖**，然后才是增量和速度。输入文档把“30s 缓存重扫”和 `partialDocuments` 当作主要问题，实测这两者都是次要的。
2. `DatabaseSync` 是同步 API，在 daemon 主线程上一次性构建 2–4 s 会卡住钉钉流式卡片和心跳。必须分片让出事件循环（§3.1.5）。
3. 去重、信封剥离、角色归一要与索引一起设计，否则只是把污染语料检索得更快。

### B. `aliases`：暂不采纳

OpenMausBot 需要 alias，是因为它的主题文件**不在上下文里**，召回只能靠词面匹配主题头部。Pipiclaw 的情况不同：

1. **索引首轮全量注入**（spec 050 D1）。当前 19 条、上限约 70–100 条的描述都在主模型眼前，“dws ↔ 钉钉机器人”这类改述由主模型自己完成，比任何词面别名都强。
2. **会话中途的 `memory_search` 主要查 journal**，即索引里没有的东西。别名只挂在记忆条目上，帮不到 journal。
3. **别名在写入时只能猜**未来的问法；查询时，模型已经知道用户在问什么。§3.1 的 OR 语义 BM25 让模型可以在一次查询里写 `dws 钉钉机器人 DingTalk Stream`，效果等同于查询时扩展别名，且无需新增字段、工具参数、反思 schema 和评测。只需在工具描述里加一句“可同时给出中英文名与别称”。

**复议条件**：工位索引经常触发 D4 超预算分层（`overBudget`），并且 `memory-recall-quality` 评测出现“被省略条目换说法查不到”的失败。届时再在 `memory/<name>.md` 加 `aliases`，作为 FTS 元数据列加权，不进入 bootstrap。

### C. 反思反幻觉：只采纳“标识符锚点核验”

不采纳“逐字 `evidence` 字段 + 必须出自用户发言 + 疑问/假设句过滤”，原因如下：

- **来源模型不同**：OpenMausBot 记的是“关于这个人的事实”，证据自然来自用户原话；Pipiclaw 的 `reference`/`project` 记忆大多来自工具输出和已验证的结果（仓库路径、命令、提交）。只认用户原话会把这类正当记忆全部拒掉。
- **条件句是规则的主要写法**：“如果测试失败就停下来汇报”“review→修复超过三轮就停止”都是最高价值的 `feedback` 常驻规则（见真实条目 `review-fix-max-three-rounds`），用正则过滤“如果/假如”会误伤它们。
- **真实失败模式不同**（§1.4）：主要问题是“有据但非长期”，已由 `durability` 处理。

采纳的部分：**标识符必须有出处**。描述与正文里出现的 URL、路径、提交哈希、版本号、端口等，必须逐字出现在反思 pass 的输入里（任何角色）。这一步完全确定，不增加 LLM 调用，不改 prompt 和输出 schema，专防“模型改写时把参数写错”这种一旦写进常驻记忆就会长期误导的错误。设计见 §3.3。假设讨论、条件规则这两类边界交给评测负例（§5.3），不写成代码规则。

### D. 每轮预召回：不采纳

- spec 050 D1 有意退役了每轮 ≤1,800 units 的召回，理由（历史中堆积副本、干扰模型）现在依然成立，退役也有 `memory-recall-quality` 评测作为证据。
- OpenMausBot 的“放在 user turn 前，不放 system”只能保证 prompt cache 不失效，解决不了历史膨胀；研发对话每轮都塞召回片段，噪音成本高于陪伴场景。
- 输入文档担心的“索引溢出后模型不知道条目存在”已由 D4 省略行（`use memory_search`）和 condense 模式覆盖。A 落地后，`memory_search` 和 `session_search` 变准，这条退路更可靠。

**复议条件**：评测显示模型在省略条目相关的问题上系统性地不调用 `memory_search`。即便如此，也应先改省略行文案和 playbook，再考虑注入。

### 顺带评估：OpenMausBot 其余机制

| 机制 | 判断 |
|---|---|
| 记忆审计日志放在 agent 工作区外，带 diff 与回滚 | 不在本 spec 范围。Pipiclaw 的记忆写入主要经过运行时（工具与反思），review-log 已记录动作；模型直接 `edit` 记忆文件的审计属于 path-guard 话题，另议 |
| `expectedHash` 乐观锁 | 不需要。Pipiclaw 由 `DeskMemoryQueue` 串行化单 desk 写入 |
| 召回块 `clean()` 防止伪造结束标记 | 不采纳注入，自然也不需要；`session_search` 结果已声明为“历史数据”，§3.1 保留这一点 |

---

## 3. 方案

### 3.1 冷存储派生索引（P0，spec 072 主体）

#### 3.1.1 位置与粒度

`state/search-index/<desk>.sqlite`（WAL，文件权限 0600），每个 desk 一个库。

- 不放 desk 目录：desk 目录是 agent 默认 cwd 和工作文件区，几十 MB 的二进制文件会污染 grep/git，也会被模型当作工作文件。索引属于派生运行时状态，与 `state/daemon.lock`、`state/webapi/` 同类。
- 每个 desk 一个库：清理和重建互不影响，与“desk 之间隔离优先”一致。启动时删除对应 desk 目录已不存在的孤儿库。
- 唯一写入者是 daemon（`state/daemon.lock` 保证单进程）；进程内按 desk 用 `SerialQueue` 串行同步。

#### 3.1.2 Schema（`PRAGMA user_version = 1`；版本不符就删库重建，不做迁移）

```sql
CREATE TABLE files (                -- 每个被索引的源文件
  path TEXT PRIMARY KEY, kind TEXT NOT NULL,      -- session|context|log|task
  conversation TEXT, ino INTEGER, size INTEGER, mtime_ms INTEGER,
  indexed_bytes INTEGER NOT NULL, head_hash TEXT  -- 前 4 KiB 的 sha1，识别截断/替换
);
CREATE TABLE docs (                 -- 规范化文本去重后的文档
  id INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE,  -- sha1(role \0 规范化文本)
  role TEXT NOT NULL,               -- user|assistant|tool|system|unknown
  text TEXT NOT NULL, search_text TEXT                -- 含 CJK 时插入 U+200B，否则 NULL
);
CREATE TABLE refs (                 -- 文档出现在哪里；一个文档可有多处出现
  path TEXT NOT NULL, line INTEGER NOT NULL, doc_id INTEGER NOT NULL,
  ts TEXT, conversation TEXT, source TEXT NOT NULL,
  PRIMARY KEY (path, line)
);
CREATE INDEX refs_doc ON refs(doc_id);
CREATE VIEW docs_search AS SELECT id AS rid, coalesce(search_text, text) AS text FROM docs;
CREATE VIRTUAL TABLE docs_fts USING fts5(text, content='docs_search', content_rowid='rid', tokenize='unicode61');
-- ai / ad / au 三个触发器维护 docs_fts（同 OpenMausBot ensureSearchIndex）
```

硬规则：upsert 一律写 `INSERT … ON CONFLICT DO UPDATE`，**禁止 `INSERT OR REPLACE`**（默认不触发 delete trigger，会在 FTS 里留下孤儿行，这是 OpenMausBot 踩过的坑）。

#### 3.1.3 索引什么，怎么提取

| 来源 | 范围变化 |
|---|---|
| 会话 JSONL、`context.jsonl` | **全部**（取消 `maxFiles`） |
| `log.jsonl` 与所有轮转 `.N` | 同上 |
| `tasks/archive/<id>.md` + `.jsonl` | 每个任务一个文档（沿用现有拼装逻辑） |

| 提取规则 | 决定 | 理由 |
|---|---|---|
| user 文本 | 先 `stripInjectedMemoryContext`，再 `redactSecrets` | 修 §1.2；复用 `transcript.ts`，信封标签只维护一份 |
| assistant 文本、工具调用名 | 保留 | 与现状一致 |
| thinking | **不索引** | 推理过程常是假设（“可能是 X”），作为检索证据会把猜测当事实返回；结论会出现在可见回复里 |
| 工具结果 | 角色归一为 `tool`，只保留头 3k + 尾 1k 字符 | 修 `roleFilter` 失效；报错通常在尾部；全文可按路径 read |
| 单文档上限 | 200k 字符（现为 20k） | 158 条长消息基本不再截断；仍被截断的继续计入 `partialDocuments` |
| 去重规范化 | 折叠空白、去掉行首 `[时间戳]`/`[用户名]` 前缀后再算 hash | 原型中 log/session 双写与重复工具输出占了 44% |

#### 3.1.4 增量同步（在查询时惰性执行）

每次 `session_search` 先 `sync(desk)`：

1. 列出源文件，逐个 `stat`。约 200 个文件，耗时几毫秒。
2. 同一 `ino`、`head_hash` 不变且 `size ≥ indexed_bytes`：从 `indexed_bytes` 起只解析新增内容，**只处理到最后一个 `\n`**（避免读到写入方追加了一半的行）。
3. `ino` 或 `head_hash` 变化、文件变短：删除该文件的全部 `refs`，再重新索引。`log.jsonl` 轮转（rename）会落在这一支，单个文件约 1 MB，开销很小。
4. 源文件已不存在：删除其 `refs`。
5. 每个文件一个事务。事务末尾清理本次涉及的、已没有 `refs` 的 `docs`。

不在写入侧挂钩：写路径（turn 落盘、日志轮转）保持不变，不引入新的失败点；查询前同步，所以结果总是最新的。

#### 3.1.5 不阻塞事件循环

- 一个事务处理一个文件；大文件每 2,000 行提交一次。每片之间 `await setImmediate()`，单片目标 ≤50 ms。
- 首次全量构建（最大工位实测约 2 s）在 daemon 启动、渠道连接就绪后以空闲优先级预热；如果预热期间来了查询，查询排进同一个 desk 队列等待，不另起第二次构建。
- 查询本身 4–25 ms，同步执行即可。

#### 3.1.6 查询与排序

1. **查询词**：拉丁词与标识符最多 16 个（加引号转义；长度 ≥4 的词加前缀通配 `*`），CJK 重叠 bigram 最多 24 个（先剥离虚词，虚词同时作为切分点；没有 bigram 时退回单个汉字）。两类配额独立，避免长中文把英文错误码、文件名挤出查询。虚词表在 OpenMausBot 基础上补充开发对话的高频词（`上次/之前/刚才/问题/怎么/如何/为什么/是否/一下`）。词表约 30 个，远小于现在的 273 词表，且只用作切分点，不影响召回。
2. **SQL**：`MATCH` 用 OR 连接，按 `bm25()` 取前 50；`roleFilter` 下推到 `docs.role`；join `refs` 取最新出现的时间和会话。
3. **JS 重排**：`归一化相关度 × 角色权重（tool 0.7）+ recencyBoostByAge + 整句命中加分`。常量集中放在一处，由评测调参。
4. **长问句降噪**（OpenMausBot `enoughMatches`）：有效实词数（拉丁词 + bigram/2）≥5 时，单条结果至少要覆盖 2 个不同的词。
5. **展示窗口**：在 `maxCharsPerChunk` 内取**命中词最密集**的区间（现在取首次出现的位置），清除 `U+200B` 后返回。
6. **空查询**：按时间倒序返回最近的文档，行为与现在一致。

#### 3.1.7 模型与用户可见的变化

- 工具 schema 不变，描述加一句：“可在一次查询中同时给出中英文名、别称和标识符”（这是 B 的替代做法）。
- 结果里的 `searchedDocuments` 改为工位索引的文档总数，`partialDocuments` 的提示基本不再出现。
- 设置项：`sessionSearch.maxFiles`、`sessionSearch.maxChunks` 失去意义，加入 `RETIRED_SETTINGS_KEYS`；`maxCharsPerChunk`、`summarizeWithModel`（默认已关闭）保留。

#### 3.1.8 失败语义

| 情况 | 行为 |
|---|---|
| `SQLITE_CORRUPT` / `SQLITE_NOTADB` / `user_version` 不符 | 删除库后重建，写一条 warn 日志 |
| 重建仍失败（磁盘满、权限问题） | 工具抛普通 `Error`（用户需要知道），文案带下一步：“冷存储索引不可用：<原因>。可先用 grep 搜索 `desk-<desk>/conversations/`。”**不保留第二套内存扫描实现**，避免长期维护两套检索 |
| `ExperimentalWarning` | 只有 `memory/search-index-db.ts` 一处 import `node:sqlite`；import 前只过滤这一条警告（`name === "ExperimentalWarning"` 且消息以 `SQLite` 开头），其余警告不受影响 |

#### 3.1.9 代码落位（Layer 6 `memory`，不越层）

| 文件 | 内容 | 预估行数 |
|---|---|---|
| `memory/cjk-terms.ts` | `U+200B` 写入形态、bigram/虚词、FTS 表达式构造与转义、`enoughMatches` | ~150 |
| `memory/search-index-db.ts` | 开库/建表/版本检查/损坏重建、upsert、FTS 查询（唯一的 `node:sqlite` 使用方） | ~250 |
| `memory/search-index-sync.ts` | 文件扫描、增量追加、轮转识别、分片让出 | ~250 |
| `memory/session-corpus.ts` | 保留解析函数（逐行转文档），删除整库构建、`shareBudget` 与预算逻辑 | 467 → ~250 |
| `memory/session-search.ts` | 改为调用索引；删除 TTL 缓存、`WeakMap` 分词缓存 | 315 → ~200 |
| `tools/session-search.ts` | 文案微调，仍是薄适配器 | 不变 |

净增约 300 行，换来全量覆盖和统一的排序模型。§3.2 完成后还能再删掉 `chinese-words.ts`（273 行）和 `search.ts` 中的手写打分。

### 3.2 `memory_search` 并入同一引擎（P1，依赖 3.1 稳定）

收益不在速度（19 条记忆加一年 journal，线性扫描足够），而在**统一**：同一套中文处理、BM25 与 IDF、片段选取，并能删掉词表维护负担。

- 同一个库增加 `kind ∈ {memory, journal, workspace}` 的文档：记忆每个文件一个文档（description + 正文），journal 每条 bullet 一个文档，工作区 `MEMORY.md` 每个 H2 段一个文档。按 `(mtime, size)` 同步，规模很小。
- 去掉现在 journal 检索的“365 个文件 / 1 MiB / 每份 64 KiB”上限。
- **`memory_save` 的近重复判断不迁入 SQLite**（输入文档在这点上是对的）。`tokenizeRecallText` 换成 `cjk-terms` 的 bigram 集合后，需要用真实条目对（本机 19 条 + 墓碑 + review-log 中的 replaces 记录）重新标定 0.6 阈值。阈值标定通过后才删除 `chinese-words.ts`，否则继续保留并单独记录。

### 3.3 反思标识符锚点核验（P1，可与 3.1 并行，只改动 `reflect.ts`）

- **锚点**：在 add/update 的 `description` + `details` 中抽取 URL、含 `/` 的路径（`~/` 与 `$HOME` 视为等价）、7–40 位且同时含字母和数字的十六进制串（提交哈希）、`v?\d+\.\d+(\.\d+)+` 版本号、`host:port` 或“端口 N”中的端口。**不包括日期**，因为模型会根据“今天”推算日期。
- **出处**（haystack）：反思 pass 实际可见的全部输入，即**未截断**的序列化窗口（任何角色，含工具结果）、当前索引与正文、工作区 `MEMORY.md`、当天 journal。另外，被 update 的旧条目本身包含的锚点视为已有出处。比较前做 NFKC 归一并去掉末尾标点。
- **不通过**：该 op 进入 `rejected`，原因写 `unanchored identifier: <锚点>`。现有逻辑会把同一 pass 的删除顺延，这正是想要的保守行为。
- **不适用于** `memory_save`：用户明确要求记住的内容不受此限。
- **误拒成本低**：被拒的事实仍在 journal 和冷存储里，3.1 落地后可以完整检索到。所以直接执行，不设观察期开关。

---

## 4. 不采纳项的复议触发条件

| 项 | 何时重新考虑 |
|---|---|
| `aliases` | 工位常态性触发 D4 超预算，且 `memory-recall-quality` 出现“被省略条目换说法召回失败” |
| 每轮预召回 | 评测显示模型在省略条目相关的问题上系统性不调用 `memory_search`，并且改省略行文案和 playbook 后仍无改善 |
| 向量/embedding | 同 spec 050 §7：单个工位记忆达到数千条，或词法召回在评测中成为主要失败原因 |
| 逐字 evidence / 假设句过滤 | 出现有记录的“由假设讨论写成的记忆”事故，且评测负例无法通过 prompt 修正 |

---

## 5. 测试与评测（遵守 AGENTS.md 分层与规模控制）

### 5.1 单元测试

`session-search.test.ts` 当前 391 行，用例**以替换为主**：内存打分、TTL 缓存、`shareBudget` 相关用例随代码删除；以下新增用例各自对应一种明确的错误实现。

| 风险 | 用例 |
|---|---|
| 中文词面边界 | 2 字词、虚词切分、单字退回、中英混排的配额隔离、引号/`AND`/`*`/`:` 转义（错误实现会让 FTS 抛语法错误或漏召回） |
| 增量正确性 | 追加了半行时不索引该行；轮转（rename）后不重复、不丢失；截断/替换后重建；源文件删除后 refs 与孤儿 docs 被清理 |
| 触发器一致性 | 同一文档重复 upsert 后 FTS 行数与 docs 行数一致（防 `INSERT OR REPLACE` 回归） |
| 自愈 | 写坏库文件头 → 自动重建；`user_version` 不符 → 重建 |
| 语料质量 | 带注入块的 user 消息只索引 `<user_message>` 内文；`toolResult` 能被 `roleFilter: ["tool"]` 命中；thinking 不可检索 |
| 锚点核验 | 窗口里没有的路径被拒、工具结果里有的路径通过、`~` 与 `$HOME` 等价、日期不算锚点、同一 pass 的删除被顺延 |

### 5.2 确定性 e2e（净增 1 例，附 mutation check）

**新增 1 例**：真实 daemon，脚本化 provider 产生 15 个会话文件（超过旧的 12 文件上限），在最旧那个文件里写入唯一标记 → 通过 `session_search` 命中该标记 → 再追加一轮对话 → 再查询，能命中新内容，并且在同一进程里通过计数器确认没有重新全量构建 → 重启 daemon 后查询不触发重建。

- 能抓住的跨模块失败：同步没接上查询路径、增量退化成全量、重启丢索引。单元测试证明不了“真实落盘的会话文件 → 索引 → 工具”这条链路。
- mutation check：把 `maxFiles` 式的截取逻辑放回去，或让 sync 每次都全量重建，确认这个用例变红。

现有 M3/M4 等反思用例中补一个断言：脚本化反思返回带有窗口外路径的 add，确认它被拒并记入 review-log（扩展已有用例，不新增用例）。

### 5.3 评测（`evals/`）

- `memory-recall-quality` 增加冷存储问题：只在 3 个月前的会话里出现过的细节，验证覆盖面的改进确实被模型用上了。
- 反思新增两个对照负例：①“如果把部署挪到周五会怎样”这类纯假设讨论**不应**入库；②“以后测试失败就先停下来汇报”这类条件规则**应**入库。这两例同时证明不写假设句过滤是对的。
- 按 AGENTS.md 规定：改动 `session_search` 工具描述属于模型可见的变更，需要跑 `eval -- plan --changed-since <ref>` 涉及的 dev 用例，并记录 run id 与失败归因。

---

## 6. 用设计哲学的七问检查本方案

| 问题 | 回答 |
|---|---|
| 真相存在哪里？ | 仍在 JSONL / Markdown；索引是可以删除的派生物 |
| 重启后如何继续？ | 库在 `state/` 持久化；按文件指纹增量追上，版本或损坏不符就重建 |
| 并发时谁拥有写入权？ | daemon 单进程（daemon.lock）+ 每个 desk 一个 `SerialQueue`；源文件只读 |
| 失败时如何停止？ | 损坏 → 重建；重建失败 → 带下一步的明确错误，不静默返回空结果 |
| 花费如何受控？ | 不增加任何 LLM 调用；锚点核验是纯确定性逻辑；磁盘占用约为源数据的 0.7 倍（原型 v2） |
| 行动凭什么被证明？ | 单元测试覆盖边界，e2e 覆盖真实链路，评测覆盖召回质量 |
| 用户如何撤销或修复？ | 删除 `state/search-index/<desk>.sqlite` 即可，下次查询自动重建 |

---

## 7. 实施顺序与验收

1. **072-A 冷存储索引**（§3.1）。验收：本机 `desk-default` 的 `session_search` 能检索到 2026-04 的内容；首次构建期间钉钉流式卡片不卡顿（单片 ≤50 ms 的日志证据）；同步后查询 p95 <50 ms；`npm run check` 与 `npm run test:e2e` 全部通过。
2. **072-B 锚点核验**（§3.3），可以与 1 并行。验收：单元测试 + 评测负例；上线两周后查看 review-log 的 `unanchored` 拒绝记录，人工抽查误拒率。
3. **072-C `memory_search` 并轨**（§3.2），在 1 稳定后进行。验收：近重复阈值重新标定，且 `memory-recall-quality` 不低于基线后，才删除 `chinese-words.ts`。

## 8. 已拍板（2026-11-26）

1. thinking 不进索引。
2. 索引放在 `state/search-index/<desk>.sqlite`，不放 desk 目录。
3. 不保留内存扫描作为兜底：索引不可用时明确报错，并引导改用 grep。

## 9. 成本、时效与长期运维

### 9.1 成本

| 项 | 量级 |
|---|---|
| 开发 | 新增约 650 行（cjk-terms / search-index-db / search-index-sync），删除约 330 行（整库构建、预算分配、TTL 与分词缓存）；单元测试以替换为主，e2e 净增 1 例 |
| LLM 费用 | 零增加 |
| 磁盘 | 约为对话源数据的 0.7 倍（原型 v2：48 MB 源 → 34 MB）；`desk-default` 增速按 5–10 MB/月对话计，索引约 4–7 MB/月 |
| 内存 | 下降：不再在堆里缓存每个 desk 最多 5,000 份文档全文及其分词集合，改用 SQLite 页缓存 |
| CPU | 首次全量构建与数据量成正比（实测 48 MB 约 2 s）；之后每次查询只处理新增字节（毫秒级）加约 200 次 `stat` |
| 新风险 | `node:sqlite` 仍是实验性 API（收敛在一个文件里）；同步 API 阻塞事件循环（分片缓解）；新增“索引不可用”的失败模式（明确报错 + grep 退路） |

### 9.2 时效

查询前同步：每次 `session_search` 先把磁盘上已写入、以 `\n` 结尾的新内容索引进去，再执行查询。所以结果与磁盘上的数据同步到最后一个完整行。唯一的盲区是写入方还没落盘的内容（例如 `log.jsonl` 防抖刷盘的最后几秒），而这部分内容本来就在当前会话上下文中，且会话 JSONL 里也有同一份。

### 9.3 长期运维

不需要定期任务：

- 增量只追加；源文件被截断、替换或删除时，按文件指纹自动处理。
- FTS5 自动合并段（automerge），WAL 自动 checkpoint；daemon 正常关闭时 `PRAGMA optimize`。
- 运行时不会删除对话，所以库只增不减，不需要 VACUUM；人工删除大量会话后，可以直接删库让它重建，比 VACUUM 更简单。
- schema 变化 → `user_version` 不符 → 自动重建，不写迁移。
- 唯一需要持续关注的是 Node 升级时 `node:sqlite` 的 API 变化：只有 `search-index-db.ts` 一个文件受影响，单元测试会第一时间报错。

### 9.4 删除索引文件

| 时机 | 行为 |
|---|---|
| daemon 未运行时删除 | 下次启动时后台预热会重建；如果预热完成前有查询，查询等待重建完成（当前最大 desk 约 2 s）。结果与删除前一致，因为索引完全由真相文件推导 |
| daemon 运行中删除 `.sqlite` | Linux 上已打开的句柄会继续指向已被 unlink 的旧文件。**设计要求**：每次 sync 先比对库路径的 `ino` 与打开时是否一致；不一致就关闭旧句柄，在原路径重新建库。否则 daemon 会一直往一个看不见的文件里写，直到重启 |
| 只删除 `-wal` / `-shm` | 未 checkpoint 的事务丢失。`files.indexed_bytes` 与文档写在同一个事务里，回滚后两者仍一致，下次 sync 会从回滚点继续追加，不会丢数据也不会重复 |

### 9.5 与数据规模的关系

- 数据量在旧上限以内（12 个会话文件 / 5,000 文档，例如 `desk-qiyuan`）：收益只有质量方面（去掉注入污染、去重、BM25 排序、工具结果过滤、长消息不截断），覆盖面不变。
- 超过上限（例如 `desk-default`）：旧实现能看到的比例随时间不断下降，新实现始终全量，收益随数据量线性增长。
- 成本：查询延迟基本不随规模增长；磁盘与首次构建时间线性增长。按目前增速，几年后单个 desk 的首次构建也只在分钟级以内。真到 GB 级时，再考虑“只索引最近 N 年”的保留策略，现在不做。
