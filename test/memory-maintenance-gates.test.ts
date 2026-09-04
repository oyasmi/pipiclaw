import { describe, expect, it, vi } from "vitest";
import { shouldRunReflect } from "../src/memory/maintenance-gates.js";
import type { MemoryMaintenanceState } from "../src/memory/maintenance-state.js";

const now = new Date("2026-04-19T01:00:00.000Z");

const state: MemoryMaintenanceState = {
	channelId: "dm_1",
	dirty: true,
	eligibleAfter: "2026-04-19T00:00:00.000Z",
	failureBackoffUntil: null,
};

const maintenance = {
	enabled: true,
	minIdleMinutesBeforeLlmWork: 10,
	reflectIntervalMinutes: 20,
	maxConcurrentChannels: 1,
	failureBackoffMinutes: 30,
};

const material = (hasNewEntry: boolean, hasMeaningfulExchange: boolean) => () => ({
	hasNewEntry,
	hasMeaningfulExchange,
});

describe("shouldRunReflect", () => {
	it("denies locally before material is ever evaluated", () => {
		expect(
			shouldRunReflect({
				now,
				state: { ...state, dirty: false },
				maintenance,
				channelActive: false,
				material: material(true, true),
			}),
		).toMatchObject({ allowed: false, skipReason: "clean" });
		expect(
			shouldRunReflect({ now, state, maintenance, channelActive: true, material: material(true, true) }),
		).toMatchObject({ allowed: false, skipReason: "channel-active" });
		expect(
			shouldRunReflect({
				now,
				state: { ...state, eligibleAfter: "2026-04-19T02:00:00.000Z" },
				maintenance,
				channelActive: false,
				material: material(true, true),
			}),
		).toMatchObject({ allowed: false, skipReason: "not-idle-yet" });
		expect(
			shouldRunReflect({
				now,
				state: { ...state, failureBackoffUntil: "2026-04-19T02:00:00.000Z" },
				maintenance,
				channelActive: false,
				material: material(true, true),
			}),
		).toMatchObject({ allowed: false, skipReason: "backoff-active" });
		expect(
			shouldRunReflect({
				now,
				state: { ...state, lastReflectAt: "2026-04-19T00:55:00.000Z" },
				maintenance,
				channelActive: false,
				material: material(true, true),
			}),
		).toMatchObject({ allowed: false, skipReason: "interval-not-elapsed" });
	});

	it("checks material only after the cheap gates pass", () => {
		expect(
			shouldRunReflect({ now, state, maintenance, channelActive: false, material: material(false, true) }),
		).toMatchObject({ allowed: false, skipReason: "no-new-entry" });
		expect(
			shouldRunReflect({ now, state, maintenance, channelActive: false, material: material(true, false) }),
		).toMatchObject({ allowed: false, skipReason: "no-meaningful-exchange" });
		expect(
			shouldRunReflect({ now, state, maintenance, channelActive: false, material: material(true, true) }),
		).toMatchObject({ allowed: true });
	});

	// The whole point of the thunk: an idle daemon ticks every minute, and a tick that stops at a
	// schedule gate must not build the incremental source window or scan the transcript.
	it("never evaluates material when a cheap schedule gate denies", () => {
		const spy = vi.fn(() => ({ hasNewEntry: true, hasMeaningfulExchange: true }));
		shouldRunReflect({ now, state, maintenance, channelActive: true, material: spy });
		expect(spy).not.toHaveBeenCalled();
	});
});
