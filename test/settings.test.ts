import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
});
