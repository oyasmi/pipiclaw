import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { isProcessGroupAlive, killProcessGroup, reapProcessGroup } from "../src/shared/host-process.js";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.skipIf(process.platform !== "linux")("host-process (Linux process-group kill)", () => {
	it("kills a descendant that outlives its process-group leader (the leader-only liveness check regression)", async () => {
		// The leader (a shell) backgrounds `sleep 2` and exits immediately. Non-interactive shells
		// have job control off, so the background job stays in the leader's own process group —
		// this reproduces "leader gone, descendant still holds the group" without any manual setsid.
		const leader = spawn("/bin/sh", ["-c", "sleep 2 & exit 0"], { detached: true });
		const pgid = leader.pid!;
		await new Promise((resolve) => leader.once("exit", resolve));
		await sleep(30);
		expect(isProcessGroupAlive(pgid)).toBe(true); // the descendant is still running

		await killProcessGroup(pgid, 50);
		await sleep(30);
		expect(isProcessGroupAlive(pgid)).toBe(false);
	}, 10_000);

	it("killProcessGroup on an already-gone group is a harmless no-op", async () => {
		const child = spawn("true", [], { detached: true });
		await new Promise((resolve) => child.once("exit", resolve));
		await sleep(10);
		await expect(killProcessGroup(child.pid!, 10)).resolves.toBeUndefined();
	});

	// Spec 042, D8: the normal-exit cleanup path should not pay killProcessGroup's grace period on
	// every single run — reapProcessGroup must return immediately (no signal, no wait) when the
	// group is already empty, which is the common case.
	it("reapProcessGroup on an already-empty group returns immediately, without waiting out a grace period", async () => {
		const child = spawn("true", [], { detached: true });
		await new Promise((resolve) => child.once("exit", resolve));
		await sleep(10);
		expect(isProcessGroupAlive(child.pid!)).toBe(false);

		const start = Date.now();
		await reapProcessGroup(child.pid!);
		// killProcessGroup's own grace defaults to 5s; a well-under-that elapsed time proves this
		// path never entered the TERM-then-wait-then-KILL sequence at all.
		expect(Date.now() - start).toBeLessThan(1_000);
	});

	// The rare branch: a descendant outlived its already-exited leader. reapProcessGroup must still
	// terminate it — it degrades to killProcessGroup's own sequence, just off the common hot path.
	it("reapProcessGroup terminates a lingering descendant when the group is not actually empty", async () => {
		const leader = spawn("/bin/sh", ["-c", "sleep 2 & exit 0"], { detached: true });
		const pgid = leader.pid!;
		await new Promise((resolve) => leader.once("exit", resolve));
		await sleep(30);
		expect(isProcessGroupAlive(pgid)).toBe(true);

		await reapProcessGroup(pgid); // resolves only after its own 300ms grace on this branch
		await sleep(30);
		expect(isProcessGroupAlive(pgid)).toBe(false);
	}, 10_000);
});
