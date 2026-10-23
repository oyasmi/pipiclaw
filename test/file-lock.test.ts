import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireFileLock, FileLockTimeoutError, withFileLock } from "../src/shared/file-lock.js";
import { useTempDirs } from "./helpers/fixtures.js";
import { spawnLockHolder, spawnPausedReclaimer } from "./helpers/lock-holder.js";

/**
 * Spec 058, D6/INV-6: the daemon and a TUI may write the same desk, so memory, task and desk.json
 * writers hold a cross-process lock. Every case here uses a real second process — an in-process
 * fake could pass while the on-disk protocol is broken.
 */
describe("cross-process file lock", () => {
	const makeDir = useTempDirs("pipiclaw-file-lock-");

	it("waits for another process to release before entering", async () => {
		const lockPath = join(makeDir(), ".locks", "memory.lock");
		const holder = await spawnLockHolder(lockPath);
		const order: string[] = [];
		const entered = withFileLock(
			lockPath,
			async () => {
				order.push("entered");
			},
			{ timeoutMs: 10_000 },
		);
		await new Promise((resolve) => setTimeout(resolve, 150));
		order.push("releasing");
		await holder.release();
		await entered;
		// Failure caught: the lock is advisory only within one process (a second process walks in).
		expect(order).toEqual(["releasing", "entered"]);
		expect(existsSync(lockPath)).toBe(false);
	});

	it("gives up with the holder's pid after the timeout", async () => {
		const lockPath = join(makeDir(), "task-a.lock");
		const holder = await spawnLockHolder(lockPath);
		try {
			const error = await withFileLock(lockPath, async () => "ran", { timeoutMs: 200 }).catch((e: unknown) => e);
			// Failure caught: a waiter that never times out would hang a tool call forever.
			expect(error).toBeInstanceOf(FileLockTimeoutError);
			expect((error as FileLockTimeoutError).heldBy?.pid).toBe(holder.pid);
		} finally {
			await holder.release();
		}
	});

	it("reclaims a lock whose holder died, one reclaimer at a time", async () => {
		const lockPath = join(makeDir(), "desk-json.lock");
		const holder = await spawnLockHolder(lockPath);
		await holder.kill();
		// A reclaimer took the guard and was descheduled just before unlinking the dead lock — for
		// longer than any reclaim takes.
		const reclaimer = await spawnPausedReclaimer(lockPath);
		const guard = `${lockPath}.reclaim`;
		const longAgo = new Date(Date.now() - 60_000);
		utimesSync(guard, longAgo, longAgo);
		const blocked = await withFileLock(lockPath, async () => "ran", { timeoutMs: 300 }).catch((e: unknown) => e);
		// Failure caught: taking an old guard away let this process reclaim and enter, after which
		// the woken reclaimer unlinked our live lock and entered too — two holders at once.
		// Mutation check (run: goes red): restore the age-based guard removal in `reclaimStale`.
		expect(blocked).toBeInstanceOf(FileLockTimeoutError);
		expect((blocked as Error).message).toContain(guard);
		expect(existsSync(guard)).toBe(true);
		await reclaimer.resume();
		await reclaimer.release();
		// Failure caught: a crashed TUI would otherwise lock its desk's memory until a human intervened.
		await expect(withFileLock(lockPath, async () => "ran", { timeoutMs: 2_000 })).resolves.toBe("ran");
		expect(existsSync(guard)).toBe(false);
	});

	it("never removes a lock it does not hold", async () => {
		const lockPath = join(makeDir(), "memory.lock");
		const first = await acquireFileLock(lockPath);
		if (first.kind !== "acquired") throw new Error("expected to acquire");
		// Someone else's lock now sits at the path (ours was removed out from under us).
		const foreign = JSON.stringify({ pid: 1, hostname: hostname(), acquiredAt: "x", token: "foreign" });
		writeFileSync(lockPath, foreign);
		await first.handle.release();
		// Failure caught: an over-eager release would free a lock another process is relying on.
		expect(readFileSync(lockPath, "utf-8")).toBe(foreign);
		const second = await acquireFileLock(lockPath);
		expect(second).toMatchObject({ kind: "held", heldBy: { pid: 1 } });
	});
});
