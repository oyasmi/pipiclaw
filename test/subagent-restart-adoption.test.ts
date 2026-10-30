import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as hostProcess from "../src/shared/host-process.js";
import { readProcessStartTime } from "../src/shared/host-process.js";
import { SubAgentRunManager } from "../src/subagents/runs.js";
import { acquireWorkspaceLease, releaseWorkspaceLease } from "../src/subagents/workspace-lease.js";
import { readTaskLog, resetTaskLogAppenders } from "../src/tasks/loop-log.js";
import { testDesk } from "./helpers/background-runtime.js";
import { useTempDirs } from "./helpers/fixtures.js";

/** Spawns a process that exits immediately and resolves its pid once it has been reaped, so a
 *  reconciliation test can exercise the "pid is gone" branch without waiting on a real deadline. */
function spawnAndWaitExit(): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
		child.once("error", reject);
		child.once("close", () => {
			if (child.pid === undefined) {
				reject(new Error("child never got a pid"));
				return;
			}
			resolve(child.pid);
		});
	});
}

/**
 * Spec 040, D10.3 (P0-1): a restart must genuinely re-adopt a still-running external run, not
 * just probe it once — rebuild its write lease, keep enforcing its persisted deadline, and
 * settle it exactly once when it actually ends. Three independent `SubAgentRunManager` instances
 * sharing the same on-disk state simulate three daemon lifetimes; a real detached OS process is
 * used throughout since the point under test is process identity and process-group behavior,
 * which a fake spawn cannot exercise.
 */

const createTempWorkspace = useTempDirs("pipiclaw-subagent-restart-adoption-");
const managers = new Set<SubAgentRunManager>();
const childGroups = new Set<number>();
const leases: Array<{ leaseKey?: string; runId: string }> = [];

function createManager(
	channelId: string,
	options: ConstructorParameters<typeof SubAgentRunManager>[1],
	deskDir = "/tmp/pipiclaw-test-desk",
): SubAgentRunManager {
	const manager = new SubAgentRunManager({ desk: testDesk(channelId), deskDir }, options);
	managers.add(manager);
	return manager;
}

function claimWorkspaceLease(options: Parameters<typeof acquireWorkspaceLease>[0]) {
	const result = acquireWorkspaceLease(options);
	if (result.ok) leases.push({ leaseKey: result.leaseKey, runId: options.runId });
	return result;
}

afterEach(async () => {
	for (const manager of managers) manager.stop();
	managers.clear();
	for (const { leaseKey, runId } of leases.splice(0)) releaseWorkspaceLease(leaseKey, runId);
	for (const pid of childGroups) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// The child group may already have exited or been killed by the tested timeout.
		}
	}
	childGroups.clear();
	await resetTaskLogAppenders();
	vi.restoreAllMocks();
});

function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const tick = async () => {
			if (await predicate()) {
				if (timer) clearTimeout(timer);
				return resolve();
			}
			if (Date.now() - start > timeoutMs) {
				if (timer) clearTimeout(timer);
				return reject(new Error("waitFor timed out"));
			}
			timer = setTimeout(tick, 20);
		};
		void tick();
	});
}

