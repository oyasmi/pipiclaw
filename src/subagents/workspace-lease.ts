import { realpathSync } from "node:fs";
import { withTrailingSlash } from "../shared/text-utils.js";

/**
 * Process-wide checkout leases for delegations (spec 040 D10.1, extended with shared verify read leases):
 * - `mode: "write"` (default): exclusive — conflicts with any overlapping write OR read lease.
 * - `mode: "read"` (used by `purpose: "verify"` runs with `mutates: "read"`): shared — coexists with
 *   other read leases on overlapping paths while blocking write delegations until verification settles.
 *
 * Global across channels and desks; the main agent's own write/edit/bash calls deliberately do not
 * participate so a parent turn cannot deadlock against a run it dispatched.
 */

export type WorkspaceLeaseMode = "write" | "read";

export interface WorkspaceLeaseHolder {
	runId: string;
	channelId: string;
	workingDirectory: string;
	mode?: WorkspaceLeaseMode;
}

const leases = new Map<string, Map<string, WorkspaceLeaseHolder>>();

function holderMode(holder: WorkspaceLeaseHolder): WorkspaceLeaseMode {
	return holder.mode === "read" ? "read" : "write";
}

function crossesArtifactBoundary(parent: string, child: string): boolean {
	const rel = child.slice(withTrailingSlash(parent).length);
	return rel.startsWith("subagent-artifacts/") || rel.includes("/subagent-artifacts/");
}

function pathsConflict(a: string, b: string): boolean {
	if (a === b) return true;
	const aSlash = withTrailingSlash(a);
	const bSlash = withTrailingSlash(b);
	if (b.startsWith(aSlash)) return !crossesArtifactBoundary(a, b);
	if (a.startsWith(bSlash)) return !crossesArtifactBoundary(b, a);
	return false;
}

/** The stable lease key for a working directory: its realpath, so a symlink or `..` cannot dodge a conflict. */
export function workspaceLeaseKey(workingDirectory: string): string {
	try {
		return realpathSync(workingDirectory);
	} catch {
		return workingDirectory;
	}
}

function findConflict(leaseKey: string, requestedMode: WorkspaceLeaseMode): WorkspaceLeaseHolder | undefined {
	for (const [key, holders] of leases) {
		if (!pathsConflict(key, leaseKey)) continue;
		for (const holder of holders.values()) {
			if (requestedMode === "write" || holderMode(holder) === "write") {
				return holder;
			}
		}
	}
	return undefined;
}

export type AcquireWorkspaceLeaseResult =
	| { ok: true; leaseKey: string }
	| { ok: false; leaseKey: string; heldBy: WorkspaceLeaseHolder };

export function acquireWorkspaceLease(holder: WorkspaceLeaseHolder): AcquireWorkspaceLeaseResult {
	const leaseKey = workspaceLeaseKey(holder.workingDirectory);
	const mode = holderMode(holder);
	const conflict = findConflict(leaseKey, mode);
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
