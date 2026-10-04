import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunHarness, RunMutates, SettleInput } from "../runs.js";
import { resolveVerificationVerdict } from "../verification-outcome.js";
import { changedPathsSummary } from "../workspace-summary.js";
import { classifyExternalOutcome, type ExternalOutcome } from "./harness.js";
import { getExternalHarness } from "./registry.js";

/**
 * Spec 042 D1: the one place an external run's parsed outcome becomes a `SettleInput`, and the
 * one place its verify verdict gets decided. Before this module existed, that logic was written
 * three times — the live post-exit path (`external/run.ts`), and restart reconciliation
 * (`runs.ts`) — and the third copy was the thinnest: it never read `events.jsonl` at all on a
 * cancelled/timed-out run. Making this the only path either caller can take closes that defect.
 */

const STDERR_TAIL_CHARS = 2_000;

export interface BuildExternalSettleInputInput {
	harnessId: RunHarness;
	outcome: ExternalOutcome;
	durationMs: number;
	durationEstimated?: boolean;
	terminationReason?: "timeout" | "cancelled";
	maxWallTimeSec?: number;
}

/**
 * Translate a parsed outcome into the only `SettleInput` this run will get. `terminationReason`
 * overrides `status`/`failureReason` (P1-1: even a CLI that prints a success terminal right before
 * SIGTERM lands does not get credit for finishing) but never touches usage, output text, or
 * session id — those come from whatever the process actually produced, parsed or not.
 */
export function buildExternalSettleInput(input: BuildExternalSettleInputInput): SettleInput {
	const classification = classifyExternalOutcome(input.harnessId, input.outcome);
	const cancelled = input.terminationReason === "cancelled";
	const timedOut = input.terminationReason === "timeout";
	const status: SettleInput["status"] = cancelled ? "cancelled" : timedOut ? "failed" : classification.status;
	const failureReason = cancelled
		? "Cancelled by request."
		: timedOut
			? `Wall time budget exceeded (${input.maxWallTimeSec}s)`
			: classification.failureReason;
	return {
		status,
		failureReason,
		usage: {
			input: input.outcome.usage?.input ?? 0,
			output: input.outcome.usage?.output ?? 0,
			cacheRead: input.outcome.usage?.cacheRead ?? 0,
			cacheWrite: input.outcome.usage?.cacheWrite ?? 0,
			total: input.outcome.usage?.total ?? 0,
			cost: input.outcome.usage?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		usageKnown: input.outcome.usageKnown,
		costKnown: input.outcome.costKnown,
		turns: 0,
		toolCalls: 0,
		durationMs: input.durationMs,
		durationEstimated: input.durationEstimated,
		outputText: input.outcome.finalText,
		sessionId: input.outcome.sessionId,
	};
}

export interface FinalizeExternalRunInput {
	harnessId: RunHarness;
	purpose: "work" | "verify";
	workingDirectory: string;
	artifactDir: string;
	/** `undefined` when the process was killed by a signal, or when this is a restart
	 *  reconciliation that never observed the exit at all. */
	exitCode?: number;
	durationMs: number;
	durationEstimated?: boolean;
	terminationReason?: "timeout" | "cancelled";
	maxWallTimeSec?: number;
	/** P2-2: only a `write` run's completion pays for a `git status` summary — a `read` run cannot
	 *  have changed anything, and this must never become a hidden cost on the common read-only path. */
	mutates?: RunMutates;
}

/**
 * Read this run's artifact files, parse them through its harness, decide its verdict (for a
 * `purpose=verify` run), and hand the result to `settle`. Both the live post-exit path and
 * restart reconciliation call this and only this — there is no second implementation to drift out
 * of sync with the first (spec 042 F1).
 */
export async function finalizeExternalRun(
	input: FinalizeExternalRunInput,
	settle: (settleInput: SettleInput, options: { announce: boolean }) => Promise<void>,
	options: { announce: boolean },
): Promise<void> {
	const harness = getExternalHarness(input.harnessId);
	const eventsPath = join(input.artifactDir, "events.jsonl");
	const stderrPath = join(input.artifactDir, "stderr.log");
	const eventsText = await readFile(eventsPath, "utf-8").catch(() => "");
	const stderrTail = (await readFile(stderrPath, "utf-8").catch(() => "")).slice(-STDERR_TAIL_CHARS);
	const outcome: ExternalOutcome = harness
		? harness.parseOutcome({ eventsText, exitCode: input.exitCode, stderrTail })
		: {
				finalText: "",
				terminalSeen: false,
				protocolStatus: "unparsable",
				usageKnown: false,
				costKnown: false,
				stderrTail,
				errorMessage: `Unknown harness "${input.harnessId}"; cannot judge this run.`,
			};

	let settleInput = buildExternalSettleInput({
		harnessId: input.harnessId,
		outcome,
		durationMs: input.durationMs,
		durationEstimated: input.durationEstimated,
		terminationReason: input.terminationReason,
		maxWallTimeSec: input.maxWallTimeSec,
	});

	// P2-2: only for a run that actually could have changed the working directory, and only once it
	// is known to have finished cleanly — best-effort, never blocks or fails settlement.
	if (input.mutates === "write" && settleInput.status === "completed") {
		const workspaceSummary = await changedPathsSummary(input.workingDirectory).catch(() => undefined);
		if (workspaceSummary) settleInput = { ...settleInput, workspaceSummary };
	}

	if (input.purpose === "verify" && settleInput.status === "completed") {
		// A verifier that did not finish cleanly gets no verdict at all; one that did is judged on
		// what it printed, so `runFailed` is false by construction here.
		const verificationVerdict = resolveVerificationVerdict({ finalText: outcome.finalText, runFailed: false });
		await settle({ ...settleInput, verificationVerdict }, options);
		return;
	}
	await settle(settleInput, options);
}
