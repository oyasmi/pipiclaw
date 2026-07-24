import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PipiclawSettingsManager } from "../src/settings.js";
import { useTempDirs } from "./helpers/fixtures.js";

const makeTempDir = useTempDirs("pipiclaw-settings-");

describe("settings manager", () => {
	it("reports parse errors and falls back to defaults", () => {
		const appHomeDir = makeTempDir();
		writeFileSync(join(appHomeDir, "settings.json"), "{", "utf-8");

		const manager = new PipiclawSettingsManager(appHomeDir);
		expect(manager.getDefaultThinkingLevel()).toBeUndefined();

		const diagnostics = manager.drainErrors();
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.error.message).toContain("Expected property name");
		expect(manager.drainErrors()).toEqual([]);
	});

	it("merges configured memory maintenance settings over defaults", () => {
		const dir = makeTempDir();
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({ memoryMaintenance: { checkpointIntervalMinutes: 45 } }),
			"utf-8",
		);

		const maintenance = new PipiclawSettingsManager(dir).getMemoryMaintenanceSettings();
		expect(maintenance.checkpointIntervalMinutes).toBe(45);
		expect(maintenance.minMemoryAutoWriteConfidence).toBe(0.85);
	});

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

	it("clamps unsafe task driver cadence settings", () => {
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

		expect(new PipiclawSettingsManager(defaultsDir).getTaskDriverSettings()).toEqual({
			continuationDelayMinutes: 5,
			stalledRetryMinutes: 60,
			maxDispatchesPerTick: 4,
			maxSleepMinutes: 15,
		});
		expect(new PipiclawSettingsManager(configuredDir).getTaskDriverSettings()).toEqual({
			continuationDelayMinutes: 1,
			stalledRetryMinutes: 1,
			maxDispatchesPerTick: 20,
			maxSleepMinutes: 60,
		});
	});
});
