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

describe("E2E deterministic: external (exec) run", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		harness.assertNoUnmatchedRequests();
		await harness.shutdown();
	});

	function runRecords(): string[] {
		const dir = join(harness.homeDir, "state", "subagent-runs", harness.channelId);
		try {
			return readdirSync(dir).filter((f) => f.endsWith(".json"));
		} catch {
			return [];
		}
	}

	it("A18: an `exec` harness run is detached, persisted, and survives a daemon restart", async () => {
		// Covers the daemon-only recovery path (restoreAllSubAgentRuns) with no claude/codex
		// install. Mutation check: make restoreAllSubAgentRuns a no-op and the record check
		// after restart finds a run stuck in a non-terminal state.
		harness = await createDeterministicHarness({ services: true });
		writeWorkspaceFile(
			harness,
			"sub-agents/echo-runner.md",
			"---\nname: echo-runner\nruntime: external\nharness: exec\nmutates: read\ndescription: e2e exec fixture\ncommand: echo A18_EXTERNAL_RAN\n---\n\nRun the command.\n",
		);

		harness.model.script.route({
			name: "parent",
			when: (r) => r.isMainTurn && r.systemPrompt.includes("## Pipiclaw") && r.lastUserText.includes("RUN_EXEC"),
			respond: [
				reply.toolCall("subagent", { agent: "echo-runner", task: "run the echo command" }),
				reply.text("外部执行已派发。"),
			],
			repeat: true,
		});
		// Post-restart reconciliation can dispatch a completion-wake turn; answer any other turn.
		harness.model.script.route({
			name: "any",
			when: (r) => r.isMainTurn && !r.lastUserText.includes("RUN_EXEC"),
			respond: [reply.text("[SILENT]")],
			repeat: true,
		});

		await harness.sendUserMessage("RUN_EXEC 跑一个外部命令");
		await waitFor("run record on disk", () => runRecords().length > 0, { intervalMs: 50 });

		const dir = join(harness.homeDir, "state", "subagent-runs", harness.channelId);
		const before = JSON.parse(readFileSync(join(dir, runRecords()[0]), "utf-8"));
		expect(before.runtime).toBe("external");

		await harness.restart();
		// restoreAllSubAgentRuns ran on boot; the record is still there and reconciled to terminal.
		const after = JSON.parse(readFileSync(join(dir, runRecords()[0]), "utf-8"));
		expect(after.runId).toBe(before.runId);
		expect(["completed", "failed", "cancelled", "lost"]).toContain(after.status);
	});
});
