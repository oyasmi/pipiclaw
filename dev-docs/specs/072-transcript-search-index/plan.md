# 072：实施计划（面向实施 Agent 的执行手册）

| 字段 | 内容 |
| --- | --- |
| 状态 | 待实施 |
| 日期 | 2026-11-26 |
| 设计依据 | [design.md](./design.md)，D1–D12，不变量 I1–I10 |
| 交付顺序 | 阶段 0 → 1 → 2 → 3 → 4 → 5。阶段 3（锚点核验）只依赖阶段 0，可与 1–2 并行；阶段 4 必须在阶段 2 合入且门禁通过后开始 |
| 提交粒度 | 每个阶段一个提交（阶段 1 可拆为“词项”和“索引层”两个）；每个提交单独通过本阶段门禁 |

---

## 1. 开工前

1. 完整阅读 [`AGENTS.md`](../../../AGENTS.md)（模块分层表、800 行预算、测试准入、e2e 六条硬规则、错误文案规则）和 [design.md](./design.md)。工作区可能有未提交的文档，**严禁 `git reset --hard` 或 `git clean`**。
2. 记录基线，结果写入 `acceptance.md` 开头：
   ```bash
   git rev-parse --short HEAD
   npm run check
   npm run test:e2e
   npm run playbooks:measure
   node --version            # 应 ≥ 22.19
   node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(':memory:');d.exec('create virtual table t using fts5(x)');console.log(d.prepare('select sqlite_version() v').get())"
   ```
3. 记录行数，核对本次要改的文件：
   ```bash
   wc -l src/memory/{session-corpus,session-search,search,reflect,scheduler,store,journal}.ts src/tools/{session-search,memory-manage,registry}.ts src/config/settings.ts
   ```
   - `src/runtime/bootstrap.ts`（787 行）和 `src/agent/session/session-host.ts`（788 行）**本 spec 不得修改**。D5 的调度器注入项和 D10 从 `securityContext` 取 `appHomeDir` 的做法，正是为了避开这两个文件。
   - `src/memory/reflect.ts` 当前 548 行。阶段 3 只增加 ≤ 40 行，锚点逻辑全部放在 `anchors.ts`。
4. 用 `npx vitest run test/<file>.test.ts` 跑单个文件，不要每次都跑全量。

---

## 2. 阶段总览

| 阶段 | 目标 | 主要文件 | 门禁 |
|---|---|---|---|
| 0 | 基线（§1） | — | 基线记录完整 |
| 1 | 词项与索引层，暂不接线 | `memory/search-terms.ts`、`memory/search-index-db.ts`、`memory/search-index-sync.ts`、`memory/session-corpus.ts` | `npm run check` 通过；§3.4 的 grep 门禁通过 |
| 2 | `session_search` 切换到索引；调度器预热；文档 | `memory/session-search.ts`、`memory/scheduler.ts`、`tools/session-search.ts`、`tools/registry.ts`、`config/settings.ts`、文档与 playbook | `npm run check`、`npm run test:e2e` 通过；新 e2e 完成 mutation check |
| 3 | 反思锚点核验 | `memory/anchors.ts`、`memory/reflect.ts` | `npm run check`、`npm run test:e2e` 通过；M3 扩展断言完成 mutation check |
| 4 | `memory_search` 并入索引；近重复阈值标定 | `memory/search-index-notes.ts`、`memory/search.ts`、`tools/memory-manage.ts`、`memory/journal.ts` | `npm run check`、`npm run test:e2e` 通过；标定结论写入 acceptance |
| 5 | 真实数据验收与评测 | `acceptance.md`、`evals/` | §7 全部项目有记录 |

---

## 3. 阶段 1：词项与索引层

### 3.1 `src/memory/search-terms.ts`（新）

```ts
export const SEARCH_MARK = "\u200b";                         // 写成转义，防止编辑器吞掉
export function hasCjk(text: string): boolean;
export function searchTextFor(text: string): string | null;  // D6 写入形态；无 CJK 返回 null
export function stripSearchMarks(text: string): string;
export interface QueryTerms { latin: string[]; cjk: string[] }  // cjk 中是二元组或单个汉字
export function buildQueryTerms(query: string): QueryTerms;     // 拉丁 ≤16，CJK ≤24
export function buildMatchExpression(terms: QueryTerms): string | null; // 两类都为空时返回 null
export function countMatchedUnits(text: string, terms: QueryTerms): number;
export function effectiveTermCount(terms: QueryTerms): number;
export function enoughMatches(text: string, terms: QueryTerms): boolean;
```

要点：

