import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createDeterministicHarness,
	type DeterministicHarness,
	reply,
	writeWorkspaceFile,
} from "../../support/runtime-harness.js";
import { waitFor } from "../helpers/wait.js";

describe("E2E deterministic: completion-wake coalescing", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		harness.assertNoUnmatchedRequests();
		await harness.shutdown();
	});

	it("A23: chat-level runs that settle while the channel is busy are handled in one wake turn", async () => {
		// Catches: each completion wake costing its own full main-agent turn (K fan-out runs → K
		// turns, and past the event-queue cap a 30s+ retry each). Mutation check (run: goes red): make
		// `absorbPending` return [] and this sees three wake turns instead of one.
		harness = await createDeterministicHarness({ services: true });
		writeWorkspaceFile(
			harness,
			"sub-agents/echo-runner.md",
			"---\nname: echo-runner\nruntime: external\nharness: exec\nmutates: read\ndescription: e2e exec fixture\ncommand: echo A23_DONE\n---\n\nRun the command.\n",
		);

		const fanOut = {
			steps: ["one", "two", "three"].map((which) => ({
				toolCall: { name: "subagent", args: { agent: "echo-runner", task: `run ${which}` } },
			})),
		};
		harness.model.script.route({
			name: "parent",
			when: (r) => r.isMainTurn && r.lastUserText.includes("A23_FANOUT"),
			respond: [fanOut, reply.text("三路已派发。")],
		});
		harness.model.script.route({
			name: "wake",
			when: (r) => r.isMainTurn && r.lastUserText.includes("[SUBAGENT:"),
			respond: [reply.text("[SILENT]")],
			repeat: true,
		});
		// Keep the dispatching turn open (its post-tool-call request) until every run has settled and
		// its wake is waiting behind this turn.
		const gate = harness.model.script.hold({
			when: (r) =>
				r.isMainTurn && r.lastUserText.includes("A23_FANOUT") && r.messages.some((m) => m.role === "tool"),
		});

		const runsDir = join(harness.homeDir, "state", "subagent-runs", harness.channelId);
		const settledRuns = (): Array<{ runId: string }> => {
			let names: string[];
			try {
				names = readdirSync(runsDir).filter((name) => name.endsWith(".json"));
			} catch {
				return []; // no run registered yet
			}
			return names
				.map((name) => JSON.parse(readFileSync(join(runsDir, name), "utf-8")))
				.filter((record) => record.status !== "running" && record.wakeEnqueued);
		};

		await harness.sendUserMessageNoWait("A23_FANOUT 并行跑三个");
		await waitFor("three settled runs with wakes enqueued", () => settledRuns().length === 3, { intervalMs: 50 });
		gate.release();
		await harness.waitForIdle();

		const wakeTurns = harness.mainTurnRequests().filter((r) => r.matchedRoute === "wake");
		expect(wakeTurns).toHaveLength(1);
		for (const record of settledRuns()) {
			expect(wakeTurns[0]?.lastUserText).toContain(`[SUBAGENT:${record.runId}]`);
		}
		// Every merged wake was finalized: nothing is left in the outbox to redeliver later.
		const dispatchDir = join(harness.homeDir, "state", "dispatch");
		const leftovers = (() => {
			try {
				return readdirSync(dispatchDir).filter((name) => name.startsWith("subagent"));
			} catch {
				return [];
			}
		})();
		expect(leftovers).toEqual([]);
	});
});
