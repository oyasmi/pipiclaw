import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getMemoryMaintenanceTuning, getSessionRefreshCadence } from "../src/memory/maintenance-tuning.js";
import { PipiclawSettingsManager } from "../src/settings.js";
import { useTempDirs } from "./helpers/fixtures.js";

const makeTempDir = useTempDirs("pipiclaw-settings-");

describe("settings manager", () => {
	// Parse-error fallback and the memory-maintenance-cadence-ignores-config behavior are both
	// covered against the real settings authority in context.test.ts (`tolerates invalid JSON
	// settings files…` / `re-parses settings.json only when the file changed`, and `keeps the
	// enabled switch configurable while ignoring retired numeric keys`, respectively).

	it("resolves the fallback model reference, treating empty/missing as unset", () => {
		const setDir = makeTempDir();
		const blankDir = makeTempDir();
		const missingDir = makeTempDir();
		writeFileSync(
			join(setDir, "settings.json"),
			JSON.stringify({ fallbackModel: "  openai/gpt-4o-mini  " }),
			"utf-8",
		);
		writeFileSync(join(blankDir, "settings.json"), JSON.stringify({ fallbackModel: "   " }), "utf-8");
		writeFileSync(join(missingDir, "settings.json"), JSON.stringify({}), "utf-8");

		expect(new PipiclawSettingsManager(setDir).getFallbackModelReference()).toBe("openai/gpt-4o-mini");
		expect(new PipiclawSettingsManager(blankDir).getFallbackModelReference()).toBeNull();
		expect(new PipiclawSettingsManager(missingDir).getFallbackModelReference()).toBeNull();
	});

	// The clamp this replaces existed only to defend against user input; with the
	// cadence fixed in code there is nothing left to clamp.
	it("serves task driver cadence from constants, ignoring any configured values", () => {
		const defaultsDir = makeTempDir();
		const configuredDir = makeTempDir();
		writeFileSync(join(defaultsDir, "settings.json"), "{}", "utf-8");
		writeFileSync(
			join(configuredDir, "settings.json"),
			JSON.stringify({
				taskDriver: {
					continuationDelayMinutes: 0,
					stalledRetryMinutes: 0,
					maxDispatchesPerTick: 999,
					maxSleepMinutes: 999,
				},
			}),
			"utf-8",
		);

		const expected = {
			continuationDelayMinutes: 5,
			stalledRetryMinutes: 60,
			maxDispatchesPerTick: 4,
			maxSleepMinutes: 15,
		};
		expect(new PipiclawSettingsManager(defaultsDir).getTaskDriverSettings()).toEqual(expected);
		expect(new PipiclawSettingsManager(configuredDir).getTaskDriverSettings()).toEqual(expected);
	});
});

describe("memory maintenance tuning", () => {
	it("serves production cadence unless the test hook is set", () => {
		expect(getMemoryMaintenanceTuning({})).toMatchObject({
			minIdleMinutesBeforeLlmWork: 10,
			sessionRefreshIntervalMinutes: 10,
			failureBackoffMinutes: 30,
		});
		expect(getMemoryMaintenanceTuning({ PIPICLAW_TEST_FAST_MAINTENANCE: "0" }).minIdleMinutesBeforeLlmWork).toBe(10);
	});

	it("drops the idle and interval gates under PIPICLAW_TEST_FAST_MAINTENANCE", () => {
		const fast = getMemoryMaintenanceTuning({ PIPICLAW_TEST_FAST_MAINTENANCE: "1" });

		expect(fast).toMatchObject({
			minIdleMinutesBeforeLlmWork: 0,
			sessionRefreshIntervalMinutes: 0,
			failureBackoffMinutes: 1,
		});
		// Thresholds that are not about cadence stay at production values.
		expect(fast.minMemoryAutoWriteConfidence).toBe(0.85);
		expect(fast.cleanupShrinkGuardMinRatio).toBe(0.4);
	});

	it("lowers the scheduled session-refresh thresholds under the test hook", () => {
		expect(getSessionRefreshCadence({})).toEqual({ minTurnsBetweenUpdate: 2, minToolCallsBetweenUpdate: 4 });
		expect(getSessionRefreshCadence({ PIPICLAW_TEST_FAST_MAINTENANCE: "1" })).toEqual({
			minTurnsBetweenUpdate: 1,
			minToolCallsBetweenUpdate: 1,
		});
	});
});