- CJK 字符类与 OpenMausBot 一致：`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u30fc\uff70\uff9e\uff9f`。插入边界的正则：`(?<=[CJK])(?=[\p{L}\p{N}])|(?<=[\p{L}\p{N}])(?=[CJK])`。
- 虚词表按 design D6 逐字照抄，**按长度降序**拼成正则，避免 `一下` 被拆成 `一` 和 `下`。
- 英文停用词：把 `search.ts` 中的 `LATIN_STOP_WORDS` 移到本文件并导出，`search.ts` 改为从这里导入，不要复制两份。
- `buildMatchExpression`：拉丁词 → `"${w.replaceAll('"', "")}"`；满足 design D6 前缀条件时追加 `*`。CJK 词 → `"${[...w].join(" ")}"`。用 `" OR "` 连接。
- `countMatchedUnits`：在 `stripSearchMarks(text).toLowerCase()` 上判断子串是否存在；拉丁前缀词按“以该词开头的词”判断（`\b` + 词，词内标点已在查询侧保留）。

### 3.2 `src/memory/search-index-db.ts`（新；唯一引用 `node:sqlite` 的文件）

```ts
type Sqlite = typeof import("node:sqlite");
let sqlitePromise: Promise<Sqlite> | undefined;
async function loadSqlite(): Promise<Sqlite>;   // design D8：临时包装 process.emitWarning，finally 中恢复

export const SEARCH_INDEX_SCHEMA_VERSION = 1;    // 阶段 4 改为 2
export function getSearchIndexPath(appHomeDir: string, desk: string): string;
  // join(appHomeDir, "state", "search-index", `${desk}.sqlite`)

export interface SearchIndexHandle {
  db: InstanceType<Sqlite["DatabaseSync"]>;
  path: string;
  ino: number;
}

/** 唯一入口：串行进入该库的队列；处理打开、ino 校验、版本校验、损坏重建（每进程每库最多一次）。 */
export function withSearchIndex<T>(path: string, job: (handle: SearchIndexHandle) => Promise<T>): Promise<T>;
export function transaction<T>(db: SearchIndexHandle["db"], fn: () => T): T;   // BEGIN IMMEDIATE / COMMIT / 出错 ROLLBACK
export async function closeSearchIndexes(): Promise<void>;          // 测试用：经队列逐个关闭
export class SearchIndexUnavailableError extends Error {}           // design D9
```

实现清单：

1. 模块级 `const queue = createSerialQueue<string>()`、`const handles = new Map<string, SearchIndexHandle>()`、`const rebuiltOnce = new Set<string>()`。
2. `withSearchIndex(path, job)` = `queue.run(path, async () => { const h = await ensureOpen(path); try { return await job(h); } catch (e) { if (isCorrupt(e)) { await rebuild(path, "corrupt"); return job(await ensureOpen(path)); } throw e; } })`。重建只允许一次；第二次失败抛 `SearchIndexUnavailableError`。
3. `ensureOpen(path)`：
   - 已有句柄时 `statSync(path)`：ENOENT 或 `ino !== handle.ino` → `close()`，从 Map 中移除。
   - 新开：`mkdirSync(dirname, { recursive: true, mode: 0o700 })` → `new DatabaseSync(path)` → `exec` 设置三个 PRAGMA → 读取 `PRAGMA user_version`：为 0 表示新库，在一个事务里建表并设为当前版本；既非 0 也非当前版本 → `rebuild(path, "version")`。最后 `chmodSync(path, 0o600)`，记录 `ino`。
4. `isCorrupt(e)`：`e.code === "ERR_SQLITE_ERROR" && (e.errcode === 11 || e.errcode === 26)`。打开阶段抛出的同类错误也走重建。
5. `rebuild(path, reason)`：关闭句柄，`rmSync` 删除 `path`、`path-wal`、`path-shm`（`force: true`），记 `log.logWarn("memory.search_index.rebuilt", "Search index rebuild started", { reason, fields: { path } })`。
6. 建表 SQL 与 design D2 **逐字一致**，包括三个触发器：
   ```sql
   CREATE TRIGGER docs_ai AFTER INSERT ON docs BEGIN
     INSERT INTO docs_fts(rowid, text) VALUES (new.id, coalesce(new.search_text, new.text)); END;
   CREATE TRIGGER docs_ad AFTER DELETE ON docs BEGIN
     INSERT INTO docs_fts(docs_fts, rowid, text) VALUES ('delete', old.id, coalesce(old.search_text, old.text)); END;
   CREATE TRIGGER docs_au AFTER UPDATE ON docs BEGIN
     INSERT INTO docs_fts(docs_fts, rowid, text) VALUES ('delete', old.id, coalesce(old.search_text, old.text));
     INSERT INTO docs_fts(rowid, text) VALUES (new.id, coalesce(new.search_text, new.text)); END;
   ```
