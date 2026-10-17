/**
 * Disk I/O for dots (spec 058, D3/D4): `dots/<dot>/dot.json` and `dots/bindings.json`.
 *
 * `dot.json` may be written by the daemon (`/dot bind`) and a TUI (first open) at once, so every
 * read-modify-write of it runs under the cross-process lock `.locks/dot-json.lock`. The bindings
 * file is written by the daemon alone. Writes are atomic and serialized per path in-process.
 *
 * Channel ids are only JSON keys here; this module never parses them — callers pass the
 * conversation kind (the format rules live in `channel/channel-id.ts`).
 */
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { withFileLock } from "../shared/file-lock.js";
import { createSerialQueue } from "../shared/serial-queue.js";
import { isPlainObject } from "../shared/type-guards.js";
import {
	DOT_RECORD_FILENAME,
	getBindingsPath,
	getConversationDir,
	getDotDir,
	getDotLockPath,
	getDotsDir,
	isConversationName,
	isDotName,
	parseConversationName,
} from "./paths.js";
import type {
	BindingsFile,
	ConversationKind,
	CreateDotOutcome,
	DotConversation,
	DotRecord,
	DotSummary,
} from "./types.js";

/** `dot.json` writes are tiny; anything waiting this long is a stuck holder, not contention. */
const DOT_RECORD_LOCK_TIMEOUT_MS = 10_000;

const writeQueue = createSerialQueue<string>();

function errorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

function recordPath(dotDir: string): string {
	return join(dotDir, DOT_RECORD_FILENAME);
}

/** Validate a parsed `dot.json`; returns the reason it is unusable, or `undefined`. */
function invalidRecordReason(value: unknown, dirName: string): string | undefined {
	if (!isPlainObject(value)) return "dot.json is not a JSON object";
	if (value.version !== 1) return `unsupported dot.json version ${String(value.version)}`;
	if (value.name !== dirName) return `dot.json name ${JSON.stringify(value.name)} does not match directory ${dirName}`;
	if (typeof value.createdAt !== "string") return "dot.json createdAt is missing";
	if (!isPlainObject(value.conversations)) return "dot.json conversations is not an object";
	const dirs = new Set<string>();
	for (const [channelId, entry] of Object.entries(value.conversations)) {
		if (!isPlainObject(entry) || typeof entry.dir !== "string" || !isConversationName(entry.dir)) {
			return `dot.json conversation for ${channelId} has an invalid dir`;
		}
		if (dirs.has(entry.dir)) return `dot.json conversation dir ${entry.dir} is assigned twice`;
		dirs.add(entry.dir);
	}
	return undefined;
}

