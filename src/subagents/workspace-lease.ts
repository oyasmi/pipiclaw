import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, normalize, resolve } from "node:path";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { withTrailingSlash } from "../shared/text-utils.js";

/**
 * Process-wide checkout RW leases for delegations (spec 040 D10.1, Direction 1.3):
 * - `mode: "write"` (default): exclusive — conflicts with any overlapping write OR read lease, and
 *   blocks main/task-session `write`/`edit` calls targeting the leased checkout.
 * - `mode: "read"` (`purpose: "verify"` runs with `mutates: "read"`): shared — coexists with other
 *   read leases on overlapping paths while blocking write delegations and main/task `write`/`edit`
 *   calls so files cannot move mid-verification.
 * - `mode: "use"`: ordinary read-only work may overlap writers, but pins its directory against
 *   cleanup. Cleanup excludes all users and holds admission closed across asynchronous Git I/O.
 */

export type WorkspaceLeaseMode = "write" | "read" | "use";

export interface WorkspaceLeaseHolder {
	runId: string;
	channelId: string;
	workingDirectory: string;
	mode?: WorkspaceLeaseMode;
}

const leases = new Map<string, Map<string, WorkspaceLeaseHolder>>();
const cleanups = new Map<string, WorkspaceLeaseHolder>();

const DESK_CONTROL_SUBDIRS = [
	"tasks",
	"subagent-artifacts",
	"memory",
	"journal",
	"events",
	"conversations",
	"inbox",
	"logs",
	".memory-work",
	".locks",
] as const;

const DESK_CONTROL_FILES = ["desk.json", "MEMORY.md"] as const;

function holderMode(holder: WorkspaceLeaseHolder): WorkspaceLeaseMode {
	return holder.mode ?? "write";
}

function crossesIsolatedBoundary(parent: string, child: string): boolean {
	const rel = child.slice(withTrailingSlash(parent).length);
	return (
		rel.startsWith("subagent-artifacts/") ||
		rel.includes("/subagent-artifacts/") ||
		rel.startsWith(".git/pipiclaw-worktrees/") ||
		rel.includes("/.git/pipiclaw-worktrees/") ||
		rel.startsWith("pipiclaw-worktrees/") ||
		rel.includes("/pipiclaw-worktrees/")
	);
}

function pathsConflict(a: string, b: string): boolean {
	if (a === b) return true;
	const aSlash = withTrailingSlash(a);
	const bSlash = withTrailingSlash(b);
	if (b.startsWith(aSlash)) return !crossesIsolatedBoundary(a, b);
	if (a.startsWith(bSlash)) return !crossesIsolatedBoundary(b, a);
	return false;
}

/**
 * Resolve a directory or file path (including not-yet-created files for `write`) through symlinks
 * so an alias or `..` segment cannot bypass an active checkout lease.
 */
export function workspaceLeaseKey(targetPath: string): string {
	const normalized = normalize(targetPath);
	try {
		return realpathSync(normalized);
	} catch {
		const missingSegments: string[] = [];
		let current = normalized;
		while (!existsSync(current)) {
			missingSegments.unshift(basename(current));
			const parent = dirname(current);
			if (parent === current) return normalized;
			current = parent;
		}
		try {
			return resolve(realpathSync(current), ...missingSegments);
		} catch {
			return normalized;
		}
	}
}

function isDeskControlPlanePath(resolvedTarget: string, deskDir: string | undefined): boolean {
	if (!deskDir) return false;
	const canonicalDesk = workspaceLeaseKey(deskDir);
	for (const file of DESK_CONTROL_FILES) {
		if (resolvedTarget === resolve(canonicalDesk, file)) return true;
	}
	for (const sub of DESK_CONTROL_SUBDIRS) {
		const subRoot = resolve(canonicalDesk, sub);
		if (resolvedTarget === subRoot || resolvedTarget.startsWith(withTrailingSlash(subRoot))) {
			return true;
		}
	}
	return false;
}

function findConflict(
	leaseKey: string,
	requestedMode: WorkspaceLeaseMode | "cleanup",
	excludeRunId?: string,
): WorkspaceLeaseHolder | undefined {
	for (const [key, holder] of cleanups) {
		if (pathsConflict(key, leaseKey)) return holder;
	}
	for (const [key, holders] of leases) {
		if (!pathsConflict(key, leaseKey)) continue;
		for (const holder of holders.values()) {
			if (excludeRunId && holder.runId === excludeRunId) continue;
			const mode = holderMode(holder);
			if (
				requestedMode === "cleanup" ||
				(requestedMode !== "use" && mode !== "use" && (requestedMode === "write" || mode === "write"))
			) {
				return holder;
			}
		}
	}
	return undefined;
}

/**
 * Atomically exclude every other directory user, then hold that exclusion across inspection and
 * removal. A finished worker may clean up under its own still-held lease; never release that lease
 * here — settlement remains the run manager's responsibility.
 */
