# 原生文件 I/O：把文件工具从 shell 管道上迁走

| 字段 | 值 |
|------|------|
| 状态 | IMPLEMENTED（P1–P4 全部完成；D5.4 的 `rg` 探测按 spec 原文标注为可解耦增益项，未实现） |
| 日期 | 2026-08-25 |
| 触发 | 一次代码核查发现 `edit` 对 >10MB 文件静默销毁数据，追查后确认这不是三个独立缺陷，而是"用命令执行口承担文件访问职责"这一个架构错配的多种表现 |
| 前置 | 015 tool-registry、021 toolset-enhancement、030 outbound-media、043 project-scope-and-turn-recovery |
| 关联实现 | `src/executor.ts`、`src/tools/`（`edit.ts`、`read.ts`、`write.ts`、`write-content.ts`、`grep.ts`、`send-media.ts`、`bash.ts`、`truncate.ts`、`registry.ts`、`index.ts`）、`src/agent/job-manager.ts`、`src/security/path-guard.ts`、`src/shared/atomic-file.ts` |

## 摘要

Pipiclaw 的所有文件工具都建在 `Executor` 之上，而 `Executor` 的契约是"跑一条 shell 命令，把 stdout 收成一个字符串"。于是**文件内容必须穿过一个 10MB 的 shell stdout 字符串缓冲**。这一个错配同时产生了数据销毁、编码损坏、口径错误、路径解析分叉和 O(n²) 翻页五类问题，并且已经在三个调用点分别打过局部补丁（`read` 的 `wc -c`、`send_media` 的 `wc -c`、`bash` 的 spill 改 fs 写）——`edit` 漏了，所以它是唯一一个直接损坏用户数据的。

本 spec 引入与 `Executor` 并列的 **`FileStore` 端口**，把文件内容的读写从 shell 迁到 `node:fs` 流上，并按依赖顺序分成四个可独立合并的阶段：

| 阶段 | 内容 | 解决 |
|---|---|---|
| **P1 地基** | `FileStore` 端口 + executor 捕获语义重写 | F2/F3/F4 三个已确认缺陷，不改任何工具语义 |
| **P2 写路径** | `edit` 改字节级 splice、`write` 走 `writeAtomic` | edit 对任意大小/任意编码/二进制正确；写入获得 fsync 保证 |
| **P3 读路径** | `read` 流式 + 行偏移索引；`grep` 过滤下推 | 大文档翻页从 O(n²) 降到 O(n)；grep 不再对着被截断的结果说"没找到" |
| **P4 清理** | 媒体去 base64 往返、`job readOutput`、删历史绕行补丁 | 消除同一根因的最后几处表现 |

最终不变量：

> 文件内容永不经过 argv、stdout 或 stdin；任何上界都必须同时提供"剩下的在哪儿"；路径只解析一次，守卫判定的和实际打开的是同一个 `resolvedPath`。

## 当前事实与证据

### F1 文件内容穿过 10MB shell stdout 字符串缓冲（根因）

`Executor` 是命令执行口（`src/executor.ts:34-38`），但四个文件工具都用它承载文件内容：

| 工具 | 实现 | 内容通道 |
|---|---|---|
| `read` | `awk 'END{print NR}'` + `tail -n +N \| head -c`（`read.ts:226,295`） | stdout 字符串 |
| `read`(图片) | `base64 <`（`read.ts:181`） | stdout 字符串 |
| `edit` | `cat` ×2（`edit.ts:187,245`）+ `cat > tmp && mv`（`write-content.ts:70-79`） | stdout 字符串 + stdin 管道 |
| `write` | 同上 | stdin 管道 |
| `send_media` | `base64 <`（`send-media.ts:109`） | stdout 字符串 |
| `job` 读输出 | `cat <spillFile>`（`job-manager.ts:660`） | stdout 字符串 |

而该缓冲的实现是 cap-and-discard，无任何标注：

```ts
// src/executor.ts:3
const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;

// src/executor.ts:128-135
child.stdout?.on("data", (data) => {
	if (stdoutCapped) return;
	stdout += data.toString();
	if (stdout.length > MAX_CAPTURE_BYTES) {
		stdout = stdout.slice(0, MAX_CAPTURE_BYTES);
		stdoutCapped = true;
	}
});
```

