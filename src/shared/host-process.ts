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

const CLI_VERSION_PROBE_TIMEOUT_MS = 1_000;
const CLI_VERSION_MAX_CHARS = 200;

/**
 * Best-effort `<executable> --version`, so a run persists which build of the target CLI it ran
 * against (spec 042 D12) — the other half of `parserVersion`'s "adapter drift vs. agent failure"
 * diagnosis. `undefined` on any failure or timeout; this must never block or fail a dispatch over
 * a CLI that does not support `--version`, is slow to start, or fails outright.
 */
export async function probeCliVersion(executable: string): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync(executable, ["--version"], { timeout: CLI_VERSION_PROBE_TIMEOUT_MS });
		const value = stdout.trim().split("\n")[0]?.slice(0, CLI_VERSION_MAX_CHARS);
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

/** True if any process in `pid`'s process group is still alive — probes the *group* (`-pid`), not
 *  just the leader, so a leader that already exited while a lingering descendant (e.g. a shell
 *  that forked and returned) is still running is correctly reported as "still something there". */
export function isProcessGroupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Spec 042 D8: cancel/timeout grace before SIGKILL — long enough for a coding agent CLI to flush
 * its protocol terminal event and buffered output before being force-killed (300ms was rarely
 * enough for that, which is why D1's "keep parsed output on cancel/timeout" fix had little to
 * actually keep). Not used on the normal-exit path below, so it costs nothing on the common case.
 */
const KILL_GRACE_MS = 5_000;
/** Grace for `reapProcessGroup`'s rare non-empty branch — a lingering descendant outliving its
 *  already-exited leader is not the hot path a normal exit takes, so this stays short. */
const REAP_GRACE_MS = 300;

/**
 * SIGTERM the process group, then unconditionally SIGKILL it after `graceMs`. `detached: true` at
 * spawn time makes the child its own process-group leader, so `-pid` reaches it and everything it
 * spawned. The SIGKILL is not gated on a liveness probe first: a dead group simply makes it a
 * harmless ESRCH, caught below — probing first would only add a syscall on the already-rare path
 * where this function is used to actually terminate something (cancel/timeout, not a normal exit).
 */
export async function killProcessGroup(pid: number, graceMs = KILL_GRACE_MS): Promise<void> {
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

/**
 * Spec 042 D8: cleanup after a *normal* exit, as opposed to `killProcessGroup`'s explicit
 * cancel/timeout termination. The common case — nothing left in the group — returns immediately
 * with no signal and no wait, so a normal settlement no longer pays `killProcessGroup`'s grace
 * period on every single run. The rare case — a descendant outlived its already-exited leader —
 * still needs terminating, so it falls through to the same TERM-then-KILL sequence, just off the
 * hot path and with a short grace since a genuinely finished CLI has nothing left to flush.
 */
export async function reapProcessGroup(pid: number): Promise<void> {
	if (!isProcessGroupAlive(pid)) return;
	await killProcessGroup(pid, REAP_GRACE_MS);
}
