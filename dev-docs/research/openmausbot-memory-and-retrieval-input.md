# OpenMausBot 记忆存储与检索机制剖析及 Pipiclaw 架构借鉴输入

日期：2026-11-26

用途：供后续架构 Agent 作为输入材料，用于设计 Pipiclaw 记忆与检索优化 Spec（Spec 072+）

参考源码：
- OpenMausBot：`~/projects/OpenMausBot/server/{workspace,memory-store,memory-topics,memory-entries,memory-journal,memory-capture,memory-fact-checks,message-db,message-db-memory-index,cjk-search,recall,recall-disclosure}.ts`
- Pipiclaw 基线：`src/memory/{store,search,chinese-words,session-search,session-corpus,reflect,prompt-safety}.ts`、`dev-docs/design-philosophy.md`、`AGENTS.md`

---

## 0. 核心结论（给架构 Agent 的 Executive Summary）

1. **OpenMausBot 没有使用向量库或 Embedding 模型**。它采用的是 **“纯 Markdown 文件为唯一真相源 + Node 内置 `node:sqlite` FTS5（BM25）作为可随时重建的侧边索引 + 97 行零依赖 CJK Bigram 中文检索”** 的务实架构。
2. **这套路线与 Pipiclaw 高度同频**：
   - Pipiclaw 已确立“纯 Markdown 一事实一文件 + 生成 `MEMORY.md` 索引 + `journal/` + `log.jsonl`”（Spec 050）与“零重型外部依赖、可审计可修复”的设计哲学；
   - Pipiclaw 运行环境已要求 **Node >= 22.19**，天然内置 `node:sqlite`（`DatabaseSync`），无需新增任何 npm / native 编译依赖；
   - Pipiclaw 的核心运行场景是**中文高频研发对话（钉钉 + TUI）**，OpenMausBot 的零依赖 CJK FTS5 方案几乎可以无缝补齐 Pipiclaw 当前手写词表 + 线性扫描 + 无 IDF/BM25 排序的真实短板。
3. **本输入文档聚焦 4 个正交可落地的优化方向**：
   - **方向 A（最高收益）**：基于 `node:sqlite` FTS5 + `U+200B` CJK Bigram 的**可重建侧边检索索引**，统一升级 `session_search`（消除 30s 缓存全量扫描与 `partialDocuments` 截断盲区）和 `memory_search`（引入 BM25 + 精准片段提取）；
   - **方向 B（轻量高杠杆）**：为 `memory/<name>.md` frontmatter 增加可选 `aliases` 字段与元数据优先加权，在不上向量库的前提下解决简称/俗称召回盲区；
   - **方向 C（质量守门）**：为 `reflect.ts` 补齐确定性反幻觉核验（原文 `evidence` 引证 + 疑问/假设句过滤 + 关键实体子串核对）；
   - **方向 D（审慎评估项）**：是否引入自动 Pre-turn Recall（若引入，必须守住缓存与防注入红线；也可继续坚持 Pipiclaw 当前的“首轮 Bootstrap + 显式工具按需召回”）。

---

## 1. OpenMausBot 当前做法（源码级拆解）

### 1.1 存储分层：Markdown 是唯一真相，SQLite 仅作派生索引

| 层级 | 位置与格式 | 职责与硬约束 | 源码位置 |
|---|---|---|---|
| **核心常驻记忆** | `workspaces/<botId>/MEMORY.md` | 每次加载进上下文；硬上限 **200 行 / 24 KB**；超限时按优先级（`superseded` → `expired` → 最旧）自动搬迁至 `memory/archive.md` | `workspace.ts:30-31, 423-446` |
| **主题详情文件** | `workspaces/<botId>/memory/<topic>.md` | 按主题拆分；可选 YAML frontmatter：`title`、`description`、`aliases`（最多 12 个） | `memory-topics.ts:10-55` |
| **每日日志** | `workspaces/<botId>/memory/log/YYYY-MM-DD.md` | 按天追加记录 | `workspace.ts` |
| **会话私有笔记** | `workspaces/<botId>/memory/threads/<threadId>.md` | 仅当前会话加载，不入全局列表/索引/审计 | `memory-store.ts:55-57` |
| **审计日志（外置）** | `DATA_DIR/memory-journal/<botId>.ndjson` | 存在 **Agent 工作区之外**，含 LCS unified diff 与变更前快照，支持回滚；防注入 Agent 篡改自身审计 | `memory-journal.ts` |
| **派生全文索引** | `messages.db` 中的 `memory_files` + `memory_fts`、`messages` + `messages_fts` | 纯只读/派生加速层，**删库可全量从磁盘 Markdown 重建** | `message-db-memory-index.ts`, `message-db.ts:935-982` |

