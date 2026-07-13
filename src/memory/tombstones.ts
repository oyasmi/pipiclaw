import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createSerialQueue } from "../shared/serial-queue.js";

export interface MemoryTombstone {
	entryId: string;
	contentHash: string;
	deletedAt: string;
	scope: "channel";
	reason: string;
	sourceEntryIds?: string[];
}

const appendQueue = createSerialQueue<string>();

function normalizeMemoryContent(content: string): string {
	return content.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

export function hashMemoryContent(content: string): string {
	return createHash("sha256").update(normalizeMemoryContent(content)).digest("hex");
}

export function getMemoryTombstonesPath(channelDir: string): string {
	return join(channelDir, ".memory", "tombstones.jsonl");
}

export async function appendMemoryTombstone(channelDir: string, tombstone: MemoryTombstone): Promise<void> {
	const path = getMemoryTombstonesPath(channelDir);
	await appendQueue.run(path, async () => {
		await mkdir(dirname(path), { recursive: true });
		await appendFile(path, `${JSON.stringify(tombstone)}\n`, "utf-8");
	});
}

export async function readMemoryTombstones(channelDir: string): Promise<MemoryTombstone[]> {
	try {
		const raw = await readFile(getMemoryTombstonesPath(channelDir), "utf-8");
		return raw
			.split("\n")
			.filter(Boolean)
			.flatMap((line) => {
				try {
					const value = JSON.parse(line) as MemoryTombstone;
					return value.entryId && value.contentHash ? [value] : [];
				} catch {
					return [];
				}
			});
	} catch (error) {
		if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw error;
	}
}
