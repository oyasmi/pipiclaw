import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireFileLock, FileLockTimeoutError, withFileLock } from "../src/shared/file-lock.js";
import { useTempDirs } from "./helpers/fixtures.js";
import { spawnLockHolder } from "./helpers/lock-holder.js";

/**
 * Spec 058, D6/INV-6: the daemon and a TUI may write the same dot, so memory, task and dot.json
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

	it("reclaims a lock whose holder died", async () => {
		const lockPath = join(makeDir(), "dot-json.lock");
		const holder = await spawnLockHolder(lockPath);
		await holder.kill();
		expect(existsSync(lockPath)).toBe(true);
		// …and a reclaimer died too, inside its reclaim guard.
		const guard = `${lockPath}.reclaim`;
		writeFileSync(guard, "");
		const longAgo = new Date(Date.now() - 60_000);
		utimesSync(guard, longAgo, longAgo);
		// Failure caught: a crashed TUI (or a crashed reclaimer) would otherwise lock its dot's
		// memory until a human intervened.
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
