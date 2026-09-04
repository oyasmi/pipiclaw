import { createHash } from "node:crypto";

/**
 * The one piece of the v1 tombstone module that survived spec 050: a normalized content hash,
 * shared by `store.ts` (the v2 `.tombstones.jsonl`), `migrate.ts` (carrying v1 tombstones over
 * by hash), and the memory tools/commands (audit log entries that must not carry the forgotten
 * text itself).
 */
function normalizeMemoryContent(content: string): string {
	return content.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

export function hashMemoryContent(content: string): string {
	return createHash("sha256").update(normalizeMemoryContent(content)).digest("hex");
}