7. 打开失败的非损坏错误（EACCES、ENOSPC、SQLITE_READONLY / CANTOPEN 等）→ 抛 `SearchIndexUnavailableError`（`message` 带原因），并记 `memory.search_index.open_failed`。

### 3.3 `src/memory/session-corpus.ts`（改）与 `src/memory/search-index-sync.ts`（新）

**session-corpus.ts** 保留并导出：

```ts
export type SessionSearchSource = "context" | "session" | "log" | "task";
export type SessionSearchRole = "user" | "assistant" | "tool" | "system" | "unknown";
export interface TranscriptSourceFile { path: string; relPath: string; kind: "session" | "log" | "task"; source: SessionSearchSource; conversation?: string }
export interface TranscriptDoc { role: SessionSearchRole; text: string; truncated: boolean; speaker?: string; ts?: string }
export async function listDeskTranscriptSources(deskDir: string): Promise<TranscriptSourceFile[]>;
export function parseTranscriptLine(source: SessionSearchSource, value: unknown): TranscriptDoc | null;
export async function readArchivedTaskDoc(mdPath: string): Promise<{ doc: TranscriptDoc; jsonlPath: string } | null>;
export function dedupKey(text: string): string;
```

- 删除 `buildSessionCorpus`、`shareBudget`、`deduplicate`、`DEFAULT_MAX_*`、`SESSION_SCAN_MAX_CHARS` 及其调用方。
- `parseTranscriptLine` 在现有 `parseSessionEntry` / `parseLogEntry` 的基础上按 design D3 修改：
  - role 归一：`toolResult` → `tool`，`bot` → `assistant`。
  - `extractContentText` **去掉 thinking 分支**。
  - user 文本：`stripInjectedMemoryContext`；再用 `/^\[([^\]]{8,40})\]\s*\[([^\]]{1,64})\]:\s*/` 拆出时间与发言人（发言人存入 `speaker`；行内时间存在时优先作为 `ts`）。
  - log 行的 `speaker` 取 `displayName ?? userName`（bot 行不设），**不再**把 `[名字]` 拼进正文。
  - 工具结果按 4,000 字符阈值做头 3,000 + 尾 1,000 截断，`truncated` 保持 false；user / assistant 按 200,000 截断并置 true。
  - 所有文本经 `redactSecrets`（从 `./secret-redaction.js` 导入）。
- `listDeskTranscriptSources`：
  - 每个会话区包含 `context.jsonl`（source context）、`log.jsonl` 与 `/^log\.jsonl\.\d+$/`（source log）、其余 `*.jsonl`（排除 `IGNORED_JSONL_FILES`，source session）。
  - 加上 `tasks/archive/*.md`（kind task）。
  - **不排序、不截取**；不存在的目录返回空数组。
- `dedupKey`：NFKC → 去掉行首前缀（同上正则；只有时间、没有发言人的形式也要去掉）→ `\s+` 折叠为单个空格 → trim。

**search-index-sync.ts**：

```ts
export interface SyncStats { filesScanned: number; filesIndexed: number; filesAppended: number; filesRebuilt: number; filesRemoved: number; docsAdded: number; durationMs: number; maxSliceMs: number }
export interface DeskIndexTarget { appHomeDir: string; desk: string; deskDir: string }
/** 在已持有的句柄上同步（供 session_search 在同一个队列任务内调用）。 */
export async function syncTranscriptSources(handle: SearchIndexHandle, deskDir: string): Promise<SyncStats>;
/** 独立入口（调度器使用）：withSearchIndex + syncTranscriptSources。 */
export async function syncDeskSearchIndex(target: DeskIndexTarget): Promise<SyncStats>;
/** 删除 workspace 下已无对应 desk 目录的库。 */
export async function pruneOrphanSearchIndexes(appHomeDir: string, workspaceDir: string): Promise<string[]>;
```

实现顺序：

1. 一次性预编译语句：`selectFile`、`upsertFile`（`ON CONFLICT(path) DO UPDATE`）、`deleteFile`、`insertDoc`（`ON CONFLICT(hash) DO NOTHING`）、`selectDocId`、`selectRefDocId`（`SELECT doc_id FROM refs WHERE path=? AND line=?`，因为 `RETURNING` 只能取到新值，被替换的旧 doc_id 要先查出来、计入孤儿清理）、`upsertRef`（`ON CONFLICT(path, line) DO UPDATE`）、`selectRefDocIds(path)`、`deleteRefs(path)`、`deleteOrphans`（每批 ≤ 500 个 id，参数化 `IN (?, …)`）。
2. 对每个 `TranscriptSourceFile` 按 design D4 的五步判定。`headHash(path, len)` 用 `fs.open` + `read` 读前 `len` 字节再算 sha1，不读整个文件。
3. 全量或追加：`readFile` 得到 Buffer（追加时用 `fs.open` 从 `indexed_bytes` 起读取），找到最后一个 `0x0a`，逐行 `JSON.parse`（失败跳过但行号照常推进）→ `parseTranscriptLine` → `searchTextFor` → 插入。每 2,000 行调用一次 `transaction()`，事务内同时 upsert files 进度。事务之间 `await new Promise((r) => setImmediate(r))`，记录每片耗时的最大值。
4. task 文档：`readArchivedTaskDoc` 返回单个文档，line = 0；指纹按 design D4 计算；任何变化都 `deleteRefs` 后重新插入。
5. 删除：先 `selectRefDocIds`，再 `deleteRefs`、`deleteFile`，最后对这些 id 执行 `deleteOrphans`，三步在同一事务内。
6. 列表中已不存在的 files 行 → 执行删除流程。
7. `ts_ms` 用 `parseLocalTime(ts)`（`../shared/local-time.js`），解析失败存 NULL。

