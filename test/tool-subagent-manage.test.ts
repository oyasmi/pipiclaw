import { describe, expect, it, vi } from "vitest";
import { externalRoleFingerprint } from "../src/subagents/discovery.js";
import { configureSubAgentRuntime, getSubAgentRunManager } from "../src/subagents/runs.js";
import { acquireWorkspaceLease, releaseWorkspaceLease } from "../src/subagents/workspace-lease.js";
import { createSubAgentManageTool } from "../src/tools/subagent-manage.js";

const { launchExternalRunMock } = vi.hoisted(() => ({
	launchExternalRunMock: vi.fn(async (..._args: unknown[]) => ({ ok: true }) as const),
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

		const tool = createSubAgentManageTool({ channelId, workspaceDir: "/tmp", channelDir: "/tmp/channel" });
		const result = await tool.execute("call-1", { label: "check", op: "list" });
		const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
		expect(text).toContain("run-1");
		expect(text).toContain("explorer");
	});

	// Spec 042, D9: op=list used to return every run on the channel unbounded, in both the text and
	// `details.runs`. Running runs are always shown in full; only the terminal tail is capped.
	it("caps a long history with a truncation note, without dropping running runs", async () => {
		configureSubAgentRuntime({});
		const channelId = `dm_manage_cap_${Date.now()}`;
		const manager = getSubAgentRunManager(channelId);
		for (let i = 0; i < 55; i++) {
			const runId = `run-terminal-${i}`;
			await manager.register({
				runId,
				channelId,
				runtime: "internal",
				agent: "explorer",
				label: "explore",
				source: "predefined",
				tools: ["read"],
				purpose: "work",
				workingDirectory: "/tmp",
				artifactDir: `/tmp/artifacts/${runId}`,
			});
			await manager.settle(
				runId,
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
		}
		await manager.register({
			runId: "run-still-going",
			channelId,
			runtime: "internal",
			agent: "explorer",
			label: "explore",
			source: "predefined",
			tools: ["read"],
			purpose: "work",
			workingDirectory: "/tmp",
			artifactDir: "/tmp/artifacts/run-still-going",
		});

		const tool = createSubAgentManageTool({ channelId, workspaceDir: "/tmp", channelDir: "/tmp/channel" });
		const result = await tool.execute("call-cap", { label: "check", op: "list" });
		const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
		const details = result.details as { runs: Array<{ runId: string }> };
		expect(text).toContain("run-still-going");
		expect(text).toContain("showing 50 of 56 runs");
		expect(details.runs).toHaveLength(50);
		expect(details.runs.some((run) => run.runId === "run-still-going")).toBe(true);
	});

	it("tool-level cancel reports a handle-less run as lost and rejects unknown ids recoverably", async () => {
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

		const tool = createSubAgentManageTool({ channelId, workspaceDir: "/tmp", channelDir: "/tmp/channel" });
		const result = await tool.execute("call-2", { label: "stop it", op: "cancel", runId: "run-2" });
		const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
		expect(text).toContain("lost");
		expect(manager.get("run-2")?.status).toBe("lost");

		await expect(tool.execute("call-3", { label: "stop it", op: "cancel", runId: "no-such-run" })).rejects.toThrow(
			"was not found",
		);
	});

	it("follow_up is rejected for an internal run and for a still-running codex-cli run", async () => {
		configureSubAgentRuntime({});
		const channelId = `dm_manage_followup_${Date.now()}`;
		const manager = getSubAgentRunManager(channelId);
		const base = {
			channelId,
			source: "predefined" as const,
			purpose: "work" as const,
			workingDirectory: "/tmp",
		};
		await manager.register({
			...base,
			runId: "run-internal",
			runtime: "internal",
			agent: "explorer",
			label: "explore",
			tools: ["read"],
			artifactDir: "/tmp/artifacts/run-internal",
		});
		await manager.register({
			...base,
			runId: "run-running",
			runtime: "external",
			harness: "codex-cli",
			agent: "builder",
			label: "build",
			tools: [],
			artifactDir: "/tmp/artifacts/run-running",
		});

		const tool = createSubAgentManageTool({ channelId, workspaceDir: "/tmp", channelDir: "/tmp/channel" });
		await expect(
			tool.execute("call-4", { label: "continue", op: "follow_up", runId: "run-internal", task: "keep going" }),
		).rejects.toThrow("does not support follow_up yet");
		await expect(
			tool.execute("call-5", { label: "continue", op: "follow_up", runId: "run-running", task: "keep going" }),
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

		const tool = createSubAgentManageTool({ channelId, workspaceDir: "/tmp", channelDir: "/tmp/channel" });
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
			channelDir: "/workspace/dm_manage_followup_ok",
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
		const launchInput = launchExternalRunMock.mock.calls[0]?.[0] as { task: string; artifactDir: string };
		expect(launchInput).toMatchObject({
			runId: expect.stringMatching(/^run_[a-z0-9]{6}$/),
			resumeSessionId: "thread-abc",
			harness: "codex-cli",
			mutates: "read",
			workspaceDir: "/workspace",
		});
		// Spec 042, D7: the follow-up task is the same envelope the initial dispatch builds — runtime
		// context (including this run's own, freshly computed artifact directory), not just the bare
		// instruction string a hand-rolled append used to produce.
		expect(launchInput.task).toContain("keep going");
		expect(launchInput.task).toContain("Runtime context:");
		expect(launchInput.task).toContain(`Artifact directory: ${launchInput.artifactDir}`);
		expect(launchInput.artifactDir).toMatch(/^\/tmp\/checkout\/subagent-artifacts\/run_[a-z0-9]{6}$/);
	});

	// Review 2026-08-23 §3.1: the original dispatch validated `workingDirectory` against the
	// boundary in effect at launch time; `/project` can move that boundary before a later follow_up.
	it("follow_up is rejected when the recorded workingDirectory has fallen outside the current project boundary", async () => {
		configureSubAgentRuntime({});
		const channelId = `dm_manage_followup_boundary_${Date.now()}`;
		const manager = getSubAgentRunManager(channelId);
		await manager.register({
			runId: "run-boundary",
			channelId,
			runtime: "external",
			harness: "codex-cli",
			agent: "builder",
			label: "build",
			source: "predefined",
			tools: [],
			purpose: "work",
			workingDirectory: "/tmp/checkout-outside-project",
			artifactDir: "/tmp/checkout-outside-project/subagent-artifacts/run-boundary",
		});
		await manager.settle(
			"run-boundary",
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
			channelDir: "/workspace/dm_manage_followup_boundary",
			workingDirectory: "/tmp/some-other-project-root",
			projectBoundary: "project",
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

		await expect(
			tool.execute("call-boundary", {
				label: "continue",
				op: "follow_up",
				runId: "run-boundary",
				task: "keep going",
			}),
		).rejects.toThrow("must be inside the project root");
	});

	it("follow_up rejects a task instruction over the sub-agent task length limit", async () => {
		configureSubAgentRuntime({});
		const channelId = `dm_manage_followup_toolong_${Date.now()}`;
		const manager = getSubAgentRunManager(channelId);
		await manager.register({
			runId: "run-toolong",
			channelId,
			runtime: "external",
			harness: "codex-cli",
			agent: "builder",
			label: "build",
			source: "predefined",
			tools: [],
			purpose: "work",
			workingDirectory: "/tmp/checkout",
			artifactDir: "/tmp/checkout/subagent-artifacts/run-toolong",
		});
		await manager.settle(
			"run-toolong",
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

		const tool = createSubAgentManageTool({ channelId, workspaceDir: "/workspace", channelDir: "/workspace/dm" });
		await expect(
			tool.execute("call-toolong", {
				label: "continue",
				op: "follow_up",
				runId: "run-toolong",
				task: "x".repeat(12001),
			}),
		).rejects.toThrow("exceeds");
	});

	it("follow_up is rejected when the role's harness changed since the original run (P1-2)", async () => {
		configureSubAgentRuntime({});
		launchExternalRunMock.mockClear();
		const channelId = `dm_manage_followup_harness_${Date.now()}`;
		const manager = getSubAgentRunManager(channelId);
		await manager.register({
			runId: "run-harness",
			channelId,
			runtime: "external",
			harness: "codex-cli",
			agent: "builder",
			label: "build",
			source: "predefined",
			tools: [],
			purpose: "work",
			workingDirectory: "/tmp/checkout",
			artifactDir: "/tmp/checkout/subagent-artifacts/run-harness",
		});
		await manager.settle(
			"run-harness",
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
			channelDir: "/workspace/dm_manage",
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
						// Role was edited to claude-code since run-harness was dispatched on codex-cli.
						harness: "claude-code",
						command: "claude --dangerously-skip-permissions",
						mutates: "read",
					},
				],
			}),
		});

		await expect(
			tool.execute("call-harness-mismatch", {
				label: "continue",
				op: "follow_up",
				runId: "run-harness",
				task: "keep going",
			}),
		).rejects.toThrow('now uses harness "claude-code"');
		expect(launchExternalRunMock).not.toHaveBeenCalled();
	});

	it("follow_up is rejected when the current role runs through a shell (P1-2)", async () => {
		configureSubAgentRuntime({});
		launchExternalRunMock.mockClear();
		const channelId = `dm_manage_followup_shell_${Date.now()}`;
		const manager = getSubAgentRunManager(channelId);
		await manager.register({
			runId: "run-shell",
			channelId,
			runtime: "external",
			harness: "codex-cli",
			agent: "builder",
			label: "build",
			source: "predefined",
			tools: [],
			purpose: "work",
			workingDirectory: "/tmp/checkout",
			artifactDir: "/tmp/checkout/subagent-artifacts/run-shell",
		});
		await manager.settle(
			"run-shell",
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
			channelDir: "/workspace/dm_manage",
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
						shell: true,
						mutates: "read",
					},
				],
			}),
		});

		await expect(
			tool.execute("call-shell-mismatch", {
				label: "continue",
				op: "follow_up",
				runId: "run-shell",
				task: "keep going",
			}),
		).rejects.toThrow("runs its command through a shell");
		expect(launchExternalRunMock).not.toHaveBeenCalled();
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
			channelDir: "/workspace/dm_manage",
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
		if (next.ok) releaseWorkspaceLease(next.leaseKey, "next");
	});

	// Spec 042, D7: verify admission (a `mutates: write` role cannot verify, `exec` cannot verify)
	// must apply to follow_up too — before this fix, a role hot-edited to `mutates: write` after the
	// original verify run would silently take the write lease and dispatch on follow-up, while the
	// initial dispatch path would have refused the exact same role outright.
	it("rejects follow_up on a purpose=verify run when the role has since become mutates: write", async () => {
		configureSubAgentRuntime({});
		launchExternalRunMock.mockClear();
		const channelId = `dm_manage_followup_verify_mutated_${Date.now()}`;
		const manager = getSubAgentRunManager(channelId);
		await manager.register({
			runId: "run-verify",
			channelId,
			runtime: "external",
			harness: "codex-cli",
			agent: "checker",
			label: "verify",
			source: "predefined",
			tools: [],
			purpose: "verify",
			taskId: "ship",
			workingDirectory: "/tmp/checkout",
			artifactDir: "/tmp/checkout/subagent-artifacts/run-verify",
		});
		await manager.settle(
			"run-verify",
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
				outputText: "VERDICT: PASS",
				sessionId: "thread-verify",
			},
			{ announce: false },
		);

		const tool = createSubAgentManageTool({
			channelId,
			workspaceDir: "/workspace",
			channelDir: "/workspace/dm_manage_followup_verify_mutated",
			getSubAgentDiscovery: () => ({
				directory: "/workspace/sub-agents",
				warnings: [],
				agents: [
					{
						name: "checker",
						description: "checker role, hot-edited to write since the original run",
						systemPrompt: "You check things.",
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
						mutates: "write", // was presumably "read" when the original run dispatched
					},
				],
			}),
		});

		await expect(
			tool.execute("call-verify-mutated", {
				label: "continue",
				op: "follow_up",
				runId: "run-verify",
				task: "re-check",
			}),
		).rejects.toThrow("cannot be used for purpose=verify");
		expect(launchExternalRunMock).not.toHaveBeenCalled();
	});

	// Spec 042, D7: `roleFingerprint` covers command/model/shell (what decides how the process is
	// built) but deliberately not the system-prompt body — a follow-up on a role whose prompt was
	// edited (e.g. a typo fix) must still be resumable; only a change to how the process itself is
	// invoked should break resumability.
	describe("roleFingerprint (spec 042, D7)", () => {
		async function registerLaunchedRun(channelId: string, command: string) {
			const manager = getSubAgentRunManager(channelId);
			await manager.register({
				runId: "run-fp",
				channelId,
				runtime: "external",
				harness: "codex-cli",
				agent: "builder",
				label: "build",
				source: "predefined",
				tools: [],
				purpose: "work",
				workingDirectory: "/tmp/checkout",
				artifactDir: "/tmp/checkout/subagent-artifacts/run-fp",
			});
			await manager.setLaunched("run-fp", {
				pid: 4242,
				argv: ["codex", "exec"],
				deadlineAt: Date.now() + 60_000,
				roleFingerprint: externalRoleFingerprint({ command, externalModelRef: undefined, shell: false }),
			});
			await manager.settle(
				"run-fp",
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
					sessionId: "thread-fp",
				},
				{ announce: false },
			);
		}

		function makeTool(channelId: string, command: string, systemPrompt: string) {
			return createSubAgentManageTool({
				channelId,
				workspaceDir: "/workspace",
				channelDir: "/workspace/dm_manage_fp",
				getSubAgentDiscovery: () => ({
					directory: "/workspace/sub-agents",
					warnings: [],
					agents: [
						{
							name: "builder",
							description: "builder role",
							systemPrompt,
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
							command,
							mutates: "read",
						},
					],
				}),
			});
		}

		it("rejects follow_up when the role's command has changed since launch", async () => {
			launchExternalRunMock.mockClear();
			const channelId = `dm_manage_fp_command_${Date.now()}`;
			await registerLaunchedRun(channelId, "codex exec");
			const tool = makeTool(channelId, "codex exec --sandbox danger-full-access", "You build things.");

			await expect(
				tool.execute("call-fp-command", {
					label: "continue",
					op: "follow_up",
					runId: "run-fp",
					task: "keep going",
				}),
			).rejects.toThrow("has changed");
			expect(launchExternalRunMock).not.toHaveBeenCalled();
		});

		it("still allows follow_up when only the role's system prompt has changed", async () => {
			launchExternalRunMock.mockClear();
			const channelId = `dm_manage_fp_prompt_${Date.now()}`;
			await registerLaunchedRun(channelId, "codex exec");
			const tool = makeTool(channelId, "codex exec", "You build things, carefully now (typo fixed).");

			const result = await tool.execute("call-fp-prompt", {
				label: "continue",
				op: "follow_up",
				runId: "run-fp",
				task: "keep going",
			});
			const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
			expect(text).toContain("Follow-up dispatched");
			expect(launchExternalRunMock).toHaveBeenCalledTimes(1);
		});
	});
});
