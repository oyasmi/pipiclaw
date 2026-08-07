import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleSubagentsCommand } from "../src/runtime/subagent-commands.js";
import { configureSubAgentRuntime, getSubAgentRunManager } from "../src/subagents/runs.js";
import { useTempDirs } from "./helpers/fixtures.js";

/** Spec 040, D6: `/subagents list|show|cancel` — the human control path independent of the model. */

const createTempDir = useTempDirs("pipiclaw-subagent-commands-");

describe("handleSubagentsCommand", () => {
	it("list shows an empty state when no runs exist", async () => {
		configureSubAgentRuntime({});
		const channelId = `dm_cmd_empty_${Date.now()}`;
		const response = await handleSubagentsCommand({ args: "list", channelId });
		expect(response).toContain("No delegation runs");
	});

	it("list shows registered runs and, given a discovery snapshot, a role-directory health tail", async () => {
		configureSubAgentRuntime({});
		const channelId = `dm_cmd_list_${Date.now()}`;
		const manager = getSubAgentRunManager(channelId);
		await manager.register({
			runId: "run-1",
			channelId,
			runtime: "internal",
			agent: "explorer",
			label: "explore",
			source: "predefined",
			tools: ["read"],
			purpose: "work",
			workingDirectory: "/tmp",
			artifactDir: "/tmp/artifacts/run-1",
		});

		const response = await handleSubagentsCommand({
			args: "list",
			channelId,
			discovery: {
				directory: "/workspace/sub-agents",
				warnings: ["some-role.md: bad frontmatter"],
				agents: [
					{
						name: "builder",
						description: "d",
						systemPrompt: "p",
						tools: [],
						maxTurns: 24,
						maxToolCalls: 48,
						maxWallTimeSec: 1800,
						bashTimeoutSec: 120,
						contextMode: "isolated",
						memory: "none",
						paths: [],
						source: "predefined",
						runtime: "external",
						harness: "codex-cli",
						command: "codex exec",
						mutates: "write",
						unavailable: 'executable "codex" was not found on PATH',
					},
				],
			},
		});

		expect(response).toContain("run-1");
		expect(response).toContain("explorer");
		expect(response).toContain("Role directory health");
		expect(response).toContain("builder");
		expect(response).toContain("some-role.md: bad frontmatter");
	});

	it("show returns the full record as JSON, including a stderr tail for an external run", async () => {
		configureSubAgentRuntime({});
		const channelId = `dm_cmd_show_${Date.now()}`;
		const artifactDir = join(createTempDir(), "artifacts", "run-2");
		mkdirSync(artifactDir, { recursive: true });
		writeFileSync(join(artifactDir, "stderr.log"), "warning: something noisy\n", "utf-8");

		const manager = getSubAgentRunManager(channelId);
		await manager.register({
			runId: "run-2",
			channelId,
			runtime: "external",
			harness: "codex-cli",
			agent: "builder",
			label: "build",
			source: "predefined",
			tools: [],
			purpose: "work",
			workingDirectory: "/tmp",
			artifactDir,
		});

		const response = await handleSubagentsCommand({ args: "show run-2", channelId });
		expect(response).toContain('"runId": "run-2"');
		expect(response).toContain("stderr (tail)");
		expect(response).toContain("warning: something noisy");
	});

	it("show reports not found for an unknown runId", async () => {
		configureSubAgentRuntime({});
		const channelId = `dm_cmd_show_missing_${Date.now()}`;
		const response = await handleSubagentsCommand({ args: "show no-such-run", channelId });
		expect(response).toContain("Run not found: no-such-run");
	});

	it("cancel with no live handle reports the run as lost", async () => {
		configureSubAgentRuntime({});
		const channelId = `dm_cmd_cancel_${Date.now()}`;
		const manager = getSubAgentRunManager(channelId);
		await manager.register({
			runId: "run-3",
			channelId,
			runtime: "internal",
			agent: "explorer",
			label: "explore",
			source: "predefined",
			tools: ["read"],
			purpose: "work",
			workingDirectory: "/tmp",
			artifactDir: "/tmp/artifacts/run-3",
		});

		const response = await handleSubagentsCommand({ args: "cancel run-3", channelId });
		expect(response).toContain("lost");
	});

	it("rejects a malformed command with usage text instead of throwing", async () => {
		configureSubAgentRuntime({});
		const channelId = `dm_cmd_bad_${Date.now()}`;
		const response = await handleSubagentsCommand({ args: "frobnicate", channelId });
		expect(response).toContain("Unknown /subagents action");
		expect(response).toContain("Usage");
	});
});