`stdoutCapped` 是闭包局部变量，`ExecResult`（`executor.ts:48-52`）没有任何截断标志位——**任何调用方都无从知晓自己拿到的是不是残次品**。

### F2 edit 的读-改-写回销毁数据（已复现）

链路：`edit.ts:187` `cat` 读全文 → 被截断成 10M 前缀 → `edit.ts:192` 拿到前缀 → `edit.ts:245` 的并发 recheck 再 `cat` 一次，读到**同样被截断的前缀**，字符串相等，防护形同虚设 → `edit.ts:254` 把前缀整体写回。

实测（12,582,937 字节文件，替换开头一个 marker）：

```
before: 12582937  after: 10485760  lost: 2097177
tail marker still present: false
tool said: Successfully replaced text in /tmp/.../big.txt. Changed 11 characters to 11 characters.
```

2MB 数据永久消失，工具报告"成功"。

### F3 逐 chunk 解码破坏多字节字符（已复现，且是写入路径损坏）

`executor.ts:130` 的 `data.toString()` 对每个 chunk 独立解码，UTF-8 多字节序列跨 chunk 边界时产出 U+FFFD。裸流实测（900KB 中文，19 个 chunk）：`U+FFFD count: 30`。

关键在于 `edit` 走同一条路，所以这是**写入路径的数据损坏**，触发门槛只有 64KB（stream 的 highWaterMark），不是 10MB。实测（约 300KB 中文 Markdown，做一次普通 edit）：

```
U+FFFD before: 0  after edit: 2
file bytes before/after: 306897 306903
```

一次编辑把两个汉字永久变成 `EF BF BD`。`edit.ts:245` 的 recheck 同样拦不住——两次 `cat` 的 chunk 边界一致，损坏方式相同，比较通过。对钉钉优先、中文工作区的场景，这是高频静默损坏。

### F4 上界口径错误

`executor.ts:131` 比较的是 `stdout.length`，即 UTF-16 code unit，不是字节。`MAX_CAPTURE_BYTES` 这个名字是错的：12MB 的 ASCII 文件会被截断，12MB 的纯中文文件（约 4M 字符）不会。任何基于 `wc -c` 的字节预检都和实际阈值对不上，会误拒或漏拒。

### F5 同一个坑被逐点绕行三次，edit 漏了

`truncate.ts:14-21` 的注释、`read.ts:164-168` 的注释、`send-media.ts:88-92` 的注释，三处都完整描述了这个危险（"silently cut mid-stream, producing a buffer that still decodes (so failure is invisible) but is corrupt"），并各自用 `wc -c` 预检绕过。`edit.ts` 没有绕。

这不是疏忽，是把本该在一层解决的问题推给了每个调用点——每新增一个读文件的地方，就多一次漏掉的机会。

### F6 相对路径：守卫解析的和 shell 打开的不是同一个文件

`guardPath` 把相对路径解析到 `projectRoot`：

```ts
// src/security/path-guard.ts:90-99
function resolveTargetPath(rawPath: string, ctx: PathGuardContext): string {
	const cwd = ctx.projectRoot ?? process.cwd();
	...
	return resolve(cwd, expanded);
}
```

但没有任何文件工具给 `executor.exec` 传 `cwd`（`edit.ts:187`、`read.ts:295`、`grep.ts:228`、`write-content.ts:77`、`bash.ts:295` 全部不传），`HostExecutor` 于是在 **daemon 自己的 `process.cwd()`** 下 spawn。全仓库只有 `DirectoryExecutor`（`subagents/tool.ts:266`）设过 exec cwd；`channel-runner.ts:1222` 等处的 `cwd: this.projectScope.projectRoot` 是 AgentSession 的 cwd，不是执行器的。

