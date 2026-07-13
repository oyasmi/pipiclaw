import { createHash, randomBytes } from "crypto";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { copyFile, readdir, rm } from "fs/promises";
import { basename, join } from "path";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { readOptionalTextFile } from "../shared/fs-utils.js";
import { type MemoryMetadataUpdate, type MemoryWriteMetadataInput, syncMemoryMetadata } from "./metadata.js";
import { containsSecret, REDACTED_SECRET } from "./policy.js";
import { appendMemoryTombstone, hashMemoryContent, readMemoryTombstones } from "./tombstones.js";

const DEFAULT_CHANNEL_MEMORY = `# Channel Memory

This file stores durable channel-specific memory.

- It is not preloaded into session context.
- Read it on demand when prior decisions, preferences, or long-running work matter.
- The runtime may append updates here during consolidation.

## Durable Facts

<!-- Stable facts, preferences, and ongoing commitments can accumulate here. -->
`;

const DEFAULT_CHANNEL_HISTORY = `# Channel History

This file stores summarized older channel history.

- It is not preloaded into session context.
- Read it on demand when older context matters.
- The runtime may append and fold history blocks here during consolidation.
`;

const DEFAULT_CHANNEL_SESSION = `# Session Title

<!-- A short title for the current active work in this channel. -->

# Current State

<!-- What is actively being worked on right now. -->

# User Intent

<!-- What the user is currently trying to achieve. -->

# Active Files

<!-- Important files or directories currently in focus. -->

# Decisions

<!-- Recent decisions that matter to the current work. -->

# Constraints

<!-- Current constraints, assumptions, or important guardrails. -->

# Errors & Corrections

<!-- Recent failures, corrections, and things to avoid repeating. -->

# Next Steps

<!-- Likely next actions if work resumes later. -->

# Worklog

<!-- Very terse notes about recent progress. -->
`;

const MEMORY_BACKUP_DIR = ".memory-backups";
const MEMORY_BACKUP_KEEP = 5;
const ENTRY_ID_COMMENT = /<!--\s*id:(m-[a-z0-9]+)\s*-->/i;
const ENTRY_ID_COMMENT_TRAILING = /\s*<!--\s*id:m-[a-z0-9]+\s*-->\s*$/i;

export function generateMemoryEntryId(): string {
	return `m-${randomBytes(4).toString("hex")}`;
}

// Deterministic id for legacy entries that predate id comments, so a single
// consolidation prompt can reference them; the real id is written in on supersede.
function stableMemoryEntryId(sectionHeading: string, content: string): string {
	const hash = createHash("sha1").update(`${sectionHeading}\x00${content}`).digest("hex");
	return `m-${hash.slice(0, 8)}`;
}

export function stripMemoryEntryIdComment(text: string): string {
	return text.replace(ENTRY_ID_COMMENT_TRAILING, "").trimEnd();
}

function renderMemoryEntryLine(content: string, id: string): string {
	return `- ${content.trim()} <!--id:${id}-->`;
}

export function parseUpdateHeadingTimestamp(heading: string): string | undefined {
	const match = heading.match(/^Update\s+(.+)$/);
	if (!match) {
		return undefined;
	}
	const timestamp = match[1].trim();
	return Number.isFinite(Date.parse(timestamp)) ? timestamp : undefined;
}

export interface ParsedMemoryEntry {
	id: string;
	content: string;
	sectionHeading: string;
	timestamp?: string;
	lineIndex: number;
	hasExplicitId: boolean;
}

/** Parse durable MEMORY.md bullet entries with stable ids for op-based edits. */
export function parseChannelMemoryEntries(content: string): ParsedMemoryEntry[] {
	const lines = content.replace(/\r/g, "").split("\n");
	const entries: ParsedMemoryEntry[] = [];
	let currentHeading = "";
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (line.startsWith("## ")) {
			currentHeading = line.slice(3).trim();
			continue;
		}
		const trimmed = line.trim();
		// Only bullets inside an H2 section are durable entries; bullets under the H1
		// header (the template's descriptive intro) are prose, not memory.
		if (!currentHeading || !trimmed.startsWith("- ")) {
			continue;
		}
		const body = trimmed.slice(2);
		const idMatch = body.match(ENTRY_ID_COMMENT);
		const displayContent = stripMemoryEntryIdComment(body).trim();
		if (!displayContent) {
			continue;
		}
		entries.push({
			id: idMatch ? idMatch[1] : stableMemoryEntryId(currentHeading, displayContent),
			content: displayContent,
			sectionHeading: currentHeading,
			timestamp: parseUpdateHeadingTimestamp(currentHeading),
			lineIndex: index,
			hasExplicitId: Boolean(idMatch),
		});
	}
	return entries;
}