### 3.4 阶段 1 门禁

```bash
npm run check
grep -rn "INSERT OR REPLACE\|REPLACE INTO" src/memory && exit 1 || true     # I3：必须无输出
grep -rln "node:sqlite" src | grep -v "src/memory/search-index-db.ts" && exit 1 || true   # I6：必须无输出
grep -n "from \"node:sqlite\"" src/memory/search-index-db.ts && exit 1 || true  # 静态 import（含 import type）也不允许；类型一律用 typeof import("node:sqlite")
```

注意 `npm run deadcode`（knip）：阶段 1 的新导出还没有调用方，如果 knip 报未使用，**把阶段 1 与阶段 2 合并为一个提交**，不要为了过检查加忽略配置。

---

## 4. 阶段 2：切换 `session_search`

### 4.1 `src/memory/session-search.ts`

- `SearchDeskSessionsRequest`：删除 `maxFiles`、`maxChunks`，新增 `appHomeDir: string`。
- `searchDeskSessions(request)`：
  ```ts
  const indexPath = getSearchIndexPath(request.appHomeDir, request.desk ?? deriveDeskNameFromPath(request.deskDir));
  return withSearchIndex(indexPath, async (handle) => {
    const index = await syncTranscriptSources(handle, request.deskDir);
    const hits = query ? rankedHits(handle, terms, roleFilter, limit) : recentHits(handle, roleFilter, limit);
    ... // 窗口与摘要见下
    return { query, results, searchedDocuments, partialDocuments, index };
  });
  ```
  **摘要旁路（`summarizeWithModel`）的 LLM 调用必须放在 `withSearchIndex` 回调之外**：回调里只取出文档，回调返回后再逐条摘要，以免一次模型调用长时间占住队列。
- 排序常量集中放在文件顶部：`CANDIDATE_LIMIT = 60`、`ROLE_WEIGHT`、`RELEVANCE_WEIGHT = 3`、`RECENCY = { day: 0.5, week: 0.25, month: 0.1 }`、`EXACT_BONUS = 1`。
- `windowAroundDensestMatch` 按 design D7 第 5 条实现，替换 `windowAroundMatch`。
- `SessionSearchResult` 增加 `speaker?: string`；`path` 为 `relPath#L<line>`（task 文档不带行号）。
- 删除 `corpusCache`、`documentTokenCache`、`CORPUS_CACHE_*`，以及对 `tokenizeRecallText` 的引用。

### 4.2 工具与配置

- `src/config/settings.ts`：`PipiclawSessionSearchSettings` 删除 `maxFiles`、`maxChunks`，同步修改 `DEFAULT_SESSION_SEARCH`。`RETIRED_SETTINGS_KEYS` **不动**。
- `src/tools/session-search.ts`：
  - `SessionSearchToolOptions` 增加 `appHomeDir: string`。
  - 描述和无命中文案按 design D10 **原样**写入。
  - `details` = `{ resultCount, searchedDocuments, partialDocuments, index }`。
  - 结果行 `- [<channel 或 conversation 或 source> · <path> · <role>[ · <speaker>] · <when>] <summary>`。
  - 捕获 `SearchIndexUnavailableError` 后**重新抛出普通 `Error`**（design D9 的英文消息）。其他异常不捕获。
- `src/tools/registry.ts`：`session_search` 的 `create` 中加 `appHomeDir: req(ctx.securityContext.appHomeDir, "appHomeDir")`。如果类型上 `securityContext.appHomeDir` 是可选的，`req` 会在缺失时抛错，这是期望行为：主路径恒有该值，子代理工具集不构建此工具。

### 4.3 调度器预热

`src/memory/scheduler.ts`：

```ts
export interface MemoryMaintenanceSchedulerOptions {
  ...
  /** design D5；默认 syncDeskSearchIndex。测试注入替身。 */
  syncSearchIndex?: (target: DeskIndexTarget) => Promise<unknown>;
}
```