spec 043 把 `projectRoot` 变成了每频道的运行时事实（`/project` 可切换，`project-scope.ts:15-22`），所以两者分叉是常态而非边角：模型按提示词以为自己在 `projectRoot`，`read src/foo.ts` 的守卫判定针对 `<projectRoot>/src/foo.ts`，实际打开的却是 `<daemonCwd>/src/foo.ts`。既是功能错误，也是守卫判定与实际操作对象脱节。

### F7 性能同样破产

- `read` 一次调用全文扫两遍：`awk 'END{print NR}'`（`read.ts:226`）数行 + `tail -n +N`（`read.ts:294`）定位。用 `offset` 翻一个大日志是 O(n²)。
- `grep`（`grep.ts:222-228`）拼出的命令**没有 `--exclude-dir`**，`IGNORED_DIR_SEGMENTS`（`grep.ts:29`）只在 JS 侧后置过滤（`grep.ts:243-247`）。大仓库里 node_modules 先把 10MB 填满，真实源码的匹配被丢弃，过滤后走到 `grep.ts:262` 返回自信的 "No matches found ... Try a broader pattern"。spec 021:133 计划的 `rg` 探测从未实现。
- `job` 的 `readOutput`（`job-manager.ts:660`）用 `cat` 读 spill 文件，同样吃 10MB cap：一个长跑作业的输出被静默砍头。

### F8 仓库里已经有正确的路径，只是文件工具没用

- **两条写路径**：`src/shared/atomic-file.ts:9` 的 `writeFileAtomically` 有 fsync + 目录 fsync，memory/config/job 记录都在用；`write-content.ts:70-79` 的 `cp -p; cat > tmp; mv` 没有 fsync。**文件工具用的是弱的那条。**
- **bash 已经先行搬家**：`bash.ts:255-266` 的注释写明 spill 从 `sh -c 'cat > file'` 改成了 `node:fs` 的 `writeFile`，理由正是"spawned a process and copied the whole (up to 10MB) buffer over a pipe to reach the same local filesystem the executor already runs on"。

这两点说明本 spec 不是引入新范式，是把已经证明正确的做法推广到剩下的地方。

### F9 `Executor` 的 sandbox 缝是空的

spec 021:133 写过"复用现有 `Executor`（host 或 docker sandbox 内跑命令）"。但今天只有 `HostExecutor` 一个实现（`executor.ts:56`），`DirectoryExecutor`（`subagents/tool.ts:259`）只是设 cwd 的装饰器。这个缝是设想，不是现实。

而且引入 `FileStore` **加强**而非削弱它：真要上 sandbox，`FileStore` 的实现是 `docker cp` / 流式 attach，天然是流；今天那条路是"shell out 然后祈祷 payload 小于 10MB"，在 sandbox 下只会更糟。

## 设计原则

**P1 文件内容不穿 shell。** payload 走 argv / stdout / stdin 是根本错误。文件 I/O 走 `node:fs` 流。`Executor` 保留，继续服务它本来的职责：`bash`、`grep`、`pdftotext`、`rtk`、job 启动。

**P2 "有界"不等于"静默丢弃"。** 任何上界都必须配一个"剩下的在哪儿"——分页游标、落盘路径、或显式失败。没有第四种选项。

**P3 路径只解析一次。** 守卫返回 `resolvedPath`（`security/types.ts:66-73`），后续操作直接打开它。守卫判定的对象和实际操作的对象在类型层面就是同一个值。

## D1 `FileStore` 端口

新增 `src/file-store.ts`，与 `src/executor.ts` 并列。**是端口不是工具函数集**：有 interface、有 `createFileStore()` 工厂、有 `HostFileStore` 实现，形状对齐 `Executor`。

