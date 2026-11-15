import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { heldCommand } from "../../support/held-command.js";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";

describe("E2E deterministic: background job chain", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		await harness.shutdown();
	});

	it("A17: `bash async` runs detached in the desk cwd after write/sync-bash, finishes, and wakes the channel with its output", async () => {
		// Spec 067 mutation: remove FileStore.watchDirectory; with the sweep disabled, no completion request arrives.
		// Mutation check: set the job wake contract's `notify` to false and the wake turn
		// (route `saw-job` below) never runs.
		// H0.3 mutation check (2026-11-15): ignore `options.cwd` in DeskJobManager.start (falling back to `this.target.deskDir`),
		// or skip `releaseRunner` in DeskRuntime.cwd + the `existing.conversation.cwd === conversation.cwd` check in bootstrap.ts `getRunner`,
		// and the relative-path `write -> bash -> bash(async: true)` chain fails to produce `FROM_WRITE_FROM_SYNC_BASH` in `customCwd` / wake output (confirmed red).
		harness = await createDeterministicHarness({ services: true, jobSweepIntervalMs: 3_600_000 });

		const customCwd = join(harness.homeDir, "custom-cwd");
		mkdirSync(customCwd, { recursive: true });
		const job = await heldCommand(harness.homeDir, "JOB_OUTPUT_MARKER_7799");
		harness.model.script.route({
			name: "warmup",
			when: (r) => r.isMainTurn && r.lastUserText.includes("WARMUP"),
			respond: [reply.text("已就绪。")],
		});
		harness.model.script.route({
			name: "start-job",
			when: (r) => r.isMainTurn && r.lastUserText.includes("RUN_JOB"),
			respond: [
				reply.toolCall("write", { path: "rel-chain.txt", content: "FROM_WRITE" }),
				reply.toolCall("bash", { command: "printf '_FROM_SYNC_BASH' >> ./rel-chain.txt" }),
				reply.toolCall("bash", { command: `cat ./rel-chain.txt; ${job.command}`, async: true }),
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

		// Warm up the runner + SDK session before changing `/desk cwd` so `getRunner` must invalidate the cached runner.
		await harness.sendUserMessage("WARMUP");
		await harness.waitForIdle();
		await harness.sendUserMessage(`/desk cwd ${customCwd}`);
		await harness.waitForIdle();

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

		expect(readFileSync(join(customCwd, "rel-chain.txt"), "utf8")).toBe("FROM_WRITE_FROM_SYNC_BASH");
		// The completion wake turn's request carried the job's captured output inline.
		const wakeReq = harness.model.requests.find((r) => r.matchedRoute === "saw-job");
		expect(wakeReq).toBeDefined();
		const wakeMessages = JSON.stringify(wakeReq!.messages);
		expect(wakeMessages).toContain("FROM_WRITE_FROM_SYNC_BASH");
		expect(wakeMessages).toContain("JOB_OUTPUT_MARKER_7799");
	});
});
