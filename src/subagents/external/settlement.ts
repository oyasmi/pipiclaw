import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as log from "../../log.js";
import { formatLocalTime } from "../../shared/local-time.js";
import { errorMessage } from "../../shared/text-utils.js";
import { workspaceSubjectHash } from "../../tasks/artifact-subject.js";
import { writeVerificationAttestation } from "../../tasks/verification.js";
import type { RunHarness, SettleInput } from "../runs.js";
import { resolveVerificationOutcome } from "../verification-outcome.js";
import { classifyExternalOutcome, type ExternalOutcome } from "./harness.js";
import { getExternalHarness } from "./registry.js";

/**
 * Spec 042 D1: the one place an external run's parsed outcome becomes a `SettleInput`, and the
 * one place its verify verdict gets decided and attested. Before this module existed, that logic
 * was written three times — the live post-exit path (`external/run.ts`), and restart
 * reconciliation (`runs.ts`) — and the third copy was the thinnest: it never read `events.jsonl`
 * at all on a cancelled/timed-out run, and never attempted a verify attestation, because the
 * inputs it would have needed (`verifySubjectBefore`, `channelDir`) were never persisted. Both
 * defects are closed by making this the only path either caller can take.
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
	runId: string;
	channelId: string;
	/** Needed only for `purpose=verify`: where the attestation gets written. Absent on an older
	 *  record (predating spec 042) — verify processing degrades to "skip" rather than guessing. */
	channelDir?: string;
	harnessId: RunHarness;
	purpose: "work" | "verify";
	taskId?: string;
	workingDirectory: string;
	artifactDir: string;
	/** `undefined` when the process was killed by a signal, or when this is a restart
	 *  reconciliation that never observed the exit at all. */
	exitCode?: number;
	durationMs: number;
	durationEstimated?: boolean;
	terminationReason?: "timeout" | "cancelled";
	maxWallTimeSec?: number;
	/** The workspace subject hash taken just before this run started (D9's before/after pair for
	 *  external verify) — persisted at launch so restart reconciliation has it too. */
	verifySubjectBefore?: string;
}

/**
 * Read this run's artifact files, parse them through its harness, decide its verdict (including a
 * verify attestation when applicable), and hand the result to `settle`. Both the live post-exit
 * path and restart reconciliation call this and only this — there is no second implementation to
 * drift out of sync with the first (spec 042 F1).
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

	const settleInput = buildExternalSettleInput({
		harnessId: input.harnessId,
		outcome,
		durationMs: input.durationMs,
		durationEstimated: input.durationEstimated,
		terminationReason: input.terminationReason,
		maxWallTimeSec: input.maxWallTimeSec,
	});

	const shouldVerify =
		input.purpose === "verify" &&
		input.taskId !== undefined &&
		input.channelDir !== undefined &&
		settleInput.status === "completed";

	if (!shouldVerify) {
		await settle(settleInput, options);
		return;
	}

	// D9: an external verifier's tools cannot be structurally removed, so a before/after subject
	// hash is the only after-the-fact check available. `subjectBefore` came from the launch-time
	// snapshot (persisted so restart reconciliation has it too, spec 042 D1).
	const subjectAfter = await workspaceSubjectHash(input.workingDirectory);
	const verification = resolveVerificationOutcome({
		subjectBefore: input.verifySubjectBefore,
		subjectAfter,
		finalText: outcome.finalText,
		runFailed: false, // shouldVerify already gates on settleInput.status === "completed".
	});
	await writeVerificationAttestation(input.channelDir as string, {
		runId: input.runId,
		taskId: input.taskId as string,
		verdict: verification.verdict,
		checkedAt: formatLocalTime(),
		evidence: verification.evidence,
		workspaceChanged: verification.workspaceChanged,
		subjectHash: verification.workspaceChanged ? undefined : subjectAfter,
		subjectDir: input.workingDirectory,
		// External verifiers cannot have their tools structurally removed the way an internal
		// verifier's are — advisory, not enforced (D9).
		verificationStrength: "advisory",
	}).catch((error) => {
		log.logWarning(`Failed to write verification attestation for run ${input.runId}`, errorMessage(error));
	});

	await settle(
		{ ...settleInput, verificationVerdict: verification.verdict, verificationStrength: "advisory" },
		options,
	);
}