```ts
export interface FileStat {
	size: number;
	mtimeMs: number;
	ino: number;
	mode: number;
	isDirectory: boolean;
	isFile: boolean;
}

/** 并发写检测用的轻量指纹；见 D2.4。 */
export interface FileFingerprint {
	size: number;
	mtimeMs: number;
	ino: number;
}

export interface FileStore {
	/** ENOENT 返回 undefined，不抛。 */
	stat(path: string): Promise<FileStat | undefined>;

	/** 单次有界读。`eof` 说明是否读到文件尾——调用方据此知道"还有没有剩下的"（P2）。 */
	readBytes(
		path: string,
		opts?: { start?: number; maxBytes?: number; signal?: AbortSignal },
	): Promise<{ data: Buffer; eof: boolean; stat: FileStat }>;

	/** 流式读，供 edit 的大文件路径和 read 的索引扫描使用。 */
	openRead(path: string, opts?: { start?: number; end?: number }): Readable;

	/** 复用 shared/atomic-file.ts 的 fsync + 目录 fsync 语义。 */
	writeAtomic(
		path: string,
		data: Buffer | string,
		opts?: { createParentDir?: boolean; preserveMode?: boolean; signal?: AbortSignal },
	): Promise<void>;

	/** 流式原子替换：produce 往临时文件写，成功后 rename。edit 大文件路径用。 */
	replaceViaTemp(
		path: string,
		produce: (out: Writable) => Promise<void>,
		opts?: { preserveMode?: boolean; signal?: AbortSignal },
	): Promise<void>;

	/** 取代 read 的 `find -maxdepth N` 分支。 */
	listDirectory(path: string, opts: { maxDepth: number }): Promise<DirectoryEntry[]>;
}
```

### D1.1 路径契约

**`FileStore` 的所有方法只接受绝对路径，且约定是 `guardPath` 返回的 `resolvedPath`。** 每个文件工具的形状统一成：

```ts
const guard = guardPath(path, "read", { ...securityContext, config: securityConfig.pathGuard });
if (!guard.allowed) { /* 现有的 logSecurityEvent + formatPathBlockMessage，不变 */ }
const target = guard.resolvedPath!;   // 之后所有 I/O 只用 target
```

这按构造消掉 F6：守卫解析的和实际打开的必然是同一个路径。

一个边角：`pathGuard.enabled === false` 时 `guardPath` 提前返回不带 `resolvedPath`（`path-guard.ts:340-342`）。改成守卫关闭时也返回解析后的路径（解析本身不是策略，只是归一化），保证 `resolvedPath` 恒有值。这是本 spec 对 `src/security/` 的唯一改动。

### D1.2 `writeAtomic` 需要补 `preserveMode`

`shared/atomic-file.ts` 现在不保留原文件权限位；`write-content.ts:73` 的 `cp -p` 保留。迁移必须补上这一条，否则第一次 `edit` 就会剥掉可执行文件的 x 位。实现：写临时文件前 `stat` 目标，存在则 `fchmod` 临时文件到相同 mode。

### D1.3 注入

`ToolBuildContext`（`registry.ts:35-66`）加 `fileStore: FileStore`，`fileToolOptions(ctx)`（`registry.ts:87`）把它带给 `read`/`edit`/`write`/`grep`/`send_media`。`CreatePipiclawToolsOptions`（`tools/index.ts:21`）加同名字段，`bootstrap.ts:845` 在 `createExecutor()` 旁边 `createFileStore()`。

`src/index.ts` 是公开 barrel（spec 035）——**不导出 `FileStore`**，它是内部端口。

## D2 `edit`：字节级 splice

这是整个方案的核心。**`edit` 根本不应该解码文件。**

`oldText` / `newText` 是模型给的 JS 字符串，`Buffer.from(oldText, "utf8")` 之后在文件字节里 `Buffer.indexOf`、splice、写回。这一步消掉的东西：

- 不可能有 U+FFFD——从不解码（F3 在此彻底消失）。
- 不需要为了正确性设大小上限——不再物化成字符串（F2 消失）。
- 二进制安全，且**保留非法 UTF-8 字节**（今天是 decode→U+FFFD→re-encode，直接毁掉）。
- 顺带修掉 `edit.ts:203` 的 `content.split(oldText)` ——它为了数一个数分配一整个巨型数组。

### D2.1 小文件路径（`size <= EDIT_INLINE_MAX_BYTES`，8MB）

`readBytes` 全读成 Buffer → 在 Buffer 上做查找/计数/splice → `writeAtomic`。现有的唯一性判定、`replaceAll`、no-op streak（`edit.ts:210-241` 的 `noopCounts`/`NOOP_HARD_LIMIT`）全部保留，只是操作对象从 string 换成 Buffer。

