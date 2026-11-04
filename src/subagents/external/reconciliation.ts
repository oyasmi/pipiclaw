import { stat } from "node:fs/promises";
import { join } from "node:path";
import * as log from "../../log.js";
import {
	isProcessAlive,
	isProcessGroupAlive,
	processGroupQuiescent,
	readProcessStartTime,
	reapProcessGroup,
} from "../../shared/host-process.js";
import type { RunRecord, SettleInput } from "../run-record.js";
import { finalizeExternalRun } from "./settlement.js";

type Settle = (runId: string, input: SettleInput, options: { announce: boolean }) => Promise<void>;

export async function processIdentity(record: RunRecord): Promise<"same" | "different" | "unknown"> {
	if (!record.pid || !record.pidStartedAt) return "unknown";
	const current = await readProcessStartTime(record.pid);
	return !current ? "unknown" : current === record.pidStartedAt ? "same" : "different";
}

export async function reconcileExternalRun(record: RunRecord, settle: Settle, active: () => boolean): Promise<void> {
	if (!record.pid) {
		await settle(
			record.runId,
			{
				status: "lost",
				failureReason: "No pid was ever recorded for this run; it cannot be proven to have started.",
				usage: record.usage,
				usageKnown: record.usageKnown,
				costKnown: record.costKnown,
				turns: record.turns ?? 0,
				toolCalls: record.toolCalls ?? 0,
				durationMs: Date.now() - record.startedAt,
				durationEstimated: true,
				outputText: "",
			},
			{ announce: true },
		);
		return;
	}
	if (isProcessAlive(record.pid) && (await processIdentity(record)) !== "different") {
		return; // Still genuinely running; nothing to reconcile yet.
	}
	if (!active()) return;
	log.logInfoEvent("subagent.process.observed", "External process completion observed", {
		fields: { runId: record.runId, taskId: record.taskId, observer: "adopted", deskDir: record.deskDir },
	});
	// A dead leader can leave writing descendants. Reap its group before releasing the lease.
	// A reused leader is never signalled, including via its (possibly reused) group id.
	if (!isProcessAlive(record.pid)) {
		await reapProcessGroup(record.pid);
		if (!(await processGroupQuiescent(record.pid))) {
			log.logWarn("subagent.recovery.group_unconfirmed", "Adopted process cleanup failed", {
				fields: { runId: record.runId, pid: record.pid },
				reason: "Process group quiescence could not be confirmed",
			});
			return;
		}
	} else if (isProcessGroupAlive(record.pid)) {
		log.logWarn("subagent.recovery.group_unconfirmed", "Adopted process cleanup failed", {
			fields: { runId: record.runId, pid: record.pid },
			reason: "PID was reused and process group ownership cannot be confirmed",
		});
		return;
	}
	if (!active()) return;

	if (!record.harness) {
		// Defensive only: external runs always get a harness at register() time (spec 040 D1).
		await settle(
			record.runId,
			{
				status: "failed",
				failureReason: "Run has no recorded harness; cannot judge it.",
				usage: record.usage,
				usageKnown: record.usageKnown,
				costKnown: record.costKnown,
				turns: record.turns ?? 0,
				toolCalls: record.toolCalls ?? 0,
				durationMs: Date.now() - record.startedAt,
				durationEstimated: true,
				outputText: "",
			},
			{ announce: true },
		);
		return;
	}

	// Duration can only be estimated post-restart: the artifact file's own mtime is the closest
	// proxy for "when the process last wrote something" (D1); wall clock from the last known
	// process start is the fallback when the file is missing (e.g. already GC'd).
	const processStartedAt = record.processStartedAt ?? record.startedAt;
	let durationMs = Date.now() - processStartedAt;
	try {
		const eventsStat = await stat(join(record.artifactDir, "events.jsonl"));
		durationMs = eventsStat.mtimeMs - processStartedAt;
	} catch {
		// No events file (or already GC'd) — fall back to the wall-clock estimate above.
	}

	const maxWallTimeSec =
		record.maxWallTimeSec ??
		(record.deadlineAt ? Math.round((record.deadlineAt - record.startedAt) / 1000) : undefined);

	if (!active()) return;
	log.logEvent("debug", "subagent.finalizer.started", "External run finalizer started", {
		fields: { runId: record.runId, taskId: record.taskId, observer: "adopted", deskDir: record.deskDir },
	});
	await finalizeExternalRun(
		{
			harnessId: record.harness,
			purpose: record.purpose,
			workingDirectory: record.workingDirectory,
			artifactDir: record.artifactDir,
			exitCode: undefined,
			durationMs: Math.max(0, durationMs),
			durationEstimated: true,
			terminationReason: record.terminationReason,
			maxWallTimeSec,
			mutates: record.mutates,
			workspaceBaseline: record.workspaceBaseline,
		},
		(settleInput, options) => (active() ? settle(record.runId, settleInput, options) : Promise.resolve()),
		{ announce: record.terminationReason !== "cancelled" },
	);
}
