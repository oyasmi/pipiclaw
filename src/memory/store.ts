import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { readOptionalTextFile } from "../shared/fs-utils.js";
import { localDayKey } from "../shared/local-time.js";
import { containsSecret } from "./secret-redaction.js";
import { hashMemoryContent } from "./tombstones.js";

/**
 * Spec 050, D2/D3: one memory is one Markdown file under a channel's `memory/` directory,
 * with frontmatter as the single source of metadata truth. The `MEMORY.md` index is a
 * generated artifact rebuilt from those files after every write — never hand-authored, never
 * a second store. Files may be edited directly with any editor; the next read reflects the
 * change and the index is regenerated.
 */

export type MemoryType = "user" | "feedback" | "project" | "reference";
export type MemorySource = "user" | "agent" | "migrated";

const MEMORY_TYPES: readonly MemoryType[] = ["user", "feedback", "project", "reference"];
const MEMORY_SOURCES: readonly MemorySource[] = ["user", "agent", "migrated"];

/** Group order in the generated index; also the fallback ordering used by the budget tiering. */
export const MEMORY_TYPE_ORDER: readonly MemoryType[] = MEMORY_TYPES;

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 60;
const MAX_SLUG_WORDS = 6;

export interface MemoryEntry {
	/** File name without `.md`. Authoritative even when frontmatter `name` disagrees. */
	name: string;
	/** One self-contained line — exactly what the index shows. */
	description: string;
	type: MemoryType;
	source: MemorySource;
	/** Local calendar dates (`YYYY-MM-DD`). */
	created: string;
	updated: string;
	/** Present only for probationary entries (spec 050, D6); cleared on touch/update. */
	expires?: string;
	/** Optional long form; empty for the common one-line memory. */
	body: string;
	/** Frontmatter was missing or incomplete and defaults were filled in. Reported by `/memory status`. */
	malformed: boolean;
}

export interface MemoryTombstoneRecord {
	/** The entry name at deletion time; may be absent for records carried over from v1. */
	name?: string;
	contentHash: string;
	deletedAt: string;
	reason: string;
}

export function getChannelMemoryDir(channelDir: string): string {
	return join(channelDir, "memory");
}

export function getChannelMemoryIndexPath(channelDir: string): string {
	return join(channelDir, "MEMORY.md");
}

export function getMemoryEntryPath(channelDir: string, name: string): string {
	return join(getChannelMemoryDir(channelDir), `${name}.md`);
}

function getTombstonesPath(channelDir: string): string {
	return join(getChannelMemoryDir(channelDir), ".tombstones.jsonl");
}

// -------------------------------------------------------------------------------------------------
// Names
// -------------------------------------------------------------------------------------------------

export function isValidMemoryName(name: string): boolean {
	return name.length > 0 && name.length <= MAX_NAME_LENGTH && NAME_PATTERN.test(name);
}

function shortHash(seed: string): string {
	return createHash("sha1").update(seed).digest("hex").slice(0, 6);
}

/** Slugify free text into a memory name; falls back to `m-<hash6>` when nothing usable remains. */
export function slugifyMemoryName(text: string): string {
	const words = text
		.toLowerCase()
		.replace(/<!--[\s\S]*?-->/g, " ")
		.normalize("NFKD")
		.replace(/[^a-z0-9\s-]/g, " ")
		.split(/[\s-]+/)
		.filter(Boolean)
		.slice(0, MAX_SLUG_WORDS);
	const slug = words.join("-").slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
	return isValidMemoryName(slug) ? slug : `m-${shortHash(text)}`;
}

/** Return a name not already taken by `existing`, appending `-2`, `-3`, … when needed. */
export function dedupeMemoryName(name: string, existing: Iterable<string>): string {
	const taken = new Set(existing);
	if (!taken.has(name)) {
		return name;
	}
	for (let suffix = 2; ; suffix++) {
		const candidate = `${name}-${suffix}`.slice(0, MAX_NAME_LENGTH);
		if (!taken.has(candidate)) {
			return candidate;
		}
	}
}

// -------------------------------------------------------------------------------------------------
// Frontmatter parse / serialize
// -------------------------------------------------------------------------------------------------

function collapseToLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function firstParagraph(text: string): string {
	const block = text
		.replace(/\r/g, "")
		.split(/\n\s*\n/)
		.map((part) => part.trim())
		.find((part) => part.length > 0);
	return block ? collapseToLine(block) : "";
}

interface RawFrontmatter {
	fields: Map<string, string>;
	body: string;
	hadFrontmatter: boolean;
}

function parseRawFrontmatter(raw: string): RawFrontmatter {
	const normalized = raw.replace(/\r/g, "");
	const fields = new Map<string, string>();
	if (!normalized.startsWith("---\n")) {
		return { fields, body: normalized.trim(), hadFrontmatter: false };
	}
	const end = normalized.indexOf("\n---", 4);
	if (end === -1) {
		return { fields, body: normalized.trim(), hadFrontmatter: false };
	}
	const header = normalized.slice(4, end);
	for (const line of header.split("\n")) {
		const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
		if (match) {
			fields.set(match[1].toLowerCase(), match[2].trim().replace(/^["']|["']$/g, ""));
		}
	}
	const afterEnd = normalized.indexOf("\n", end + 1);
	const body = afterEnd === -1 ? "" : normalized.slice(afterEnd + 1).trim();
	return { fields, body, hadFrontmatter: true };
}

function coerceType(value: string | undefined): MemoryType | undefined {
	return value && (MEMORY_TYPES as readonly string[]).includes(value) ? (value as MemoryType) : undefined;
}

function coerceSource(value: string | undefined): MemorySource | undefined {
	return value && (MEMORY_SOURCES as readonly string[]).includes(value) ? (value as MemorySource) : undefined;
}

/** Parse one memory file. `name` (from the file name) always wins over frontmatter `name`. */
export function parseMemoryFile(name: string, raw: string, fallbackDate: string): MemoryEntry {
	const { fields, body, hadFrontmatter } = parseRawFrontmatter(raw);
	const type = coerceType(fields.get("type"));
	const source = coerceSource(fields.get("source"));
	const fmDescription = fields.get("description");
	const description = collapseToLine(fmDescription || firstParagraph(hadFrontmatter ? body : raw));
	const created = fields.get("created") || fallbackDate;
	const updated = fields.get("updated") || created;
	const expires = fields.get("expires") || undefined;
	// When frontmatter carried no description, the first paragraph became the description, so it
	// must not be repeated in the body.
	const effectiveBody = fmDescription ? body : stripFirstParagraph(hadFrontmatter ? body : raw);
	const malformed = !hadFrontmatter || !fmDescription || !type || !source || !fields.get("created");
	return {
		name,
		description,
		type: type ?? "project",
		source: source ?? "migrated",
		created,
		updated,
		expires,
		body: effectiveBody,
		malformed,
	};
}

function stripFirstParagraph(text: string): string {
	const normalized = text.replace(/\r/g, "").trim();
	const parts = normalized.split(/\n\s*\n/);
	return parts.slice(1).join("\n\n").trim();
}

export function serializeMemoryEntry(entry: MemoryEntry): string {
	const lines = [
		"---",
		`name: ${entry.name}`,
		`description: ${collapseToLine(entry.description)}`,
		`type: ${entry.type}`,
		`source: ${entry.source}`,
		`created: ${entry.created}`,
		`updated: ${entry.updated}`,
	];
	if (entry.expires) {
		lines.push(`expires: ${entry.expires}`);
	}
	lines.push("---", "");
	const body = entry.body.trim();
	return `${lines.join("\n")}\n${body ? `${body}\n` : ""}`;
}

// -------------------------------------------------------------------------------------------------
// Listing (with per-file mtime cache)
// -------------------------------------------------------------------------------------------------

const fileCache = new Map<string, { mtimeMs: number; entry: MemoryEntry }>();

/** Test seam: drop the parse cache so a fixture rewritten in place is re-read. */
export function clearMemoryStoreCache(): void {
	fileCache.clear();
}

export async function listMemoryEntries(channelDir: string): Promise<MemoryEntry[]> {
	const dir = getChannelMemoryDir(channelDir);
	let names: string[];
	try {
		names = await readdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw error;
	}
	const entries: MemoryEntry[] = [];
	for (const fileName of names) {
		if (!fileName.endsWith(".md") || fileName.startsWith(".")) {
			continue;
		}
		const path = join(dir, fileName);
		let info: Awaited<ReturnType<typeof stat>>;
		try {
			info = await stat(path);
		} catch {
			continue;
		}
		if (!info.isFile()) {
			continue;
		}
		const name = fileName.slice(0, -3);
		const cached = fileCache.get(path);
		if (cached && cached.mtimeMs === info.mtimeMs) {
			entries.push(cached.entry);
			continue;
		}
		const raw = await readFile(path, "utf-8");
		const entry = parseMemoryFile(name, raw, localDayKey(info.mtime));
		fileCache.set(path, { mtimeMs: info.mtimeMs, entry });
		entries.push(entry);
	}
	entries.sort((a, b) => a.name.localeCompare(b.name));
	return entries;
}

export async function readMemoryEntry(channelDir: string, name: string): Promise<MemoryEntry | undefined> {
	const path = getMemoryEntryPath(channelDir, name);
	const raw = await readOptionalTextFile(path);
	if (!raw) {
		return undefined;
	}
	let fallback = localDayKey();
	try {
		fallback = localDayKey((await stat(path)).mtime);
	} catch {
		/* use today */
	}
	return parseMemoryFile(name, raw, fallback);
}

// -------------------------------------------------------------------------------------------------
// Index generation
// -------------------------------------------------------------------------------------------------

export function renderMemoryIndex(entries: MemoryEntry[]): string {
	const lines = ["# Channel Memory", ""];
	for (const type of MEMORY_TYPE_ORDER) {
		const group = entries
			.filter((entry) => entry.type === type)
			.sort((a, b) => a.name.localeCompare(b.name));
		if (group.length === 0) {
			continue;
		}
		lines.push(`## ${type}`);
		for (const entry of group) {
			lines.push(renderIndexLine(entry));
		}
		lines.push("");
	}
	if (lines.length === 2) {
		lines.push("_No stored memory in this channel yet._", "");
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

export function renderIndexLine(entry: MemoryEntry): string {
	const marker = entry.body.trim() ? " (+)" : "";
	return `- ${entry.name} — ${entry.description}${marker}`;
}

export async function rebuildMemoryIndex(channelDir: string): Promise<MemoryEntry[]> {
	const entries = await listMemoryEntries(channelDir);
	await writeFileAtomically(getChannelMemoryIndexPath(channelDir), renderMemoryIndex(entries));
	return entries;
}

// -------------------------------------------------------------------------------------------------
// Tombstones
// -------------------------------------------------------------------------------------------------

export async function readMemoryTombstoneRecords(channelDir: string): Promise<MemoryTombstoneRecord[]> {
	const raw = await readOptionalTextFile(getTombstonesPath(channelDir));
	if (!raw) {
		return [];
	}
	const records: MemoryTombstoneRecord[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) {
			continue;
		}
		try {
			const value = JSON.parse(line) as MemoryTombstoneRecord;
			if (value.contentHash) {
				records.push(value);
			}
		} catch {
			/* skip malformed line */
		}
	}
	return records;
}

export async function appendMemoryTombstoneRecord(
	channelDir: string,
	record: MemoryTombstoneRecord,
): Promise<void> {
	const path = getTombstonesPath(channelDir);
	await mkdir(getChannelMemoryDir(channelDir), { recursive: true });
	await appendFile(path, `${JSON.stringify(record)}\n`, "utf-8");
}

export async function isDescriptionTombstoned(channelDir: string, description: string): Promise<boolean> {
	const hash = hashMemoryContent(description);
	return (await readMemoryTombstoneRecords(channelDir)).some((record) => record.contentHash === hash);
}

// -------------------------------------------------------------------------------------------------
// Op application
// -------------------------------------------------------------------------------------------------

/**
 * Mechanical store mutations. Policy — per-pass caps, confidence bars, user-source protection —
 * lives in the reflect pass (spec 050, D7), never here.
 */
export type MemoryStoreOp =
	| {
			op: "add";
			description: string;
			source: MemorySource;
			name?: string;
			type?: MemoryType;
			details?: string;
			/** A date string starts probation; omitted or `null` means permanent. */
			expires?: string | null;
	  }
	| {
			op: "update";
			name: string;
			description?: string;
			type?: MemoryType;
			details?: string;
			/** `null` clears probation (promote); a string resets it; omitted leaves it. */
			expires?: string | null;
	  }
	| { op: "delete"; name: string; reason?: string }
	| { op: "touch"; names: string[] };

export interface ApplyMemoryOpsResult {
	added: string[];
	updated: string[];
	deleted: string[];
	touched: string[];
	skippedTombstone: number;
	skippedSecret: number;
	missingTarget: number;
	renamed: Array<{ requested: string; used: string }>;
}

export async function applyMemoryOps(
	channelDir: string,
	ops: MemoryStoreOp[],
	options: { today?: string } = {},
): Promise<ApplyMemoryOpsResult> {
	const today = options.today ?? localDayKey();
	const result: ApplyMemoryOpsResult = {
		added: [],
		updated: [],
		deleted: [],
		touched: [],
		skippedTombstone: 0,
		skippedSecret: 0,
		missingTarget: 0,
		renamed: [],
	};
	if (ops.length === 0) {
		return result;
	}

	await mkdir(getChannelMemoryDir(channelDir), { recursive: true });
	const existing = await listMemoryEntries(channelDir);
	const byName = new Map(existing.map((entry) => [entry.name, entry]));
	const liveNames = new Set(byName.keys());

	for (const op of ops) {
		if (op.op === "touch") {
			for (const name of op.names) {
				const entry = byName.get(name);
				if (!entry) {
					result.missingTarget++;
					continue;
				}
				if (entry.expires) {
					const next: MemoryEntry = { ...entry, expires: undefined, updated: today };
					await writeEntryFile(channelDir, next);
					byName.set(name, next);
				}
				result.touched.push(name);
			}
			continue;
		}

		if (op.op === "delete") {
			const entry = byName.get(op.name);
			if (!entry) {
				result.missingTarget++;
				continue;
			}
			await rm(getMemoryEntryPath(channelDir, op.name), { force: true });
			await appendMemoryTombstoneRecord(channelDir, {
				name: op.name,
				contentHash: hashMemoryContent(entry.description),
				deletedAt: today,
				reason: op.reason?.trim() || "deleted",
			});
			byName.delete(op.name);
			liveNames.delete(op.name);
			result.deleted.push(op.name);
			continue;
		}

		if (op.op === "update") {
			const entry = byName.get(op.name);
			if (!entry) {
				result.missingTarget++;
				continue;
			}
			const description = op.description ? collapseToLine(op.description) : entry.description;
			if (containsSecret(description) || (op.details && containsSecret(op.details))) {
				result.skippedSecret++;
				continue;
			}
			const next: MemoryEntry = {
				...entry,
				description,
				type: op.type ?? entry.type,
				body: op.details !== undefined ? op.details.trim() : entry.body,
				updated: today,
				expires: op.expires === undefined ? entry.expires : op.expires === null ? undefined : op.expires,
				malformed: false,
			};
			await writeEntryFile(channelDir, next);
			byName.set(op.name, next);
			result.updated.push(op.name);
			continue;
		}

		// add
		const description = collapseToLine(op.description);
		if (!description) {
			continue;
		}
		if (containsSecret(description) || (op.details && containsSecret(op.details))) {
			result.skippedSecret++;
			continue;
		}
		if (await isDescriptionTombstoned(channelDir, description)) {
			result.skippedTombstone++;
			continue;
		}
		const requested = op.name && isValidMemoryName(op.name) ? op.name : slugifyMemoryName(op.name || description);
		const name = dedupeMemoryName(requested, liveNames);
		if (name !== requested) {
			result.renamed.push({ requested, used: name });
		}
		const entry: MemoryEntry = {
			name,
			description,
			type: op.type ?? "project",
			source: op.source,
			created: today,
			updated: today,
			expires: op.expires === null || op.expires === undefined ? undefined : op.expires,
			body: op.details?.trim() ?? "",
			malformed: false,
		};
		await writeEntryFile(channelDir, entry);
		byName.set(name, entry);
		liveNames.add(name);
		result.added.push(name);
	}

	await rebuildMemoryIndex(channelDir);
	return result;
}

async function writeEntryFile(channelDir: string, entry: MemoryEntry): Promise<void> {
	await mkdir(getChannelMemoryDir(channelDir), { recursive: true });
	await writeFileAtomically(getMemoryEntryPath(channelDir, entry.name), serializeMemoryEntry(entry));
}
