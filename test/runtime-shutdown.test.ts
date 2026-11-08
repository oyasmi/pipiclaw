import { afterEach, expect, it, vi } from "vitest";
import type { ChannelIndex } from "../src/channel/channel-index.js";
import type { ChannelStore } from "../src/channel/store.js";
import * as log from "../src/log.js";
import { createShutdown } from "../src/runtime/shutdown.js";
import { createFakeRunner } from "./support/fake-runner.js";

vi.mock("../src/usage/ledger.js", () => ({ getUsageLedger: () => ({ flush: async () => {} }) }));
vi.mock("../src/security/logger.js", () => ({ flushSecurityLogs: async () => {} }));
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

it("bounds hung aborts and all shutdown phases, retaining the lock while noncancellable writers remain", async () => {
	// Mutation 2026-11-08: omitting the final activeTasks check releases the lock in late-disposal mode (confirmed red).
	// Risk: abort() never settles, or a timed-out writer outlives lock release and races the next runtime.
	vi.useFakeTimers();
	const warn = vi.spyOn(log, "logWarn").mockImplementation(() => {});
	vi.spyOn(log, "flushLogging").mockResolvedValue();
	for (const mode of ["turn", "storage", "late-disposal", "clean"]) {
		let end!: () => void;
		const pending = new Promise<void>((resolve) => {
			end = resolve;
		});
		let rejectAbort!: (error: Error) => void;
		const abort = new Promise<void>((_resolve, reject) => {
			rejectAbort = reject;
		});
		const runner = createFakeRunner({ abort: () => abort, retireForRecovery: vi.fn() });
		const activeTasks = new Set<Promise<void>>();
		if (mode === "turn") {
			runner.beginTurn("held");
			activeTasks.add(pending);
		}
		const release = vi.fn(async () => {});
		const stop = () => {};
		const shutdown = createShutdown({
			taskLane: { stop },
			getDurableDispatch: () => undefined,
			memoryMaintenanceScheduler: { stop },
			deskRuntime: { stop },
			runs: { stop },
			jobs: { stop },
			ingress: { stop },
			transports: { stopAcceptingAll: async () => {}, stopAll: async () => {} },
			store: {
				close: () => {
					if (mode === "late-disposal") activeTasks.add(pending);
					return mode === "storage" ? pending : Promise.resolve();
				},
			} as unknown as ChannelStore,
			channelIndex: { close: async () => {} } as unknown as ChannelIndex,
			channelRunners: new Map([["channel", runner]]),
			activeTasks,
			markShuttingDown: stop,
			releaseDaemonLock: release,
		});
		let done = false;
		const result = shutdown().then(() => {
			done = true;
		});
		await vi.advanceTimersByTimeAsync(90_000);
		expect(done, mode).toBe(true);
		await result;
		expect(release).toHaveBeenCalledTimes(mode === "clean" ? 1 : 0);
		if (mode === "turn") expect(runner.retireForRecovery).toHaveBeenCalledOnce();
		const warnings = warn.mock.calls.length;
		if (mode === "turn") rejectAbort(new Error("late abort"));
		else void abort.catch(() => {});
		end();
		await vi.advanceTimersByTimeAsync(0);
		expect(warn.mock.calls).toHaveLength(warnings);
	}
});
