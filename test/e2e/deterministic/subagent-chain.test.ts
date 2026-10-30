import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { SUBAGENT_TOOL_NAMES } from "../../../src/tools/contract/names.js";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";

describe("E2E deterministic: internal sub-agent chain", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		await harness.shutdown();
	});

	it("A16: an internal write-delegation settles its run record and releases the workspace lease", async () => {
		// Mutation check: skip settleRun's lease release and the second write delegation
		// below hangs / errors with "workspace held by a running write delegation".
		harness = await createDeterministicHarness({ services: true });

		// Child route first: its request also carries the marker in lastUserText.
		harness.model.script.route({
			name: "child",
			when: (r) => r.systemPrompt.includes("E2E_A16_HELPER"),
			respond: [reply.text("child ok")],
			repeat: true,
		});
		const delegate = (marker: string) => ({
			name: `parent-${marker}`,
			when: (r: { isMainTurn: boolean; lastUserText: string; systemPrompt: string }) =>
				r.isMainTurn && r.systemPrompt.includes("## Pipiclaw") && r.lastUserText.includes(marker),
			respond: [
				reply.toolCall("subagent_inline", {
					task: `Do work for ${marker}.`,
					systemPrompt: `E2E_A16_HELPER for ${marker}.`,
					mutates: "write",
					tools: [...SUBAGENT_TOOL_NAMES],
				}),
				reply.text(`${marker} 子代理已结束。`),
			],
			repeat: true,
		});
		harness.model.script.route(delegate("A16_FIRST"));
		harness.model.script.route(delegate("A16_SECOND"));

		await harness.sendUserMessage("A16_FIRST 派个写子代理");
		expect(harness.deliveries.some((d) => (d.text ?? "").includes("A16_FIRST 子代理已结束"))).toBe(true);
		// A21 shares this exact delegation path: inspect the child's actual provider request,
		// rather than starting a second runtime just to check the same child's capabilities.
		// Exercise the widest supported role, not just the default subset.
		// Mutation check: injecting job at the worker's final SDK tool assignment fails here.
		const child = harness.model.requests.find((request) => request.matchedRoute === "child");
		expect(child?.tools).toContain("read");
		for (const forbidden of ["send_media", "job", "subagent", "subagent_inline"]) {
			expect(child!.tools, `child must not have ${forbidden}`).not.toContain(forbidden);
		}

		// Run record persisted and marked settled.
		const runsDir = join(harness.homeDir, "state", "subagent-runs", harness.desk);
		const records = readdirSync(runsDir).filter((f) => f.endsWith(".json"));
		expect(records.length).toBeGreaterThan(0);
		const record = JSON.parse(readFileSync(join(runsDir, records[0]), "utf-8"));
		expect(record.status).toBe("completed");
		expect(record.settledAt ?? record.finishedAt).toBeDefined();

		// The exclusive workspace write lease was released — a second write delegation runs.
		await harness.sendUserMessage("A16_SECOND 再派一个");
		expect(harness.deliveries.some((d) => (d.text ?? "").includes("A16_SECOND 子代理已结束"))).toBe(true);
		expect(harness.model.requests.filter((r) => r.matchedRoute === "child").length).toBeGreaterThanOrEqual(2);
	});
});
