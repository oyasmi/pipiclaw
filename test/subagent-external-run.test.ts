import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DingTalkEvent } from "../src/runtime/dingtalk.js";
import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";
import { launchExternalRun } from "../src/subagents/external/run.js";
import { configureSubAgentRuntime, getSubAgentRunManager } from "../src/subagents/runs.js";
import { acquireWorkspaceLease, releaseWorkspaceLease } from "../src/subagents/workspace-lease.js";
import { useTempDirs } from "./helpers/fixtures.js";

/** Spec 040, D1/D3/D4: the external-run orchestrator, driven with a fake `spawn` so the test
 *  never touches a real process or a real codex-cli binary. */

const createTempWorkspace = useTempDirs("pipiclaw-subagent-external-run-");

class FakeChildProcess extends EventEmitter {
	// stdout/stderr are real files under fd-direct stdio (P0-1) — the fake process has none, so
	// tests simulate its output by writing straight to `events.jsonl`/`stderr.log` instead.
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

	it("rejects shell mode for structured harnesses before spawning", async () => {
		const workspaceDir = createTempWorkspace();
		const { spawnFn, spawnFnForInput } = makeFakeSpawn();

		await expect(
			launchExternalRun({
				runId: "run-shell-structured",
				channelId: "dm_shell_structured",
				label: "invalid shell run",
				agent: "builder",
				source: "predefined",
				harness: "claude-code",
				command: "claude",
				shell: true,
				maxWallTimeSec: 60,
				systemPrompt: "Build things.",
				task: "Build the thing.",
				workingDirectory: workspaceDir,
				artifactDir: join(workspaceDir, "artifacts"),
				purpose: "work",
				workspaceDir,
				securityConfig: DEFAULT_SECURITY_CONFIG,
				spawnFn: spawnFnForInput,
			}),
		).rejects.toThrow("cannot use shell mode because it would bypass protocol argv assembly");
		expect(spawnFn).not.toHaveBeenCalled();
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
			mutates: "write",
			workspaceDir,
			securityConfig: DEFAULT_SECURITY_CONFIG,
			spawnFn: spawnFnForInput,
		});

		expect(spawnFn).toHaveBeenCalledTimes(1);
		expect(spawnFn.mock.calls[0]?.[0]).toBe("codex");
		expect(spawnFn.mock.calls[0]?.[1]).toEqual(["exec", "--json", "-"]);

		const manager = getSubAgentRunManager("dm_ext");
		await waitFor(() => manager.get("run-ext-1")?.pid !== undefined);
		expect(manager.get("run-ext-1")?.status).toBe("running");
		expect(manager.get("run-ext-1")?.pid).toBe(5150);