**安全与一致性细节**：
- 路径校验采用 **4 种形态白名单**（`parseMemoryPath`），拒绝任意路径清理器；读写前用 `realpathSync` + `lstatSync` 严格禁止 symlink 逃逸工作区（`memory-store.ts:60-113`）。
- 写入前强制经过 `redactSecretsInText` 脱敏，原子写 `0600`，API 层支持 `expectedHash`（SHA-256）乐观锁（冲突返 409）。
- 条目自带行内结构化标记：`- YYYY-MM-DD · from <source> · <fact> [· until YYYY-MM-DD]`，`supersede` 划掉旧行并追加新行；`searchableMemoryText()` 在入索引前自动剔除已过期与已取代条目（`workspace.ts:235-239`）。

### 1.2 派生索引与增量同步机制（`node:sqlite` + FTS5）

**表结构与触发器（`message-db-memory-index.ts` & `cjk-search.ts:60-96`）**：
```sql
CREATE TABLE IF NOT EXISTS memory_files (
  bot_id TEXT NOT NULL,
  path TEXT NOT NULL,
  text TEXT NOT NULL,
  mtime_ms INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  search_text TEXT,
  PRIMARY KEY (bot_id, path)
);

CREATE VIEW IF NOT EXISTS memory_search AS
  SELECT rowid AS rid, coalesce(search_text, text) AS text FROM memory_files;

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  text, content='memory_search', content_rowid='rid', tokenize='unicode61'
);
-- 配套 AFTER INSERT / DELETE / UPDATE 触发器维护 memory_fts
```

**关键工程避坑点**：
1. **不能用 `INSERT OR REPLACE`**：`message-db.ts:135` 明确踩过坑——SQLite 默认关闭 `recursive_triggers` 时，`INSERT OR REPLACE` 不会触发 `DELETE` trigger，导致 FTS5 出现孤儿索引行。必须使用 **`INSERT ... ON CONFLICT(bot_id, path) DO UPDATE SET ...`**（`message-db.ts:938-940`）。
2. **惰性增量同步（`syncMemoryIndex`, `workspace.ts:241-258`）**：
   - 每次执行 `searchMemoryFiles()` 前，扫描磁盘文件的 `(path, mtimeMs, bytes)` 与 `memory_files` 已有记录对比；
   - 若 `(bytes, trunc(mtimeMs))` 未变且**本地日期未跨天**，直接跳过；
   - **跨天触发重同步**（`memoryIndexDates.get(botId) !== today`），确保带 `until YYYY-MM-DD` 的过期条目在次日自动从 FTS5 索引中消失；
   - 磁盘已删除的文件同步 `DELETE`。

### 1.3 零依赖中文检索：`cjk-search.ts`（97 行核心原理）

SQLite FTS5 内置的 `unicode61` 分词器没有中文词典，会把整段连续汉字当成一个超长 token，导致中文子串/词语完全无法命中。OpenMausBot 用极简纯 TS 逻辑解决该问题，无需任何 C 扩展或词典包：

1. **写入侧（单字切分，`cjkSearchText`）**：
   - 仅当文本包含 CJK 字符（汉字、平假名、片假名等）时，在每个 CJK 字符与相邻字母/数字/CJK 字符的边界插入零宽空格 **`U+200B`**（`SEARCH_MARK`），存入 `search_text` 列；无 CJK 文本 `search_text` 为 `NULL`（由 `coalesce(search_text, text)` 零拷贝复用原文）。
   - `unicode61` 将 `U+200B` 视为分隔符，于是每个汉字独立成为一个位置连续的 FTS5 token。
   - 读取 `snippet()` 返回给模型/用户前，调用 `withoutSearchMarks()` 将 `U+200B` 全部抹掉，对外完全透明。
