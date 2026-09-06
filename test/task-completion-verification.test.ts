import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatLocalTime } from "../src/shared/local-time.js";
import { renderTaskDocument } from "../src/tasks/ledger.js";
import { resetTaskLogAppenders } from "../src/tasks/log.js";
import { recordVerificationRound } from "../src/tasks/rounds.js";
import { openCycle, readStoredTask, writeStoredTask } from "../src/tasks/store.js";
import {
	completionVerificationBlockReason,
	verificationAttestationPath,
	writeVerificationAttestation,
} from "../src/tasks/verification.js";

/**
 * The close-time re-check (spec 051, D7 follow-up).
 *
 * Both close entry points used to ask only "did a PASS ever land in this cycle". A PASS is a
 * statement about the contract and the artifact the verifier actually saw, and the loop can edit
 * both afterwards — so the question has to be re-asked at close, against what is on disk then.
 */

let dir: string;
const GOAL = "# T\n\n## Goal\n\n交付 A。\n";

async function taskBody(): Promise<string> {
	const document = await readStoredTask(dir, "T");
	if (!document) throw new Error("task missing");
	return document.body;
}

async function blockReason(cycleId: string | undefined, workingDirectory = dir): Promise<string | undefined> {
	return await completionVerificationBlockReason({
		channelDir: dir,
		taskId: "T",
		taskBody: await taskBody(),
		cycleId,
		findRunWorkingDirectory: () => workingDirectory,
	});
}

/** A verifier's PASS on the contract exactly as it stands right now. */
async function attestPass(runId: string): Promise<void> {
	await writeVerificationAttestation(dir, {
		runId,
		taskId: "T",
		verdict: "pass",
		checkedAt: formatLocalTime(),
		evidence: "ran the suite",
		workspaceChanged: false,
		verificationStrength: "enforced",
	});
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "task-completion-"));
	await mkdir(join(dir, "tasks"), { recursive: true });
	await writeFile(join(dir, "tasks", "T.md"), renderTaskDocument({ state: "open", verify: "required" }, GOAL));
});

afterEach(async () => {
	await resetTaskLogAppenders();
	await rm(dir, { recursive: true, force: true });
});

describe("completionVerificationBlockReason", () => {
	it("accepts a PASS that still binds to the contract on disk", async () => {
		const opened = await openCycle(dir, "T");
		await attestPass("run_v1");
		await recordVerificationRound(
			{ channelDir: dir, taskId: "T", verifyRunId: "run_v1", verdict: "pass", strength: "enforced" },
			4,
		);

		expect(await blockReason(opened?.cycleId)).toBeUndefined();
	});

	it("rejects a PASS whose contract was edited after the verifier signed it", async () => {
		const opened = await openCycle(dir, "T");
		await attestPass("run_v1");
		await recordVerificationRound(
			{ channelDir: dir, taskId: "T", verifyRunId: "run_v1", verdict: "pass", strength: "enforced" },
			4,
		);
		expect(await blockReason(opened?.cycleId)).toBeUndefined();

		// The loop widens the goal after acceptance — the PASS no longer covers what would ship.
		const document = await readStoredTask(dir, "T");
		if (!document) throw new Error("task missing");
		document.body = document.body.replace("交付 A。", "交付 A 和 B。");
		await writeStoredTask(document);

		expect(await blockReason(opened?.cycleId)).toMatch(/task contract changed after verification/);
	});

	it("does not let an earlier PASS override the FAIL that followed it", async () => {
		const opened = await openCycle(dir, "T");
		await attestPass("run_v1");
		await recordVerificationRound(
			{ channelDir: dir, taskId: "T", verifyRunId: "run_v1", verdict: "pass", strength: "enforced" },
			4,
		);
		await recordVerificationRound(
			{
				channelDir: dir,
				taskId: "T",
				verifyRunId: "run_v2",
				verdict: "fail",
				strength: "enforced",
				reason: "regression in the CLI path",
			},
			4,
		);

		expect(await blockReason(opened?.cycleId)).toMatch(/#2.*FAIL.*regression in the CLI path/);
	});

	it("rejects a recorded PASS whose attestation is gone", async () => {
		const opened = await openCycle(dir, "T");
		await attestPass("run_v1");
		await recordVerificationRound(
			{ channelDir: dir, taskId: "T", verifyRunId: "run_v1", verdict: "pass", strength: "enforced" },
			4,
		);
		await rm(verificationAttestationPath(dir, "run_v1"));

		expect(await blockReason(opened?.cycleId)).toMatch(/was not found or is unreadable/);
	});

	it("ignores a PASS recorded against a previous cycle", async () => {
		await openCycle(dir, "T");
		await attestPass("run_v1");
		await recordVerificationRound(
			{ channelDir: dir, taskId: "T", verifyRunId: "run_v1", verdict: "pass", strength: "enforced" },
			4,
		);
		const reopened = await openCycle(dir, "T");

		expect(await blockReason(reopened?.cycleId)).toMatch(/no verification round/);
	});
});