/** Read one dot's record, classifying it the way `/dot` and binding resolution need. */
export async function readDotRecord(workspaceDir: string, name: string): Promise<DotSummary> {
	if (!isDotName(name)) {
		return { name, dotDir: "", availability: "invalid", reason: `invalid dot name ${JSON.stringify(name)}` };
	}
	const dotDir = getDotDir(workspaceDir, name);
	let text: string;
	try {
		text = await readFile(recordPath(dotDir), "utf-8");
	} catch (error) {
		const code = errorCode(error);
		return {
			name,
			dotDir,
			availability: code === "ENOENT" ? "missing" : "invalid",
			reason: code === "ENOENT" ? `${recordPath(dotDir)} does not exist` : `cannot read ${recordPath(dotDir)}`,
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { name, dotDir, availability: "invalid", reason: `${recordPath(dotDir)} is not valid JSON` };
	}
	const reason = invalidRecordReason(parsed, name);
	if (reason) return { name, dotDir, availability: "invalid", reason };
	return { name, dotDir, availability: "available", record: parsed as DotRecord };
}

/** Every directory under `dots/`, each classified. A directory with an illegal name is reported invalid. */
export async function listDots(workspaceDir: string): Promise<DotSummary[]> {
	let entries: string[];
	try {
		entries = (await readdir(getDotsDir(workspaceDir), { withFileTypes: true }))
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
			.map((entry) => entry.name);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return [];
		throw error;
	}
	const summaries = await Promise.all(entries.sort().map((name) => readDotRecord(workspaceDir, name)));
	return summaries;
}

/**
 * Create an empty dot. `mkdir` without `recursive` is the exclusivity check: two creators of the
 * same name cannot both succeed. Binds nothing (D5).
 */
export async function createDot(workspaceDir: string, name: string, now: Date): Promise<CreateDotOutcome> {
	if (!isDotName(name)) return { kind: "invalid", name };
	const dotDir = getDotDir(workspaceDir, name);
	await mkdir(getDotsDir(workspaceDir), { recursive: true });
	try {
		await mkdir(dotDir);
	} catch (error) {
		if (errorCode(error) === "EEXIST") return { kind: "exists", name };
		throw error;
	}
	const record: DotRecord = { version: 1, name, createdAt: now.toISOString(), conversations: {} };
	await withFileLock(
		getDotLockPath(dotDir, "dot-json.lock"),
		() => writeQueue.run(recordPath(dotDir), () => writeJson(recordPath(dotDir), record)),
		{ timeoutMs: DOT_RECORD_LOCK_TIMEOUT_MS },
	);
	return { kind: "created", record };
}

/**
 * The conversation directory a channel uses in this dot, allocating it on first use (INV-7):
 * `<kind>-<n>` with `n` one past the largest index of that kind already in `dot.json`. Idempotent —
 * a channel already registered gets its existing directory back. The read-modify-write holds the
 * cross-process `dot-json.lock`, so a TUI allocating `tui-N` and the daemon allocating `group-N`
 * never lose each other's entry.
 */
export async function allocateConversation(
	workspaceDir: string,
	dot: string,
	channelId: string,
	kind: ConversationKind,
	now: Date,
): Promise<DotConversation> {
	const dotDir = getDotDir(workspaceDir, dot);
	return withFileLock(
		getDotLockPath(dotDir, "dot-json.lock"),
		() =>
			writeQueue.run(recordPath(dotDir), async () => {
				const summary = await readDotRecord(workspaceDir, dot);
				if (!summary.record) throw new Error(`Dot ${dot} is unavailable: ${summary.reason}`);
				const record = summary.record;
				const existing = record.conversations[channelId];
				if (existing) {
					return conversationOf(dot, dotDir, channelId, existing.dir);
				}
				let next = 1;
				for (const entry of Object.values(record.conversations)) {
					const parsed = parseConversationName(entry.dir);
					if (parsed?.kind === kind) next = Math.max(next, parsed.index + 1);
				}
				const dir = `${kind}-${next}`;
				await mkdir(getConversationDir(dotDir, dir), { recursive: true });
				const updated: DotRecord = {
					...record,
					conversations: { ...record.conversations, [channelId]: { dir, createdAt: now.toISOString() } },
				};
				await writeJson(recordPath(dotDir), updated);
				return conversationOf(dot, dotDir, channelId, dir);
			}),
		{ timeoutMs: DOT_RECORD_LOCK_TIMEOUT_MS },
	);
}

/** The conversation already registered for `channelId` in `record`, or `undefined`. Pure lookup. */
export function findConversation(record: DotRecord, dotDir: string, channelId: string): DotConversation | undefined {
	const entry = record.conversations[channelId];
	return entry ? conversationOf(record.name, dotDir, channelId, entry.dir) : undefined;
}

function conversationOf(dot: string, dotDir: string, channelId: string, conversation: string): DotConversation {
	return { dot, dotDir, channelId, conversation, conversationDir: getConversationDir(dotDir, conversation) };
}

function emptyBindings(): BindingsFile {
	return { version: 1, bindings: {} };
}

/**
 * Load `dots/bindings.json`. Missing means "nothing bound yet" (a fresh install). Anything
 * unreadable or of an unknown version throws: treating it as empty would silently suspend every
 * channel's background work and invite rebinding to the wrong dot (D4).
 */
export async function loadBindings(workspaceDir: string): Promise<BindingsFile> {
	const path = getBindingsPath(workspaceDir);
	let text: string;
	try {
		text = await readFile(path, "utf-8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return emptyBindings();
		throw new Error(`Cannot read dot bindings file ${path}: ${(error as Error).message}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`Dot bindings file ${path} is not valid JSON; fix or restore it before starting`);
	}
	if (!isPlainObject(parsed) || parsed.version !== 1 || !isPlainObject(parsed.bindings)) {
		throw new Error(
			`Dot bindings file ${path} has an unsupported shape or version; fix or restore it before starting`,
		);
	}
	const bindings: BindingsFile["bindings"] = {};
	for (const [channelId, entry] of Object.entries(parsed.bindings)) {
		if (
			!isPlainObject(entry) ||
			typeof entry.dot !== "string" ||
			!isDotName(entry.dot) ||
			typeof entry.boundAt !== "string"
		) {
			throw new Error(
				`Dot bindings file ${path} has an invalid entry for ${channelId}; fix or restore it before starting`,
			);
		}
		bindings[channelId] = { dot: entry.dot, boundAt: entry.boundAt };
	}
	return { version: 1, bindings };
}

export async function writeBindings(workspaceDir: string, file: BindingsFile): Promise<void> {
	const path = getBindingsPath(workspaceDir);
	await writeQueue.run(path, () => writeJson(path, file));
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await writeFileAtomically(path, `${JSON.stringify(value, null, "\t")}\n`);
}