- 在 `runOnce` 中，`conversations.length === 0` 判断之后、`digestArchivedTasksOnce` 之前插入 `await this.syncSearchIndexesOnce(conversations)`。它**不受 `memoryMaintenance.enabled` 影响**。
- `syncSearchIndexesOnce`：按 `conversation.desk` 去重；每个 desk 调用 `syncSearchIndex({ appHomeDir, desk, deskDir })`，`catch` 后记 `log.logWarn("memory.search_index.sync_failed", "Search index sync failed", { reason, fields: { desk } })` 并继续下一个 desk。
- 每个进程的第一次调用前执行一次 `pruneOrphanSearchIndexes(appHomeDir, dirname(conversations[0].deskDir))`，用实例字段 `orphansPruned` 记录是否已执行。
- `bootstrap.ts` 不改。

### 4.4 文档与 playbook

按 design §7 的表格修改。`AGENTS.md` 和 `dev-docs/architecture.md` 中新增的路径会被 `npm run arch` 校验，必须写对。`docs/tools.md` 第 100 行关于“扫描上限截断”的描述改为：全量检索；只有超过 200k 字符的单条消息才会被截断，并在响应中说明。

### 4.5 阶段 2 门禁

```bash
npm run check
npm run test:e2e
npm run playbooks:measure     # 与基线比较：session_search 描述的体积变化写入 acceptance
```

模型可见的改动（工具描述、playbook）需按 AGENTS.md 运行：
`npm run eval -- plan --changed-since <基线 commit>`。有凭据时跑其中的 dev 用例，记录 run id 与失败归因；没有凭据时如实记为“未执行”，不能写成通过。

---

## 5. 测试清单与用例数预算

原则：先替换、扩展已有用例；每个新增用例都必须对应一个具体的错误实现（写在用例注释里）。

### 5.1 单元测试

| 文件 | 变化 | 用例（括号内是它要抓住的错误实现） |
|---|---|---|
| `test/search-terms.test.ts`（新） | +4 | ① 查询词：2 字词、虚词作为切分点、单字退回、长中英混排时拉丁 16 / CJK 24 的独立配额（配额合并导致错误码被挤掉）② 表达式安全：`"`、`AND`、`OR`、`NOT`、`NEAR`、`*`、`:`、`^`、`(`、`-`、`c++`、emoji、纯标点，逐个在**真实内存 FTS5** 上执行，均不抛错，且字面量能被命中（漏转义导致语法错误）③ 写入形态：句子中间的 2 字词可被 FTS 命中，`stripSearchMarks` 还原后与原文逐字相同（标记泄漏到结果中）④ `enoughMatches`：长问句只命中 1 个单位时被拒，短查询命中 1 个单位时通过（降噪门槛失效或过严） |
| `test/search-index.test.ts`（新） | +8 | ① 追加：写入半行时不索引，补全后被索引，行号续接；同步前后 desk 内文件 hash 不变（I1）② 轮转：`log.jsonl` 改名为 `.1` 并新建 `log.jsonl` 后无重复 refs、无丢失（只按 path 判定）③ 替换：同长度改写、变短 → 重建（只比较 size）④ 删除：源文件删除后 refs 与孤儿 docs 被清除，`count(docs_fts) == count(docs)`（I3，`INSERT OR REPLACE` 或漏删孤儿）⑤ 持久化：`closeSearchIndexes()` 后重开，第二次 sync 的 `filesIndexed == 0 && filesRebuilt == 0`（指纹没有落盘）⑥ 自愈：写坏文件头 → 自动重建且结果正确；`user_version` 改为 99 → 重建（坏库导致工具永久报错）⑦ 运行中删除：`unlink` 库文件后，下一次查询在原路径新建库（ino 改变）且结果与删除前一致（I2，写入已 unlink 的旧文件）⑧ 并发：同一库同时发起两次 sync 和一次查询，结果无重复 refs、`docsAdded` 总和正确（I5，队列失效） |
| `test/session-search.test.ts` | 9 → 7 | 保留并改写：语料来源（加入 `log.jsonl.2`，并验证 15 个会话文件时最旧的可检索，替代原“maxDocumentsTotal 上限”用例）；中英检索与角色过滤（加入 `roleFilter: ["tool"]` 命中工具结果、thinking 不可检索、注入块里的词不可检索）；空查询按时间倒序（混合 `Z` 与 `+08:00` 格式）；摘要失败回退；镜像去重（带发言人前缀的会话文本与 log 文本合并为 1 条，speaker 保留）与归档任务；长消息命中最密集窗口；不相关的新消息不返回，并加入长问句降噪。**删除**：“短期语料缓存”（缓存已删除）和“maxDocumentsTotal 上限”（上限已删除） |
| `test/memory-maintenance-scheduler.test.ts` | 0 | 扩展“disabled 时不请求 runtime context”这一用例：注入 `syncSearchIndex: vi.fn()`，断言 disabled 时它仍按 desk 去重后各调用一次，且 `getRuntimeContext` 未被调用。其余用例注入空实现 |

