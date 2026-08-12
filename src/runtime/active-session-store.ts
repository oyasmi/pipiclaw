import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { writeFileAtomically } from "../shared/atomic-file.js";

/**
 * Points a channel at the one session file it currently considers active. Spec 043, D1.
 *
 * Only the pointer is persisted here — never messages, branches, or project state. A missing ref
 * means "this channel has never run a session-topology operation"; it is interpreted as
 * `context.jsonl` (today's fixed name) rather than written eagerly, so a channel that never calls
 * `/new`/fork/switch never gains an `active-session.json` at all.
 */
export interface ActiveSessionRefV1 {
	version: 1;
	/** Basename only — see `isValidSessionRefBasename`. */
	file: string;
	sessionId: string;
	updatedAt: string;
}

const REF_FILENAME = "active-session.json";
const DEFAULT_SESSION_FILENAME = "context.jsonl";

export function getActiveSessionRefPath(channelDir: string): string {
	return join(channelDir, REF_FILENAME);
}

/**
 * The ref's `file` is opened for append under `channelDir`, and the ref itself lives in a
 * directory a chat participant can otherwise influence the contents of. Reject anything that
 * isn't a plain, single-segment `.jsonl` name so this can never be used to open or create a file
 * outside the channel directory.
 */
export function isValidSessionRefBasename(file: string): boolean {
	return (
		typeof file === "string" &&
		file.length > 0 &&
		file.endsWith(".jsonl") &&
		!file.includes("/") &&
		!file.includes("\\") &&
		!file.includes("\0") &&
		file !== "." &&
		file !== ".."
	);
}

function readActiveSessionRef(channelDir: string): ActiveSessionRefV1 | undefined {
	const refPath = getActiveSessionRefPath(channelDir);
	if (!existsSync(refPath)) {
		return undefined;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(refPath, "utf-8"));
	} catch {
		return undefined;
	}
	if (
		!raw ||
		typeof raw !== "object" ||
		(raw as { version?: unknown }).version !== 1 ||
		typeof (raw as { file?: unknown }).file !== "string" ||
		typeof (raw as { sessionId?: unknown }).sessionId !== "string" ||
		typeof (raw as { updatedAt?: unknown }).updatedAt !== "string"
	) {
		return undefined;
	}
	const ref = raw as ActiveSessionRefV1;
	return isValidSessionRefBasename(ref.file) ? ref : undefined;
}

/**
 * An existing-but-empty file makes the SDK's `SessionManager._setSessionFile()` write the header
 * and flip `flushed = true` synchronously, instead of the deferred-flush path it takes for a file
 * that doesn't exist yet. Materializing this before `SessionManager.open()` closes the delay
 * window described in spec 043 F4/D1.2 without touching SDK internals.
 */
function materializeSessionFile(channelDir: string, file: string): void {
	const target = join(channelDir, file);
	if (!existsSync(target)) {
		closeSync(openSync(target, "a"));
	}
}

/**
 * Resolves which session file a channel should open (runner construction / restart), migrating a
 * channel with no ref to `context.jsonl` and materializing that file. Never writes the ref
 * itself — a missing ref stays missing until a session-topology operation commits one.
 */
export function resolveActiveSessionFile(channelDir: string): string {
	const ref = readActiveSessionRef(channelDir);
	const file = ref?.file ?? DEFAULT_SESSION_FILENAME;
	materializeSessionFile(channelDir, file);
	return file;
}

export interface SessionFileHandle {
	getSessionFile(): string | undefined;
	getSessionId(): string;
}

/**
 * Commits the active-session ref for a session a topology operation (`/new`, fork, switch) has
 * already created/opened. The SDK writes that session's durable header synchronously before
 * invoking the caller's rebuild callback, so by the time this is called the target file already
 * exists on disk; this only records the pointer. Callers must not rebind their live `AgentSession`
 * until this resolves (spec 043, D1.3) — on throw, nothing is written and the old ref (and thus
 * the old session) remains authoritative.
 */
export async function commitActiveSessionRef(channelDir: string, session: SessionFileHandle): Promise<void> {
	const sessionFile = session.getSessionFile();
	if (!sessionFile) {
		throw new Error("Cannot commit active-session ref: session has no backing file (not persisted).");
	}
	const resolvedDir = resolve(channelDir);
	const resolvedFile = resolve(sessionFile);
	if (dirname(resolvedFile) !== resolvedDir) {
		throw new Error(`Session file must live directly under the channel directory: ${sessionFile}`);
	}
	const file = basename(resolvedFile);
	if (!isValidSessionRefBasename(file)) {
		throw new Error(`Invalid session file name for active-session ref: ${file}`);
	}
	const ref: ActiveSessionRefV1 = {
		version: 1,
		file,
		sessionId: session.getSessionId(),
		updatedAt: new Date().toISOString(),
	};
	await writeFileAtomically(getActiveSessionRefPath(channelDir), `${JSON.stringify(ref, null, 2)}\n`);
}
