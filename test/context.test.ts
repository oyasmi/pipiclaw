import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { PipiclawSettingsManager } from "../src/settings.js";
import { useTempDirs } from "./helpers/fixtures.js";

const createTempDir = useTempDirs("pipiclaw-context-");

describe("PipiclawSettingsManager", () => {
	it("returns defaults when no settings file exists", () => {
		const manager = new PipiclawSettingsManager(createTempDir());

		expect(manager.getCompactionSettings()).toEqual({
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 20000,
		});
		expect(manager.getRetrySettings()).toEqual({
			enabled: true,
			maxRetries: 3,
			baseDelayMs: 2000,
		});
		expect(manager.getMemoryMaintenanceSettings()).toEqual({
			enabled: true,
			minIdleMinutesBeforeLlmWork: 10,
			reflectIntervalMinutes: 20,
			maxConcurrentChannels: 1,
			failureBackoffMinutes: 30,
		});
		expect(manager.getDefaultThinkingLevel()).toBeUndefined();
	});

	it("persists updated settings to settings.json", () => {
		const baseDir = createTempDir();
		const manager = new PipiclawSettingsManager(baseDir);
		const settingsPath = join(baseDir, "settings.json");

		manager.setCompactionEnabled(false);
		manager.setRetryEnabled(false);
		manager.setDefaultModelAndProvider("anthropic", "claude-sonnet-4-5");
		manager.setDefaultThinkingLevel("medium");

		expect(existsSync(settingsPath)).toBe(true);
		expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toMatchObject({
			compaction: { enabled: false },
			retry: { enabled: false },
			defaultProvider: "anthropic",
			defaultModel: "claude-sonnet-4-5",
			defaultThinkingLevel: "medium",
		});

		const reloaded = new PipiclawSettingsManager(baseDir);
		expect(reloaded.getCompactionEnabled()).toBe(false);
		expect(reloaded.getRetryEnabled()).toBe(false);
		expect(reloaded.getDefaultProvider()).toBe("anthropic");
		expect(reloaded.getDefaultModel()).toBe("claude-sonnet-4-5");
		expect(reloaded.getDefaultThinkingLevel()).toBe("medium");
	});

	// Spec 035 D1: numeric thresholds are constants. A user who tuned them before
	// keeps the file working, but the values no longer take effect.
	it("keeps the enabled switch configurable while ignoring retired numeric keys", () => {
		const baseDir = createTempDir();
		writeFileSync(
			join(baseDir, "settings.json"),
			JSON.stringify({
				compaction: { enabled: false, reserveTokens: 4096, keepRecentTokens: 8192 },
				retry: { enabled: false, maxRetries: 99 },
				memoryRecall: { rerankWithModel: false, maxInjected: 99 },
				memoryMaintenance: { enabled: false, checkpointIntervalMinutes: 45 },
				sessionSearch: { summarizeWithModel: true, maxFiles: 99 },
				logging: { level: "debug", file: { enabled: false, maxFiles: 99 } },
			}),
			"utf-8",
		);

		const manager = new PipiclawSettingsManager(baseDir);

		expect(manager.getCompactionSettings()).toEqual({
			enabled: false,
			reserveTokens: 16384,
			keepRecentTokens: 20000,
		});
		expect(manager.getRetrySettings()).toEqual({ enabled: false, maxRetries: 3, baseDelayMs: 2000 });
		expect(manager.getMemoryMaintenanceSettings()).toMatchObject({
			enabled: false,
			reflectIntervalMinutes: 20,
		});
		expect(manager.getSessionSearchSettings()).toMatchObject({ summarizeWithModel: true, maxFiles: 12 });
		expect(manager.getLoggingSettings()).toEqual({
			level: "debug",
			file: { enabled: false, maxSizeBytes: 5_000_000, maxFiles: 3 },
		});
	});

	it("warns once about retired settings keys, and stays silent for supported-only files", () => {
		const baseDir = createTempDir();
		writeFileSync(
			join(baseDir, "settings.json"),
			JSON.stringify({
				defaultModel: "claude-sonnet-4-5",
				memoryMaintenance: { enabled: true, checkpointIntervalMinutes: 45 },
				taskDriver: { maxDispatchesPerTick: 9 },
			}),
			"utf-8",
		);

		const diagnostics = new PipiclawSettingsManager(baseDir).getDiagnostics();

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({ source: "settings", severity: "warning" });
		expect(diagnostics[0]?.message).toContain("memoryMaintenance.checkpointIntervalMinutes");
		expect(diagnostics[0]?.message).toContain("taskDriver.maxDispatchesPerTick");

		const cleanDir = createTempDir();
		writeFileSync(
			join(cleanDir, "settings.json"),
			JSON.stringify({ defaultModel: "claude-sonnet-4-5", memoryMaintenance: { enabled: false } }),
			"utf-8",
		);

		expect(new PipiclawSettingsManager(cleanDir).getDiagnostics()).toEqual([]);
	});

	// The task driver reloads on every tick — and ticks after every turn — so an unchanged
	// file must not be re-read. A *changed* file still must be, which is the risk being pinned.
	it("tolerates invalid JSON with defaults, re-parses only when the file changed", () => {
		const baseDir = createTempDir();
		const settingsPath = join(baseDir, "settings.json");
		writeFileSync(settingsPath, "{invalid", "utf-8");

		const manager = new PipiclawSettingsManager(baseDir);
		expect(manager.getCompactionEnabled()).toBe(true);
		expect(manager.getMemoryMaintenanceSettings().enabled).toBe(true);
		expect(manager.drainErrors()).toEqual([
			expect.objectContaining({
				scope: "global",
				error: expect.objectContaining({
					message: expect.stringContaining("Expected property name"),
				}),
			}),
		]);

		manager.reload();
		// A re-parse would have produced the same parse error again.
		expect(manager.drainErrors()).toEqual([]);

		writeFileSync(settingsPath, JSON.stringify({ defaultModel: "claude-sonnet-4-5" }), "utf-8");
		manager.reload();
		expect(manager.getDefaultModel()).toBe("claude-sonnet-4-5");
	});
});