### 5.2 阶段 3 与阶段 4

| 文件 | 变化 | 用例 |
|---|---|---|
| `test/memory-anchors.test.ts`（新） | +1 | 抽取矩阵：URL、`/abs/path`、`~/x/y`、`src/a/b.ts`、哈希、`v22.19`、`1.2.3`、`localhost:8787`、`端口 15432` 为正例；`2026-11-26`、`0.85`、`15px/1.75`、`deadbeef`（无数字）、`CI/CD` 为反例；末尾标点被去掉 |
| `test/memory-reflect.test.ts` | +1 | “反思锚点”：窗口外的路径 → add 被拒，原因以 `unanchored identifier:` 开头，同一 pass 的 delete 被顺延；只出现在**工具结果**里的路径 → 通过；`~/` 与家目录绝对路径等价；描述中的日期不触发核验；在已有条目上 update 时，沿用旧正文中的锚点 → 通过 |
| `test/memory-search.test.ts` | 6 → 5 | 删除“tokenizer 二元组/三元组”用例（由 `search-terms` 覆盖）；`searchMemory` 两个用例改为基于索引的异步实现，并补充：过期的试用条目不返回；修改 journal 文件后旧内容不再命中；近重复三个用例保留（阈值重新标定后必须仍然通过） |

### 5.3 确定性 e2e（`test/e2e/deterministic/memory.test.ts`）

**新增 S1**（+1）：

1. `createDeterministicHarness()` 之后，在 `harness.deskDir/conversations/dm-9/` 下用 `SessionManager`（参考 `evals/cases/compaction.ts` 的写法）生成 15 个会话文件，每个文件 2 条消息。**最旧**的文件中有一条 user 消息含 `COLD-ANCHOR-4471`，然后用 `utimesSync` 把各文件 mtime 依次设为递增的旧时间。
2. 路由 `s1-search-old`：`lastUserText` 含 `S1_ASK_OLD` 时 → `reply.toolCall("session_search", { query: "COLD-ANCHOR-4471" })` → `reply.text("ok")`。
3. 发送 `S1_ASK_OLD`，断言最后一次请求的 tool 消息含 `COLD-ANCHOR-4471` 和 `conversations/dm-9/`。
4. 发送普通消息 `S1 新对话 FRESH-MARK-9902`（路由回复 `reply.text("收到")`）。
5. 路由 `s1-search-new`：`S1_ASK_NEW` → `session_search { query: "FRESH-MARK-9902" }`。发送后断言 tool 消息含 `FRESH-MARK-9902`。然后读取当前会话 JSONL 中该次调用的 `toolResult.details.index`，断言 `filesRebuilt === 0` 且 `filesAppended >= 1`。
6. 用例注释写明它要抓的失败和 mutation check：(a) 在 `listDeskTranscriptSources` 中恢复“按 mtime 取前 12 个”→ 第 3 步变红；(b) 让 sync 无条件走全量重建 → 第 5 步 `filesRebuilt` 断言变红。实施时**实际执行**这两项 mutation，并把结果和日期写进注释。

**阶段 3 扩展 M3**（+0）：在脚本化反思的 ops 里加一个 add，description 含窗口中不存在的 `/opt/never-seen/config.yaml`。断言 `memory/` 下没有对应文件，且 `memory-review.jsonl` 的 rejected 中有 `unanchored identifier`。mutation：让 `findUnanchored` 恒返回空数组 → 断言变红，结果记入注释。

### 5.4 用例数变化（写入 acceptance）

单元测试：+4 +8 −2 +1 +1 −1 = **+11**；e2e：**+1**。新增用例全部属于 AGENTS.md 列出的保留类别：持久化完整性、恢复、并发、解析器边界、安全边界（锚点）。

---

## 6. 阶段 3：反思锚点核验

### 6.1 `src/memory/anchors.ts`（新）

```ts
export function extractAnchors(text: string): string[];                      // design D12；去重并保持顺序
export function anchorForms(anchor: string, home: string): string[];         // 展开 ~ / $HOME / 家目录；URL 末尾 /
export function findUnanchored(anchors: string[], haystack: string, home = homedir()): string[];
```

正则全部写成具名常量，附带一两个例子的注释。路径规则必须排除 URL 内部的片段：先抽出 URL，在剩余文本上再抽路径。

### 6.2 `src/memory/reflect.ts`