### D2.2 大文件路径（> 8MB）：两趟流式

**第一趟（扫描，不写）**：`openRead` 流式过一遍，维护一个 `needle.length - 1` 字节的滑动前缀以跨 chunk 边界匹配。这一趟收集：

- `occurrences` 计数
- 每个匹配的字节偏移（数组）
- 换行计数（免费拿到每个匹配点的行号，diff 要用）
- 内容 hash（并发检测要用，见 D2.4）

拿到 `occurrences` 后做唯一性判定——**判定必须在任何写入之前完成**，这是两趟的理由。

**第二趟（应用）**：`replaceViaTemp`，按第一趟记录的偏移做"拷贝 + splice"，无需再搜索。成功后 rename。

内存 O(chunk + needle + offsets)。偏移数组在 `replaceAll` 遇到病态文件时可能很大——上限 100k 个偏移，超出则第二趟退回流式搜索（不记偏移）。

### D2.3 diff 必须局部化

`edit.ts:266` 的 `generateDiffString(content, newContent)` 和 `edit.ts:274` 的 `Diff.createPatch` 对全文做 diff，大文件上必炸。

改成：按第一趟记录的偏移，`openRead({ start, end })` 取匹配点前后 K 字节窗口，扩展到行边界，只解码那个窗口，用现有的 `generateDiffString` 渲染这一小段（行号来自第一趟的换行计数，所以是准确的绝对行号）。

对小文件，窗口覆盖全文，输出与今天逐字一致（现有的 `contextLines = 4` 本来就只显示变更点附近）。`details.diff` 和 `details.patch` 字段保留（它们是 tool details 契约的一部分），只是内容变成局部补丁。核实过：`src/` 内没有任何消费者读这两个字段，所以局部化不会破坏渲染。

### D2.4 并发检测换成指纹 + hash

`edit.ts:245` 现在的做法是"再 `cat` 一遍全文比字符串"——既贵（第二次全文读），又因为两次都被截断在同一位置而在大文件上完全失效。

改成：读前 `stat` 取 `FileFingerprint`，第一趟顺手算内容 hash（免费），rename 前重新 `stat` 比指纹。更便宜，且能发现 10MB 之后的改动（今天那是盲区）。错误消息保持不变（`edit.ts:246-249`），模型侧行为一致。

保留 `edit.ts:240-244` 的注释精神：这仍然是"收窄竞态窗口，不是加锁"。

### D2.5 二进制守卫

字节级 splice 让 `edit` 对二进制文件技术上可用，但那几乎总是模型的误操作。第一趟扫描时若在前 8KB 内发现 NUL 字节，抛 `RecoverableToolError` 建议改用 `bash`。这是产品判断，不是技术限制。

## D3 `write`

`writeContent`（`write-content.ts`）从"构造 shell 脚本 + stdin 管道"改成 `fileStore.writeAtomic(target, content, { createParentDir, preserveMode: true })`。

收益：获得 fsync + 目录 fsync（F8）；不再把整个内容经管道复制给 `sh`（今天内容在内存里存在两份）；不再需要 `shellEscape` 和 EPIPE 处理（`write-content.ts:70-79`、`executor.ts:167-171`）。

`write.ts` 本身几乎不变——CLAUDE.md 要求它保持"`write-content.ts` 的薄包装"，这一点维持。

## D4 `read`：流式 + 行偏移索引

### D4.1 去掉两次全文扫描

- `wc -c`（`read.ts:169`）→ `fileStore.stat`。
- `awk 'END{print NR}'`（`read.ts:226`）→ 删除，见 D4.3。
- `tail -n +N | head -c`（`read.ts:295`）→ `openRead({ start: lineOffsets[N] })` 读到窗口满即停。
- `find -maxdepth 2`（`read.ts:237`）→ `fileStore.listDirectory`。spec 021:438 当年选 `find` + `sed` 是因为 `find -printf`/`stat` 在 BSD/GNU/busybox 之间格式不一致——`fs.readdir({ withFileTypes: true, recursive: true })` 没有这个问题，可移植性反而更好。

