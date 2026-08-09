import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleSubagentsCommand } from "../src/runtime/subagent-commands.js";
import { configureSubAgentRuntime, getSubAgentRunManager } from "../src/subagents/runs.js";
import { useTempDirs } from "./helpers/fixtures.js";

/**
 * Spec 040 D6 / spec 041: `/subagents` — the human control path that does not depend on the
 * model. Short `run_` ids, richer list/show output, `output`, `cancel all`, and `roles` are all
 * spec 041 additions on top of the original `list|show|cancel`.
 */

const createTempDir = useTempDirs("pipiclaw-subagent-commands-");

const builderRole = {
	name: "builder",
	description: "d",
	systemPrompt: "p",
	tools: [],
	maxTurns: 24,
	maxToolCalls: 48,
	maxWallTimeSec: 1800,
	bashTimeoutSec: 120,
	contextMode: "isolated" as const,
	memory: "none" as const,
	paths: [],
	source: "predefined" as const,
	runtime: "external" as const,
	harness: "codex-cli" as const,
	command: "codex exec",
	mutates: "write" as const,
	unavailable: 'executable "codex" was not found on PATH',
};

describe("handleSubagentsCommand", () => {
	it("shows an empty state when no runs exist", async () => {
		configureSubAgentRuntime({});
		const channelId = `dm_cmd_empty_${Date.now()}`;
		const response = await handleSubagentsCommand({ args: "list", channelId });
		expect(response).toContain("没有委派记录");
	});

	it("no-args, bare 'list', and the discovery-augmented overview all render consistently", async () => {
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

		const bare = await handleSubagentsCommand({ args: "", channelId });
		const list = await handleSubagentsCommand({ args: "list", channelId });
		for (const response of [bare, list]) {
			expect(response).toContain("运行中");
			expect(response).toContain("run-1");
			expect(response).toContain("explorer");
			expect(response).toContain("explore");
		}

		const withDiscovery = await handleSubagentsCommand({
			args: "list",
			channelId,
			discovery: {
				directory: "/workspace/sub-agents",
				warnings: ["some-role.md: bad frontmatter"],
				agents: [builderRole],
			},
		});
		expect(withDiscovery).toContain("run-1");
		expect(withDiscovery).toContain("explorer");
		expect(withDiscovery).toContain("角色目录");
		expect(withDiscovery).toContain("个不可用");
		expect(withDiscovery).toContain("some-role.md: bad frontmatter");
	});

	it("list running/failed/all filter without the roles tail", async () => {
		configureSubAgentRuntime({});
		const channelId = `dm_cmd_filter_${Date.now()}`;
		const manager = getSubAgentRunManager(channelId);
		await manager.register({
			runId: "run-running",
			channelId,
			runtime: "internal",
			agent: "explorer",
			label: "explore",
			source: "predefined",
			tools: ["read"],
			purpose: "work",
			workingDirectory: "/tmp",
			artifactDir: "/tmp/artifacts/run-running",
		});

		const running = await handleSubagentsCommand({ args: "list running", channelId });
		expect(running).toContain("run-running");
		expect(running).not.toContain("角色目录");

		const failed = await handleSubagentsCommand({ args: "list failed", channelId });
		expect(failed).toContain("没有失败的 run");

		const all = await handleSubagentsCommand({ args: "list all", channelId });
		expect(all).toContain("run-running");
	});

	it("show returns a structured record, including a stderr tail for an external run", async () => {
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
		expect(response).toContain("run-2");
		expect(response).toContain("builder");
		expect(response).toContain("stderr (tail)");
		expect(response).toContain("warning: something noisy");
	});

	it("show reports not found for an unknown runId", async () => {
		configureSubAgentRuntime({});
		const channelId = `dm_cmd_show_missing_${Date.now()}`;
		const response = await handleSubagentsCommand({ args: "show no-such-run", channelId });
		expect(response).toContain("未找到 run");
		expect(response).toContain("no-such-run");
	});

	it("output returns output.md's tail, or a clear message when there is none", async () => {
		configureSubAgentRuntime({});
		const channelId = `dm_cmd_output_${Date.now()}`;
		const artifactDir = join(createTempDir(), "artifacts", "run-out");
		mkdirSync(artifactDir, { recursive: true });
		writeFileSync(join(artifactDir, "output.md"), "the delegation's final answer", "utf-8");

		const manager = getSubAgentRunManager(channelId);
		await manager.register({
			runId: "run-out",
			channelId,
			runtime: "internal",
			agent: "explorer",
			label: "explore",
			source: "predefined",
			tools: ["read"],
			purpose: "work",
			workingDirectory: "/tmp",
			artifactDir,
		});

		const withOutput = await handleSubagentsCommand({ args: "output run-out", channelId });
		expect(withOutput).toContain("the delegation's final answer");

		const emptyArtifactDir = join(createTempDir(), "artifacts", "run-empty");
		mkdirSync(emptyArtifactDir, { recursive: true });
		await manager.register({
			runId: "run-empty",
			channelId,
			runtime: "internal",
			agent: "explorer",
			label: "explore",
			source: "predefined",
			tools: ["read"],
			purpose: "work",
			workingDirectory: "/tmp",
			artifactDir: emptyArtifactDir,
		});
		const stillRunning = await handleSubagentsCommand({ args: "output run-empty", channelId });
		expect(stillRunning).toContain("仍在运行");

		await manager.settle(
			"run-empty",
			{
				status: "completed",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				usageKnown: true,
				costKnown: true,
				turns: 0,
				toolCalls: 0,
				durationMs: 0,
				outputText: "",
			},
			{ announce: false },
		);
		const withoutOutput = await handleSubagentsCommand({ args: "output run-empty", channelId });
		expect(withoutOutput).toContain("没有文本产出");
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

	it("cancel all terminates every running run on the channel", async () => {
		configureSubAgentRuntime({});
		const channelId = `dm_cmd_cancel_all_${Date.now()}`;
		const manager = getSubAgentRunManager(channelId);
		await manager.register({
			runId: "run-4a",
			channelId,
			runtime: "internal",
			agent: "explorer",
			label: "explore a",
			source: "predefined",
			tools: ["read"],
			purpose: "work",
			workingDirectory: "/tmp",
			artifactDir: "/tmp/artifacts/run-4a",
		});
		await manager.register({
			runId: "run-4b",
			channelId,
			runtime: "internal",
			agent: "explorer",
			label: "explore b",
			source: "predefined",
			tools: ["read"],
			purpose: "work",
			workingDirectory: "/tmp",
			artifactDir: "/tmp/artifacts/run-4b",
		});

		const response = await handleSubagentsCommand({ args: "cancel all", channelId });
		expect(response).toContain("run-4a");
		expect(response).toContain("run-4b");
	});

	it("roles lists the role directory, grouped by runtime, from the live discovery snapshot", async () => {
		configureSubAgentRuntime({});
		const channelId = `dm_cmd_roles_${Date.now()}`;
		const response = await handleSubagentsCommand({
			args: "roles",
			channelId,
			discovery: { directory: "/workspace/sub-agents", warnings: [], agents: [builderRole] },
		});
		expect(response).toContain("外部");
		expect(response).toContain("builder");
		expect(response).toContain("不可用");
	});

	it("roles <name> shows a single role's detail, including its system prompt", async () => {
		configureSubAgentRuntime({});
		const channelId = `dm_cmd_role_detail_${Date.now()}`;
		const response = await handleSubagentsCommand({
			args: "roles builder",
			channelId,
			discovery: { directory: "/workspace/sub-agents", warnings: [], agents: [builderRole] },
		});
		expect(response).toContain("codex exec");
		expect(response).toContain("system prompt");
	});

	it("roles falls back to a detached discovery loader when no runner is active", async () => {
		configureSubAgentRuntime({});
		const channelId = `dm_cmd_roles_detached_${Date.now()}`;
		const response = await handleSubagentsCommand({
			args: "roles",
			channelId,
			getDetachedDiscovery: async () => ({
				directory: "/workspace/sub-agents",
				warnings: [],
				agents: [builderRole],
			}),
		});
		expect(response).toContain("builder");
	});

	it("roles reports unavailability plainly when no discovery source is given", async () => {
		configureSubAgentRuntime({});
		const channelId = `dm_cmd_roles_unavailable_${Date.now()}`;
		const response = await handleSubagentsCommand({ args: "roles", channelId });
		expect(response).toContain("不可用");
	});

	it("rejects a malformed command with usage text instead of throwing", async () => {
		configureSubAgentRuntime({});
		const channelId = `dm_cmd_bad_${Date.now()}`;
		const response = await handleSubagentsCommand({ args: "frobnicate", channelId });
		expect(response).toContain("未知的 /subagents 子命令");
		expect(response).toContain("用法");
	});
});
