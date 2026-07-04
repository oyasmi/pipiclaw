import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createSerialQueue } from "./serial-queue.js";

export interface JsonlAppenderOptions {
	/** Fixed target file. Mutually exclusive with `pathFor`. */
	path?: string;
	/** Resolve the target file per append (e.g. monthly ledger files). */
	pathFor?: (now: Date) => string;
	/** Rotate when the file would exceed this size (bytes). Omit to disable. */
	maxSizeBytes?: number;
	/** Number of rotated backups to keep (`.1`..`.N`). Default 3. */
	maxRotations?: number;
	/** File mode for created files. Default 0o600. */
	mode?: number;
}

export interface JsonlAppender {
	/** Serialize `record` as one JSON line. Never throws. */
	append(record: unknown): Promise<void>;
}

/**
 * Append-only JSONL writer shared by the runtime log and the usage ledger.
 *
 * Writes are serialized per resolved file path, size-tracked in memory (one
 * initial stat), and rotated via rename. Observability infrastructure must not
 * reach back into the business path, so a failed append only warns once (until
 * the next success) and never rejects.
 */
export function createJsonlAppender(options: JsonlAppenderOptions): JsonlAppender {
	if (!options.path && !options.pathFor) {
		throw new Error("createJsonlAppender requires either `path` or `pathFor`");
	}

	const maxRotations = options.maxRotations ?? 3;
	const mode = options.mode ?? 0o600;
	const queue = createSerialQueue<string>();
	const sizes = new Map<string, number>();
	const ensuredDirs = new Set<string>();
	let warned = false;

	const resolvePath = (now: Date): string => (options.pathFor ? options.pathFor(now) : options.path!);

	const ensureDir = (filePath: string): void => {
		const dir = dirname(filePath);
		if (ensuredDirs.has(dir)) return;
		mkdirSync(dir, { recursive: true });
		ensuredDirs.add(dir);
	};

	const currentSize = (filePath: string): number => {
		const cached = sizes.get(filePath);
		if (cached !== undefined) return cached;
		let size = 0;
		try {
			if (existsSync(filePath)) size = statSync(filePath).size;
		} catch {
			size = 0;
		}
		sizes.set(filePath, size);
		return size;
	};

	const rotate = (filePath: string): void => {
		for (let i = maxRotations - 1; i >= 1; i--) {
			const from = `${filePath}.${i}`;
			if (existsSync(from)) {
				renameSync(from, `${filePath}.${i + 1}`);
			}
		}
		if (existsSync(filePath)) {
			renameSync(filePath, `${filePath}.1`);
		}
		sizes.set(filePath, 0);
	};

	const write = async (filePath: string, line: string): Promise<void> => {
		ensureDir(filePath);
		const lineBytes = Buffer.byteLength(line);
		if (options.maxSizeBytes && options.maxSizeBytes > 0) {
			if (currentSize(filePath) + lineBytes > options.maxSizeBytes && currentSize(filePath) > 0) {
				rotate(filePath);
			}
		}
		await appendFile(filePath, line, { encoding: "utf-8", mode });
		sizes.set(filePath, currentSize(filePath) + lineBytes);
	};

	return {
		async append(record: unknown): Promise<void> {
			const filePath = resolvePath(new Date());
			const line = `${JSON.stringify(record)}\n`;
			try {
				await queue.run(filePath, () => write(filePath, line));
				warned = false;
			} catch (error) {
				if (!warned) {
					warned = true;
					console.warn(
						`[jsonl-appender] Failed to append to ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
		},
	};
}
