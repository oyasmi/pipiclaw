import { describe, expect, it, vi } from "vitest";
import { TurnStateMachine } from "../src/agent/turn-state.js";

describe("TurnStateMachine", () => {
	it("reports busy from begin until end, and carries the turn's task text", () => {
		const machine = new TurnStateMachine();
		expect(machine.isBusy()).toBe(false);

		machine.begin("build the thing");
		expect(machine.isBusy()).toBe(true);
		expect(machine.status()).toEqual({ phase: "dispatching", stopRequested: false, taskText: "build the thing" });

		machine.end();
		expect(machine.isBusy()).toBe(false);
		expect(machine.status().taskText).toBeUndefined();
	});

	describe("force-release", () => {
		it("swallows the wedged turn's late end() instead of clearing the turn that replaced it", () => {
			const machine = new TurnStateMachine();
			machine.begin("wedged turn");
			expect(machine.forceEnd("stop watchdog")).toBe(true);
			expect(machine.isBusy()).toBe(false);

			// The channel is handed to the next message while the wedged epilogue still runs.
			machine.begin("next turn");
			// ...which now finishes and releases a turn it no longer owns.
			machine.end();

			expect(machine.isBusy()).toBe(true);
			expect(machine.status().taskText).toBe("next turn");
		});

		it("absorbs one late end() per force-release, not just the first", () => {
			const machine = new TurnStateMachine();
			machine.begin("first");
			machine.forceEnd("watchdog");
			machine.begin("second");
			machine.forceEnd("watchdog");

			machine.begin("third");
			machine.end(); // first wedged turn
			machine.end(); // second wedged turn
			expect(machine.status().taskText).toBe("third");

			machine.end(); // the third turn's own release
			expect(machine.isBusy()).toBe(false);
		});

		it("does not arm an absorb when it force-ends nothing", () => {
			const machine = new TurnStateMachine();
			expect(machine.forceEnd("nothing running")).toBe(false);

			// A stale absorb here would make the next real turn un-releasable.
			machine.begin("real turn");
			machine.end();
			expect(machine.isBusy()).toBe(false);
		});

		it("reports the phase it interrupted so the operator can tell where turns wedge", () => {
			const onWarn = vi.fn();
			const machine = new TurnStateMachine(onWarn);
			machine.begin("turn");
			machine.setPhase(machine.current(), "finishing");

			machine.forceEnd("/stop did not take effect within 15000ms");
			expect(onWarn).toHaveBeenCalledWith(
				expect.stringContaining("phase=finishing"),
				expect.stringContaining("/stop did not take effect"),
			);
		});
	});

	describe("setPhase", () => {
		it("advances the turn it is addressed to", () => {
			const machine = new TurnStateMachine();
			machine.begin("turn");
			const handle = machine.current();

			machine.setPhase(handle, "preparing");
			expect(machine.phase()).toBe("preparing");
			machine.setPhase(handle, "streaming");
			expect(machine.phase()).toBe("streaming");
		});

		it("ignores a handle whose turn was already released", () => {
			const machine = new TurnStateMachine();
			machine.begin("wedged turn");
			const staleHandle = machine.current();
			machine.forceEnd("watchdog");
			machine.begin("next turn");

			// The wedged turn's epilogue still runs `setPhase(ownTurn, "finishing")`.
			machine.setPhase(staleHandle, "finishing");
			expect(machine.phase()).toBe("dispatching");
		});

		it("ignores a stale handle even while idle", () => {
			const machine = new TurnStateMachine();
			machine.begin("turn");
			const handle = machine.current();
			machine.end();

			machine.setPhase(handle, "streaming");
			expect(machine.isBusy()).toBe(false);
		});
	});

	describe("markStreaming", () => {
		it("advances only from preparing", () => {
			const machine = new TurnStateMachine();
			machine.begin("turn");

			// `message_start` before run() reached its prompt assembly must not skip a phase.
			expect(machine.markStreaming()).toBe(false);
			expect(machine.phase()).toBe("dispatching");

			machine.setPhase(machine.current(), "preparing");
			expect(machine.markStreaming()).toBe(true);
			expect(machine.phase()).toBe("streaming");
		});

		it("cannot revive a released turn", () => {
			const machine = new TurnStateMachine();
			machine.begin("turn");
			machine.setPhase(machine.current(), "preparing");
			machine.forceEnd("watchdog");

			// A late event from the abandoned agent loop arrives after the release.
			expect(machine.markStreaming()).toBe(false);
			expect(machine.isBusy()).toBe(false);
		});
	});

	describe("requestStop", () => {
		it("sticks across phase changes and does not leak into the next turn", () => {
			const machine = new TurnStateMachine();
			machine.begin("turn");
			machine.requestStop();
			machine.setPhase(machine.current(), "streaming");
			expect(machine.status().stopRequested).toBe(true);

			machine.end();
			machine.begin("next turn");
			expect(machine.status().stopRequested).toBe(false);
		});

		it("is a no-op while idle, so an unattached /stop cannot pre-arm a future turn", () => {
			const machine = new TurnStateMachine();
			machine.requestStop();
			expect(machine.isBusy()).toBe(false);

			machine.begin("turn");
			expect(machine.status().stopRequested).toBe(false);
		});
	});

	it("warns but still takes over when a turn begins while one is running", () => {
		const onWarn = vi.fn();
		const machine = new TurnStateMachine(onWarn);
		machine.begin("first");
		machine.begin("second");

		expect(onWarn).toHaveBeenCalledWith(expect.stringContaining("turns must be serialized"));
		expect(machine.status().taskText).toBe("second");
	});

	it("hands out a status snapshot callers cannot mutate the machine through", () => {
		const machine = new TurnStateMachine();
		machine.begin("turn");

		const snapshot = machine.status();
		snapshot.phase = "streaming";
		snapshot.stopRequested = true;

		expect(machine.phase()).toBe("dispatching");
		expect(machine.status().stopRequested).toBe(false);
	});
});
