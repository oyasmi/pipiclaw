import { afterEach, describe, expect, it } from "vitest";
import { heldCommand } from "../../support/held-command.js";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";

describe("E2E deterministic: background job chain", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		await harness.shutdown();
	});

	it("A17: `bash async` runs detached, finishes, and wakes the channel with its output", async () => {
		// Spec 067 mutation: remove FileStore.watchDirectory; with the sweep disabled, no completion request arrives.
		// Mutation check: set the job wake contract's `notify` to false and the wake turn
		// (route `saw-job` below) never runs.
		harness = await createDeterministicHarness({ services: true, jobSweepIntervalMs: 3_600_000 });

		const job = await heldCommand(harness.homeDir, "JOB_OUTPUT_MARKER_7799");
		harness.model.script.route({
			name: "start-job",
			when: (r) => r.isMainTurn && r.lastUserText.includes("RUN_JOB"),
			respond: [reply.toolCall("bash", { command: job.command, async: true }), reply.text("已在后台启动作业。")],
			repeat: true,
		});
		harness.model.script.route({
			name: "saw-job",
			when: (r) => r.isMainTurn && r.lastUserText.includes("JOB_OUTPUT_MARKER_7799"),
			respond: [reply.text("作业完成，我看到了输出。")],
			repeat: true,
		});

		const gate = harness.model.script.hold({
			when: (r) => r.isMainTurn && r.lastUserText.includes("JOB_OUTPUT_MARKER_7799"),
		});
		await harness.sendUserMessage("RUN_JOB 跑个后台命令");
		try {
			await job.arrived;
			await harness.runtime.jobs.get(harness.desk).list();
			job.release();
			await gate.arrived;
		} finally {
			gate.release();
			await job.close();
		}
		await harness.waitForIdle();

		// The completion wake turn's request carried the job's captured output inline.
		const wakeReq = harness.model.requests.find((r) => r.matchedRoute === "saw-job");
		expect(wakeReq).toBeDefined();
		expect(JSON.stringify(wakeReq!.messages)).toContain("JOB_OUTPUT_MARKER_7799");
	});
});
