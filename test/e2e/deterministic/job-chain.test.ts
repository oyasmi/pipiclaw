import { afterEach, describe, expect, it } from "vitest";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";

describe("E2E deterministic: background job chain", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		harness.assertNoUnmatchedRequests();
		await harness.shutdown();
	});

	it("A17: `bash async` runs detached, finishes, and wakes the channel with its output", async () => {
		// Mutation check: set the job wake contract's `notify` to false and the wake turn
		// (route `saw-job` below) never runs.
		harness = await createDeterministicHarness({ services: true });

		harness.model.script.route({
			name: "start-job",
			when: (r) => r.isMainTurn && r.lastUserText.includes("RUN_JOB"),
			respond: [
				reply.toolCall("bash", { command: "echo JOB_OUTPUT_MARKER_7799", async: true }),
				reply.text("已在后台启动作业。"),
			],
			repeat: true,
		});
		harness.model.script.route({
			name: "saw-job",
			when: (r) => r.isMainTurn && r.lastUserText.includes("JOB_OUTPUT_MARKER_7799"),
			respond: [reply.text("作业完成，我看到了输出。")],
			repeat: true,
		});

		await harness.sendUserMessage("RUN_JOB 跑个后台命令");
		await harness.waitForDelivery((d) => (d.text ?? "").includes("作业完成"));

		// The completion wake turn's request carried the job's captured output inline.
		const wakeReq = harness.model.requests.find((r) => r.matchedRoute === "saw-job");
		expect(wakeReq).toBeDefined();
		expect(JSON.stringify(wakeReq!.messages)).toContain("JOB_OUTPUT_MARKER_7799");
	});
});
