/**
 * Cross-process advisory lock on one file path (spec 058, D6). Two processes — the daemon and a
 * TUI — may write the same dot; an in-process serial queue cannot see the other one, so the
 * writers of shared files additionally hold one of these.
 *
 * A lock is a file holding `{ pid, hostname, acquiredAt, token }`. It is created exclusively: the
 * content is written to a private temp file first and then `link`ed into place, which fails with
 * `EEXIST` when someone else holds it — so a lock file never exists half-written. A lock whose
 * holder ran on this host and whose pid is gone is stale and is reclaimed — one reclaimer at a time,
 * see {@link reclaimStale}; a holder on another host is never presumed dead, and neither is a
 * reclaimer. Release removes the file only while it still carries this acquisition's token.
 *
 * Domain-free on purpose (layer 0): memory, tasks and the dot registry each pick their own path
 * and timeout.
 */
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import { dirname } from "node:path";

export interface FileLockHolder {
	pid: number;
	hostname: string;
	acquiredAt: string;
}

interface LockContent extends FileLockHolder {
	token: string;
}

export interface FileLockHandle {
	release(): Promise<void>;
}

export type AcquireFileLockResult =
	| { kind: "acquired"; handle: FileLockHandle }
	| { kind: "held"; heldBy: FileLockHolder | undefined };

export interface WithFileLockOptions {
	/** How long to keep retrying a held lock before giving up with {@link FileLockTimeoutError}. */
	timeoutMs: number;
}

export class FileLockTimeoutError extends Error {
	readonly lockPath: string;
	readonly heldBy: FileLockHolder | undefined;

	// Plain fields, not parameter properties: the lock tests load this file into a child
	// process with Node's type stripping, which does not support them.
	constructor(lockPath: string, heldBy: FileLockHolder | undefined, reclaimGuard?: string) {
		super(
			(heldBy
				? `Lock ${lockPath} is held by pid ${heldBy.pid} on ${heldBy.hostname} since ${heldBy.acquiredAt}`
				: `Lock ${lockPath} is held by another process`) +
				(reclaimGuard
					? `; its reclaim guard ${reclaimGuard} is present — if no Pipiclaw process is still running, delete that file`
					: ""),
		);
		this.name = "FileLockTimeoutError";
		this.lockPath = lockPath;
		this.heldBy = heldBy;
	}
}

const FIRST_RETRY_MS = 20;
const MAX_RETRY_MS = 250;

function errorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

function parseContent(text: string): LockContent | undefined {
	try {
		const value = JSON.parse(text) as Partial<LockContent>;
		if (
			typeof value.pid === "number" &&
			typeof value.hostname === "string" &&
			typeof value.acquiredAt === "string" &&
			typeof value.token === "string"
		) {
			return value as LockContent;
		}
	} catch {}
	return undefined;
}

async function readContent(path: string): Promise<LockContent | undefined> {
	try {
		return parseContent(await readFile(path, "utf-8"));
	} catch {
		return undefined;
	}
}

function toHolder(content: LockContent | undefined): FileLockHolder | undefined {
	return content ? { pid: content.pid, hostname: content.hostname, acquiredAt: content.acquiredAt } : undefined;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the pid exists but belongs to someone else — still alive.
		return errorCode(error) !== "ESRCH";
	}
}

function isStale(content: LockContent): boolean {
	return content.hostname === osHostname() && !isProcessAlive(content.pid);
}

/** One exclusive-create attempt. `undefined` = acquired; otherwise the current holder's content. */
async function tryCreate(path: string, content: LockContent): Promise<{ held: LockContent | undefined } | undefined> {
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.${content.token}.tmp`;
	await writeFile(temp, JSON.stringify(content), { encoding: "utf-8", flag: "wx" });
	try {
		await link(temp, path);
		return undefined;
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw error;
		return { held: await readContent(path) };
	} finally {
		await unlink(temp).catch(() => undefined);
	}
}

/**
 * Remove a stale lock. Reclaimers take turns through an exclusive `<path>.reclaim` guard, and
 * under it the lock is unlinked only if it still carries the stale token judged dead: while that
 * file exists nobody can create a new lock, its dead holder cannot release it, and every other
 * reclaimer is waiting on the guard — so the unlink can only ever remove the dead lock. (Moving
 * the lock aside instead left the path empty for a moment, and a third process could take it
 * while the mover was still putting back a live lock it had grabbed by mistake.) Returns false
 * when another reclaimer holds the guard; the caller treats the lock as still held.
 *
 * The guard is never taken away from its holder, however old: a reclaimer that is merely paused
 * past the stale check would wake up and unlink whatever lock sits at the path by then — a live
 * one. A guard left by a reclaimer killed inside this function therefore blocks the lock until it
 * is deleted by hand; {@link FileLockTimeoutError} names it.
 */
async function reclaimStale(path: string, stale: LockContent): Promise<boolean> {
	const guard = reclaimGuardPath(path);
	try {
		await writeFile(guard, "", { flag: "wx" });
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw error;
		return false;
	}
	try {
		if ((await readContent(path))?.token === stale.token) await unlink(path).catch(() => undefined);
		return true;
	} finally {
		await unlink(guard).catch(() => undefined);
	}
}

function reclaimGuardPath(path: string): string {
	return `${path}.reclaim`;
}

async function attempt(path: string): Promise<AcquireFileLockResult> {
	for (;;) {
		const content: LockContent = {
			pid: process.pid,
			hostname: osHostname(),
			acquiredAt: new Date().toISOString(),
			token: randomUUID(),
		};
		const result = await tryCreate(path, content);
		if (!result) return { kind: "acquired", handle: createHandle(path, content.token) };
		if (result.held && isStale(result.held) && (await reclaimStale(path, result.held))) continue;
		return { kind: "held", heldBy: toHolder(result.held) };
	}
}

function createHandle(path: string, token: string): FileLockHandle {
	let released = false;
	return {
		async release(): Promise<void> {
			if (released) return;
			released = true;
			const current = await readContent(path);
			if (current?.token === token && current.pid === process.pid) {
				await unlink(path).catch(() => undefined);
			}
		},
	};
}

/**
 * Take the lock once, without waiting: the long-lived form (a TUI holding its conversation for
 * the whole session). A stale lock is reclaimed first; a live holder is reported.
 */
export function acquireFileLock(path: string): Promise<AcquireFileLockResult> {
	return attempt(path);
}

/**
 * Run `fn` while holding the lock, retrying with backoff until `timeoutMs` elapses. Not
 * re-entrant: a nested call on the same path from the same process waits for itself — callers
 * that can nest (task mutations) track re-entry themselves.
 */
export async function withFileLock<T>(path: string, fn: () => Promise<T>, options: WithFileLockOptions): Promise<T> {
	const deadline = Date.now() + options.timeoutMs;
	let delay = FIRST_RETRY_MS;
	for (;;) {
		const result = await attempt(path);
		if (result.kind === "acquired") {
			try {
				return await fn();
			} finally {
				await result.handle.release();
			}
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			const guard = reclaimGuardPath(path);
			const guarded = await stat(guard).then(
				() => true,
				() => false,
			);
			throw new FileLockTimeoutError(path, result.heldBy, guarded ? guard : undefined);
		}
		await new Promise((resolve) => setTimeout(resolve, Math.min(delay, remaining)));
		delay = Math.min(delay * 2, MAX_RETRY_MS);
	}
}
