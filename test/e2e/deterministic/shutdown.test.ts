import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { crash, startDaemon } from "../../support/daemon-process.js";
import { startMockProvider } from "../../support/mock-provider/server.js";
import { bindChannelOnDisk, reply } from "../../support/runtime-harness.js";
import { cleanupE2ETestHome, createDeterministicHome } from "../../support/setup.js";

it("exits a real daemon with a never-returning abort and keeps its home locked until process exit", async () => {
	// Mutation 2026-11-08: restore unbounded allSettled(aborts); the child never exits and the 30s IPC deadline fails.
	// Risk: SIGTERM waits forever in abort(), or releases the writer lock while an old callback survives.
	// Unit fake clocks cover the total budget; this case proves bootstrap → signal → exit → fresh-process lock recovery.
	const model = await startMockProvider();
	const home = createDeterministicHome({ mockBaseUrl: model.baseUrl });
	const channel = "dingtalk:dm:e2e_user";
	let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
	const gate = model.script.hold({ when: (r) => r.isMainTurn });
	model.script.route({ name: "held", when: (r) => r.isMainTurn, respond: [reply.text("held")], repeat: true });
	try {
		await bindChannelOnDisk(home.workspaceDir, channel);
		daemon = await startDaemon(home.homeDir, "./daemon-worker.mjs", ["hung-shutdown"]);
		await daemon.call("send", { channelId: channel, text: "HOLD_SHUTDOWN" });
		await gate.arrived;
		const lock = join(home.homeDir, "state", "daemon.lock");
		const oldLock = readFileSync(lock, "utf-8");
		const exited = once(daemon.child, "exit", { signal: AbortSignal.timeout(30_000) });
		daemon.child.kill("SIGTERM");
		expect(await exited).toEqual([0, null]);
		// A live process with noncancellable work never unlocked the home. Only its exit makes this stale.
		expect(readFileSync(lock, "utf-8")).toBe(oldLock);
		gate.release();
		daemon = await startDaemon(home.homeDir);
		expect(existsSync(lock)).toBe(true);
		expect(readFileSync(lock, "utf-8")).not.toBe(oldLock);
	} finally {
		gate.release();
		if (daemon) await crash(daemon.child);
		await model.close();
		cleanupE2ETestHome(home.homeDir);
	}
});