PDF 分支（`read.ts:204`）继续走 `Executor` 调 `pdftotext`：那是命令，不是文件读。

### D4.2 行偏移索引

新增 `src/tools/line-index.ts`：按 `resolvedPath + size + mtimeMs` 键控的 LRU（32 条），值是"已发现的行首字节偏移数组 + 已扫描字节数 + 是否已扫到 EOF"。

- `read(offset=N)`：索引里有第 N 行 → 直接 seek，O(窗口)。
- 没有 → 从上次扫到的位置继续前扫，追加偏移，到达 N 后读窗口。
- size 或 mtimeMs 变化 → 整条失效。

效果：顺序翻一个 2GB 日志的总代价从 O(n²) 降到 O(n)。

### D4.3 总行数要诚实

现在的 `[Showing lines X-Y of TOTAL]`（`read.ts:325-333`）依赖全文数行。索引只在扫到 EOF 后才知道确切总数，所以：

- 已扫到 EOF：`of N`，与今天一致。
- 未扫到：`of ≥N`，并保留 `Use offset=... to continue` 游标。

宁可承认不知道，也不要编一个数字——这是 P2 在读路径上的具体形态。`offset` 越界判定（`read.ts:262-275`）同样改成基于索引的已知信息，未知时不预先拒绝，读到 EOF 再报越界。

### D4.4 上界不变

`DEFAULT_MAX_LINES = 2000` / `DEFAULT_MAX_BYTES = 50KB`（`truncate.ts:11-12`）和 `truncateHead` 的语义全部保留。`read.ts:288` 的 `readWindowBytes = DEFAULT_MAX_BYTES * 2` 窗口逻辑也保留——它本来就是对的，只是数据来源从管道换成 `openRead`。

## D5 `grep`：过滤下推 + 按结果条数设界

`grep` 是真正需要子进程的（或 `rg`），保留在 `Executor` 上。改三处：

### D5.1 把过滤条件下推给 grep

`IGNORED_DIR_SEGMENTS`（`grep.ts:29`）下推成 `--exclude-dir=`，`glob` 下推成 `--include=`。已在目标平台验证过与 `-rnH -E -B1 -A3` 组合正常。JS 侧的 `isIgnoredPath` 后置过滤保留作兜底（不同 grep 实现的 `--exclude-dir` 语义有细微差异）。

### D5.2 界的单位从字节改成结果行数

管道接 `| head -n <MAX_RESULT_LINES>`，SIGPIPE 会把 grep 提前掐掉。这比按 10MB 字节设界严格更好：界的单位和用户关心的东西对齐，且在大仓库上把耗时从"扫完 node_modules"降到"凑够 N 条就停"。

### D5.3 空结果必须区分两种情况

`grep.ts:262-273` 的 "No matches found" 分支要检查截断标志（D6.2）。结果被截断时的消息必须说明"结果在过滤前就触到上限，请收窄 path 或 pattern"，绝不能对着被砍过的输出说没找到。

### D5.4 `rg` 探测

补上 spec 021:133 计划过但没实现的 `rg` 探测，复用 `command-optimizer.ts:35-42` 的 `probeRtk`/`isRtkAvailable` 缓存模式。有 `rg` 用 `rg`，无则退化 `grep`。这是纯增益项，可以放到 P3 末尾，与主线解耦。

## D6 `Executor`：只管命令捕获，且捕获要正确

文件 I/O 搬走后，`exec` 仍需给 `bash`/`grep`/`pdftotext` 一个上界。改成：

### D6.1 累积 Buffer，close 时一次性解码

`stdout`/`stderr` 从 `string` 改成 `Buffer[]` + 精确字节计数器；`data` 事件只 push 和累加，不解码；`child.on("close")` 里 `Buffer.concat(...).toString("utf8")`。

一次改动拿到三件事：跨 chunk 的多字节字符自然完整（F3）；`MAX_CAPTURE_BYTES` 变成真正的字节口径，名副其实（F4）；解码从每 chunk 一次降到一次（比现在还快）。