export type MemoryOp =
	| { op: "add"; content: string; sourceEntryIds?: string[]; metadata?: MemoryWriteMetadataInput }
	| {
			op: "supersede";
			targetId: string;
			content: string;
			sourceEntryIds?: string[];
			metadata?: MemoryWriteMetadataInput;
	  }
	| { op: "invalidate"; targetId: string; reason?: string }
	| { op: "forget"; targetId: string; reason?: string; sourceEntryIds?: string[] };

export interface ApplyMemoryOpsResult {
	added: number;
	superseded: number;
	invalidated: number;
	downgradedToAdd: number;
	missingTarget: number;
	forgotten: number;
	blockedByPolicy: number;
	blockedByTombstone: number;
}

/**
 * Apply add/supersede/invalidate ops to a channel MEMORY.md with line-level edits,
 * preserving any surrounding markdown. Missing supersede targets downgrade to add;
 * missing invalidate targets are skipped. Mutating edits are backed up first.
 */
export async function applyChannelMemoryOps(
	channelDir: string,
	ops: MemoryOp[],
	timestamp: string = new Date().toISOString(),
): Promise<ApplyMemoryOpsResult> {
	const result: ApplyMemoryOpsResult = {
		added: 0,
		superseded: 0,
		invalidated: 0,
		downgradedToAdd: 0,
		missingTarget: 0,
		forgotten: 0,
		blockedByPolicy: 0,
		blockedByTombstone: 0,
	};
	if (ops.length === 0) {
		return result;
	}

	await ensureChannelMemoryFiles(channelDir);
	const path = getChannelMemoryPath(channelDir);
	const existing = await readOptionalTextFile(path);
	const lines = existing.replace(/\r/g, "").split("\n");
	const existingEntries = parseChannelMemoryEntries(existing);
	const byId = new Map(existingEntries.map((entry) => [entry.id, entry]));
	// Reconcile legacy entries before applying removals so terminal status retains
	// the entry's provenance even when no sidecar record existed yet.
	await syncMemoryMetadata(channelDir, existingEntries, [], timestamp);
	const tombstones = await readMemoryTombstones(channelDir);
	const tombstoneHashes = new Set(tombstones.map((tombstone) => tombstone.contentHash));
	const tombstoneSourceIds = new Set(tombstones.flatMap((tombstone) => tombstone.sourceEntryIds ?? []));

	const removals = new Set<number>();
	const replacements = new Map<number, string>();
	const additions: Array<{ content: string; id: string }> = [];
	const metadataUpdates: MemoryMetadataUpdate[] = [];

	for (const op of ops) {
		if (op.op === "add" || op.op === "supersede") {
			if (containsSecret(op.content) || op.content.includes(REDACTED_SECRET)) {
				result.blockedByPolicy++;
				continue;
			}
			if (
				tombstoneHashes.has(hashMemoryContent(op.content)) ||
				op.sourceEntryIds?.some((entryId) => tombstoneSourceIds.has(entryId))
			) {
				result.blockedByTombstone++;
				continue;
			}
		}

		if (op.op === "add") {
			if (op.content.trim()) {
				const id = generateMemoryEntryId();
				additions.push({ content: op.content.trim(), id });
				metadataUpdates.push({ id, status: "active", metadata: op.metadata, sourceEntryIds: op.sourceEntryIds });
				result.added++;
			}
			continue;
		}

		const target = byId.get(op.targetId);
		if (op.op === "invalidate" || op.op === "forget") {
			if (target) {
				removals.add(target.lineIndex);
				if (op.op === "forget") {
					await appendMemoryTombstone(channelDir, {
						entryId: target.id,
						contentHash: hashMemoryContent(target.content),
						deletedAt: timestamp,
						scope: "channel",
						reason: op.reason?.trim() || "user forget",
						sourceEntryIds: op.sourceEntryIds,
					});
					result.forgotten++;
					metadataUpdates.push({ id: target.id, status: "forgotten", sourceEntryIds: op.sourceEntryIds });
				} else {
					result.invalidated++;
					metadataUpdates.push({ id: target.id, status: "invalidated" });
				}
			} else {
				result.missingTarget++;
			}
			continue;
		}

		// supersede
		if (!op.content.trim()) {
			continue;
		}
		if (target) {
			const replacementId = target.hasExplicitId ? target.id : generateMemoryEntryId();
			replacements.set(target.lineIndex, renderMemoryEntryLine(op.content, replacementId));
			if (replacementId !== target.id) metadataUpdates.push({ id: target.id, status: "superseded" });
			metadataUpdates.push({
				id: replacementId,
				status: "active",
				metadata: op.metadata,
				sourceEntryIds: op.sourceEntryIds,
			});
			result.superseded++;
		} else {
			const id = generateMemoryEntryId();
			additions.push({ content: op.content.trim(), id });
			metadataUpdates.push({ id, status: "active", metadata: op.metadata, sourceEntryIds: op.sourceEntryIds });
			result.downgradedToAdd++;
			result.missingTarget++;
		}
	}

	const editedLines = lines
		.map((line, index) => replacements.get(index) ?? line)
		.filter((_, index) => !removals.has(index));
	let nextContent = editedLines.join("\n");

	if (additions.length > 0) {
		const block = [
			`## Update ${timestamp}`,
			...additions.map(({ content, id }) => renderMemoryEntryLine(content, id)),
		].join("\n");
		nextContent = `${ensureTrailingNewlines(nextContent)}${block}\n`;
	} else {
		nextContent = `${nextContent.replace(/\s+$/, "")}\n`;
	}

	if (removals.size > 0 || replacements.size > 0) {
		await backupBeforeRewrite(channelDir, path);
	}
	await writeFileAtomically(path, nextContent);
	await syncMemoryMetadata(channelDir, parseChannelMemoryEntries(nextContent), metadataUpdates, timestamp);
	return result;
}

