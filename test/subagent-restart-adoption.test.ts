import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readProcessStartTime } from "../src/shared/host-process.js";
import { SubAgentRunManager } from "../src/subagents/runs.js";
import { acquireWorkspaceLease, releaseWorkspaceLease } from "../src/subagents/workspace-lease.js";
import { useTempDirs } from "./helpers/fixtures.js";

/**
 * Spec 040, D10.3 (P0-1): a restart must genuinely re-adopt a still-running external run, not
 * just probe it once — rebuild its write lease, keep enforcing its deadline via the sweeper, and
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
	it("rebuilds the write lease for a still-alive adopted run, enforces its deadline via sweep, and settles it exactly once", async () => {
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
		releaseWorkspaceLease(lease.ok ? lease.leaseKey : undefined);

		const secondDaemon = new SubAgentRunManager(channelId, { stateDir });
		const restoredCount = await secondDaemon.restore();
		expect(restoredCount).toBe(1);
		expect(secondDaemon.get("run-adopt")?.status).toBe("running"); // still genuinely alive — left alone

		// The lease is rebuilt: a competing write dispatch to the same workspace is refused.
		const competing = acquireWorkspaceLease({ runId: "competing", channelId, workingDirectory: workspaceDir });
		expect(competing.ok).toBe(false);

		// A third "daemon" (or the same one's periodic sweep tick) with `now` pushed past any
		// deadline this run could have — this must kill the real process and settle it as a
		// timeout failure, without ever falling back to the "no protocol terminal" guess.
		const dispatched: unknown[] = [];
		const swept = new SubAgentRunManager(channelId, {
			stateDir,
			dispatch: (event) => {
				dispatched.push(event);
				return true;
			},
		});
		await swept.restore();
		await waitFor(async () => {
			await swept.sweep(Date.now() + 999_999);
			return swept.get("run-adopt")?.status !== "running";
		});

		expect(swept.get("run-adopt")?.status).toBe("failed");
		expect(swept.get("run-adopt")?.failureReason).toContain("Wall time budget exceeded");
		expect(existsSync(marker)).toBe(false); // killed before it could write
		expect(dispatched).toHaveLength(1);

		// A later sweep tick (production runs one every 30s) must not double-kill or re-announce.
		await swept.sweep();
		expect(dispatched).toHaveLength(1);

		// The lease was released once the run went terminal.
		const afterLease = acquireWorkspaceLease({ runId: "after", channelId, workingDirectory: workspaceDir });
		expect(afterLease.ok).toBe(true);
		if (afterLease.ok) releaseWorkspaceLease(afterLease.leaseKey);
	}, 15_000);
});
