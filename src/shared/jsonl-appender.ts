import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

const DEFAULT_MAX_PENDING_RECORDS = 2_000;
const DEFAULT_MAX_PENDING_BYTES = 8 * 1024 * 1024;
const DEFAULT_RESERVED_CRITICAL_RECORDS = 100;
const DEFAULT_RESERVED_CRITICAL_BYTES = 512 * 1024;

export type JsonlPriority = "normal" | "critical";

export interface JsonlAppenderOptions {
	/** Fixed target file. Mutually exclusive with `pathFor`. */
	path?: string;
	/** Resolve the target file per append (e.g. monthly ledger files). */
	pathFor?: (now: Date, record: unknown) => string;
	/** Transform an internal routing envelope into the value written to JSON. */
	recordForWrite?: (record: unknown) => unknown;
	/** Rotate when the file would exceed this size (bytes). Omit to disable. */
	maxSizeBytes?: number;
	/** Number of rotated backups to keep (`.1`..`.N`). Default 3. */
	maxRotations?: number;
	/** File mode for created files. Default 0o600. */
	mode?: number;
	/** Maximum accepted records waiting for disk. Default 2,000. */
	maxPendingRecords?: number;
	/** Maximum accepted UTF-8 bytes waiting for disk. Default 8 MiB. */
	maxPendingBytes?: number;
	/** Capacity unavailable to normal records, reserved for critical records. */
	reservedCriticalRecords?: number;
	/** Byte capacity unavailable to normal records, reserved for critical records. */
	reservedCriticalBytes?: number;
	/** Optional work that must follow a successful rotation in the same file queue. */
	onRotate?: (filePath: string) => Promise<void>;
}

export interface JsonlAppender {
	/** Queue and await one record. Never throws; a full or closed writer drops it. */
	append(record: unknown, priority?: JsonlPriority): Promise<void>;
	/** Queue one record without waiting for disk. Returns false when it cannot be accepted. */
	tryAppend(record: unknown, priority?: JsonlPriority): boolean;
	/** Wait until every currently accepted record has finished. */
	flush(): Promise<void>;
	/** Stop accepting records and drain the queue. */
	close(): Promise<void>;
}

interface PendingLine {
	filePath: string;
	line: string;
	bytes: number;
	completion: Promise<void>;
}

/**
 * Bounded append-only JSONL writer shared by runtime logs, channel archives,
 * audit logs, event history, and the usage ledger.
 *
 * Records are ordered per resolved path. Different paths may write in parallel.
 * Slow or failed observability storage never creates an unbounded in-memory
 * backlog and never rejects into the business path.
 */
