import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Stateless host-process operations shared by background jobs and external delegation runs
 * (spec 040, D1): a liveness probe and a process-group kill. Nothing here is job- or run-specific
 * — both callers bring their own persisted pid and decide what "gone" means for their own state
 * machine. `job-manager.ts` still probes through its shell `Executor` (its jobs are shell
 * children); this is for callers that spawn argv-direct, detached children of their own (D3/D4).
 */

const execFileAsync = promisify(execFile);

/**
 * A live pid's start time, as `ps` reports it — the only OS-verifiable way to tell a still-running
 * process apart from an unrelated one that later reused the same pid (spec 040, D10.3). `undefined`
 * when the pid is gone or `ps` itself is unavailable; callers must treat that as "cannot verify",
 * never as proof either way.
 */
export async function readProcessStartTime(pid: number): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="]);
		const value = stdout.trim();
		return value || undefined;
	} catch {
		return undefined;
	}
}

/** True if `pid` names a live process this user can at least see, without sending a real signal. */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to someone else — still alive from our view.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * SIGTERM the process group, then unconditionally SIGKILL it after a short grace period.
 * `detached: true` at spawn time makes the child its own process-group leader, so `-pid` reaches
 * it and everything it spawned.
 *
 * The SIGKILL is not gated on a liveness probe of the leader pid: a leader that exits before a
 * lingering descendant (e.g. a shell that forked and returned) would make `isProcessAlive(pid)`
 * report false while the descendant is still alive and still holding the workspace, so probing
 * only the leader and skipping the SIGKILL on that basis is exactly the wrong direction to err in.
 * A dead group simply makes the SIGKILL a harmless ESRCH, caught below.
 */
export async function killProcessGroup(pid: number, graceMs = 300): Promise<void> {
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		return; // Already gone.
	}
	await new Promise((resolve) => setTimeout(resolve, graceMs));
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		// Already gone.
	}
}
