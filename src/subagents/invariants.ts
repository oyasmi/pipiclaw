import { isTerminal, type RunRecord } from "./run-record.js";
import {
	type ActiveWorkspaceLease,
	workspaceLeaseModesConflict,
	workspaceLeasePathsConflict,
} from "./workspace-lease.js";

interface SubAgentInvariantInput {
	records: Iterable<RunRecord>;
	activeLeases?: readonly ActiveWorkspaceLease[];
	diskRecords?: ReadonlyMap<string, RunRecord>;
}

export interface SubAgentInvariantViolation {
	invariant: "INV-1" | "INV-2" | "INV-3" | "INV-4" | "INV-5" | "INV-6";
	runId: string;
	message: string;
}

const DISK_FIELDS = ["status", "settledAt", "usageRecorded", "wakeEnqueued"] as const;

/** Compare snapshots at a quiescent checkpoint; the checker performs no I/O or mutation. */
export function checkSubAgentInvariants(input: SubAgentInvariantInput): SubAgentInvariantViolation[] {
	const violations: SubAgentInvariantViolation[] = [];
	const statusByRun = new Map<string, RunRecord["status"]>();
	for (const record of input.records) {
		const {
			runId,
			status,
			settledAt,
			finishedAt,
			settlementPending,
			usageRecorded,
			wakeEnqueued,
			failureKind,
			failurePreExecution,
		} = record;
		statusByRun.set(runId, status);
		if (
			isTerminal(status) &&
			(settledAt === undefined || finishedAt === undefined || settlementPending !== undefined)
		) {
			violations.push({ invariant: "INV-1", runId, message: "Terminal run has incomplete settlement." });
		}
		if (status === "running" && settledAt !== undefined) {
			violations.push({ invariant: "INV-2", runId, message: "Running run has a settlement timestamp." });
		}
		if ((usageRecorded === true || wakeEnqueued === true) && settledAt === undefined) {
			violations.push({ invariant: "INV-3", runId, message: "Usage or wake was recorded before settlement." });
		}
		if (
			(failureKind !== undefined && status !== "failed") ||
			(failurePreExecution === true && (status !== "failed" || failureKind === "timeout"))
		) {
			violations.push({
				invariant: "INV-5",
				runId,
				message: "Failure metadata disagrees with run status or timeout.",
			});
		}
		if (input.diskRecords) {
			const disk = input.diskRecords.get(runId);
			const differing = disk && DISK_FIELDS.filter((field) => record[field] !== disk[field]);
			if (!differing || differing.length > 0) {
				violations.push({
					invariant: "INV-6",
					runId,
					message: differing ? `Disk record differs in ${differing.join(", ")}.` : "Disk record is missing.",
				});
			}
		}
	}

	const runningLeases: ActiveWorkspaceLease[] = [];
	for (const lease of input.activeLeases ?? []) {
		const status = statusByRun.get(lease.runId);
		if (status === undefined) continue; // A process-wide snapshot can include other desks.
		if (isTerminal(status)) {
			violations.push({
				invariant: "INV-4",
				runId: lease.runId,
				message: "Terminal run still owns an active lease.",
			});
			continue;
		}
		for (const other of runningLeases) {
			if (
				other.runId !== lease.runId &&
				workspaceLeaseModesConflict(lease.mode, other.mode) &&
				workspaceLeasePathsConflict(lease.leaseKey, other.leaseKey)
			) {
				violations.push({
					invariant: "INV-4",
					runId: lease.runId,
					message: `Active ${lease.mode} lease overlaps ${other.runId}'s ${other.mode} lease.`,
				});
			}
		}
		runningLeases.push(lease);
	}
	return violations;
}

export function assertSubAgentInvariants(input: SubAgentInvariantInput): void {
	const violations = checkSubAgentInvariants(input);
	if (violations.length > 0) {
		throw new Error(
			violations.map(({ invariant, runId, message }) => `${invariant} ${runId}: ${message}`).join("\n"),
		);
	}
}