超时/abort 路径安全：`killProcessTree` 之后 `close` 仍会触发，`CommandTerminatedError`（`executor.ts:19-32`）拿得到解码后的部分输出。`error` 路径不变。

### D6.2 截断必须可见

`ExecResult`（`executor.ts:48-52`）加 `stdoutTruncated?: boolean` / `stderrTruncated?: boolean`。可选字段，现有构造 `ExecResult` 的测试不受影响。

`ExecOptions` 加 `maxCaptureBytes?: number`，让 `grep` 这类调用方按自己的需要设界。

### D6.3 `bash` 改流式落盘

`bash.ts:255-266` 现在的顺序是"executor 先砍到 10MB → bash 再把这份残次品写进 spill 文件 → 声称是 full output"。改成 `ExecOptions.spillTo`：executor 边收边写文件，内存里只保留 head + tail 环形缓冲。

收益：`fullOutputPath` 指向的才是真正的完整输出（P2）；内存 O(head+tail) 而非 10MB；`truncateTail` 的输入从"被砍过的 10MB"变成"真实的 tail"。

## D7 媒体：去掉 base64 往返

`read`(图片)（`read.ts:181`）和 `send_media`（`send-media.ts:109`）改成 `fileStore.readBytes` → `Buffer.toString("base64")`。

省掉一个子进程、一次 4/3 膨胀、和两处 `wc -c` 预检（`read.ts:169`、`send-media.ts:93`）。

`MAX_INLINE_BINARY_BYTES = 5MB`（`truncate.ts:21`）**保留但换语义**：它从此是产品限制（钉钉上传上限、模型上下文成本），不再是捕获缓冲的副作用。`truncate.ts:14-21` 那段解释 10MB cap 的注释要重写——留着会误导后来者。

## D8 `job readOutput`

`job-manager.ts:660` 的 `cat <spillFile>` 改成 `fileStore.readBytes(spillFile, { maxBytes })` + 明确的截断提示。spill 文件的**写入**仍由 `nohup sh -c ... > spillFile`（`job-manager.ts:299`）负责——那是 shell 重定向到真实文件，不经过任何缓冲，本来就是对的。

## 不做什么

- **不删 `Executor`**，不动 `bash` 的命令语义、不动命令守卫、不动 `DirectoryExecutor`。
- **不引入 native 依赖**（保持 spec 021 的约束）。`node:fs` 是标准库。
- **不改任何工具的 schema 或对模型可见的成功消息**（除 D4.3 的 `of ≥N` 和 D5.3 的截断说明，两处都是把假话改成真话）。
- **不做跨进程文件锁**。D2.4 仍然只是收窄竞态窗口。真正的写租约是 `SubAgentRunManager` 的职责（CLAUDE.md 已述），不在本 spec 范围。
- **不改 `settings.json`**。本 spec 引入的都是数值阈值，按 CLAUDE.md 的规则一律作为代码常量。

## 阶段与验收

每个阶段独立可合并、可发布。

### P1 地基（`FileStore` + executor 捕获）

改：新增 `src/file-store.ts`；`executor.ts` D6.1/D6.2；`shared/atomic-file.ts` 加 `preserveMode`；`path-guard.ts` 恒返回 `resolvedPath`；`registry.ts`/`tools/index.ts`/`bootstrap.ts` 注入。此阶段**不改任何工具的实现**。

验收：
- 900KB 中文命令输出经 `exec` 后 U+FFFD 计数为 0。
- 12MB ASCII 输出的 `ExecResult.stdoutTruncated === true`；11MB 中文输出（约 3.7M 字符）同样为 `true`（口径是字节）。
- `npm run check` 全绿。

### P2 写路径（`edit` + `write`）

改：`edit.ts` D2 全部；`write-content.ts` D3。

验收：
- 12MB 文件 edit 后尾部 marker 仍在，文件大小不变（F2 回归）。
- 300KB 中文文件 edit 后 U+FFFD 计数为 0（F3 回归）。
- 100MB 文件 edit 成功，进程 RSS 峰值增量 < 100MB（流式路径生效）。
- 含非法 UTF-8 字节的文件 edit 后，非匹配区域字节逐一相等。
- 可执行文件 edit 后 mode 不变（`preserveMode` 回归）。
- `replaceAll` 计数、唯一性拒绝、no-op streak 三条行为与改动前逐字一致。

