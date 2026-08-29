import { type ChildProcess, execFileSync, type spawn as nodeSpawn } from "node:child_process";
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
import { readVerificationAttestation } from "../src/tasks/verification.js";
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
		// Spec 042, D12: persisted at launch so a later failure is diagnosable as "adapter is stale"
		// vs. "the agent failed". `cliVersion` is best-effort (the fake "codex" executable does not
		// really exist in the test environment) — only that the probe does not crash the dispatch.
		expect(manager.get("run-ext-1")?.parserVersion).toBe(1);

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

	it("persists the pid before post-spawn probes finish", async () => {
		const workspaceDir = createTempWorkspace();
		const channelId = "dm_ext_launch_handshake";
		const stateDir = join(workspaceDir, "state");
		const artifactDir = join(workspaceDir, channelId, "subagent-artifacts", "run-ext-handshake");
		mkdirSync(artifactDir, { recursive: true });
		configureSubAgentRuntime({ stateDir });

		let probeStartedResolve!: () => void;
		const probeStarted = new Promise<void>((resolve) => {
			probeStartedResolve = resolve;
		});
		let releaseProbe!: () => void;
		const probeGate = new Promise<void>((resolve) => {
			releaseProbe = resolve;
		});
		const { spawnFnForInput, child } = makeFakeSpawn({ pid: 73737 });
		const launchPromise = launchExternalRun({
			runId: "run-ext-handshake",
			channelId,
			label: "persist before probe",
			agent: "runner",
			source: "inline",
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
			probeCliVersionFn: async () => {
				probeStartedResolve();
				await probeGate;
				return undefined;
			},
		});

		await probeStarted;
		const recordPath = join(stateDir, channelId, "run-ext-handshake.json");
		await waitFor(() => existsSync(recordPath));
		const persisted = JSON.parse(readFileSync(recordPath, "utf-8")) as {
			status?: string;
			pid?: number;
		};
		expect(persisted).toMatchObject({ status: "running", pid: 73737 });

		releaseProbe();
		await launchPromise;
		child.emit("close", 0);
		await waitFor(() => getSubAgentRunManager(channelId).get("run-ext-handshake")?.status !== "running");
	});

	it("runs a write-capable purpose=verify under the lease and records a commit-stable advisory subject", async () => {
		const workspaceDir = createTempWorkspace();
		const projectDir = join(workspaceDir, "project");
		const channelId = "dm_ext_verify_write";
		const channelDir = join(workspaceDir, channelId);
		const runId = "run-ext-verify-write";
		const artifactDir = join(channelDir, "subagent-artifacts", runId);
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(join(channelDir, "tasks"), { recursive: true });
		writeFileSync(
			join(channelDir, "tasks", "ship.md"),
			"---\nstatus: active\n---\n# Ship\n\n## DoD\n- checks pass\n",
		);
		execFileSync("git", ["-C", projectDir, "init", "-q"], { stdio: "pipe" });
		execFileSync("git", ["-C", projectDir, "config", "user.email", "test@example.com"], { stdio: "pipe" });
		execFileSync("git", ["-C", projectDir, "config", "user.name", "Test"], { stdio: "pipe" });
		writeFileSync(join(projectDir, "README.md"), "checkout\n");
		execFileSync("git", ["-C", projectDir, "add", "README.md"], { stdio: "pipe" });
		execFileSync("git", ["-C", projectDir, "commit", "-q", "-m", "baseline"], { stdio: "pipe" });

		const lease = acquireWorkspaceLease({ runId, channelId, workingDirectory: projectDir });
		expect(lease.ok).toBe(true);
		const { spawnFnForInput, child } = makeFakeSpawn({ pid: 8181 });
		configureSubAgentRuntime({ dispatch: () => true });
		await launchExternalRun({
			runId,
			channelId,
			channelDir,
			label: "verify build outputs",
			agent: "verifier",
			source: "predefined",
			harness: "codex-cli",
			command: "codex exec",
			maxWallTimeSec: 60,
			systemPrompt: "Verify the result.",
			task: "Run npm test and npm run build.",
			workingDirectory: projectDir,
			artifactDir,
			purpose: "verify",
			taskId: "ship",
			mutates: "write",
			leaseKey: lease.ok ? lease.leaseKey : undefined,
			workspaceDir,
			securityConfig: DEFAULT_SECURITY_CONFIG,
			spawnFn: spawnFnForInput,
		});

		const manager = getSubAgentRunManager(channelId);
		expect(manager.get(runId)?.mutates).toBe("write");
		expect(acquireWorkspaceLease({ runId: "blocked", channelId, workingDirectory: projectDir }).ok).toBe(false);
		appendFileSync(
			join(artifactDir, "events.jsonl"),
			`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Checks passed.\nVERDICT: PASS" } })}\n` +
				`${JSON.stringify({ type: "turn.completed", thread_id: "thread-verify-write" })}\n`,
		);
		child.emit("close", 0);
		// Observe the terminal transition rather than waiting for the whole settlement promise: the
		// lease must already be free at the first point a completed run is externally visible.
		await waitFor(() => manager.get(runId)?.status !== "running");

		const attestation = await readVerificationAttestation(channelDir, runId);
		expect(attestation).toMatchObject({
			verdict: "pass",
			verificationStrength: "advisory",
			subjectMode: "base-relative",
		});
		expect(attestation.subjectBaseCommit).toMatch(/^[a-f0-9]{40,64}$/);
		expect(attestation.subjectBaselineUntrackedPaths).toEqual([]);
		const nextLease = acquireWorkspaceLease({ runId: "next", channelId, workingDirectory: projectDir });
		expect(nextLease.ok).toBe(true);
		if (nextLease.ok) releaseWorkspaceLease(nextLease.leaseKey, "next");
	});

	it("drops only pipiclaw's own LLM/DingTalk env vars, keeps others, and records what was dropped (fix plan §4.3)", async () => {
		const workspaceDir = createTempWorkspace();
		const channelDir = join(workspaceDir, "dm_ext");
		const artifactDir = join(channelDir, "subagent-artifacts", "run-ext-env");
		mkdirSync(artifactDir, { recursive: true });

		const { spawnFn, spawnFnForInput, child } = makeFakeSpawn({ pid: 5151 });

		const originalAnthropic = process.env.ANTHROPIC_API_KEY;
		const originalDingtalk = process.env.DINGTALK_APP_KEY;
		process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
		process.env.DINGTALK_APP_KEY = "dt-should-not-leak";
		process.env.GITHUB_TOKEN = "gh-should-be-kept";
		try {
			await launchExternalRun({
				runId: "run-ext-env",
				channelId: "dm_ext",
				label: "build",
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
		} finally {
			if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = originalAnthropic;
			if (originalDingtalk === undefined) delete process.env.DINGTALK_APP_KEY;
			else process.env.DINGTALK_APP_KEY = originalDingtalk;
			delete process.env.GITHUB_TOKEN;
		}

		expect(spawnFn).toHaveBeenCalledTimes(1);
		const spawnOptions = spawnFn.mock.calls[0]?.[2] as { env?: Record<string, string | undefined> };
		expect(spawnOptions.env?.ANTHROPIC_API_KEY).toBeUndefined();
		expect(spawnOptions.env?.DINGTALK_APP_KEY).toBeUndefined();
		expect(spawnOptions.env?.GITHUB_TOKEN).toBe("gh-should-be-kept");

		const manager = getSubAgentRunManager("dm_ext");
		await waitFor(() => manager.get("run-ext-env")?.pid !== undefined);
		const warnings = manager.get("run-ext-env")?.invocationWarnings ?? [];
		expect(warnings.some((w) => w.includes("ANTHROPIC_API_KEY"))).toBe(true);
		expect(warnings.some((w) => w.includes("DINGTALK_APP_KEY"))).toBe(true);
		expect(warnings.some((w) => w.includes("GITHUB_TOKEN"))).toBe(false);

		child.emit("close", 0);
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
		const result = await launchExternalRun({
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
		expect(manager.get("run-ext-3")?.status).toBe("failed");
		expect(manager.get("run-ext-3")?.failureReason).toContain("Failed to launch");
		// Spec 042 D2: a pre-spawn failure is reported in the same call instead of a wake — the
		// caller (tool.ts) surfaces `result` in this same turn, so there is nothing to wait for here.
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.kind).toBe("missing-binary");
		expect(dispatched).toHaveLength(0);
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

	// One real-process scenario per termination path (natural completion, explicit cancel, and
	// wall-time timeout): in every case the run's own descendant group must be reaped before the
	// external write lease is released, so a late-writing orphan can never survive the run.
	it.each(["complete", "cancel", "timeout"] as const)(
		"reaps the owned descendant group and releases the write lease on %s",
		async (mode) => {
			const workspaceDir = createTempWorkspace();
			const channelId = `dm_group_${mode}`;
			const runId = `run-group-${mode}`;
			const artifactDir = join(workspaceDir, channelId, "subagent-artifacts", runId);
			const marker = join(workspaceDir, `${mode}-late-write.txt`);
			const script = join(workspaceDir, `${mode}-leader.cjs`);
			// "complete" lets the leader exit normally (the run finishes on its own); the other
			// modes keep the leader alive until the group kill reaches it.
			const leaderBody =
				mode === "complete" ? `process.stdout.write("leader done");process.exit(0);` : `setInterval(()=>{},1000);`;
			writeFileSync(
				script,
				`const {spawn}=require("node:child_process");const c=spawn(process.execPath,["-e","setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'late'),250)",${JSON.stringify(marker)}],{stdio:"ignore"});c.unref();${leaderBody}`,
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
			expect(acquireWorkspaceLease({ runId: "blocked", channelId, workingDirectory: workspaceDir }).ok).toBe(false);
			if (mode === "cancel") await manager.cancel(runId);
			await waitFor(() => manager.get(runId)?.status !== "running", 5_000);
			// Give any surviving descendant enough of its 250ms budget to land its late write.
			await new Promise((resolve) => setTimeout(resolve, 400));

			expect(existsSync(marker)).toBe(false);
			expect(manager.get(runId)?.status).toBe(
				mode === "cancel" ? "cancelled" : mode === "timeout" ? "failed" : "completed",
			);
			const nextLease = acquireWorkspaceLease({ runId: "next", channelId, workingDirectory: workspaceDir });
			expect(nextLease.ok).toBe(true);
			if (nextLease.ok) releaseWorkspaceLease(nextLease.leaseKey, "next");
		},
	);

	// Spec 042, D1: before this fix, the cancel/timeout branches settled immediately without ever
	// reading `events.jsonl` — a run that had already produced real output, usage, and a resumable
	// session id lost all three the moment it was cancelled or hit its wall-time budget. Status and
	// failureReason still get overridden by the termination reason; nothing else does.
	it.each(["cancel", "timeout"] as const)(
		"keeps parsed output, usage, and session id on %s instead of discarding them",
		async (mode) => {
			const workspaceDir = createTempWorkspace();
			const channelId = `dm_partial_${mode}`;
			const runId = `run-partial-${mode}`;
			const artifactDir = join(workspaceDir, channelId, "subagent-artifacts", runId);
			mkdirSync(artifactDir, { recursive: true });

			const dispatched: DingTalkEvent[] = [];
			configureSubAgentRuntime({
				dispatch: (event) => {
					dispatched.push(event);
					return true;
				},
			});

			const { spawnFnForInput, child } = makeFakeSpawn({ pid: mode === "cancel" ? 7171 : 7172 });
			await launchExternalRun({
				runId,
				channelId,
				label: mode,
				agent: "worker",
				source: "inline",
				harness: "codex-cli",
				command: "codex exec",
				maxWallTimeSec: mode === "timeout" ? 0.05 : 60,
				systemPrompt: "System.",
				task: "Task.",
				workingDirectory: workspaceDir,
				artifactDir,
				purpose: "work",
				workspaceDir,
				securityConfig: DEFAULT_SECURITY_CONFIG,
				spawnFn: spawnFnForInput,
			});

			const manager = getSubAgentRunManager(channelId);
			await waitFor(() => manager.get(runId)?.pid !== undefined);

			// Simulate the process having produced full output right before it was killed.
			appendFileSync(
				join(artifactDir, "events.jsonl"),
				`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Partial but real work." } })}\n` +
					`${JSON.stringify({
						type: "turn.completed",
						thread_id: "th_partial",
						usage: { input_tokens: 30, output_tokens: 12 },
					})}\n`,
			);

			if (mode === "cancel") {
				await manager.cancel(runId);
			} else {
				await waitFor(() => manager.get(runId)?.terminationReason === "timeout");
			}
			child.emit("close", undefined); // killed by signal, no exit code.

			// Wait for the terminal state and its artifact. Waiting only for output.md is racy:
			// settle() writes that file before publishing the terminal record.
			if (mode === "cancel") {
				await waitFor(
					() => manager.get(runId)?.status === "cancelled" && existsSync(join(artifactDir, "output.md")),
				);
			} else {
				await waitFor(() => dispatched.length > 0);
			}
			const record = manager.get(runId);
			if (mode === "cancel") {
				expect(record?.status).toBe("cancelled");
				expect(record?.failureReason).toBe("Cancelled by request.");
				expect(dispatched).toHaveLength(0); // cancel is the model's own decision — no wake.
			} else {
				expect(record?.status).toBe("failed");
				expect(record?.failureReason).toContain("Wall time budget exceeded");
				expect(dispatched).toHaveLength(1);
			}
			expect(record?.usage.input).toBe(30);
			expect(record?.usage.output).toBe(12);
			expect(record?.usageKnown).toBe(true);
			expect(record?.sessionId).toBe("th_partial");
			expect(readFileSync(join(artifactDir, "output.md"), "utf-8")).toBe("Partial but real work.");
		},
	);

	it("settles failed (without spawning) when the mandatory audit record cannot be written", async () => {
		const workspaceDir = createTempWorkspace();
		const artifactDir = join(workspaceDir, "dm_audit_fail", "subagent-artifacts", "run-audit-fail");
		const auditDirectory = join(workspaceDir, "audit-is-a-directory");
		mkdirSync(auditDirectory, { recursive: true });
		const { spawnFn, spawnFnForInput } = makeFakeSpawn();

		const result = await launchExternalRun({
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
		});

		// Spec 042 D11: admission (register()) now happens before the audit write, so a capacity
		// rejection never leaves behind an audit record for a process that never existed. An audit
		// write failure past that point settles the run as failed rather than leaving an orphaned
		// "running" record — and (spec 042 D2) is reported in this same call, not thrown.
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.kind).toBe("launch-failed");
		expect(spawnFn).not.toHaveBeenCalled();
		expect(getSubAgentRunManager("dm_audit_fail").get("run-audit-fail")?.status).toBe("failed");
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
