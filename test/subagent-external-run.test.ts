import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DingTalkEvent } from "../src/runtime/dingtalk.js";
import { launchExternalRun } from "../src/subagents/external/run.js";
import { configureSubAgentRuntime, getSubAgentRunManager } from "../src/subagents/runs.js";
import { useTempDirs } from "./helpers/fixtures.js";

/** Spec 040, D1/D3/D4: the external-run orchestrator, driven with a fake `spawn` so the test
 *  never touches a real process or a real codex-cli binary. */

const createTempWorkspace = useTempDirs("pipiclaw-subagent-external-run-");

class FakeChildProcess extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	stdin = new PassThrough();
	pid: number | undefined;
}

function makeFakeSpawn(options: { pid?: number; failToSpawn?: Error } = {}) {
	const child = new FakeChildProcess();
	const spawnFn = vi.fn((..._args: unknown[]) => {
		if (options.failToSpawn) {
			queueMicrotask(() => child.emit("error", options.failToSpawn));
		} else {
			child.pid = options.pid ?? 4242;
			queueMicrotask(() => child.emit("spawn"));
		}
		return child as unknown as ChildProcess;
	});
	return { spawnFn, spawnFnForInput: spawnFn as unknown as typeof nodeSpawn, child };
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const tick = () => {
			if (predicate()) return resolve();
			if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
			setTimeout(tick, 5);
		};
		tick();
	});
}