describe("SubAgentRunManager restart adoption (spec 040, D10.3)", () => {
	it("rebuilds the write lease for a still-alive adopted run, enforces its deadline once, and settles exactly once", async () => {
		// Keep real process identity, signals and termination; the host-process tests own the
		// kill grace itself. Adoption must not spend the production 5s grace on every run.
		const killGroup = hostProcess.killProcessGroup;
		vi.spyOn(hostProcess, "killProcessGroup").mockImplementation((pid) => killGroup(pid, 10));
		const workspaceDir = createTempWorkspace();
		const channelId = "dingtalk:dm:adopt";
		const stateDir = join(workspaceDir, "state");
		const artifactDir = join(workspaceDir, channelId, "subagent-artifacts", "run-adopt");
		mkdirSync(artifactDir, { recursive: true });

		// Keep the process alive until the adopted deadline kills it; no elapsed-time guess
		// about whether a delayed write had a chance to run can prove termination.
		const ready = join(workspaceDir, "ready.txt");
		const script = join(workspaceDir, "leader.cjs");
		writeFileSync(
			script,
			`require("node:fs").writeFileSync(${JSON.stringify(ready)},"ready");setInterval(()=>{},1000);`,
		);
		const child = spawn(process.execPath, [script], { detached: true, stdio: "ignore" });
		child.unref();
		await waitFor(() => child.pid !== undefined && existsSync(ready));
		const pid = child.pid!;
		childGroups.add(pid);
		const pidStartedAt = await readProcessStartTime(pid);

		// "First daemon": registers the run, takes its write lease, records the launch — then
		// vanishes without ever calling settle(), exactly like a daemon that dies mid-run.
		const firstDaemon = createManager(channelId, { stateDir });
		const lease = claimWorkspaceLease({ runId: "run-adopt", channelId, workingDirectory: workspaceDir });
		expect(lease.ok).toBe(true);
		await firstDaemon.register({
			runId: "run-adopt",
			channelId,
			runtime: "external",
			harness: "exec",
			agent: "runner",
			label: "adopt me",
			source: "inline",
			tools: [],
			purpose: "work",
			workingDirectory: workspaceDir,
			artifactDir,
			leaseKey: lease.ok ? lease.leaseKey : undefined,
		});
		await firstDaemon.setLaunched("run-adopt", {
			pid,
			pidStartedAt,
			argv: [process.execPath, script],
			deadlineAt: Date.now() + 60_000, // plenty of headroom until the sweep below
		});

		// Simulate the restart: the lease map is process-local (workspace-lease.ts persists
		// nothing), so a fresh process starts holding none — this is exactly what restore() must
		// rebuild from the persisted record alone.
		firstDaemon.stop();
		releaseWorkspaceLease(lease.ok ? lease.leaseKey : undefined, "run-adopt");

		const secondDaemon = createManager(channelId, { stateDir });
		const restoredCount = await secondDaemon.restore();
		expect(restoredCount).toBe(1);
		expect(secondDaemon.get("run-adopt")?.status).toBe("running"); // still genuinely alive — left alone

		// The lease is rebuilt: a competing write dispatch to the same workspace is refused.
		const competing = claimWorkspaceLease({ runId: "competing", channelId, workingDirectory: workspaceDir });
		expect(competing.ok).toBe(false);

		// A third "daemon" adopts the run shortly before its persisted deadline. It must install one
		// deadline check, kill the real process, and settle it as a timeout failure without a periodic
		// poller or falling back to the "no protocol terminal" guess. Simulated the same way as the
		// first→second transition: release the second daemon's process-local lease first.
		secondDaemon.stop();
		releaseWorkspaceLease(secondDaemon.get("run-adopt")?.leaseKey, "run-adopt");
		const recordPath = join(stateDir, testDesk(channelId), "run-adopt.json");
		const persisted = JSON.parse(readFileSync(recordPath, "utf-8"));
		persisted.deadlineAt = Date.now() + 100;
		writeFileSync(recordPath, `${JSON.stringify(persisted)}\n`, "utf-8");
		const dispatched: unknown[] = [];
		const swept = createManager(channelId, {
			stateDir,
			dispatch: (event) => {
				dispatched.push(event);
				return true;
			},
		});
		// Reproduce an early timer delivery: without re-arming, the only recovery check is
		// consumed before the deadline and this adopted process runs forever. Mutation: removing
		// the early-delivery guard leaves the run running and prevents the persisted wake.
		const nativeSetTimeout = globalThis.setTimeout;
		const timerSpy = vi.spyOn(globalThis, "setTimeout").mockImplementationOnce((callback, delay, ...args) =>
			nativeSetTimeout(() => {
				const clock = vi.spyOn(Date, "now").mockReturnValue(persisted.deadlineAt - 1);
				try {
					callback(...args);
				} finally {
					clock.mockRestore();
				}
			}, delay),
		);
		try {
			await swept.restore();
		} finally {
			timerSpy.mockRestore();
		}
		// Wait for the persisted wake receipt as well as the terminal state: observing the
		// in-memory status alone could pass before settlement's durable effects finished.
		await waitFor(() => {
			if (swept.get("run-adopt")?.status === "running" || dispatched.length !== 1) return false;
			try {
				return JSON.parse(readFileSync(recordPath, "utf-8")).wakeEnqueued === true;
			} catch {
				return false;
			}
		}, 20_000);

		expect(swept.get("run-adopt")?.status).toBe("failed");
		expect(swept.get("run-adopt")?.failureReason).toContain("Wall time budget exceeded");
		if (child.exitCode === null && child.signalCode === null) {
			await once(child, "exit", { signal: AbortSignal.timeout(5_000) });
		}
		expect(hostProcess.isProcessGroupAlive(pid)).toBe(false);
		expect(dispatched).toHaveLength(1);

		// Another restart must not double-kill or re-announce the already-settled run.
		const repeated = createManager(channelId, {
			stateDir,
			dispatch: (event) => {
				dispatched.push(event);
				return true;
			},
		});
		await repeated.restore();
		expect(dispatched).toHaveLength(1);

		// The lease was released once the run went terminal.
		const afterLease = claimWorkspaceLease({ runId: "after", channelId, workingDirectory: workspaceDir });
		expect(afterLease.ok).toBe(true);
		if (afterLease.ok) releaseWorkspaceLease(afterLease.leaseKey, "after");
	}, 30_000);

	it("settles an adopted write run when its lease cannot be rebuilt, without releasing another holder", async () => {
		const workspaceDir = createTempWorkspace();
		const channelId = "dingtalk:dm:adopt_lease_conflict";
		const stateDir = join(workspaceDir, "state");
		const artifactDir = join(workspaceDir, channelId, "subagent-artifacts", "run-conflict");
		mkdirSync(artifactDir, { recursive: true });

		const firstDaemon = createManager(channelId, { stateDir });
		const originalLease = claimWorkspaceLease({ runId: "run-conflict", channelId, workingDirectory: workspaceDir });
		expect(originalLease.ok).toBe(true);
		await firstDaemon.register({
			runId: "run-conflict",
			channelId,
			runtime: "external",
			harness: "codex-cli",
			agent: "builder",
			label: "conflicted adoption",
			source: "inline",
			tools: [],
			purpose: "work",
			workingDirectory: workspaceDir,
			artifactDir,
			leaseKey: originalLease.ok ? originalLease.leaseKey : undefined,
			mutates: "write",
		});
		await firstDaemon.setLaunched("run-conflict", {
			pid: 999_999,
			argv: [process.execPath],
			deadlineAt: Date.now() + 60_000,
		});
		releaseWorkspaceLease(originalLease.ok ? originalLease.leaseKey : undefined, "run-conflict");

		const otherLease = claimWorkspaceLease({
			runId: "other-writer",
			channelId: "other",
			workingDirectory: workspaceDir,
		});
		expect(otherLease.ok).toBe(true);
		const secondDaemon = createManager(channelId, { stateDir });
		await secondDaemon.restore();

		expect(secondDaemon.get("run-conflict")?.status).toBe("lost");
		expect(secondDaemon.get("run-conflict")?.leaseKey).toBeUndefined();
		expect(secondDaemon.get("run-conflict")?.failureReason).toContain("could not be confirmed");
		expect(
			acquireWorkspaceLease({ runId: "third-writer", channelId: "third", workingDirectory: workspaceDir }).ok,
		).toBe(false);
		releaseWorkspaceLease(otherLease.ok ? otherLease.leaseKey : undefined, "other-writer");
	});

	it("does not signal a reused pid when a conflicting lease prevents adoption", async () => {
		const workspaceDir = createTempWorkspace();
		const channelId = "dingtalk:dm:adopt_pid_mismatch";
		const stateDir = join(workspaceDir, "state");
		const artifactDir = join(workspaceDir, channelId, "subagent-artifacts", "run-pid-mismatch");
		mkdirSync(artifactDir, { recursive: true });
		const readyPath = join(workspaceDir, "pid-mismatch-ready.txt");
		const childScript = join(workspaceDir, "pid-mismatch.cjs");
		writeFileSync(
			childScript,
			`require("node:fs").writeFileSync(${JSON.stringify(readyPath)},"ready");setInterval(()=>{},1000);`,
		);
		const child = spawn(process.execPath, [childScript], {
			detached: true,
			stdio: "ignore",
		});
		child.unref();
		await waitFor(() => child.pid !== undefined && existsSync(readyPath));
		const pid = child.pid!;
		childGroups.add(pid);

		const firstDaemon = createManager(channelId, { stateDir });
		const originalLease = claimWorkspaceLease({
			runId: "run-pid-mismatch",
			channelId,
			workingDirectory: workspaceDir,
		});
		expect(originalLease.ok).toBe(true);
		try {
			await firstDaemon.register({
				runId: "run-pid-mismatch",
				channelId,
				runtime: "external",
				harness: "codex-cli",
				agent: "builder",
				label: "pid mismatch",
				source: "inline",
				tools: [],
				purpose: "work",
				workingDirectory: workspaceDir,
				artifactDir,
				leaseKey: originalLease.ok ? originalLease.leaseKey : undefined,
				mutates: "write",
			});
			await firstDaemon.setLaunched("run-pid-mismatch", {
				pid,
				pidStartedAt: "not-the-current-process-start-time",
				argv: [process.execPath],
				deadlineAt: Date.now() + 60_000,
			});
			releaseWorkspaceLease(originalLease.ok ? originalLease.leaseKey : undefined, "run-pid-mismatch");
			firstDaemon.stop();

			const otherLease = claimWorkspaceLease({
				runId: "other-writer-mismatch",
				channelId: "other-mismatch",
				workingDirectory: workspaceDir,
			});
			expect(otherLease.ok).toBe(true);
			try {
				const secondDaemon = createManager(channelId, { stateDir });
				await secondDaemon.restore();

				const record = secondDaemon.get("run-pid-mismatch");
				expect(record?.status).toBe("lost");
				expect(record?.failureReason).toContain("identity did not match");
				// A pid now belonging to another process is evidence that the original child is gone;
				// restore must not signal the live replacement while resolving the lease conflict.
				expect(() => process.kill(pid, 0)).not.toThrow();
				expect(
					claimWorkspaceLease({
						runId: "third-writer-mismatch",
						channelId: "third-mismatch",
						workingDirectory: workspaceDir,
					}).ok,
				).toBe(false);
			} finally {
				releaseWorkspaceLease(otherLease.ok ? otherLease.leaseKey : undefined, "other-writer-mismatch");
			}
		} finally {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				// The child may already have been terminated by a failing assertion.
			}
			releaseWorkspaceLease(originalLease.ok ? originalLease.leaseKey : undefined, "run-pid-mismatch");
		}
	});

	// Spec 042, D1: before this fix, restart reconciliation settled a run using whatever zeroed
	// `record.usage` register() had left behind, while still reporting `usageKnown: true` — a run
	// that finished after the daemon disappeared showed up as "0 tokens, $0.00, known" instead of
	// carrying the usage the process actually reported. `finalizeExternalRun` (shared with the live
	// post-exit path) closes that by parsing `events.jsonl` on the reconciliation path too.
	it("reconciles a completed run's usage, output, and session id across a restart instead of a false 'known zero'", async () => {
		const workspaceDir = createTempWorkspace();
		const channelId = "dingtalk:dm:usage_restart";
		const stateDir = join(workspaceDir, "state");
		const artifactDir = join(workspaceDir, channelId, "subagent-artifacts", "run-usage");
		mkdirSync(artifactDir, { recursive: true });

		// The process has already exited by the time reconciliation runs; events.jsonl already
		// holds what a live codex-cli process would have written before it died.
		const pid = await spawnAndWaitExit();
		writeFileSync(
			join(artifactDir, "events.jsonl"),
			`${[
				JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "All checks pass." } }),
				JSON.stringify({
					type: "turn.completed",
					thread_id: "th_restart",
					usage: { input_tokens: 120, output_tokens: 45 },
				}),
			].join("\n")}\n`,
		);

		const firstDaemon = createManager(channelId, { stateDir });
		await firstDaemon.register({
			runId: "run-usage",
			channelId,
			runtime: "external",
			harness: "codex-cli",
			agent: "worker",
			label: "usage across restart",
			source: "inline",
			tools: [],
			purpose: "work",
			workingDirectory: workspaceDir,
			artifactDir,
		});
		await firstDaemon.setLaunched("run-usage", {
			pid,
			argv: [process.execPath],
			deadlineAt: Date.now() + 60_000,
			maxWallTimeSec: 60,
			processStartedAt: Date.now(),
		});
		firstDaemon.stop();

		const dispatched: unknown[] = [];
		const secondDaemon = createManager(channelId, {
			stateDir,
			dispatch: (event) => {
				dispatched.push(event);
				return true;
			},
		});
		await secondDaemon.restore();

		const record = secondDaemon.get("run-usage");
		expect(record?.status).toBe("completed");
		expect(record?.usage.input).toBe(120);
		expect(record?.usage.output).toBe(45);
		expect(record?.usageKnown).toBe(true);
		expect(record?.sessionId).toBe("th_restart");
		// The reconciled duration is an estimate (from events.jsonl's mtime), not a measured
		// process lifetime — it must be flagged as such rather than presented as precise.
		expect(record?.durationEstimated).toBe(true);
		expect(dispatched).toHaveLength(1);
	});

	// Spec 042, D1: the same defect as above, for `purpose=verify` — a verify run that completed
	// after a restart used to lose its verdict. Spec 052: the verdict is now plain recorded
	// information, so what must survive the restart is the verdict itself and the task's log.
	it("keeps a purpose=verify run's declared verdict and logs its settlement when it completes across a restart", async () => {
		const workspaceDir = createTempWorkspace();
		const channelId = "dingtalk:dm:verify_restart";
		const deskDir = join(workspaceDir, channelId);
		const stateDir = join(workspaceDir, "state");
		const artifactDir = join(deskDir, "subagent-artifacts", "run-verify");
		mkdirSync(artifactDir, { recursive: true });
		mkdirSync(join(deskDir, "tasks"), { recursive: true });
		writeFileSync(join(deskDir, "tasks", "ship.md"), "---\nstate: open\n---\n# Ship\n\n## DoD\n- [ ] checks pass\n");
		const projectDir = join(workspaceDir, "project");
		mkdirSync(projectDir, { recursive: true });

		const pid = await spawnAndWaitExit();
		writeFileSync(
			join(artifactDir, "events.jsonl"),
			`${[
				JSON.stringify({
					type: "item.completed",
					item: { type: "agent_message", text: "Checked everything.\nVERDICT: PASS" },
				}),
				JSON.stringify({ type: "turn.completed", thread_id: "th_verify" }),
			].join("\n")}\n`,
		);

		const firstDaemon = createManager(channelId, { stateDir }, deskDir);
		const lease = claimWorkspaceLease({ runId: "run-verify", channelId, workingDirectory: projectDir });
		expect(lease.ok).toBe(true);
		await firstDaemon.register({
			runId: "run-verify",
			channelId,
			runtime: "external",
			harness: "codex-cli",
			agent: "checker",
			label: "verify across restart",
			source: "inline",
			tools: [],
			purpose: "verify",
			taskId: "ship",
			workingDirectory: projectDir,
			artifactDir,
			deskDir,
			leaseKey: lease.ok ? lease.leaseKey : undefined,
			mutates: "write",
		});
		await firstDaemon.setLaunched("run-verify", {
			pid,
			argv: [process.execPath],
			deadlineAt: Date.now() + 60_000,
			maxWallTimeSec: 60,
			processStartedAt: Date.now(),
			deskDir,
		});

		firstDaemon.stop();
		releaseWorkspaceLease(lease.ok ? lease.leaseKey : undefined, "run-verify");
		const secondDaemon = createManager(channelId, { stateDir }, deskDir);
		await secondDaemon.restore();

		const record = secondDaemon.get("run-verify");
		expect(record?.status).toBe("completed");
		expect(record?.verificationVerdict).toBe("pass");
		const settled = (await readTaskLog(deskDir, "ship", { kinds: ["settle"] }))[0];
		expect(settled).toMatchObject({ ref: "run-verify", status: "completed", verdict: "pass" });
		await resetTaskLogAppenders();
	});
});
