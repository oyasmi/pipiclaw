import type { FileStat, FileStore } from "../file-store.js";

/**
 * Per-file incremental line-offset index (spec 044, D4.2). `read`'s old implementation scanned the
 * whole file once to count lines (`awk 'END{print NR}'`) and again to seek to an offset (`tail -n
 * +N`) -- paging sequentially through a large file was O(n) work per page, O(n^2) overall. This
 * index instead remembers how far it has scanned and the byte offset of every line start
 * discovered so far, so a forward page only scans the bytes between the last known line and the
 * new one.
 *
 * Keyed by `path + size + mtimeMs`: a file change mints a different key, so a stale entry is never
 * read as if it were current -- it just ages out of the LRU instead of needing explicit invalidation.
 */

interface IndexEntry {
	/** Byte offset where line N (1-indexed) starts, at index N-1. Always starts with `[0]`. */
	lineOffsets: number[];
	/** How many bytes from the start of the file have been scanned so far. */
	scannedBytes: number;
	/** Whether scanning has reached EOF. */
	eof: boolean;
}

const CACHE_CAPACITY = 32;
const SCAN_CHUNK_BYTES = 256 * 1024;

class LineIndexLru {
	private readonly map = new Map<string, IndexEntry>();

	get(key: string): IndexEntry | undefined {
		const value = this.map.get(key);
		if (value) {
			this.map.delete(key);
			this.map.set(key, value);
		}
		return value;
	}

	set(key: string, value: IndexEntry): void {
		this.map.delete(key);
		this.map.set(key, value);
		if (this.map.size > CACHE_CAPACITY) {
			const oldest = this.map.keys().next().value;
			if (oldest !== undefined) {
				this.map.delete(oldest);
			}
		}
	}

	clear(): void {
		this.map.clear();
	}
}

const cache = new LineIndexLru();

function cacheKey(path: string, stat: FileStat): string {
	return `${path}\0${stat.size}\0${stat.mtimeMs}`;
}

/** Only for tests: line-index state must not leak between unrelated test files sharing a path. */
export function clearLineIndexCacheForTests(): void {
	cache.clear();
}

export interface LineOffsetResult {
	/** Byte offset where `line` starts, or `undefined` if the index has not reached that line (yet, or ever). */
	offset: number | undefined;
	/** Whether the index has scanned to EOF -- `knownLines` is exact only when this is true. */
	eof: boolean;
	/** Lines discovered so far. Exact total when `eof`; otherwise a lower bound (D4.3: "of >= N"). */
	knownLines: number;
}

/**
 * Resolve the byte offset of `line` (1-indexed), scanning forward from wherever this file's index
 * last left off. Never re-scans bytes already indexed.
 */
export async function resolveLineOffset(
	fileStore: FileStore,
	path: string,
	stat: FileStat,
	line: number,
	signal?: AbortSignal,
): Promise<LineOffsetResult> {
	const key = cacheKey(path, stat);
	let entry = cache.get(key);
	if (!entry) {
		entry = { lineOffsets: [0], scannedBytes: 0, eof: stat.size === 0 };
		cache.set(key, entry);
	}

	while (entry.lineOffsets.length < line && !entry.eof) {
		const { data, eof } = await fileStore.readBytes(path, {
			start: entry.scannedBytes,
			maxBytes: SCAN_CHUNK_BYTES,
			signal,
		});
		for (let i = 0; i < data.length; i++) {
			if (data[i] === 0x0a) {
				entry.lineOffsets.push(entry.scannedBytes + i + 1);
			}
		}
		entry.scannedBytes += data.length;
		if (eof) {
			entry.eof = true;
		}
		if (data.length === 0) {
			break; // Defensive: readBytes returned nothing without reporting eof.
		}
	}

	const lastOffset = entry.lineOffsets[entry.lineOffsets.length - 1];
	// A file ending exactly on a newline should not count a phantom empty final line -- mirrors
	// the old `content.endsWith("\n") ? lines.length - 1 : lines.length` in truncate.ts's caller.
	// Once `eof` is reached, that phantom entry (if any) is also not a valid *offset* to resolve --
	// asking for line N+1 of an N-line file must report out of bounds, not silently hand back EOF.
	const knownLines = entry.eof && lastOffset === stat.size ? entry.lineOffsets.length - 1 : entry.lineOffsets.length;
	const resolvableLines = entry.eof ? knownLines : entry.lineOffsets.length;
	const offset = line <= resolvableLines ? entry.lineOffsets[line - 1] : undefined;

	return { offset, eof: entry.eof, knownLines };
}
