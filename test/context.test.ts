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
		expect(manager.getMemoryRecallSettings()).toEqual({
			enabled: true,
			maxCandidates: 12,
			maxInjected: 5,
			maxChars: 5000,
			rerankWithModel: "auto",
		});
		expect(manager.getMemoryMaintenanceSettings()).toEqual({
			enabled: true,
			minIdleMinutesBeforeLlmWork: 10,
			sessionRefreshIntervalMinutes: 10,
			checkpointIntervalMinutes: 20,
			minMemoryAutoWriteConfidence: 0.85,
			structuralMaintenanceIntervalHours: 6,
			maxConcurrentChannels: 1,
			failureBackoffMinutes: 30,
			cleanupShrinkGuardMinRatio: 0.4,
			cleanupShrinkGuardMinChars: 2_000,
		});
		expect(manager.getSessionMemorySettings()).toEqual({
			enabled: true,
			minTurnsBetweenUpdate: 2,
			minToolCallsBetweenUpdate: 4,
			timeoutMs: 30000,
			forceRefreshBeforeCompact: true,
			forceRefreshBeforeNewSession: true,
		});
		expect(manager.getDefaultThinkingLevel()).toBeUndefined();
		expect(manager.getSteeringMode()).toBe("one-at-a-time");
		expect(manager.getFollowUpMode()).toBe("one-at-a-time");
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
				sessionMemory: { minTurnsBetweenUpdate: 99 },
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
		expect(manager.getBranchSummarySettings()).toEqual({ reserveTokens: 16384 });
		expect(manager.getRetrySettings()).toEqual({ enabled: false, maxRetries: 3, baseDelayMs: 2000 });
		expect(manager.getMemoryRecallSettings()).toMatchObject({ rerankWithModel: false, maxInjected: 5 });
		expect(manager.getSessionMemorySettings().minTurnsBetweenUpdate).toBe(2);
		expect(manager.getMemoryMaintenanceSettings()).toMatchObject({
			enabled: false,
			checkpointIntervalMinutes: 20,
		});
		expect(manager.getSessionSearchSettings()).toMatchObject({ summarizeWithModel: true, maxFiles: 12 });
		expect(manager.getLoggingSettings()).toEqual({
			level: "debug",
			file: { enabled: false, maxSizeBytes: 5_000_000, maxFiles: 3 },
		});
	});

	it("warns once about retired settings keys without failing the load", () => {
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
	});

	it("reports no diagnostics for a settings file using only supported keys", () => {
		const baseDir = createTempDir();
		writeFileSync(
			join(baseDir, "settings.json"),
			JSON.stringify({ defaultModel: "claude-sonnet-4-5", memoryMaintenance: { enabled: false } }),
			"utf-8",
		);

		expect(new PipiclawSettingsManager(baseDir).getDiagnostics()).toEqual([]);
	});

	it("tolerates invalid JSON settings files and exposes compatibility stubs", async () => {
		const baseDir = createTempDir();
		const settingsPath = join(baseDir, "settings.json");
		writeFileSync(settingsPath, "{invalid", "utf-8");

		const manager = new PipiclawSettingsManager(baseDir);
		expect(manager.getCompactionEnabled()).toBe(true);
		expect(manager.getHookPaths()).toEqual([]);
		expect(manager.getPackages()).toEqual([]);
		expect(manager.getMemoryRecallSettings().enabled).toBe(true);
		expect(manager.getSessionMemorySettings().enabled).toBe(true);
		expect(manager.getTheme()).toBeUndefined();
		await expect(manager.flush()).resolves.toBeUndefined();
		expect(manager.drainErrors()).toEqual([
			expect.objectContaining({
				scope: "global",
				error: expect.objectContaining({
					message: expect.stringContaining("Expected property name"),
				}),
			}),
		]);
	});
});
