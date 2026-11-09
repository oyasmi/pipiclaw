import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deliveryScopeKey } from "../../../src/channel/delivery-scope.js";
import * as runtimeLog from "../../../src/log.js";
import { heldCommand } from "../../support/held-command.js";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";

describe("E2E deterministic: background job chain", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		await harness.shutdown();
		vi.restoreAllMocks();
	});

	it("A17: `bash async` runs detached, finishes, and wakes the channel with its output", async () => {
		// Mutation 2026-11-09: remove the completion-consumption gate -> two SENDs before last.arrived
		// instead of only the independent request's SEND (confirmed red, then restored).
		// Spec 067 mutation: remove FileStore.watchDirectory; with the sweep disabled, no completion request arrives.
		// Mutation check: set the job wake contract's `notify` to false and the wake turn
		// (route `saw-job` below) never runs.
		harness = await createDeterministicHarness({
			services: true,
			jobSweepIntervalMs: 3_600_000,
			subagentSyncGraceMs: 1,
		});

		let settled!: () => void;
		const settlement = new Promise<void>((resolve) => {
			settled = resolve;
		});
		const logInfo = runtimeLog.logInfoEvent;
		vi.spyOn(runtimeLog, "logInfoEvent").mockImplementation((event, message, options) => {
			logInfo(event, message, options);
			if (event === "subagent.settlement.committed") settled();
		});
		const job = await heldCommand(harness.homeDir, "JOB_OUTPUT_MARKER_7799");
		harness.model.script.route({
			name: "start-job",
			when: (r) => r.isMainTurn && r.lastUserText.includes("RUN_JOB"),
			respond: [
				reply.toolCall("bash", { command: job.command, async: true }),
				reply.toolCall("subagent_inline", {
					task: "Produce a result",
					systemPrompt: "SCOPE_SIBLING",
					tools: ["read"],
					mutates: "read",
				}),
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

		harness.model.script.route({
			name: "sibling",
			when: (r) => r.systemPrompt.includes("SCOPE_SIBLING"),
			respond: [reply.text("SIBLING_RESULT")],
		});
		harness.model.script.route({
			name: "last-result",
			when: (r) => r.isMainTurn && r.lastUserText.includes("[SUBAGENT:"),
			respond: [reply.text("全部完成。")],
			repeat: true,
		});
		harness.model.script.route({
			name: "independent",
			when: (r) => r.isMainTurn && r.lastUserText.includes("INDEPENDENT_REQUEST"),
			respond: [reply.text("独立答复。 ")],
		});
		const sibling = harness.model.script.hold({ when: (r) => r.systemPrompt.includes("SCOPE_SIBLING") });
		const last = harness.model.script.hold({ when: (r) => r.isMainTurn && r.lastUserText.includes("[SUBAGENT:") });

		const gate = harness.model.script.hold({
			when: (r) => r.isMainTurn && r.lastUserText.includes("JOB_OUTPUT_MARKER_7799"),
		});
		await harness.sendUserMessage("RUN_JOB 跑个后台命令");
		try {
			await job.arrived;
			await sibling.arrived;
			expect(harness.deliveries.filter((d) => d.method === "sendPlain")).toHaveLength(0);
			// The original runner was released: another human request gets its own owner/final.
			await harness.sendUserMessage("INDEPENDENT_REQUEST");
			expect(harness.deliveries.filter((d) => d.method === "sendPlain")).toHaveLength(1);
			await harness.runtime.jobs.get(harness.desk).list();
			job.release();
			await gate.arrived;
			// Settle the sibling AFTER this wake's inputs were fixed. pending=0 is insufficient.
			sibling.release();
			await settlement;
			gate.release();
			await last.arrived;
			expect(harness.deliveries.filter((d) => d.method === "sendPlain")).toHaveLength(1);
			last.release();
		} finally {
			sibling.release();
			gate.release();
			last.release();
			await job.close();
		}
		await harness.waitForIdle();
		const runs = harness.runtime.runs.get(harness.desk).list();
		const jobs = await harness.runtime.jobs.get(harness.desk).list();
		expect(runs[0]!.scopeRef).toEqual(jobs[0]!.scopeRef);
		const owner = runs[0]!.scopeRef!;
		expect(owner).toMatchObject({
			desk: harness.desk,
			channelId: harness.channelId,
			scopeId: expect.stringMatching(/^request:/),
		});
		const scopesDir = join(harness.homeDir, "state", "delivery-scopes");
		const snapshots = readdirSync(scopesDir).map((name) => JSON.parse(readFileSync(join(scopesDir, name), "utf-8")));
		expect(snapshots).toHaveLength(2);
		expect(snapshots.filter((state) => state.final?.confirmed)).toHaveLength(2);
		expect(snapshots.find((state) => state.owner.scopeId === owner.scopeId).consumed).toHaveLength(2);
		expect(harness.deliveries.filter((d) => d.method === "sendPlain")).toHaveLength(2);
		expect(new Set(harness.deliveries.filter((d) => d.method === "replaceCard").map((d) => d.scopeKey))).toEqual(
			new Set(snapshots.map((state) => `scope:${deliveryScopeKey(state.owner)}`)),
		);

		// The completion wake turn's request carried the job's captured output inline.
		const wakeReq = harness.model.requests.find((r) => r.matchedRoute === "saw-job");
		expect(wakeReq).toBeDefined();
		expect(JSON.stringify(wakeReq!.messages)).toContain("JOB_OUTPUT_MARKER_7799");
	});
});
