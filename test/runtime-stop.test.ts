import { afterEach, expect, it, vi } from "vitest";
import { createBusyHandlers } from "../src/runtime/ingress-busy.js";
import type { IngressDeps } from "../src/runtime/ingress-deps.js";
import { createFakeRunner } from "./support/fake-runner.js";

afterEach(() => vi.useRealTimers());

it("registers B after replacing stopped A and prevents A's late cleanup from removing B's watchdog", async () => {
	// Mutations 2026-11-08: channel-only admission and unconditional old cleanup each fail (confirmed red).
	// Risk: a channel-only Set suppresses B's watchdog; unconditional A cleanup can erase B's registration.
	vi.useFakeTimers();
	const a = createFakeRunner();
	const b = createFakeRunner({ retireForRecovery: vi.fn() });
	const channel = "dingtalk:dm:1";
	const runners = new Map([[channel, a]]);
	const watchdogs: IngressDeps["stopWatchdogs"] = new Map();
	const reset = vi.fn(() => 0);
	let shutdown = false;
	const handlers = createBusyHandlers(
		{
			options: { stopForceEndGraceMs: 500 },
			channelRunners: runners,
			stopWatchdogs: watchdogs,
			getRunner: () => runners.get(channel),
			isShuttingDown: () => shutdown,
			getDurableDispatch: () => undefined,
			pushTo: vi.fn(async () => true),
		} as unknown as IngressDeps,
		{ clearPending: () => 0, reset },
	);
	a.beginTurn("A");
	await handlers.handleStop(channel);
	await vi.advanceTimersByTimeAsync(100);
	runners.set(channel, b);
	b.beginTurn("B");
	await handlers.handleStop(channel);
	const registration = watchdogs.get(channel);
	expect(registration?.runner).toBe(b);
	await vi.advanceTimersByTimeAsync(150); // A wakes, notices replacement, and runs its finally.
	expect(watchdogs.get(channel)).toBe(registration);
	await vi.advanceTimersByTimeAsync(350);
	expect(b.retireForRecovery).toHaveBeenCalledOnce();
	expect(reset).toHaveBeenCalledOnce();
	expect(runners.has(channel)).toBe(false);
	// A watchdog already sleeping when shutdown begins must never recover or notify later.
	runners.set(channel, a);
	a.endTurn();
	a.beginTurn("next");
	await handlers.handleStop(channel);
	shutdown = true;
	await vi.advanceTimersByTimeAsync(500);
	expect(reset).toHaveBeenCalledOnce();
});