export async function withWorkspaceCleanupLease<T>(
	workingDirectory: string,
	ownerRunId: string | undefined,
	cleanup: () => Promise<T>,
): Promise<T | undefined> {
	const key = workspaceLeaseKey(workingDirectory);
	if (findConflict(key, "cleanup", ownerRunId)) return undefined;
	cleanups.set(key, { runId: `cleanup-${randomUUID()}`, channelId: "runtime", workingDirectory, mode: "write" });
	try {
		return await cleanup();
	} finally {
		cleanups.delete(key);
	}
}

export type AcquireWorkspaceLeaseResult =
	| { ok: true; leaseKey: string }
	| { ok: false; leaseKey: string; heldBy: WorkspaceLeaseHolder };

export function acquireWorkspaceLease(holder: WorkspaceLeaseHolder): AcquireWorkspaceLeaseResult {
	const leaseKey = workspaceLeaseKey(holder.workingDirectory);
	const mode = holderMode(holder);
	const conflict = findConflict(leaseKey, mode, holder.runId);
	if (conflict) {
		return { ok: false, leaseKey, heldBy: conflict };
	}
	let holders = leases.get(leaseKey);
	if (!holders) {
		holders = new Map();
		leases.set(leaseKey, holders);
	}
	holders.set(holder.runId, { ...holder, mode });
	return { ok: true, leaseKey };
}

/**
 * Spec 042 D5: release only the caller's own lease (`runId` must match). Shared read leases remove
 * only their own entry and delete `leaseKey` once the last holder settles.
 */
export function releaseWorkspaceLease(leaseKey: string | undefined, runId: string): void {
	if (!leaseKey) return;
	const holders = leases.get(leaseKey);
	if (!holders) return;
	holders.delete(runId);
	if (holders.size === 0) {
		leases.delete(leaseKey);
	}
}

/** Read-only check for pre-flight gates (`purpose=verify`, D9): returns any overlapping *write* holder. */
export function findWorkspaceLeaseHolder(workingDirectory: string): WorkspaceLeaseHolder | undefined {
	return findConflict(workspaceLeaseKey(workingDirectory), "read");
}

/**
 * Check whether mutating (or reading) `targetPath` conflicts with an active delegation lease,
 * ignoring `excludeRunId` (the worker's own run) and Pipiclaw's desk control-plane files (`tasks/`, etc.).
 */
export function findConflictingWorkspaceLease(
	targetPath: string,
	options?: { mode?: WorkspaceLeaseMode; excludeRunId?: string; deskDir?: string },
): WorkspaceLeaseHolder | undefined {
	const resolved = workspaceLeaseKey(targetPath);
	if (isDeskControlPlanePath(resolved, options?.deskDir)) return undefined;
	return findConflict(resolved, options?.mode ?? "write", options?.excludeRunId);
}

/**
 * Guard for main-session and task-session `write`/`edit` tools (Direction 1.3): rejects mutations
 * to a checkout currently locked by a write delegation or being inspected by a verification read lease.
 */
export function assertPathWritableUnderLease(
	targetPath: string,
	options?: { excludeRunId?: string; deskDir?: string },
): void {
	const heldBy = findConflictingWorkspaceLease(targetPath, { mode: "write", ...options });
	if (!heldBy) return;
	if (holderMode(heldBy) === "read") {
		throw new RecoverableToolError(
			`Cannot modify "${targetPath}" while verification delegation ${heldBy.runId} holds a shared read lease on ` +
				`"${heldBy.workingDirectory}" (channel ${heldBy.channelId}). Wait for verification to finish, cancel it ` +
				"with subagent_run op=cancel, or delegate isolated edits with subagent worktree=true (or a separate `git worktree add` checkout).",
		);
	}
	throw new RecoverableToolError(
		`Cannot modify "${targetPath}" while write delegation ${heldBy.runId} holds an exclusive write lease on ` +
			`"${heldBy.workingDirectory}" (channel ${heldBy.channelId}). Wait for the delegation to finish, cancel it ` +
			"with subagent_run op=cancel, or delegate isolated edits with subagent worktree=true (or a separate `git worktree add` checkout).",
	);
}

export function formatWorkspaceLeaseConflict(heldBy: WorkspaceLeaseHolder): string {
	if (holderMode(heldBy) === "read") {
		return (
			`Workspace "${heldBy.workingDirectory}" is currently held by a running verification delegation ` +
			`(read lease, runId ${heldBy.runId}, channel ${heldBy.channelId}). Wait for verification to finish, ` +
			"cancel it with subagent_run op=cancel, or isolate your write run with worktree=true (or a separate `git worktree add` checkout via workingDirectory)."
		);
	}
	return (
		`Workspace "${heldBy.workingDirectory}" is already held by a running write delegation ` +
		`(runId ${heldBy.runId}, channel ${heldBy.channelId}). Wait for it to finish, cancel it with ` +
		"subagent_run op=cancel, or isolate your write run with worktree=true (or a separate `git worktree add` checkout via workingDirectory)."
	);
}
