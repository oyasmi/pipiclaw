import { describe, expect, it, vi } from "vitest";
import { configureSubAgentRuntime, getSubAgentRunManager } from "../src/subagents/runs.js";
import { acquireWorkspaceLease, releaseWorkspaceLease } from "../src/subagents/workspace-lease.js";
import { createSubAgentManageTool } from "../src/tools/subagent-manage.js";

const { launchExternalRunMock } = vi.hoisted(() => ({
	launchExternalRunMock: vi.fn(async (..._args: unknown[]) => undefined),
}));
vi.mock("../src/subagents/external/run.js", () => ({ launchExternalRun: launchExternalRunMock }));

/** Spec 040, D6: `subagent_manage` — list/cancel/follow_up, the model-facing counterpart to
 *  `/subagents`. `follow_up` on an internal run must reject with a clear, non-misleading reason. */

describe("subagent_manage tool", () => {
	it("lists this channel's runs", async () => {
		configureSubAgentRuntime({});
		const channelId = `dm_manage_list_${Date.now()}`;
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

		const tool = createSubAgentManageTool({ channelId });
		const result = await tool.execute("call-1", { label: "check", op: "list" });
		const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
		expect(text).toContain("run-1");
		expect(text).toContain("explorer");
	});

	it("cancel with no registered handle marks the run lost and reports it", async () => {
		configureSubAgentRuntime({});
		const channelId = `dm_manage_cancel_${Date.now()}`;
		const manager = getSubAgentRunManager(channelId);
		await manager.register({
			runId: "run-2",
			channelId,
			runtime: "internal",
			agent: "explorer",
			label: "explore",
			source: "predefined",
			tools: ["read"],
			purpose: "work",
			workingDirectory: "/tmp",
			artifactDir: "/tmp/artifacts/run-2",
		});

		const tool = createSubAgentManageTool({ channelId });
		const result = await tool.execute("call-2", { label: "stop it", op: "cancel", runId: "run-2" });
		const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
		expect(text).toContain("lost");
		expect(manager.get("run-2")?.status).toBe("lost");
	});

	it("cancel on an unknown runId is a recoverable rejection, not a crash", async () => {
		configureSubAgentRuntime({});
		const channelId = `dm_manage_unknown_${Date.now()}`;
		const tool = createSubAgentManageTool({ channelId });
		await expect(tool.execute("call-3", { label: "stop it", op: "cancel", runId: "no-such-run" })).rejects.toThrow(
			"was not found",
		);
	});

	it("follow_up on an internal run is rejected without suggesting a silent fallback", async () => {
		configureSubAgentRuntime({});
		const channelId = `dm_manage_followup_${Date.now()}`;
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

		const tool = createSubAgentManageTool({ channelId });
		await expect(
			tool.execute("call-4", { label: "continue", op: "follow_up", runId: "run-3", task: "keep going" }),
		).rejects.toThrow("does not support follow_up yet");
	});

	it("follow_up on a still-running codex-cli run is rejected", async () => {
		configureSubAgentRuntime({});
		const channelId = `dm_manage_followup_running_${Date.now()}`;
		const manager = getSubAgentRunManager(channelId);
		await manager.register({
			runId: "run-4",
			channelId,
			runtime: "external",
			harness: "codex-cli",
			agent: "builder",
			label: "build",
			source: "predefined",
			tools: [],
			purpose: "work",
			workingDirectory: "/tmp",
			artifactDir: "/tmp/artifacts/run-4",
		});

		const tool = createSubAgentManageTool({ channelId });
		await expect(
			tool.execute("call-5", { label: "continue", op: "follow_up", runId: "run-4", task: "keep going" }),
		).rejects.toThrow("still running");
	});

	it("follow_up on a finished codex-cli run with no sessionId is rejected", async () => {
		configureSubAgentRuntime({});
		const channelId = `dm_manage_followup_nosession_${Date.now()}`;
		const manager = getSubAgentRunManager(channelId);
		await manager.register({
			runId: "run-5",
			channelId,
			runtime: "external",
			harness: "codex-cli",
			agent: "builder",
			label: "build",
			source: "predefined",
			tools: [],
			purpose: "work",
			workingDirectory: "/tmp",
			artifactDir: "/tmp/artifacts/run-5",
		});
		await manager.settle(
			"run-5",
			{
				status: "failed",
				failureReason: "spawn failed",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				usageKnown: false,
				costKnown: false,
				turns: 0,
				toolCalls: 0,
				durationMs: 0,
				outputText: "",
			},
			{ announce: false },
		);

		const tool = createSubAgentManageTool({ channelId });
		await expect(
			tool.execute("call-6", { label: "continue", op: "follow_up", runId: "run-5", task: "keep going" }),
		).rejects.toThrow("cannot be resumed");
	});

	it("follow_up on a completed codex-cli run with a session id launches a resumed run", async () => {
		configureSubAgentRuntime({});
		launchExternalRunMock.mockClear();
		const channelId = `dm_manage_followup_ok_${Date.now()}`;
		const manager = getSubAgentRunManager(channelId);
		await manager.register({
			runId: "run-6",
			channelId,
			runtime: "external",
			harness: "codex-cli",
			agent: "builder",
			label: "build",
			source: "predefined",
			tools: [],
			purpose: "work",
			workingDirectory: "/tmp/checkout",
			artifactDir: "/tmp/checkout/subagent-artifacts/run-6",
		});
		await manager.settle(
			"run-6",
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
				costKnown: false,
				turns: 0,
				toolCalls: 0,
				durationMs: 0,
				outputText: "Done.",
				sessionId: "thread-abc",
			},
			{ announce: false },
		);

		const tool = createSubAgentManageTool({
			channelId,
			workspaceDir: "/workspace",
			getSubAgentDiscovery: () => ({
				directory: "/workspace/sub-agents",
				warnings: [],
				agents: [
					{
						name: "builder",
						description: "builder role",
						systemPrompt: "You build things.",
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
						mutates: "read",
					},
				],
			}),
		});

		const result = await tool.execute("call-7", {
			label: "continue",
			op: "follow_up",
			runId: "run-6",
			task: "keep going",
		});
		const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
		// spec 041: follow_up mints its own short run id rather than reusing the dispatching tool
		// call's id (which is a long, provider-specific composite on some providers).
		expect(text).toMatch(/runId=run_[a-z0-9]{6}/);
		expect(text).toContain("run-6");
		expect(launchExternalRunMock).toHaveBeenCalledTimes(1);
		expect(launchExternalRunMock.mock.calls[0]?.[0]).toMatchObject({
			runId: expect.stringMatching(/^run_[a-z0-9]{6}$/),
			resumeSessionId: "thread-abc",
			harness: "codex-cli",
			task: "keep going",
			mutates: "read",
			workspaceDir: "/workspace",
		});
	});

	it("releases a follow_up write lease when launch fails before lifecycle ownership transfers", async () => {
		configureSubAgentRuntime({});
		launchExternalRunMock.mockRejectedValueOnce(new Error("prompt write failed"));
		const channelId = `dm_manage_followup_failure_${Date.now()}`;
		const workingDirectory = `/tmp/checkout-followup-${Date.now()}`;
		const manager = getSubAgentRunManager(channelId);
		await manager.register({
			runId: "run-parent",
			channelId,
			runtime: "external",
			harness: "codex-cli",
			agent: "builder",
			label: "build",
			source: "predefined",
			tools: [],
			purpose: "work",
			workingDirectory,
			artifactDir: `${workingDirectory}/subagent-artifacts/run-parent`,
		});
		await manager.settle(
			"run-parent",
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
				costKnown: false,
				turns: 0,
				toolCalls: 0,
				durationMs: 1,
				outputText: "done",
				sessionId: "thread-lease",
			},
			{ announce: false },
		);
		const tool = createSubAgentManageTool({
			channelId,
			workspaceDir: "/workspace",
			getSubAgentDiscovery: () => ({
				directory: "/workspace/sub-agents",
				warnings: [],
				agents: [
					{
						name: "builder",
						description: "builder",
						systemPrompt: "build",
						tools: [],
						maxTurns: 1,
						maxToolCalls: 1,
						maxWallTimeSec: 60,
						bashTimeoutSec: 10,
						contextMode: "isolated",
						memory: "none",
						paths: [],
						source: "predefined",
						runtime: "external",
						harness: "codex-cli",
						command: "codex exec",
						mutates: "write",
					},
				],
			}),
		});

		await expect(
			tool.execute("call-followup-fail", {
				label: "continue",
				op: "follow_up",
				runId: "run-parent",
				task: "continue",
			}),
		).rejects.toThrow("prompt write failed");
		const next = acquireWorkspaceLease({ runId: "next", channelId, workingDirectory });
		expect(next.ok).toBe(true);
		if (next.ok) releaseWorkspaceLease(next.leaseKey);
	});
});
