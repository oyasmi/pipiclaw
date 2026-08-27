import { realpathSync } from "node:fs";

/**
 * A process-wide, exclusive *write* lease on a checkout (spec 040, D10.1).
 *
 * Only `mutates: write` runs take a lease; read runs never do. The key is the delegation's
 * working directory realpath, and a conflict is a prefix relationship in either direction
 * (`/repo` and `/repo/pkg` are the same resource, not two). This is deliberately the whole
 * mechanism: no read/write distinction, no counting, no upgrade/downgrade. What actually produces
 * a wrong result is two writers touching the same tree at once; a reviewer reading a diff that
 * moves under it is a quality problem, not a correctness one, and is left to `agent-delegation.md`
 * plus the parked-review's own judgement rather than a second locking dimension.
 *
 * Global, not per-channel: two channels pointed at the same checkout must still exclude each
 * other. The main agent's own write/edit/bash calls deliberately do **not** participate — see
 * the design doc D10.1 for why (it would deadlock a run against the very turn that dispatched
 * it, and turns this into a runtime-wide concurrency redesign this spec does not attempt).
 */

export interface WorkspaceLeaseHolder {
	runId: string;
	channelId: string;
	workingDirectory: string;
}

const leases = new Map<string, WorkspaceLeaseHolder>();

function withTrailingSlash(path: string): string {
	return path.endsWith("/") ? path : `${path}/`;
}

function pathsConflict(a: string, b: string): boolean {
	return (
		a === b ||
		withTrailingSlash(a).startsWith(withTrailingSlash(b)) ||
		withTrailingSlash(b).startsWith(withTrailingSlash(a))
	);
}

/** The stable lease key for a working directory: its realpath, so a symlink or `..` cannot dodge a conflict. */
export function workspaceLeaseKey(workingDirectory: string): string {
	try {
		return realpathSync(workingDirectory);
	} catch {
		return workingDirectory;
	}
}

function findConflict(leaseKey: string): WorkspaceLeaseHolder | undefined {
	for (const [key, holder] of leases) {
		if (pathsConflict(key, leaseKey)) return holder;
	}
	return undefined;
}

export type AcquireWorkspaceLeaseResult =
	| { ok: true; leaseKey: string }
	| { ok: false; leaseKey: string; heldBy: WorkspaceLeaseHolder };

export function acquireWorkspaceLease(holder: WorkspaceLeaseHolder): AcquireWorkspaceLeaseResult {
	const leaseKey = workspaceLeaseKey(holder.workingDirectory);
	const conflict = findConflict(leaseKey);
	if (conflict) {
		return { ok: false, leaseKey, heldBy: conflict };
	}
	leases.set(leaseKey, holder);
	return { ok: true, leaseKey };
}

/**
 * Spec 042 D5: release only the caller's own lease. A blind `leases.delete(key)` let a restore
 * whose lease-rebuild failed (a real path — `realpath` can drift under a symlink swap) still
 * `settle()` and delete the *new* holder's lease for the same key, and a caller could otherwise
 * double-release harmlessly-in-appearance but incorrectly-in-general. `runId` must match the
 * current holder for the delete to happen; anything else (already released, held by someone else)
 * is a no-op rather than an assertion failure — callers already treat "did I ever hold it" as
 * something they cannot always know for certain (e.g. a settle() racing a lease rebuild).
 */
export function releaseWorkspaceLease(leaseKey: string | undefined, runId: string): void {
	if (!leaseKey) return;
	const holder = leases.get(leaseKey);
	if (holder && holder.runId === runId) {
		leases.delete(leaseKey);
	}
}

/** Read-only check for a pre-flight gate (e.g. `purpose=verify`, D9) that must not itself take a lease. */
export function findWorkspaceLeaseHolder(workingDirectory: string): WorkspaceLeaseHolder | undefined {
	return findConflict(workspaceLeaseKey(workingDirectory));
}

export function formatWorkspaceLeaseConflict(heldBy: WorkspaceLeaseHolder): string {
	return (
		`Workspace "${heldBy.workingDirectory}" is already held by a running write delegation ` +
		`(runId ${heldBy.runId}, channel ${heldBy.channelId}). Wait for it to finish, cancel it with ` +
		"subagent_run op=cancel, or use a separate `git worktree add` checkout via workingDirectory."
	);
}