		// D8.1/T5: the dispatch is audited once argv/cwd/role/mutates/model/runId are all final,
		// unconditionally (not gated on `audit.logBlocked`).
		const auditLog = readFileSync(join(workspaceDir, ".pipiclaw", "security.log"), "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const externalAgentEvent = auditLog.find((entry) => entry.type === "external-agent");
		expect(externalAgentEvent).toMatchObject({
			type: "external-agent",
			runId: "run-ext-1",
			agent: "builder",
			harness: "codex-cli",
			argv: ["codex", "exec", "--json", "-"],
			workingDirectory: workspaceDir,
			mutates: "write",
		});

		// P0-1: the child now writes its own output file directly (fd-direct stdio), so a fake
		// spawn's "process" simulates that by writing the artifact file itself rather than piping
		// through `child.stdout`.
		appendFileSync(
			join(artifactDir, "events.jsonl"),
			`${JSON.stringify({ type: "thread.started", thread_id: "thread-xyz" })}\n` +
				`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "All done." } })}\n` +
				`${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } })}\n`,
		);
		child.emit("close", 0);

		await waitFor(() => manager.get("run-ext-1")?.status === "completed");
		await waitFor(() => dispatched.length > 0);
		const record = manager.get("run-ext-1");
		expect(record?.sessionId).toBe("thread-xyz");
		expect(record?.usageKnown).toBe(true);
		expect(record?.costKnown).toBe(false);

		expect(dispatched).toHaveLength(1);
		expect(dispatched[0]?.text).toContain("[SUBAGENT:run-ext-1]");
		expect(dispatched[0]?.text).toContain("All done.");

		// Spec 040 D1: settlement writes the full text to output.md for every runtime, which is
		// exactly the file the completion wake points the parent agent at.
		const outputPath = join(artifactDir, "output.md");
		expect(readFileSync(outputPath, "utf-8")).toBe("All done.");
		expect(dispatched[0]?.text).toContain(`Full output: ${outputPath}`);
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
			workspaceDir,
			securityConfig: DEFAULT_SECURITY_CONFIG,
			spawnFn: spawnFnForInput,
		});

		const manager = getSubAgentRunManager("dm_ext2");
		await waitFor(() => manager.get("run-ext-2")?.pid !== undefined);
		child.emit("close", 0); // exit 0, but stdout never carried a terminal event.

		await waitFor(() => manager.get("run-ext-2")?.status !== "running");
		expect(manager.get("run-ext-2")?.status).toBe("failed");
		expect(manager.get("run-ext-2")?.failureReason).toContain("no protocol terminal event");
		expect(dispatched).toHaveLength(1);
		// Nothing was produced, so there is no output.md to point at — the wake sends the parent to
		// the artifact directory (where stderr.log lives) instead of a file that does not exist.
		expect(existsSync(join(artifactDir, "output.md"))).toBe(false);
		expect(dispatched[0]?.text).not.toContain("output.md");
		expect(dispatched[0]?.text).toContain(`Run artifacts: ${artifactDir}`);
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
			workspaceDir,
			securityConfig: DEFAULT_SECURITY_CONFIG,
			spawnFn: spawnFnForInput,
		});

		const manager = getSubAgentRunManager("dm_ext3");
		await waitFor(() => manager.get("run-ext-3")?.status !== "running");
		expect(manager.get("run-ext-3")?.status).toBe("failed");
		expect(manager.get("run-ext-3")?.failureReason).toContain("Failed to launch");
		expect(dispatched).toHaveLength(1);
	});

	it("captures a real short-lived child that closes before launchExternalRun returns", async () => {
		const workspaceDir = createTempWorkspace();
		const artifactDir = join(workspaceDir, "dm_short", "subagent-artifacts", "run-short");
		const dispatched: DingTalkEvent[] = [];
		configureSubAgentRuntime({
			dispatch: (event) => {
				dispatched.push(event);
				return true;
			},
		});

		await launchExternalRun({
			runId: "run-short",
			channelId: "dm_short",
			label: "short",
			agent: "runner",
			source: "inline",
			harness: "exec",
			command: "printf short-lived",
			maxWallTimeSec: 10,
			systemPrompt: "System.",
			task: "Task.",
			workingDirectory: workspaceDir,
			artifactDir,
			purpose: "work",
			workspaceDir,
			securityConfig: DEFAULT_SECURITY_CONFIG,
		});

		const manager = getSubAgentRunManager("dm_short");
		await waitFor(() => manager.get("run-short")?.status !== "running");
		await waitFor(() => dispatched.length === 1);
		expect(manager.get("run-short")?.status).toBe("completed");
		expect(readFileSync(join(artifactDir, "output.md"), "utf-8")).toContain("short-lived");
		expect(dispatched).toHaveLength(1);
	});

	it("cancels a launch intent before spawn when cancel arrives after register", async () => {
		const workspaceDir = createTempWorkspace();
		const artifactDir = join(workspaceDir, "dm_launch_cancel", "subagent-artifacts", "run-launch-cancel");
		configureSubAgentRuntime({});
		const manager = getSubAgentRunManager("dm_launch_cancel");
		await manager.register({
			runId: "run-launch-cancel",
			channelId: "dm_launch_cancel",
			runtime: "external",
			agent: "runner",
			label: "cancel launch",
			source: "inline",
			tools: [],
			purpose: "work",
			workingDirectory: workspaceDir,
			artifactDir,
		});
		await manager.cancel("run-launch-cancel");
		const claimed = await manager.claimExternalLaunch("run-launch-cancel", () => {});

		expect(claimed).toBe(false);
	});

	it("terminates descendants before settling and releasing the external write lease", async () => {
		const workspaceDir = createTempWorkspace();
		const channelId = "dm_descendant";
		const runId = "run-descendant";
		const artifactDir = join(workspaceDir, channelId, "subagent-artifacts", runId);
		const marker = join(workspaceDir, "late-write.txt");
		const script = join(workspaceDir, "leader.cjs");
		writeFileSync(
			script,
			`const {spawn}=require("node:child_process");const c=spawn(process.execPath,["-e","setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'late'),1000)",${JSON.stringify(marker)}],{stdio:"ignore"});c.unref();process.stdout.write("leader done");process.exit(0);`,
		);
		const lease = acquireWorkspaceLease({ runId, channelId, workingDirectory: workspaceDir });
		expect(lease.ok).toBe(true);
		configureSubAgentRuntime({ dispatch: () => true });

		await launchExternalRun({
			runId,
			channelId,
			label: "descendant",
			agent: "runner",
			source: "inline",
			harness: "exec",
			command: `${process.execPath} ${script}`,
			maxWallTimeSec: 10,
			systemPrompt: "System.",
			task: "Task.",
			workingDirectory: workspaceDir,
			artifactDir,
			purpose: "work",
			mutates: "write",
			leaseKey: lease.ok ? lease.leaseKey : undefined,
			workspaceDir,
			securityConfig: DEFAULT_SECURITY_CONFIG,
		});
		const manager = getSubAgentRunManager(channelId);
		expect(acquireWorkspaceLease({ runId: "competing", channelId, workingDirectory: workspaceDir }).ok).toBe(false);
		await waitFor(() => manager.get(runId)?.status !== "running", 5_000);
		await new Promise((resolve) => setTimeout(resolve, 1_100));

		expect(existsSync(marker)).toBe(false);
		const nextLease = acquireWorkspaceLease({ runId: "next", channelId, workingDirectory: workspaceDir });
		expect(nextLease.ok).toBe(true);
		if (nextLease.ok) releaseWorkspaceLease(nextLease.leaseKey);
	});

	it.each(["cancel", "timeout"] as const)(
		"terminates the owned descendant group on %s before releasing the write lease",
		async (mode) => {
			const workspaceDir = createTempWorkspace();
			const channelId = `dm_group_${mode}`;
			const runId = `run-group-${mode}`;
			const artifactDir = join(workspaceDir, channelId, "subagent-artifacts", runId);
			const marker = join(workspaceDir, `${mode}-late-write.txt`);
			const script = join(workspaceDir, `${mode}-leader.cjs`);
			writeFileSync(
				script,
				`const {spawn}=require("node:child_process");const c=spawn(process.execPath,["-e","setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'late'),700)",${JSON.stringify(marker)}],{stdio:"ignore"});c.unref();setInterval(()=>{},1000);`,
			);
			const lease = acquireWorkspaceLease({ runId, channelId, workingDirectory: workspaceDir });
			expect(lease.ok).toBe(true);
			configureSubAgentRuntime({ dispatch: () => true });

			await launchExternalRun({
				runId,
				channelId,
				label: mode,
				agent: "runner",
				source: "inline",
				harness: "exec",
				command: `${process.execPath} ${script}`,
				maxWallTimeSec: mode === "timeout" ? 0.05 : 10,
				systemPrompt: "System.",
				task: "Task.",
				workingDirectory: workspaceDir,
				artifactDir,
				purpose: "work",
				mutates: "write",
				leaseKey: lease.ok ? lease.leaseKey : undefined,
				workspaceDir,
				securityConfig: DEFAULT_SECURITY_CONFIG,
			});
			const manager = getSubAgentRunManager(channelId);
			if (mode === "cancel") await manager.cancel(runId);
			expect(acquireWorkspaceLease({ runId: "blocked", channelId, workingDirectory: workspaceDir }).ok).toBe(false);
			await waitFor(() => manager.get(runId)?.status !== "running", 5_000);
			await new Promise((resolve) => setTimeout(resolve, 800));

			expect(existsSync(marker)).toBe(false);
			expect(manager.get(runId)?.status).toBe(mode === "cancel" ? "cancelled" : "failed");
			const nextLease = acquireWorkspaceLease({ runId: "next", channelId, workingDirectory: workspaceDir });
			expect(nextLease.ok).toBe(true);
			if (nextLease.ok) releaseWorkspaceLease(nextLease.leaseKey);
		},
	);

	it("rejects dispatch before spawn when the mandatory audit record cannot be written", async () => {
		const workspaceDir = createTempWorkspace();
		const artifactDir = join(workspaceDir, "dm_audit_fail", "subagent-artifacts", "run-audit-fail");
		const auditDirectory = join(workspaceDir, "audit-is-a-directory");
		mkdirSync(auditDirectory, { recursive: true });
		const { spawnFn, spawnFnForInput } = makeFakeSpawn();

		await expect(
			launchExternalRun({
				runId: "run-audit-fail",
				channelId: "dm_audit_fail",
				label: "must be audited",
				agent: "builder",
				source: "predefined",
				harness: "exec",
				command: "printf unsafe",
				maxWallTimeSec: 10,
				systemPrompt: "System.",
				task: "Task.",
				workingDirectory: workspaceDir,
				artifactDir,
				purpose: "work",
				workspaceDir,
				securityConfig: {
					...DEFAULT_SECURITY_CONFIG,
					audit: { ...DEFAULT_SECURITY_CONFIG.audit, logFile: auditDirectory },
				},
				spawnFn: spawnFnForInput,
			}),
		).rejects.toThrow();
		expect(spawnFn).not.toHaveBeenCalled();
		expect(getSubAgentRunManager("dm_audit_fail").get("run-audit-fail")).toBeUndefined();
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
				workspaceDir,
				securityConfig: DEFAULT_SECURITY_CONFIG,
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
			workspaceDir,
			securityConfig: DEFAULT_SECURITY_CONFIG,
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

		appendFileSync(
			join(artifactDir, "events.jsonl"),
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
		await waitFor(() => dispatched.length > 0);
		expect(manager.get("run-ext-5")?.costKnown).toBe(true);
		expect(dispatched).toHaveLength(1);
		expect(dispatched[0]?.text).toContain("Looks good.");
	});
});