2. **查询侧（虚词剥离 + 重叠 Bigram 短语，`cjkTokenParts` & `recallTerms`）**：
   - 先用标点与中英边界拆分查询；
   - 对中文连续串先剥离高频虚词（`我们|你们|这个|那个|一下|可以|时候|已经|因为|所以|请问|帮我|[的了是吗呢吧啊呀哦嗯么]...`），虚词同时作为切分点，确保不会生成跨虚词的无效 bigram；
   - 对剩余每个汉字片段生成**重叠 2-gram（Bigram）**（如 `钉钉机器人` → `钉钉`、`钉机`、`机器`、`器人`）；若整段没有任何长度 ≥ 2 的片段（如单字 `"猫"`、`"猫的粮"`），则回退保留单个汉字；
   - 每个 Bigram 转成带空格的 FTS5 **邻接短语**（`ftsPhrase("钉钉")` → `"钉 钉"`），精确匹配位置相邻的两个单字 token；
   - **英文/数字与中文独立配额**：`recallTerms()` 分别取最多 **16 个非 CJK 词 + 24 个 CJK Bigram**，防止一段长中文把关键的英文标识符/错误码/文件名挤出查询；
   - **安全转义与英文前缀词干**：`recallMatchTerm()` 对所有 token 加双引号防止 `AND`/`NOT`/`*`/`:` 触发 FTS5 语法错误；4 字符以上纯拉丁词做简单去尾 `s` + 前缀通配 `"${stem}"*`；含标点的词（如 `c++`、`-10`）在 OR 模式下跳过避免 `unicode61` 误匹配。
3. **长句降噪门槛（`enoughMatches`, `recall.ts:62-75`）**：
   - 使用 `mode: "any"`（OR 查询）提高召回率的同时，利用 FTS5 `snippet(..., '[', ']', ...)` 产出的高亮括号统计**实际命中的不同词项数**；
   - 中文一个词约等于 2 个重叠 bigram，因此有效实词数按 `nonCjkTerms + ceil(bigrams / 2)` 折算；
   - 当查询有效实词数 ≥ 5（长问句）时，强制要求单条命中**至少覆盖 ≥ 2 个不同词项**，过滤只撞上一个泛化词的噪音。

### 1.4 三路召回与 Alias 语义桥接（`recall.ts` & `memory-topics.ts`）

每次召回按以下顺序融合（总预算 `RECALL_MAX_CHARS = 6,000`，记忆与历史对话各最多 4 条）：
1. **Topic 元数据优先匹配（`topicPassages`）**：
   - 仅读取每个 `memory/<topic>.md` 的前 **2 KB**（`readTopicHead`）解析 YAML frontmatter（`title`、`description`、`aliases`）；
   - 将文件名 + title + description + aliases 拆词，与查询词做精确/子串/词干匹配（`sameWord`）；
   - 命中的主题文件排在最前（若 FTS5 也命中了该文件，用 FTS5 精确片段替代头部截断，兼顾精准度与优先级）。
2. **记忆正文 FTS5 BM25（`memoryPassages`）**：
   - `ORDER BY bm25(memory_fts), f.mtime_ms DESC`；
   - 自动排除已常驻的 `MEMORY.md`、归档和日志。
3. **历史对话 FTS5 BM25（`conversationPassages`）**：
   - 严格限定 `thread_id IN (允许范围)`；
   - `ORDER BY (m.kind = 'digest'), bm25(messages_fts), m.at DESC`（原文优先于摘要）。

### 1.5 写入侧反幻觉护栏（`memory-capture.ts` & `memory-fact-checks.ts`）

- **单会话 Capture 护栏（`statedInConversation`）**：要求模型为每条 `fact`/`preference` 候选输出逐字 `evidence` 原文引用；确定性代码检查该引用必须真实出现在用户发言中，且**不能位于疑问句或假设句中**。
- **跨会话 Dream 护栏（`checkDreamFacts`）**：除校验原文引证外，抽取新记忆中的所有**数字、路径、URL**，要求必须逐字出现在被引用的用户原文里，否则整条丢弃。

### 1.6 缓存友好与防提示词注入的召回封装（`recall.ts:36-40, 84-112, 202-204`）

