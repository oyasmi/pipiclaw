import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { PipiclawSettingsManager } from "../src/settings.js";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pipiclaw-context-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

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
			rerankWithModel: true,
		});
		expect(manager.getSessionMemorySettings()).toEqual({
			enabled: true,
			minTurnsBetweenUpdate: 2,
			minToolCallsBetweenUpdate: 4,
			timeoutMs: 30000,
			failureBackoffTurns: 3,
			forceRefreshBeforeCompact: true,
			forceRefreshBeforeNewSession: true,
		});
		expect(manager.getDefaultThinkingLevel()).toBe("off");
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
