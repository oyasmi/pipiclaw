import { createHash } from "node:crypto";

/**
 * A normalized content hash, shared by `store.ts` (`.tombstones.jsonl`) and the memory
 * tools/commands (audit log entries that must not carry the forgotten text itself).
 */
function normalizeMemoryContent(content: string): string {
	return content.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

export function hashMemoryContent(content: string): string {
	return createHash("sha256").update(normalizeMemoryContent(content)).digest("hex");
}