export function createJsonlAppender(options: JsonlAppenderOptions): JsonlAppender {
	if (!options.path && !options.pathFor) {
		throw new Error("createJsonlAppender requires either `path` or `pathFor`");
	}

	const maxRotations = options.maxRotations ?? 3;
	const mode = options.mode ?? 0o600;
	const maxPendingRecords = options.maxPendingRecords ?? DEFAULT_MAX_PENDING_RECORDS;
	const maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
	const reservedCriticalRecords = Math.min(
		Math.floor(maxPendingRecords / 10),
		options.reservedCriticalRecords ?? DEFAULT_RESERVED_CRITICAL_RECORDS,
	);
	const reservedCriticalBytes = Math.min(
		Math.floor(maxPendingBytes / 8),
		options.reservedCriticalBytes ?? DEFAULT_RESERVED_CRITICAL_BYTES,
	);
	const chains = new Map<string, Promise<void>>();
	const sizes = new Map<string, number>();
	const ensuredDirs = new Set<string>();
	const pending = new Set<Promise<void>>();
	let pendingBytes = 0;
	let closed = false;
	let warnedWrite = false;
	let warnedDrop = false;

	const fallbackWarning = (event: string, message: string): void => {
		try {
			process.stdout.write(`${new Date().toISOString()} WARN  ${event} ${message}\n`);
		} catch {
			// Logging fallback failures must not escape into the runtime.
		}
	};

	const resolvePath = (now: Date, record: unknown): string =>
		options.pathFor ? options.pathFor(now, record) : options.path!;

	const ensureDir = async (filePath: string): Promise<void> => {
		const dir = dirname(filePath);
		if (ensuredDirs.has(dir)) return;
		await mkdir(dir, { recursive: true, mode: 0o700 });
		ensuredDirs.add(dir);
	};

	const currentSize = async (filePath: string): Promise<number> => {
		const cached = sizes.get(filePath);
		if (cached !== undefined) return cached;
		let size = 0;
		try {
			size = (await stat(filePath)).size;
		} catch {
			size = 0;
		}
		sizes.set(filePath, size);
		return size;
	};

	const rotate = async (filePath: string): Promise<void> => {
		if (maxRotations <= 0) {
			await rm(filePath, { force: true });
			sizes.set(filePath, 0);
			await options.onRotate?.(filePath);
			return;
		}
		for (let i = maxRotations - 1; i >= 1; i--) {
			const from = `${filePath}.${i}`;
			const to = `${filePath}.${i + 1}`;
			try {
				await rm(to, { force: true });
				await rename(from, to);
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			}
		}
		await rm(`${filePath}.1`, { force: true });
		await rename(filePath, `${filePath}.1`);
		sizes.set(filePath, 0);
		await options.onRotate?.(filePath);
	};

	const write = async (filePath: string, line: string, lineBytes: number): Promise<void> => {
		await ensureDir(filePath);
		const size = await currentSize(filePath);
		if (options.maxSizeBytes && options.maxSizeBytes > 0 && size + lineBytes > options.maxSizeBytes && size > 0) {
			await rotate(filePath);
		}
		await appendFile(filePath, line, { encoding: "utf-8", mode });
		sizes.set(filePath, (await currentSize(filePath)) + lineBytes);
	};

	const serialize = (record: unknown): Omit<PendingLine, "completion"> | null => {
		try {
			const json = JSON.stringify(options.recordForWrite ? options.recordForWrite(record) : record);
			if (json === undefined) throw new Error("JSONL records must be JSON-serializable values");
			const line = `${json}\n`;
			return { filePath: resolvePath(new Date(), record), line, bytes: Buffer.byteLength(line) };
		} catch {
			if (!warnedDrop) {
				warnedDrop = true;
				fallbackWarning("runtime.log_sink.dropped", "Failed to serialize JSONL record; record was dropped");
			}
			return null;
		}
	};

	const enqueue = (record: unknown, priority: JsonlPriority): PendingLine | null => {
		if (closed) return null;
		const serialized = serialize(record);
		if (!serialized) return null;
		const recordLimit = priority === "critical" ? maxPendingRecords : maxPendingRecords - reservedCriticalRecords;
		const byteLimit = priority === "critical" ? maxPendingBytes : maxPendingBytes - reservedCriticalBytes;
		if (pending.size >= recordLimit || pendingBytes + serialized.bytes > byteLimit) {
			if (!warnedDrop) {
				warnedDrop = true;
				fallbackWarning("runtime.log_sink.dropped", "JSONL queue limit reached; record was dropped");
			}
			return null;
		}

		const previous = chains.get(serialized.filePath) ?? Promise.resolve();
		const result = previous
			.catch(() => undefined)
			.then(async () => {
				try {
					await write(serialized.filePath, serialized.line, serialized.bytes);
					warnedWrite = false;
				} catch {
					if (!warnedWrite) {
						warnedWrite = true;
						fallbackWarning("runtime.log_sink.failed", "Failed to append JSONL record; continuing without it");
					}
				}
			});
		const completion = result.finally(() => {
			pending.delete(completion);
			pendingBytes -= serialized.bytes;
			if (chains.get(serialized.filePath) === completion) chains.delete(serialized.filePath);
			if (pending.size === 0) warnedDrop = false;
		});
		chains.set(serialized.filePath, completion);
		pending.add(completion);
		pendingBytes += serialized.bytes;
		return { ...serialized, completion };
	};

	const flush = async (): Promise<void> => {
		while (pending.size > 0) {
			await Promise.allSettled([...pending]);
		}
	};

	return {
		async append(record: unknown, priority: JsonlPriority = "critical"): Promise<void> {
			await enqueue(record, priority)?.completion;
		},
		tryAppend(record: unknown, priority: JsonlPriority = "normal"): boolean {
			return enqueue(record, priority) !== null;
		},
		flush,
		async close(): Promise<void> {
			closed = true;
			await flush();
		},
	};
}