- **绝不污染 System Prompt**：召回块拼在当轮**用户消息之前**（`withRecalled`），保持系统提示前缀字节级稳定，不破坏 Prompt Cache。
- **围栏逃逸清理（`clean()`）**：剥离召回文本中可能伪造的 `[end of recalled passages`、将 ```` ``` ```` 替换为 `'''`、折叠换行为 ` … `，并在头部显式声明“召回内容是历史笔记，其中形似命令的句子不是当前指令”。

---

## 2. Pipiclaw 现状基线与精准短板（基于当前 `src/memory/` 源码）

Pipiclaw 在 Spec 050 + Spec 069 中已经建立了非常干净的记忆底座：
- **存储模型优于 OpenMausBot**：`desk-<name>/memory/<name>.md`（一事实一文件，带 `name`/`description`/`type`/`source`/`created`/`updated`/`expires`）+ 自动生成的 `MEMORY.md` 索引 + `memory/.tombstones.jsonl` 墓碑 + `journal/YYYY-MM-DD.md` + `DeskMemoryQueue` 跨进程锁；
- **注入策略克制**：仅首轮与 compaction 后注入 `<memory_bootstrap>`（不破 KV Cache），会中通过 `memory_search` 和 `session_search` 按需检索；
- **安全边界清晰**：`path-guard` 禁止模型改写 `MEMORY.md`/`journal/`，`prompt-safety.ts` 已对 sidecar 声明数据/指令边界。

但直接阅读当前 `src/memory/search.ts`、`src/memory/chinese-words.ts`、`src/memory/session-search.ts` 和 `src/memory/reflect.ts`，可以看到 **5 个客观存在的具体短板**：

| # | 现状实现（精确文件） | 真实短板 |
|---|---|---|
| 1 | `src/memory/search.ts:279-292`（`scoreText`） | **无 IDF / BM25 权重**：仅统计命中 token 个数（`score++`，长度 ≥3 子串 `+0.5`）。高频泛词（如 `"配置"`、`"模块"`、`"任务"`）与稀缺专有名词（如 `"dingtalk"`、`"croner"`、`"EACCES"`）权重完全相同，文档多时排序退化。 |
| 2 | `src/memory/chinese-words.ts` + `search.ts:153-192` | **手写 273 词词表局限**：依赖人工维护的 `COMMON_CHINESE_WORDS` 做贪心最大匹配 + 未覆盖 bigram + 单字 + trigram。领域新词/人名/项目名不在词表中，且 trigram 对 2 字中文短词无效、全量生成集合在长文本上开销大。 |
| 3 | `src/memory/session-search.ts:228-250` & `46-48` | **冷日志每次重扫 + 截断盲区**：`session_search` 每次缓存过期（30s TTL）都要重新读取并解析 `conversations/*/log.jsonl` 和 session JSONL；超过 `maxCharsPerChunk` 扫描上限的长消息（`partialDocuments`）后半段**完全不可检索**；对每个文档在内存里现场 `tokenizeRecallText()`。 |
| 4 | `src/memory/store.ts`（frontmatter） | **缺少 `aliases` 语义桥接**：没有同义词/简称/别名字段；在不上向量库的情况下，用户换一种简称问法（如记忆写“钉钉开放平台”，用户问“dws”或“钉钉机器人”）容易漏召回。 |
| 5 | `src/memory/reflect.ts` | **Reflect 缺少原文引证确定性校验**：目前依赖模型自报 `confidence`（`>=0.85` / `>=0.9`）决定永久入库或 30 天试用，缺少类似 `statedInConversation` / `checkDreamFacts` 的确定性原文引证与疑问/假设句过滤。 |

---

## 3. 面向架构 Agent 的可借鉴优化方案（4 个正交能力块）

### 能力块 A：可重建 `node:sqlite` FTS5 侧边索引 + CJK Bigram 引擎（P0/P1，核心收益）

**目标**：在不改变任何现有 Markdown / JSONL 真相文件格式的前提下，在 `state/`（或 `desk-<name>/.search-index.sqlite`，需架构决策）引入一个**随时可删、随时可重建的派生 SQLite FTS5 索引**，同时服务 `memory_search` 和 `session_search`。

**核心设计要点**：
1. **复用 OpenMausBot 的 `cjk-search.ts` 原理（~100 行，放在 `src/memory/`）**：
   - 使用 Node >=22.19 原生 `node:sqlite`（`DatabaseSync`），零第三方依赖；
   - `search_text` 列用 `U+200B` 切分 CJK 字符，FTS5 使用 `tokenize='unicode61'`；
   - 查询侧采用“英文/标识符（最多 16 项）+ 剥离虚词后的 CJK 重叠 Bigram（最多 24 项）”独立配额，避免长中文挤掉英文报错码/文件名；
   - `UPSERT` 严格使用 `ON CONFLICT DO UPDATE`（禁止 `INSERT OR REPLACE`）；
   - 引入 `enoughMatches()` 长问句降噪门槛，并利用 FTS5 原生 `bm25()` + `snippet()` 生成高亮上下文片段（再结合 Pipiclaw 现有的 `recencyBoostByAge` 做时间衰减融合）。
2. **双索引对象与增量同步**：
   - **表 1：`memory_docs`**（索引 `desk-<name>/memory/*.md`、`desk-<name>/journal/*.md`、`workspace/MEMORY.md`）：按 `(mtimeMs, bytes)` + 日期变更（处理 `expires` 过期）惰性增量同步；
   - **表 2：`session_docs`**（索引 `desk-<name>/conversations/*/{log.jsonl,*.jsonl}`）：按文件 `(path, ino, byteOffset)` **只追加索引新增行**，彻底消除 30s 全量重扫和 `partialDocuments` 扫描截断盲区！
3. **容错与自愈**：
   - 索引库损坏（`SQLITE_CORRUPT` / `SQLITE_NOTADB`）或 Schema 版本不匹配时，直接删除重建，**绝不阻塞主流程**；极端情况下可降级回内存扫描。
4. **注意职责边界**：
   - `memory_save` 的近重复检测（`NEAR_DUPLICATE_JACCARD = 0.6`）只需比对几十到几百条 `description`，仍保留纯内存词集 Jaccard 即可，**不需要**强绑 SQLite。

### 能力块 B：`memory/<name>.md` Frontmatter `aliases` + 元数据优先加权（P1，极低成本高杠杆）

**目标**：在不上向量库的前提下，补齐同义词/缩写/俗称检索短板。

**核心设计要点**：
1. 在 `src/memory/store.ts` 的 YAML frontmatter 中增加可选字段 `aliases?: string[]`（上限如 8–12 个，单条 ≤ 40 字符，向后完全兼容旧文件）。
2. `memory_save` 工具与 `reflect.ts` 允许在创建/更新事实时顺带填写常见简称或中英文别名（例如 `name: dingtalk-bot`, `aliases: [dws, 钉钉机器人, 钉钉Stream]`）。
3. **检索加权**：
   - 在 FTS5 表中给 `name` / `description` / `aliases` 单独设列，通过 FTS5 `bm25(fts, weight_meta, weight_body)` 给予元数据更高权重（比 OpenMausBot 额外扫磁盘 `readTopicHead` 更干净、统一！）；
   - 保持 `MEMORY.md` 生成索引紧凑，不把 `aliases` 铺进 `<memory_bootstrap>` 浪费常驻预算（或仅在 `memory_search` 时生效）。

### 能力块 C：Reflect 确定性反幻觉引证核验（P0，低成本高确定性）

**目标**：堵住 Reflect 仅凭模型自报 `confidence` 将假设句、疑问句或编造参数写入持久记忆的漏洞。

**核心设计要点**：
1. 扩展 `src/memory/reflect.ts` 的结构化输出：对 `add` / `update` 操作要求附带 `evidence: string`（来自本轮 `source-window` 的逐字原文短摘录）。
2. 在写入前执行确定性校验（不增加任何 LLM 调用）：
   - **原文存在性**：NFKC + 空白归一化后，`evidence` 必须真实存在于本轮 `source-window` 的用户或可信发言中；
   - **疑问/假设拦截**：若 `evidence` 所在句是疑问句或命中中英文假设词（`如果/假设/假如/万一/比如/suppose/what if/imagine`），拒绝直接写永久记忆（降级为丢弃或仅允许极严条件下的 `probation`）；
   - **关键实体核对**：对 `project`/`reference` 类型记忆中出现的路径、端口号、版本号、URL，校验其必须出现在 `evidence` 或窗口原文中，防止 Reflect 写错参数。
3. 在 `evals/` 记忆用例中补充负例控制（假设讨论不入库、编造端口号被拒）及防混淆违禁词检测。

### 能力块 D（审慎评估项）：是否引入自动 Pre-turn Recall？

- **OpenMausBot 做法**：每轮在用户消息前自动跑一次 FTS5，将命中的 ≤ 6,000 字符拼在 user message 前面（不进 System Prompt）。
- **Pipiclaw 需权衡的点**：
  - **支持不自动注入的理由**：Pipiclaw 已有首轮 `<memory_bootstrap>`（含完整 `MEMORY.md` 索引表）+ 显式 `memory_search` / `session_search` 工具；每轮盲目预注入容易引入噪音、膨胀上下文并改变历史消息形态。
  - **支持轻量自动注入的场景**：当一个 Desk 积累超过百条记忆、`MEMORY.md` 索引超出 1,400u 预算被截断时，被截断在索引外的记忆模型“不知道它存在”，可能不会主动调 `memory_search`。
- **建议给架构 Agent 的折中选项**：**先把能力块 A/B/C 做扎实**（让 `memory_search` 和 `session_search` 变得极快、极准）；仅在有真实评测证据表明“索引溢出导致模型漏查”时，再考虑开启受控的 Pre-turn Recall（且必须严格遵循 OpenMausBot 的三条纪律：放 user turn 前不碰 System Prompt + `clean()` 围栏逃逸清理 + `enoughMatches()` 降噪门槛）。

---

## 4. 给架构 Agent 的硬约束与待决策清单

### 4.1 必须遵守的 Pipiclaw 架构约束
1. **模块分层（`AGENTS.md`）**：
   - `src/memory/` 处于 **Layer 6**，只能导入 `layers 0–1, desk, channel, config, models, usage`；
   - 新增的 SQLite FTS5 索引与 CJK 分词代码应全部收敛在 `src/memory/` 内（例如 `src/memory/cjk-search.ts`、`src/memory/search-index.ts`），不要向 `src/shared/` 泄漏领域逻辑，也不要破坏 800 行单文件预算；
   - `src/tools/memory-manage.ts` 和 `src/tools/session-search.ts` 保持薄适配器定位。
2. **真相源与可恢复性（`dev-docs/design-philosophy.md`）**：
   - 任何情况下 Markdown 和 JSONL 都是唯一真相源；SQLite 索引文件必须标记为纯派生缓存（`state/` 下或 `.cache`/dotfile），删除后系统仍能自动重建；
   - 不写旧格式迁移脚本（`AGENTS.md` 规则），索引 Schema 变更通过 `PRAGMA user_version` 检测不匹配直接 drop & rebuild 即可。
3. **测试分层（`AGENTS.md`）**：
   - CJK 分词、Bigram 短语构造、`enoughMatches()`、反幻觉校验、FTS5 损毁重建属于 **Unit 层**；
   - 写入 `memory_save` / 产生会话日志 → 增量索引同步 → `memory_search` / `session_search` 命中 + 重启后不重扫属于 **确定性 E2E 层**；
   - 召回准确率与 Reflect 反幻觉质量由 **`evals/`** 实测验证。

### 4.2 建议架构 Agent 在 Spec 中明确拍板的问题
1. **SQLite 索引文件放哪里、按什么粒度隔离？**
   - 选项 1：每 Desk 一个库 `state/search-index/<desk>.sqlite`（与 `state/subagent-runs/<desk>/` 对齐，物理隔离、单 Desk 清理/删除零耦合、锁竞争最小——**推荐**）；
   - 选项 2：全局单库 `state/search-index.sqlite` 加 `desk` 列。
2. **是否需要保留 `src/memory/chinese-words.ts`？**
   - `memory_save` 的 Jaccard 去重目前依赖 `tokenizeRecallText()`。架构 Agent 需决定：是让 `tokenizeRecallText()` 改为更简洁的 CJK Bigram + 虚词剥离（顺便删掉 273 词手写词表维护负担），还是保留给 Jaccard 专用、FTS5 检索独立使用 `cjk-search.ts`？
3. **`session_search` 增量索引的触发时机与并发模型**：
   - 纯查询时惰性同步（`syncOnQuery`，零后台常驻开销，类似 OpenMausBot `syncMemoryIndex`），还是由日志写入侧顺手触发？考虑到 Pipiclaw 的并发模型和单文件追加特性，查询时按 `(ino, byteOffset)` 惰性增量同步最简单且无写路径阻塞风险。
4. **`session_search` 的 `summarizeWithModel` 旁路是否仍必要？**
   - 当 FTS5 `snippet()` 已经能围绕命中的 BM25 词项精准返回上下文窗口时，是否可以降低触发 sidecar 摘要的频率或将其设为默认关闭，以节省延迟和费用？
5. **`node:sqlite` 的实验性告警处理**：
   - 确认当前 Pipiclaw 目标 Node 版本（`>=22.19`）下 `import { DatabaseSync } from "node:sqlite"` 的运行时行为、TypeScript 类型声明（`@types/node` 版本）以及是否会打印 `ExperimentalWarning`（必要时在启动/测试中评估影响）。
