import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readProcessStartTime } from "../src/shared/host-process.js";
import { SubAgentRunManager } from "../src/subagents/runs.js";
import { acquireWorkspaceLease, releaseWorkspaceLease } from "../src/subagents/workspace-lease.js";
import { workspaceSubjectHash } from "../src/tasks/artifact-subject.js";
import { verificationAttestationPath } from "../src/tasks/verification.js";
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

function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const tick = async () => {
			if (await predicate()) return resolve();
			if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
			setTimeout(tick, 20);
		};
		void tick();
	});
}

describe("SubAgentRunManager restart adoption (spec 040, D10.3)", () => {
	it("rebuilds the write lease for a still-alive adopted run, enforces its deadline once, and settles exactly once", async () => {
		const workspaceDir = createTempWorkspace();
		const channelId = "dm_adopt";
		const stateDir = join(workspaceDir, "state");
		const artifactDir = join(workspaceDir, channelId, "subagent-artifacts", "run-adopt");
		mkdirSync(artifactDir, { recursive: true });

		// A long-lived detached process that writes a marker file after 1s if left alone.
		const marker = join(workspaceDir, "late-write.txt");
		const script = join(workspaceDir, "leader.cjs");
		writeFileSync(
			script,
			`setTimeout(()=>require("node:fs").writeFileSync(${JSON.stringify(marker)},"late"),1000);setInterval(()=>{},1000);`,
		);
		const child = spawn(process.execPath, [script], { detached: true, stdio: "ignore" });
		child.unref();
		await waitFor(() => child.pid !== undefined);
		const pid = child.pid!;
		const pidStartedAt = await readProcessStartTime(pid);

		// "First daemon": registers the run, takes its write lease, records the launch — then
		// vanishes without ever calling settle(), exactly like a daemon that dies mid-run.
		const firstDaemon = new SubAgentRunManager(channelId, { stateDir });
		const lease = acquireWorkspaceLease({ runId: "run-adopt", channelId, workingDirectory: workspaceDir });
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
		releaseWorkspaceLease(lease.ok ? lease.leaseKey : undefined, "run-adopt");

		const secondDaemon = new SubAgentRunManager(channelId, { stateDir });
		const restoredCount = await secondDaemon.restore();
		expect(restoredCount).toBe(1);
		expect(secondDaemon.get("run-adopt")?.status).toBe("running"); // still genuinely alive — left alone

		// The lease is rebuilt: a competing write dispatch to the same workspace is refused.
		const competing = acquireWorkspaceLease({ runId: "competing", channelId, workingDirectory: workspaceDir });
		expect(competing.ok).toBe(false);

		// A third "daemon" adopts the run shortly before its persisted deadline. It must install one
		// deadline check, kill the real process, and settle it as a timeout failure without a periodic
		// poller or falling back to the "no protocol terminal" guess. Simulated the same way as the
		// first→second transition: release the second daemon's process-local lease first.
		releaseWorkspaceLease(secondDaemon.get("run-adopt")?.leaseKey, "run-adopt");
		const recordPath = join(stateDir, channelId, "run-adopt.json");
		const persisted = JSON.parse(readFileSync(recordPath, "utf-8"));
		persisted.deadlineAt = Date.now() + 100;
		writeFileSync(recordPath, `${JSON.stringify(persisted)}\n`, "utf-8");
		const dispatched: unknown[] = [];
		const swept = new SubAgentRunManager(channelId, {
			stateDir,
			dispatch: (event) => {
				dispatched.push(event);
				return true;
			},
		});
		await swept.restore();
		await waitFor(() => swept.get("run-adopt")?.status !== "running" && dispatched.length === 1, 10_000);

		expect(swept.get("run-adopt")?.status).toBe("failed");
		expect(swept.get("run-adopt")?.failureReason).toContain("Wall time budget exceeded");
		expect(existsSync(marker)).toBe(false); // killed before it could write
		expect(dispatched).toHaveLength(1);

		// Another restart must not double-kill or re-announce the already-settled run.
		const repeated = new SubAgentRunManager(channelId, {
			stateDir,
			dispatch: (event) => {
				dispatched.push(event);
				return true;
			},
		});
		await repeated.restore();
		expect(dispatched).toHaveLength(1);

		// The lease was released once the run went terminal.
		const afterLease = acquireWorkspaceLease({ runId: "after", channelId, workingDirectory: workspaceDir });
		expect(afterLease.ok).toBe(true);
		if (afterLease.ok) releaseWorkspaceLease(afterLease.leaseKey, "after");
	}, 15_000);

	// Spec 042, D1: before this fix, restart reconciliation settled a run using whatever zeroed
	// `record.usage` register() had left behind, while still reporting `usageKnown: true` — a run
	// that finished after the daemon disappeared showed up as "0 tokens, $0.00, known" instead of
	// carrying the usage the process actually reported. `finalizeExternalRun` (shared with the live
	// post-exit path) closes that by parsing `events.jsonl` on the reconciliation path too.
	it("reconciles a completed run's usage, output, and session id across a restart instead of a false 'known zero'", async () => {
		const workspaceDir = createTempWorkspace();
		const channelId = "dm_usage_restart";
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

		const firstDaemon = new SubAgentRunManager(channelId, { stateDir });
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

		const dispatched: unknown[] = [];
		const secondDaemon = new SubAgentRunManager(channelId, {
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

	// Spec 042, D1: the same defect as above, for `purpose=verify` — before this fix, restart
	// reconciliation never wrote a verify attestation at all (it had no path to `writeVerificationAttestation`
	// and no persisted `verifySubjectBefore`/`channelDir` to call it with), so a verify run that
	// completed after a restart silently lost its verdict.
	it("writes a verify attestation for a purpose=verify run that completes across a restart", async () => {
		const workspaceDir = createTempWorkspace();
		const channelId = "dm_verify_restart";
		const channelDir = join(workspaceDir, channelId);
		const stateDir = join(workspaceDir, "state");
		const artifactDir = join(channelDir, "subagent-artifacts", "run-verify");
		mkdirSync(artifactDir, { recursive: true });
		mkdirSync(join(channelDir, "tasks"), { recursive: true });
		writeFileSync(join(channelDir, "tasks", "ship.md"), "---\nstatus: open\n---\n# Ship\n\n## DoD\n- checks pass\n");

		// The verified checkout is a separate directory from the daemon's own state/artifacts
		// (channelDir/stateDir live under workspaceDir) — otherwise the daemon's own bookkeeping
		// writes would themselves register as "workspace changed" against the checkout being judged.
		// A real Git repo with a committed baseline, unchanged before the "after" hash is taken below:
		// `resolveVerificationOutcome` now fails closed when it cannot compare a before/after subject
		// at all (review 2026-08-23 §2.2), so a real comparable pair is required to exercise the pass
		// path end-to-end rather than relying on the old "can't tell, so assume unchanged" gap.
		const projectDir = join(workspaceDir, "project");
		mkdirSync(projectDir, { recursive: true });
		execFileSync("git", ["init"], { cwd: projectDir });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: projectDir });
		execFileSync("git", ["config", "user.name", "Test"], { cwd: projectDir });
		writeFileSync(join(projectDir, "README.md"), "checkout\n");
		execFileSync("git", ["add", "."], { cwd: projectDir });
		execFileSync("git", ["commit", "-m", "baseline"], { cwd: projectDir });
		const verifySubjectBefore = await workspaceSubjectHash(projectDir);

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

		const firstDaemon = new SubAgentRunManager(channelId, { stateDir });
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
		});
		await firstDaemon.setLaunched("run-verify", {
			pid,
			argv: [process.execPath],
			deadlineAt: Date.now() + 60_000,
			maxWallTimeSec: 60,
			processStartedAt: Date.now(),
			channelDir,
			verifySubjectBefore,
		});

		const secondDaemon = new SubAgentRunManager(channelId, { stateDir });
		await secondDaemon.restore();

		const record = secondDaemon.get("run-verify");
		expect(record?.status).toBe("completed");
		expect(record?.verificationVerdict).toBe("pass");
		expect(record?.verificationStrength).toBe("advisory");

		const attestation = JSON.parse(readFileSync(verificationAttestationPath(channelDir, "run-verify"), "utf-8"));
		expect(attestation.verdict).toBe("pass");
		expect(attestation.verificationStrength).toBe("advisory");
	});
});
