import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { killProcessGroup } from "../src/shared/host-process.js";

function groupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch {
		return false;
	}
}

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
		await sleep(100);
		expect(groupAlive(pgid)).toBe(true); // the descendant is still running

		await killProcessGroup(pgid, 50);
		await sleep(100);
		expect(groupAlive(pgid)).toBe(false);
	}, 10_000);

	it("killProcessGroup on an already-gone group is a harmless no-op", async () => {
		const child = spawn("true", [], { detached: true });
		await new Promise((resolve) => child.once("exit", resolve));
		await sleep(50);
		await expect(killProcessGroup(child.pid!, 10)).resolves.toBeUndefined();
	});
});