describe("launchExternalRun (spec 040, D1/D3/D4)", () => {
	afterEach(() => {
		configureSubAgentRuntime({});
	});

	it("spawns codex-cli, persists the pid, and settles completed once turn.completed arrives", async () => {
		const workspaceDir = createTempWorkspace();
		const channelDir = join(workspaceDir, "dm_ext");
		const artifactDir = join(channelDir, "subagent-artifacts", "run-ext-1");
		mkdirSync(artifactDir, { recursive: true });

		const dispatched: DingTalkEvent[] = [];
		configureSubAgentRuntime({
			dispatch: (event) => {
				dispatched.push(event);
				return true;
			},
		});

		const { spawnFn, spawnFnForInput, child } = makeFakeSpawn({ pid: 5150 });

		await launchExternalRun({
			runId: "run-ext-1",
			channelId: "dm_ext",
			label: "build the feature",
			agent: "builder",
			source: "predefined",
			harness: "codex-cli",
			command: "codex exec",
			maxWallTimeSec: 60,
			systemPrompt: "You are a builder.",
			task: "Implement the thing.",
			workingDirectory: workspaceDir,
			artifactDir,
			purpose: "work",
			spawnFn: spawnFnForInput,
		});

		expect(spawnFn).toHaveBeenCalledTimes(1);
		expect(spawnFn.mock.calls[0]?.[0]).toBe("codex");
		expect(spawnFn.mock.calls[0]?.[1]).toEqual(["exec", "--json", "-"]);

		const manager = getSubAgentRunManager("dm_ext");
		await waitFor(() => manager.get("run-ext-1")?.pid !== undefined);
		expect(manager.get("run-ext-1")?.status).toBe("running");
		expect(manager.get("run-ext-1")?.pid).toBe(5150);

		child.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "thread-xyz" })}\n`);
		child.stdout.write(
			`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "All done." } })}\n`,
		);
		child.stdout.write(
			`${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } })}\n`,
		);
		child.emit("close", 0);

		await waitFor(() => manager.get("run-ext-1")?.status === "completed");
		const record = manager.get("run-ext-1");
		expect(record?.sessionId).toBe("thread-xyz");
		expect(record?.usageKnown).toBe(true);
		expect(record?.costKnown).toBe(false);

		expect(dispatched).toHaveLength(1);
		expect(dispatched[0]?.text).toContain("[SUBAGENT:run-ext-1]");
		expect(dispatched[0]?.text).toContain("All done.");
	});

	it("settles failed when the process exits 0 but no protocol terminal event was observed", async () => {
		const workspaceDir = createTempWorkspace();
		const channelDir = join(workspaceDir, "dm_ext2");
		const artifactDir = join(channelDir, "subagent-artifacts", "run-ext-2");
		mkdirSync(artifactDir, { recursive: true });

		const dispatched: DingTalkEvent[] = [];
		configureSubAgentRuntime({
			dispatch: (event) => {
				dispatched.push(event);
				return true;
			},
		});

		const { spawnFn: _spawnFn2, spawnFnForInput, child } = makeFakeSpawn({ pid: 6161 });
		await launchExternalRun({
			runId: "run-ext-2",
			channelId: "dm_ext2",
			label: "quiet run",
			agent: "builder",
			source: "predefined",
			harness: "codex-cli",
			command: "codex exec",
			maxWallTimeSec: 60,
			systemPrompt: "System.",
			task: "Task.",
			workingDirectory: workspaceDir,
			artifactDir,
			purpose: "work",
			spawnFn: spawnFnForInput,
		});

		const manager = getSubAgentRunManager("dm_ext2");
		await waitFor(() => manager.get("run-ext-2")?.pid !== undefined);
		child.emit("close", 0); // exit 0, but stdout never carried a terminal event.

		await waitFor(() => manager.get("run-ext-2")?.status !== "running");
		expect(manager.get("run-ext-2")?.status).toBe("failed");
		expect(manager.get("run-ext-2")?.failureReason).toContain("no protocol terminal event");
		expect(dispatched).toHaveLength(1);
	});

	it("settles failed immediately when spawn itself fails (e.g. missing binary)", async () => {
		const workspaceDir = createTempWorkspace();
		const channelDir = join(workspaceDir, "dm_ext3");
		const artifactDir = join(channelDir, "subagent-artifacts", "run-ext-3");
		mkdirSync(artifactDir, { recursive: true });

		const dispatched: DingTalkEvent[] = [];
		configureSubAgentRuntime({
			dispatch: (event) => {
				dispatched.push(event);
				return true;
			},
		});

		const { spawnFnForInput } = makeFakeSpawn({
			failToSpawn: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
		});
		await launchExternalRun({
			runId: "run-ext-3",
			channelId: "dm_ext3",
			label: "broken command",
			agent: "builder",
			source: "predefined",
			harness: "codex-cli",
			command: "totally-nonexistent-binary-xyz123",
			maxWallTimeSec: 60,
			systemPrompt: "System.",
			task: "Task.",
			workingDirectory: workspaceDir,
			artifactDir,
			purpose: "work",
			spawnFn: spawnFnForInput,
		});

		const manager = getSubAgentRunManager("dm_ext3");
		await waitFor(() => manager.get("run-ext-3")?.status !== "running");
		expect(manager.get("run-ext-3")?.status).toBe("failed");
		expect(manager.get("run-ext-3")?.failureReason).toContain("Failed to launch");
		expect(dispatched).toHaveLength(1);
	});

	it("rejects an unknown harness before ever spawning", async () => {
		const workspaceDir = createTempWorkspace();
		const channelDir = join(workspaceDir, "dm_ext4");
		const artifactDir = join(channelDir, "subagent-artifacts", "run-ext-4");
		mkdirSync(artifactDir, { recursive: true });
		configureSubAgentRuntime({});
		const { spawnFn, spawnFnForInput } = makeFakeSpawn();

		await expect(
			launchExternalRun({
				runId: "run-ext-4",
				channelId: "dm_ext4",
				label: "bad harness",
				agent: "builder",
				source: "predefined",
				harness: "not-a-real-harness",
				command: "echo hi",
				maxWallTimeSec: 60,
				systemPrompt: "System.",
				task: "Task.",
				workingDirectory: workspaceDir,
				artifactDir,
				purpose: "work",
				spawnFn: spawnFnForInput,
			}),
		).rejects.toThrow("Unknown external harness");
		expect(spawnFn).not.toHaveBeenCalled();
	});

	it("spawns claude-code, persists the pre-assigned session id at launch, and settles completed on a result event", async () => {
		const workspaceDir = createTempWorkspace();
		const channelDir = join(workspaceDir, "dm_ext5");
		const artifactDir = join(channelDir, "subagent-artifacts", "run-ext-5");
		mkdirSync(artifactDir, { recursive: true });

		const dispatched: DingTalkEvent[] = [];
		configureSubAgentRuntime({
			dispatch: (event) => {
				dispatched.push(event);
				return true;
			},
		});

		const { spawnFn, spawnFnForInput, child } = makeFakeSpawn({ pid: 7171 });
		await launchExternalRun({
			runId: "run-ext-5",
			channelId: "dm_ext5",
			label: "review the diff",
			agent: "reviewer",
			source: "predefined",
			harness: "claude-code",
			command: "claude --dangerously-skip-permissions",
			maxWallTimeSec: 60,
			systemPrompt: "You are a reviewer.",
			task: "Review the change.",
			workingDirectory: workspaceDir,
			artifactDir,
			purpose: "work",
			spawnFn: spawnFnForInput,
		});

		expect(spawnFn.mock.calls[0]?.[0]).toBe("claude");
		const args = spawnFn.mock.calls[0]?.[1] as string[];
		expect(args).toContain("--session-id");
		const sessionIdIndex = args.indexOf("--session-id") + 1;
		const presetSessionId = args[sessionIdIndex];
		expect(presetSessionId).toBeTruthy();

		const manager = getSubAgentRunManager("dm_ext5");
		// The pre-assigned session id is persisted at launch, before any output (D4's improvement):
		// resume must not depend on a successful `result` event ever arriving.
		await waitFor(() => manager.get("run-ext-5")?.sessionId !== undefined);
		expect(manager.get("run-ext-5")?.sessionId).toBe(presetSessionId);

		child.stdout.write(
			`${JSON.stringify({
				type: "result",
				is_error: false,
				result: "Looks good.",
				session_id: presetSessionId,
				total_cost_usd: 0.01,
			})}\n`,
		);
		child.emit("close", 0);

		await waitFor(() => manager.get("run-ext-5")?.status === "completed");
		expect(manager.get("run-ext-5")?.costKnown).toBe(true);
		expect(dispatched).toHaveLength(1);
		expect(dispatched[0]?.text).toContain("Looks good.");
	});
});
