/**
 * Disk I/O for `desk-<desk>/desk.json` and desk creation (spec 060). The binding table lives in
 * `bindings.ts`.
 *
 * `desk.json` may be written by the daemon (`/desk bind`) and a TUI (first open) at once, so every
 * read-modify-write of it runs under the cross-process lock `.locks/desk-json.lock`. Writes are
 * atomic and serialized per path in-process.
 *
 * Channel ids are only JSON keys here; this module never parses them — callers pass the
 * conversation kind (the format rules live in `channel/channel-id.ts`).
 */
import { lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { syncDirectoryBestEffort, writeFileAtomically } from "../shared/atomic-file.js";
import { withFileLock } from "../shared/file-lock.js";
import { createSerialQueue } from "../shared/serial-queue.js";
import { isPlainObject } from "../shared/type-guards.js";
import { initializeBindings } from "./bindings.js";
import {
	DESK_DIR_PREFIX,
	DESK_RECORD_FILENAME,
	getConversationDir,
	getDeskDir,
	getDeskLockPath,
	isConversationName,
	isDeskEntry,
	isDeskName,
	parseConversationName,
} from "./paths.js";
import type { ConversationKind, CreateDeskOutcome, DeskConversation, DeskRecord, DeskSummary } from "./types.js";

/** `desk.json` writes are tiny; anything waiting this long is a stuck holder, not contention. */
const DESK_RECORD_LOCK_TIMEOUT_MS = 10_000;

const writeQueue = createSerialQueue<string>();

function errorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

function recordPath(deskDir: string): string {
	return join(deskDir, DESK_RECORD_FILENAME);
}

/** Validate a parsed `desk.json`; returns the reason it is unusable, or `undefined`. */
function invalidRecordReason(value: unknown, dirName: string): string | undefined {
	if (!isPlainObject(value)) return "desk.json is not a JSON object";
	if (value.version !== 1) return `unsupported desk.json version ${String(value.version)}`;
	if (value.name !== dirName)
		return `desk.json name ${JSON.stringify(value.name)} does not match directory ${dirName}`;
	if (typeof value.createdAt !== "string") return "desk.json createdAt is missing";
	if (!isPlainObject(value.conversations)) return "desk.json conversations is not an object";
	if (value.cwd !== undefined && (typeof value.cwd !== "string" || !isAbsolute(value.cwd))) {
		return "desk.json cwd must be an absolute path";
	}
	const dirs = new Set<string>();
	for (const [channelId, entry] of Object.entries(value.conversations)) {
		if (!isPlainObject(entry) || typeof entry.dir !== "string" || !isConversationName(entry.dir)) {
			return `desk.json conversation for ${channelId} has an invalid dir`;
		}
		if (dirs.has(entry.dir)) return `desk.json conversation dir ${entry.dir} is assigned twice`;
		dirs.add(entry.dir);
	}
	return undefined;
}

/** Read one desk's record, classifying it the way `/desk` and binding resolution need. */
export async function readDeskRecord(workspaceDir: string, name: string): Promise<DeskSummary> {
	if (!isDeskName(name)) {
		return { name, deskDir: "", availability: "invalid", reason: `invalid desk name ${JSON.stringify(name)}` };
	}
	const deskDir = getDeskDir(workspaceDir, name);
	let text: string;
	try {
		text = await readFile(recordPath(deskDir), "utf-8");
	} catch (error) {
		const code = errorCode(error);
		return {
			name,
			deskDir,
			availability: code === "ENOENT" ? "missing" : "invalid",
			reason: code === "ENOENT" ? `${recordPath(deskDir)} does not exist` : `cannot read ${recordPath(deskDir)}`,
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { name, deskDir, availability: "invalid", reason: `${recordPath(deskDir)} is not valid JSON` };
	}
	const reason = invalidRecordReason(parsed, name);
	if (reason) return { name, deskDir, availability: "invalid", reason };
	return { name, deskDir, availability: "available", record: parsed as DeskRecord };
}

/** Every directory under `desk-`, each classified. A directory with an illegal name is reported invalid. */
export async function listDesks(workspaceDir: string): Promise<DeskSummary[]> {
	let entries: string[];
	try {
		entries = (await readdir(workspaceDir, { withFileTypes: true }))
			.filter(isDeskEntry)
			.map((entry) => entry.name.slice(DESK_DIR_PREFIX.length));
	} catch (error) {
		if (errorCode(error) === "ENOENT") return [];
		throw error;
	}
	const summaries = await Promise.all(entries.sort().map((name) => readDeskRecord(workspaceDir, name)));
	return summaries;
}

/** Create an empty desk without binding it, publishing it atomically. Holds no conversation lock. */
export function createDeskRecord(workspaceDir: string, name: string, now: Date): CreateDeskOutcome {
	if (!isDeskName(name)) return { kind: "invalid", name };
	const bindings = initializeBindings(workspaceDir);
	const deskDir = getDeskDir(workspaceDir, name);
	try {
		lstatSync(deskDir);
		return { kind: "exists", name };
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
	if (Object.values(bindings.bindings).some((binding) => binding.desk === name)) return { kind: "unavailable", name };
	mkdirSync(workspaceDir, { recursive: true });
	const staging = mkdtempSync(join(workspaceDir, `.desk-init-${name}-`));
	const record: DeskRecord = { version: 1, name, createdAt: now.toISOString(), conversations: {} };
	try {
		writeFileSync(recordPath(staging), `${JSON.stringify(record, null, "\t")}\n`, { flush: true });
		syncDirectoryBestEffort(staging);
		try {
			renameSync(staging, deskDir);
			syncDirectoryBestEffort(workspaceDir);
		} catch (error) {
			if (["EEXIST", "ENOTEMPTY"].includes(errorCode(error) ?? "")) return { kind: "exists", name };
			throw error;
		}
		return { kind: "created", record };
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

/**
 * The conversation directory a channel uses in this desk, allocating it on first use (INV-7):
 * `<kind>-<n>` with `n` one past the largest index of that kind already in `desk.json`. Idempotent —
 * a channel already registered gets its existing directory back. The read-modify-write holds the
 * cross-process `desk-json.lock`, so two processes allocating at once (the daemon and an
 * embedded runtime, or a desk command run elsewhere) never lose each other's entry.
 */
export async function allocateConversation(
	workspaceDir: string,
	desk: string,
	channelId: string,
	kind: ConversationKind,
	now: Date,
): Promise<DeskConversation> {
	const deskDir = getDeskDir(workspaceDir, desk);
	return withFileLock(
		getDeskLockPath(deskDir, "desk-json.lock"),
		() =>
			writeQueue.run(recordPath(deskDir), async () => {
				const summary = await readDeskRecord(workspaceDir, desk);
				if (!summary.record) throw new Error(`Desk ${desk} is unavailable: ${summary.reason}`);
				const record = summary.record;
				const existing = record.conversations[channelId];
				if (existing) {
					return conversationOf(record, deskDir, channelId, existing.dir);
				}
				let next = 1;
				for (const entry of Object.values(record.conversations)) {
					const parsed = parseConversationName(entry.dir);
					if (parsed?.kind === kind) next = Math.max(next, parsed.index + 1);
				}
				const dir = `${kind}-${next}`;
				await mkdir(getConversationDir(deskDir, dir), { recursive: true });
				const updated: DeskRecord = {
					...record,
					conversations: { ...record.conversations, [channelId]: { dir, createdAt: now.toISOString() } },
				};
				await writeJson(recordPath(deskDir), updated);
				return conversationOf(updated, deskDir, channelId, dir);
			}),
		{ timeoutMs: DESK_RECORD_LOCK_TIMEOUT_MS },
	);
}

/** The conversation already registered for `channelId` in `record`, or `undefined`. Pure lookup. */
export function findConversation(record: DeskRecord, deskDir: string, channelId: string): DeskConversation | undefined {
	const entry = record.conversations[channelId];
	return entry ? conversationOf(record, deskDir, channelId, entry.dir) : undefined;
}

function conversationOf(
	record: DeskRecord,
	deskDir: string,
	channelId: string,
	conversation: string,
): DeskConversation {
	return {
		desk: record.name,
		deskDir,
		cwd: record.cwd ?? deskDir,
		channelId,
		conversation,
		conversationDir: getConversationDir(deskDir, conversation),
	};
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await writeFileAtomically(path, `${JSON.stringify(value, null, "\t")}\n`);
}
