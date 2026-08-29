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

	it("drops an unrecognized enum value, falls back to the default, and says so", () => {
		const dir = makeTempDir();
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({
				// A silenced log is the worst of these: an unknown level compares as NaN against
				// every record's own level, so nothing is ever written.
				logging: { level: "verbos", file: { enabled: true } },
				// Reads like "off" and used to behave as "live" — it passes both negative checks.
				delegation: { notices: "liv" },
				tui: { responseMode: "final_card" },
			}),
			"utf-8",
		);

		const manager = new PipiclawSettingsManager(dir);

		expect(manager.getLoggingSettings().level).toBe("info");
		expect(manager.getLoggingSettings().file.enabled).toBe(true); // siblings survive
		expect(manager.getDelegationSettings().notices).toBe("live");
		expect(manager.getTuiSettings().responseMode).toBe("full_progress_then_plain_final");

		const messages = manager.getDiagnostics().map((diagnostic) => diagnostic.message);
		expect(messages).toEqual(
			expect.arrayContaining([
				expect.stringContaining('logging.level: "verbos"'),
				expect.stringContaining('delegation.notices: "liv"'),
				expect.stringContaining('tui.responseMode: "final_card"'),
			]),
		);
		expect(manager.getDiagnostics().every((diagnostic) => diagnostic.severity === "warning")).toBe(true);
	});

	it("passes a valid enum value through untouched and reports nothing", () => {
		const dir = makeTempDir();
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({
				logging: { level: "warn" },
				delegation: { notices: "off" },
				tui: { responseMode: "final_card_only" },
			}),
			"utf-8",
		);

		const manager = new PipiclawSettingsManager(dir);

		expect(manager.getLoggingSettings().level).toBe("warn");
		expect(manager.getDelegationSettings().notices).toBe("off");
		expect(manager.getTuiSettings().responseMode).toBe("final_card_only");
		expect(manager.getDiagnostics()).toEqual([]);
	});
});