// Best-effort: a backup is a safety net, never a precondition for the write, so a
// backup failure (permissions, disk full) must not block persisting memory.
async function backupBeforeRewrite(channelDir: string, sourcePath: string): Promise<void> {
	try {
		if (!existsSync(sourcePath)) {
			return;
		}
		const backupDir = join(channelDir, MEMORY_BACKUP_DIR);
		mkdirSync(backupDir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const name = basename(sourcePath, ".md");
		await copyFile(sourcePath, join(backupDir, `${name}-${stamp}.md`));
		const files = (await readdir(backupDir))
			.filter((file) => file.startsWith(`${name}-`) && file.endsWith(".md"))
			.sort();
		const excess = files.slice(0, Math.max(0, files.length - MEMORY_BACKUP_KEEP));
		await Promise.all(excess.map((file) => rm(join(backupDir, file), { force: true })));
	} catch {
		/* best-effort backup */
	}
}

export interface MemoryUpdateBlock {
	timestamp: string;
	entries: string[];
}

export interface HistoryBlock {
	timestamp: string;
	content: string;
}

function normalizeContent(content: string): string {
	return content.trim().length > 0 ? `${content.trim()}\n` : "";
}

function ensureTrailingNewlines(content: string): string {
	return content.trimEnd().length > 0 ? `${content.trimEnd()}\n\n` : "";
}

export function getChannelMemoryPath(channelDir: string): string {
	return join(channelDir, "MEMORY.md");
}

export function getChannelHistoryPath(channelDir: string): string {
	return join(channelDir, "HISTORY.md");
}

export function getChannelSessionPath(channelDir: string): string {
	return join(channelDir, "SESSION.md");
}

export async function ensureChannelMemoryFiles(channelDir: string): Promise<void> {
	ensureChannelMemoryFilesSync(channelDir);
}

export function ensureChannelMemoryFilesSync(channelDir: string): void {
	const memoryPath = getChannelMemoryPath(channelDir);
	const historyPath = getChannelHistoryPath(channelDir);
	const sessionPath = getChannelSessionPath(channelDir);

	mkdirSync(channelDir, { recursive: true });

	if (!existsSync(memoryPath)) {
		writeFileSync(memoryPath, DEFAULT_CHANNEL_MEMORY, "utf-8");
	}
	if (!existsSync(historyPath)) {
		writeFileSync(historyPath, DEFAULT_CHANNEL_HISTORY, "utf-8");
	}
	if (!existsSync(sessionPath)) {
		writeFileSync(sessionPath, DEFAULT_CHANNEL_SESSION, "utf-8");
	}
}

export async function readChannelMemory(channelDir: string): Promise<string> {
	return readOptionalTextFile(getChannelMemoryPath(channelDir));
}

export async function readChannelHistory(channelDir: string): Promise<string> {
	return readOptionalTextFile(getChannelHistoryPath(channelDir));
}

export async function readChannelSession(channelDir: string): Promise<string> {
	return readOptionalTextFile(getChannelSessionPath(channelDir));
}

export async function rewriteChannelMemory(channelDir: string, content: string): Promise<void> {
	await ensureChannelMemoryFiles(channelDir);
	const path = getChannelMemoryPath(channelDir);
	await backupBeforeRewrite(channelDir, path);
	const nextContent = normalizeContent(content) || DEFAULT_CHANNEL_MEMORY;
	await writeFileAtomically(path, nextContent);
	await syncMemoryMetadata(channelDir, parseChannelMemoryEntries(nextContent));
}

export async function rewriteChannelHistory(channelDir: string, content: string): Promise<void> {
	await ensureChannelMemoryFiles(channelDir);
	const path = getChannelHistoryPath(channelDir);
	await backupBeforeRewrite(channelDir, path);
	const nextContent = normalizeContent(content) || DEFAULT_CHANNEL_HISTORY;
	await writeFileAtomically(path, nextContent);
}

export async function rewriteChannelSession(channelDir: string, content: string): Promise<void> {
	await ensureChannelMemoryFiles(channelDir);
	const nextContent = normalizeContent(content) || DEFAULT_CHANNEL_SESSION;
	await writeFileAtomically(getChannelSessionPath(channelDir), nextContent);
}

export async function appendChannelMemoryUpdate(channelDir: string, block: MemoryUpdateBlock): Promise<void> {
	if (block.entries.length === 0) {
		return;
	}

	await ensureChannelMemoryFiles(channelDir);
	const path = getChannelMemoryPath(channelDir);
	const existing = await readOptionalTextFile(path);
	const renderedBlock = [
		`## Update ${block.timestamp}`,
		...block.entries.map((entry) => renderMemoryEntryLine(entry, generateMemoryEntryId())),
	].join("\n");
	const nextContent = `${ensureTrailingNewlines(existing)}${renderedBlock}\n`;
	await writeFileAtomically(path, nextContent);
	await syncMemoryMetadata(channelDir, parseChannelMemoryEntries(nextContent), [], block.timestamp);
}

export function getChannelHistoryArchivePath(channelDir: string): string {
	return join(channelDir, "HISTORY.archive.md");
}

/** Append raw history blocks to a never-rewritten archive before lossy folding. */
export async function appendChannelHistoryArchive(channelDir: string, block: HistoryBlock): Promise<void> {
	const trimmedContent = block.content.trim();
	if (!trimmedContent) {
		return;
	}
	await ensureChannelMemoryFiles(channelDir);
	const path = getChannelHistoryArchivePath(channelDir);
	const existing = await readOptionalTextFile(path);
	const header = existing.trim() ? existing : "# Channel History Archive\n";
	const renderedBlock = [`## Archived ${block.timestamp}`, trimmedContent].join("\n\n");
	await writeFileAtomically(path, `${ensureTrailingNewlines(header)}${renderedBlock}\n`);
}

export async function appendChannelHistoryBlock(channelDir: string, block: HistoryBlock): Promise<void> {
	const trimmedContent = block.content.trim();
	if (!trimmedContent) {
		return;
	}

	await ensureChannelMemoryFiles(channelDir);
	const path = getChannelHistoryPath(channelDir);
	const existing = await readOptionalTextFile(path);
	const renderedBlock = [`## ${block.timestamp}`, trimmedContent].join("\n\n");
	await writeFileAtomically(path, `${ensureTrailingNewlines(existing)}${renderedBlock}\n`);
}
