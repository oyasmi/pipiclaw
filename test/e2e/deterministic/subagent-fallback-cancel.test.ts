import { afterEach, describe, expect, it, vi } from "vitest";
import * as apiKeys from "../../../src/models/api-keys.js";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";

describe("E2E deterministic: cancellation during internal backup-model resolution", () => {
	let harness: DeterministicHarness | undefined;
	afterEach(async () => {
		vi.restoreAllMocks();
		if (harness) {
			await harness.shutdown();
		}
		harness = undefined;
	});

	it.each([1, 2])("sends no backup request after cancelling at backup credential lookup %s", async (lookup) => {
		// Catches a cancelled run reviving via continue() after an async model/key lookup.
		// Lookup 1 is inside resolveFallbackModel; lookup 2 is provider-retry's own key lookup.
		// Mutation check (executed against HEAD 0e9d345): the child request count becomes 2 instead of 1.
		harness = await createDeterministicHarness();
		const current = harness;
		let entered!: () => void;
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const getKey = apiKeys.getApiKeyForModel;
		let backupLookups = 0;
		vi.spyOn(apiKeys, "getApiKeyForModel").mockImplementation(async (registry, model) => {
			if (model.id === "mock-fallback" && ++backupLookups === lookup) {
				entered();
				await gate;
			}
			return getKey(registry, model);
		});
		let parentCalls = 0;
		current.model.script.route({
			name: "parent",
			when: (request) => {
				if (!request.isMainTurn || !request.systemPrompt.includes("## Pipiclaw")) return false;
				if (parentCalls++ === 0) current.model.script.failNext({ status: 400 });
				return true;
			},
			respond: [
				reply.toolCall("subagent_inline", {
					task: "Read and report.",
					systemPrompt: "E2E_CANCEL_FALLBACK_CHILD",
					tools: ["read"],
				}),
				reply.text("[SILENT]"),
			],
		});
		// Accept a wrongly revived child request so the failure is the side-effect assertion.
		current.model.script.route({
			name: "child",
			when: (request) => request.systemPrompt.includes("E2E_CANCEL_FALLBACK_CHILD"),
			respond: [reply.text("child completed")],
			repeat: true,
		});
		await current.sendUserMessageNoWait("E2E_CANCEL_FALLBACK 派一个读取助手");
		await waiting;
		const manager = current.runtime.runs.get(current.desk);
		const run = manager.list().find((record) => record.status === "running")!;
		expect(run).toBeDefined();
		await manager.cancel(run.runId);
		release();
		await current.waitForIdle();
		expect(
			current.model.requests.filter((request) => request.systemPrompt.includes("E2E_CANCEL_FALLBACK_CHILD")),
		).toHaveLength(1);
		expect(current.model.requests.filter((request) => request.model === "mock-fallback")).toHaveLength(0);
		expect(manager.get(run.runId)?.status).toBe("cancelled");
		expect(manager.get(run.runId)?.model).toBe("e2e-mock/mock-main");
		expect(backupLookups).toBe(lookup);
	});
});
