import { createReadStream, type Dirent } from "node:fs";
import { stat as fsStat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Readable, Writable } from "node:stream";
import { createAtomicTempPath, writeFileAtomically } from "./shared/atomic-file.js";

/**
 * `FileStore` is the file-content counterpart to `Executor` (spec 044, D1): where `Executor` runs
 * a shell command and captures its stdout/stderr, `FileStore` reads and writes file *content*
 * directly over `node:fs`. File content must never be routed through argv, stdout, or stdin --
 * that path forces every read/write through `Executor`'s bounded capture buffer, which silently
 * truncates and can corrupt multi-byte text mid-stream (see the spec's F2/F3 evidence).
 *
 * All paths passed to a `FileStore` method are expected to be the absolute `resolvedPath` that
 * `guardPath` already produced -- callers resolve a path exactly once and pass that same value to
 * both the guard and the store (spec 044, D1.1).
 */

export interface FileStat {
	size: number;
	mtimeMs: number;
	ino: number;
	mode: number;
	isDirectory: boolean;
	isFile: boolean;
}

/** Lightweight fingerprint used to detect a concurrent write between a read and a later write-back (D2.4). */
export interface FileFingerprint {
	size: number;
	mtimeMs: number;
	ino: number;
}

export function fingerprintOf(stat: FileStat): FileFingerprint {
	return { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
}

export function fingerprintsEqual(a: FileFingerprint, b: FileFingerprint): boolean {
	return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

export interface DirectoryEntry {
	/** Basename of the entry. */
	name: string;
	/** Path relative to the directory passed to `listDirectory`, using `/` separators. */
	relativePath: string;
	isDirectory: boolean;
}

export interface ReadBytesOptions {
	start?: number;
	maxBytes?: number;
	signal?: AbortSignal;
}

export interface ReadBytesResult {
	data: Buffer;
	/** Whether this read reached the end of the file -- the caller's cue for "is there more?" (P2). */
	eof: boolean;
	stat: FileStat;
}

export interface WriteAtomicOptions {
	createParentDir?: boolean;
	/** Preserve the existing file's permission bits across the rename (see `shared/atomic-file.ts`). */
	preserveMode?: boolean;
	signal?: AbortSignal;
}

export interface ReplaceViaTempOptions {
	preserveMode?: boolean;
	signal?: AbortSignal;
}

export interface WalkFilesOptions {
	/** Stop once this many file paths have been collected; the walk short-circuits, `truncated` says so. */
	maxEntries: number;
	/** Called with a directory's basename; returning true skips descending into it (never dereferenced). */
	prune?: (dirName: string) => boolean;
	signal?: AbortSignal;
}

export interface WalkFilesResult {
	/** Regular-file paths only (never directories or symlinks), `/`-joined and relative to the walked root. */
	files: string[];
	/** True when `maxEntries` was hit before the walk finished -- the result is a partial, not the complete tree. */
	truncated: boolean;
}

export interface FileStore {
	/** ENOENT resolves to `undefined` rather than throwing. */
	stat(path: string): Promise<FileStat | undefined>;

	/** Single bounded read. `eof` tells the caller whether there is more file left to fetch. */
	readBytes(path: string, opts?: ReadBytesOptions): Promise<ReadBytesResult>;

	/** Streaming read, for `edit`'s large-file path and `read`'s line-index scan. */
	openRead(path: string, opts?: { start?: number; end?: number }): Readable;

	/** Write-temp-then-rename with fsync, mirroring `shared/atomic-file.ts`'s guarantees. */
	writeAtomic(path: string, data: Buffer | string, opts?: WriteAtomicOptions): Promise<void>;

	/** Streaming atomic replace: `produce` writes to a temp file; on success it is renamed over `path`. */
	replaceViaTemp(path: string, produce: (out: Writable) => Promise<void>, opts?: ReplaceViaTempOptions): Promise<void>;

	/** Depth-bounded directory listing, replacing the `find -maxdepth` shell-out. */
	listDirectory(path: string, opts: { maxDepth: number }): Promise<DirectoryEntry[]>;

	/**
	 * Unbounded-depth file discovery for `glob`, replacing the `find` shell-out. Directories are
	 * pruned by `opts.prune` before being entered (so a huge `node_modules` is never walked at all,
	 * mirroring `grep`'s `--exclude-dir` push-down); symlinks (file or directory) are never followed,
	 * since `Dirent.isFile()`/`isDirectory()` reflect the link itself, not its target.
	 */
	walkFiles(path: string, opts: WalkFilesOptions): Promise<WalkFilesResult>;
}

export function createFileStore(): FileStore {
	return new HostFileStore();
}

function toFileStat(raw: {
	size: number;
	mtimeMs: number;
	ino: number;
	mode: number;
	isDirectory(): boolean;
	isFile(): boolean;
}): FileStat {
	return {
		size: raw.size,
		mtimeMs: raw.mtimeMs,
		ino: raw.ino,
		mode: raw.mode,
		isDirectory: raw.isDirectory(),
		isFile: raw.isFile(),
	};
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new Error("Aborted");
	}
}

/** Best-effort directory fsync after a rename; mirrors `shared/atomic-file.ts`'s own tolerance. */
async function fsyncDir(dir: string): Promise<void> {
	await open(dir, "r")
		.then(async (dirHandle) => {
			try {
				await dirHandle.sync();
			} finally {
				await dirHandle.close();
			}
		})
		.catch(() => undefined);
}

class HostFileStore implements FileStore {
	async stat(path: string): Promise<FileStat | undefined> {
		try {
			return toFileStat(await fsStat(path));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return undefined;
			}
			throw error;
		}
	}

	async readBytes(path: string, opts: ReadBytesOptions = {}): Promise<ReadBytesResult> {
		throwIfAborted(opts.signal);
		const handle = await open(path, "r");
		try {
			const stat = toFileStat(await handle.stat());
			const start = Math.max(0, opts.start ?? 0);
			const maxBytes = opts.maxBytes ?? Number.POSITIVE_INFINITY;
			const available = Math.max(0, stat.size - start);
			const toRead = Math.min(available, maxBytes);
			const buffer = Buffer.alloc(toRead);
			let readTotal = 0;
			while (readTotal < toRead) {
				throwIfAborted(opts.signal);
				const { bytesRead } = await handle.read(buffer, readTotal, toRead - readTotal, start + readTotal);
				if (bytesRead === 0) {
					break;
				}
				readTotal += bytesRead;
			}
			const data = readTotal === buffer.length ? buffer : buffer.subarray(0, readTotal);
			return { data, eof: start + readTotal >= stat.size, stat };
		} finally {
			await handle.close();
		}
	}

	openRead(path: string, opts: { start?: number; end?: number } = {}): Readable {
		return createReadStream(path, { start: opts.start, end: opts.end });
	}

	async writeAtomic(path: string, data: Buffer | string, opts: WriteAtomicOptions = {}): Promise<void> {
		throwIfAborted(opts.signal);
		if (opts.createParentDir) {
			await mkdir(dirname(path), { recursive: true });
		}
		await writeFileAtomically(path, data, { preserveMode: opts.preserveMode });
	}

	async replaceViaTemp(
		path: string,
		produce: (out: Writable) => Promise<void>,
		opts: ReplaceViaTempOptions = {},
	): Promise<void> {
		throwIfAborted(opts.signal);
		const dir = dirname(path);
		await mkdir(dir, { recursive: true });
		const tempPath = createAtomicTempPath(path);
		try {
			const handle = await open(tempPath, "w");
			try {
				if (opts.preserveMode) {
					const existing = await this.stat(path);
					if (existing) {
						await handle.chmod(existing.mode & 0o777);
					}
				}
				// `handle.createWriteStream()` closes the underlying `FileHandle` itself once the stream
				// ends, so a subsequent `handle.sync()`/`handle.close()` on the same handle would throw
				// "file closed". Write through `handle.write()` directly instead, keeping the handle
				// under our own control until the explicit `sync()` + `close()` below.
				const out = new Writable({
					write(chunk: Buffer, _encoding, callback) {
						handle.write(chunk).then(
							() => callback(),
							(error) => callback(error instanceof Error ? error : new Error(String(error))),
						);
					},
				});
				await produce(out);
				await new Promise<void>((resolve, reject) => {
					out.once("error", reject);
					out.end(() => resolve());
				});
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(tempPath, path);
			await fsyncDir(dir);
		} catch (error) {
			await unlink(tempPath).catch(() => undefined);
			throw error;
		}
	}

	async listDirectory(path: string, opts: { maxDepth: number }): Promise<DirectoryEntry[]> {
		const results: DirectoryEntry[] = [];
		const walk = async (currentDir: string, relPrefix: string, depth: number): Promise<void> => {
			const entries = await readdir(currentDir, { withFileTypes: true });
			for (const entry of entries) {
				const relativePath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
				const isDirectory = entry.isDirectory();
				results.push({ name: entry.name, relativePath, isDirectory });
				if (isDirectory && depth < opts.maxDepth) {
					await walk(join(currentDir, entry.name), relativePath, depth + 1);
				}
			}
		};
		await walk(path, "", 1);
		return results;
	}

	async walkFiles(path: string, opts: WalkFilesOptions): Promise<WalkFilesResult> {
		const files: string[] = [];
		let truncated = false;
		const walk = async (currentDir: string, relPrefix: string): Promise<void> => {
			if (truncated) return;
			throwIfAborted(opts.signal);
			let entries: Dirent<string>[];
			try {
				entries = await readdir(currentDir, { withFileTypes: true });
			} catch {
				// An unreadable directory (permission, or removed mid-walk) is skipped rather than
				// failing the whole discovery -- one bad subtree must not blank out every other match.
				return;
			}
			for (const entry of entries) {
				if (truncated) return;
				const relativePath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
				if (entry.isDirectory()) {
					if (opts.prune?.(entry.name)) continue;
					await walk(join(currentDir, entry.name), relativePath);
					continue;
				}
				// Symlinks (to files or directories) report false from both checks and are skipped: a
				// glob result must never resolve outside the guarded root through a link the walk never
				// asked permission to follow.
				if (!entry.isFile()) continue;
				files.push(relativePath);
				if (files.length >= opts.maxEntries) {
					truncated = true;
					return;
				}
			}
		};
		await walk(path, "");
		return { files, truncated };
	}
}