### P3 读路径（`read` + `grep`）

改：`read.ts` D4；新增 `src/tools/line-index.ts`；`grep.ts` D5。

验收：
- 2GB 日志顺序翻 100 页的总耗时相对当前实现下降一个数量级。
- 含 node_modules 的仓库里，源码中的匹配不再被淹没；结果截断时消息明确说明截断。
- `read` 对目录、PDF、图片、`offset` 越界的行为与改动前一致。

### P4 清理（媒体 + job + 删补丁）

改：`read.ts` 图片分支、`send-media.ts` D7；`job-manager.ts` D8；重写 `truncate.ts:14-21` 注释；删除 `read.ts:164-168`、`send-media.ts:88-92` 的历史绕行注释与 `wc -c` 预检。

验收：4.9MB 图片 `send_media` 成功且字节与源文件逐一相等；超限时错误消息指向产品限制而非缓冲上限。

## 测试计划

迁移成本比预想小：全仓库只有三个测试文件依赖 scripted executor——`test/edit.test.ts`（161 行）、`test/read.test.ts`（179 行）、`test/write-content.test.ts`（78 行）。

而且它们当前断言的是 shell 命令字符串：

```ts
// test/edit.test.ts:36-38
expect(executor.calls[0].command).toContain("cat 'notes.txt'");
expect(executor.calls[2].command).toContain("mv -f \"$tmp\" 'notes.txt'");
```

这是在测实现而不是行为。改成真临时目录 + 真 `FileStore` 后，测试反而更能捕捉回归（上面 P2 的六条验收，没有一条能用 scripted executor 表达）。

新增：`test/file-store.test.ts`（端口契约：ENOENT、preserveMode、replaceViaTemp 的失败清理、start/end 窗口）；`test/line-index.test.ts`（增量扫描、失效、`of ≥N`）。`test/executor.test.ts`（53 行）加 D6.1/D6.2 的断言。

`test/bash.test.ts`（229 行）和 `test/grep-tool.test.ts`（125 行）用 scripted 结果驱动，P1/P2 不受影响，P3/P4 需要小幅调整。

## 风险与回滚

| 风险 | 评估 | 处置 |
|---|---|---|
| `preserveMode` 遗漏导致可执行位丢失 | 中——`cp -p` 是今天唯一提供而 `writeFileAtomically` 缺失的行为 | P1 就实现并单测，P2 才有消费者 |
| 大文件流式 edit 的边界匹配写错 | 中——滑动前缀的 off-by-one 是经典错误 | 针对 needle 恰好跨 chunk 边界、needle 长于 chunk、文件尾部部分匹配三种情况单测 |
| 行索引缓存在文件被外部改写后返回陈旧偏移 | 低 | 键含 size + mtimeMs；且窗口读出来的内容本身就是当前文件内容，最坏情况是行号标注偏移而非返回错内容 |
| `--exclude-dir` / `--include` 在某些 grep 实现上不支持 | 低 | JS 侧后置过滤保留作兜底；`rg` 探测独立于此 |
| 阶段间 `Executor` 与 `FileStore` 并存造成认知负担 | 低 | 每阶段独立可发布，且 P1 后新代码只有一条正确路径可选 |

回滚粒度即阶段粒度：每阶段是一次独立提交，`git revert` 单个提交即可回到上一个自洽状态。

## 对文档的影响

- `CLAUDE.md` 的 "Tools" 段现在写"Pipiclaw-owned filesystem/command/network tools go through `src/security/` guards"——需补一句：文件工具经 `FileStore`，命令工具经 `Executor`，两者都以 `guardPath` 的 `resolvedPath` 为唯一操作对象。
- `docs/architecture.md` 需要加 `FileStore` 这一层。
- `docs/specs/README.md` 的主题分组表加 `044` 一行。
- spec 021 和 030 中关于"文件经 `Executor`"的描述保留为历史，不改写（按 specs README 的维护规则）。
