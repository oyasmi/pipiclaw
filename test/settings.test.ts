import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PipiclawSettingsManager } from "../src/settings.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("settings manager", () => {
	it("reports parse errors and falls back to defaults", () => {
		const appHomeDir = mkdtempSync(join(tmpdir(), "pipiclaw-settings-"));
		tempDirs.push(appHomeDir);
		writeFileSync(join(appHomeDir, "settings.json"), "{", "utf-8");

		const manager = new PipiclawSettingsManager(appHomeDir);
		expect(manager.getDefaultThinkingLevel()).toBe("off");

		const diagnostics = manager.drainErrors();
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.error.message).toContain("Expected property name");
		expect(manager.drainErrors()).toEqual([]);
	});

	it("allows skill auto-write confidence to be raised but not lowered below the safety floor", () => {
		const lowDir = mkdtempSync(join(tmpdir(), "pipiclaw-settings-"));
		const highDir = mkdtempSync(join(tmpdir(), "pipiclaw-settings-"));
		tempDirs.push(lowDir, highDir);
		writeFileSync(
			join(lowDir, "settings.json"),
			JSON.stringify({ memoryGrowth: { minSkillAutoWriteConfidence: 0.5 } }),
			"utf-8",
		);
		writeFileSync(
			join(highDir, "settings.json"),
			JSON.stringify({ memoryGrowth: { minSkillAutoWriteConfidence: 0.95 } }),
			"utf-8",
		);

		expect(new PipiclawSettingsManager(lowDir).getMemoryGrowthSettings().minSkillAutoWriteConfidence).toBe(0.9);
		expect(new PipiclawSettingsManager(highDir).getMemoryGrowthSettings().minSkillAutoWriteConfidence).toBe(0.95);
	});

	it("resolves the fallback model reference, treating empty/missing as unset", () => {
		const setDir = mkdtempSync(join(tmpdir(), "pipiclaw-settings-"));
		const blankDir = mkdtempSync(join(tmpdir(), "pipiclaw-settings-"));
		const missingDir = mkdtempSync(join(tmpdir(), "pipiclaw-settings-"));
		tempDirs.push(setDir, blankDir, missingDir);
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
});