1. `buildPrompt` 已经读取 `entries`、`workspaceMemory`、`journalToday`。让它额外返回 `provenance: string`，内容为 NFKC 后拼接的：未截断窗口（`options.sourceText?.text ?? serializeConversation(sanitizeMessagesForMemory(options.messages))`）、每条记忆的 `description + "\n" + body`、`workspaceMemory`、`journalToday`。不要重复读取文件。
2. 在 add / update 分支中，`classifyWrite` 通过之后、计数之前执行：
   ```ts
   const unanchored = findUnanchored(extractAnchors(`${description}\n${details ?? ""}`), provenance);
   if (unanchored.length > 0) {
     rejected.push({ op: effectiveOp, name: existing?.name ?? rawName, reason: `unanchored identifier: ${unanchored[0].slice(0, 80)}` });
     continue;
   }
   ```
   这样会自然触发既有的 `unsafe` 逻辑，顺延删除，无需另写代码。
3. prompt 和输出 schema 都不改。

### 6.3 门禁

`npm run check`；`npm run test:e2e`（含 M3 扩展与 mutation 记录）。

---

## 7. 阶段 4：`memory_search` 并入索引

### 7.1 Schema v2 与 notes 同步

- `SEARCH_INDEX_SCHEMA_VERSION = 2`。建表 SQL 追加 design D11 的 `notes`、`notes_fts` 及三个触发器（`notes_ai/ad/au`，写法同 docs）。旧库会因版本不符自动重建，这正是 D8 的设计。
- `src/memory/search-index-notes.ts`（新）：
  ```ts
  export async function syncNoteSources(handle: SearchIndexHandle, deskDir: string, workspaceDir: string): Promise<void>;
  export function queryNotes(handle: SearchIndexHandle, terms: QueryTerms, today: string, limit: number): MemorySearchHit[];
  ```
  - files 行 kind 为 `memory`、`journal`、`workspace`；workspace 的 path 存为 `../MEMORY.md`（相对 deskDir）。
  - 指纹 `(ino, size, mtime_ms)` 有变化就删除该 path 的所有 notes 并重新写入；文件已不存在就删除。
  - memory 解析用 `parseMemoryFile(name, raw, fallbackDate)`（`store.ts` 已导出）。
- `src/memory/search.ts`：`searchMemory` 改为
  `async function searchMemory({ query, appHomeDir, desk, deskDir, workspaceDir, limit }): Promise<MemorySearchHit[]>`，在 `withSearchIndex` 内先 `syncNoteSources` 再 `queryNotes`。删除 `scoreText`。
- `src/tools/memory-manage.ts`：`memoryToolOptions` 增加 `appHomeDir: req(ctx.securityContext.appHomeDir, "appHomeDir")`；search 不再调用 `readJournalForSearch`，`hits` 的渲染保持不变。
- `src/memory/journal.ts`：如果 `readJournalForSearch` 与 `JOURNAL_SEARCH_*` 已无调用方，删除（knip 会报）。
- `src/playbooks/memory-operations.md`：删除第 34 行的上限说明，保留“无命中不等于不存在”。

### 7.2 近重复阈值标定（决定 `chinese-words.ts` 的去留）

1. 在 `test/memory-search.test.ts` 中把现有近重复用例里的描述对整理成一个表：正例为改述，反例为不相关。再补充 10 对合成样本，覆盖中英混排、仅一个专有名词不同、同义改述这几种模式。**不得使用真实用户数据**。
2. 临时脚本（不提交）分别计算旧分词器 Jaccard 与新词集合（`buildQueryTerms` 的 latin ∪ cjk）Jaccard，在 0.40–0.70 区间以 0.05 为步长寻找能复现**全部**旧判定的阈值。
3. **规则**：
   - 找到阈值 T → `descriptionSimilarity` 改用新词集合，`NEAR_DUPLICATE_JACCARD = T`，删除 `chinese-words.ts` 和 `tokenizeRecallText`。
   - 找不到 → 保留二者，仅供近重复判断使用（`search.ts` 中只剩近重复代码），并把两种分词器的对照表写进 acceptance。
4. 跑 `memory-manage.test.ts`、`memory-search.test.ts`、e2e M2（`memory_search` 命中 journal 的断言）。

### 7.3 门禁

`npm run check`；`npm run test:e2e`；playbook 改动后再跑一次 `eval -- plan --changed-since <基线>`，记录 run id。

---

## 8. 阶段 5：真实数据验收与评测

### 8.1 真实数据（**必须在副本上进行**，daemon 正在使用真实 app home）

```bash
ACC=$(mktemp -d)/home && mkdir -p $ACC/workspace
cp -r ~/.pipiclaw/workspace/desk-default $ACC/workspace/
npm run build
node --input-type=module -e "
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { syncDeskSearchIndex } from './dist/memory/search-index-sync.js';
import { searchDeskSessions } from './dist/memory/session-search.js';
const h = monitorEventLoopDelay({ resolution: 10 }); h.enable();
const target = { appHomeDir: '$ACC', desk: 'default', deskDir: '$ACC/workspace/desk-default' };
console.log('first', await syncDeskSearchIndex(target));
console.log('second', await syncDeskSearchIndex(target));
h.disable(); console.log('eventLoopMaxMs', h.max / 1e6);
const t = [];
for (const q of ['daily-workspace-git-save', 'croner', '钉钉卡片 流式更新', '上次那个语音输入法 ASR 加载的问题怎么修的']) {
  for (let i = 0; i < 20; i++) { const s = performance.now(); const r = await searchDeskSessions({ appHomeDir: '$ACC', desk: 'default', deskDir: target.deskDir, query: q, limit: 5, maxCharsPerChunk: 1200, summarizeWithModel: false, timeoutMs: 1000, model: {}, modelRequests: {} }); t.push(performance.now() - s); if (i === 0) console.log(q, r.results.map((x) => x.when?.slice(0, 10))); }
}
t.sort((a, b) => a - b); console.log('p95Ms', t[Math.floor(t.length * 0.95)]);
"
du -b $ACC/state/search-index/default.sqlite*; du -sb $ACC/workspace/desk-default/conversations $ACC/workspace/desk-default/tasks
```

把以下结果写入 `acceptance.md`：

| 项 | 标准 |
|---|---|
| 首次 `SyncStats.durationMs` / `maxSliceMs` / `eventLoopMaxMs` | < 5,000 / ≤ 50 / ≤ 100 |
| 第二次 sync | `filesIndexed = filesAppended = filesRebuilt = 0` |
| 查询 p95 | < 50 ms |
| 最早可检索 | `daily-workspace-git-save` 的结果中包含 2026-04 的日期 |
| 库大小 / 源数据 | ≤ 1.0 |
| 删库重建 | 删除 `default.sqlite*` 后重跑一次查询，前 5 条结果与删除前一致 |

`maxSliceMs` 超过 50 时，先把每事务的行数从 2,000 下调到 1,000，再重新测量；仍然超标的话，把大文件的单次 `readFile` 改为分块读取，并在 acceptance 中记录。

### 8.2 评测

1. **`M-cold-recall-01`**（加在 `evals/cases/memory-recall-quality.ts`）：
   - setup 用 `SessionManager` 在 `conversations/dm-1/` 下生成 15 个会话文件。最旧的一个里，用户说“staging 数据库端口统一改成 15432（代号 COLD-PORT-7）”，其余为无关对话。
   - 脚本：`你好`，然后问“我们之前定的 staging 数据库端口是多少？”。
   - grader：答案含 `15432`；trace 中至少有一次 `session_search` 调用。
   - 按 `M-extract-01` 的写法在 `evals/controls/catalog.ts` 与 `fixtures.ts` 中补齐正例、反例、等价控制，并在 `evals/cases/catalog.ts` 中登记 profile 映射。
2. **`M-reflect-conditional-01`**（加在 `evals/cases/core-families.ts`，与 `M-extract-01` 相邻）：
   - 同一窗口中，用户先说“如果把发布挪到周五会怎样？我只是随便想想”，助手回答后，用户又说“以后只要测试失败，就先停下来告诉我，别继续改”。
   - 经边界反思后的 grader：存在一条记忆表达“测试失败即停止并汇报”；没有任何记忆包含“周五”+“发布”。
   - 控制项同上。
3. 运行 `npm run test:evals`；有凭据时运行 `npm run eval -- run` 选中上述两例以及 plan 涉及的 dev 用例，记录 run id。失败要区分产品问题和 fixture / oracle / provider 问题；修正 oracle 必须另起一次运行，不得覆盖原来的失败。

---

## 9. 完成定义

- [ ] 阶段 1–4 的代码与测试合入；`npm run check`、`npm run test:e2e`、`npm run test:evals` 全部通过。
- [ ] §3.4 的 grep 门禁通过；`npm run arch` 没有新增基线条目；`bootstrap.ts` 与 `session-host.ts` 的行数未增加。
- [ ] e2e S1 与 M3 扩展的 mutation check 已实际执行，结果写在用例注释中。
- [ ] `acceptance.md` 包含：基线、用例数变化（+11 / +1）、§8.1 实测表、阈值标定结论、评测 run id 与归因、`playbooks:measure` 前后对比。
- [ ] design §7 的文档与 playbook 已同步；`dev-docs/specs/README.md` 中 072 的状态已更新。

## 10. 回滚

纯代码回退即可：`git revert` 对应提交，然后删除 `state/search-index/`。真相文件的格式没有任何变化，不需要数据迁移，也不写迁移脚本。
