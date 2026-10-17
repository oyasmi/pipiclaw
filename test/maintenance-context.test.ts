import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearDetachedMaintenanceCache, loadDetachedMaintenanceContext } from "../src/agent/maintenance-context.js";
import { PipiclawSettingsManager } from "../src/config/settings.js";
import { testConversation, useTempDirs } from "./helpers/fixtures.js";

const makeTempDir = useTempDirs("pipiclaw-maintenance-context-");

afterEach(() => vi.restoreAllMocks());

function writeTranscript(dotDir: string): void {
	const dir = testConversation(dotDir).conversationDir;
	const manager = SessionManager.open(join(dir, "context.jsonl"), dir);
	manager.appendMessage({ role: "user", content: "请记住我喜欢简洁回复", timestamp: Date.now() } as never);
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "好的，已记录。" }],
		stopReason: "stop",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} as never);
}

describe("loadDetachedMaintenanceContext", () => {
	beforeEach(() => {
		clearDetachedMaintenanceCache();
	});

	function makeOptions(appHomeDir: string, dotDir: string) {
		return {
			conversation: testConversation(dotDir, { channelId: "dm_cold" }),
			workspaceDir: appHomeDir,
			authConfigPath: join(appHomeDir, "auth.json"),
			modelsConfigPath: join(appHomeDir, "models.json"),
			settingsManager: new PipiclawSettingsManager(appHomeDir),
		};
	}

	it("returns null when there is no persisted or unreadable transcript", async () => {
		const appHomeDir = makeTempDir();
		await expect(loadDetachedMaintenanceContext(makeOptions(appHomeDir, makeTempDir()))).resolves.toBeNull();

		const corruptDir = makeTempDir();
		writeFileSync(join(testConversation(corruptDir).conversationDir, "context.jsonl"), "not json at all\n{", "utf-8");
		await expect(loadDetachedMaintenanceContext(makeOptions(appHomeDir, corruptDir))).resolves.toBeNull();
	});

	it("reuses the cached transcript while context.jsonl is unchanged", async () => {
		const appHomeDir = makeTempDir();
		const dotDir = makeTempDir();
		writeTranscript(dotDir);

		const openSpy = vi.spyOn(SessionManager, "open");
		const first = await loadDetachedMaintenanceContext(makeOptions(appHomeDir, dotDir));
		// The first load builds a full context from disk alone, without a runner.
		expect(first?.conversation.channelId).toBe("dm_cold");
		expect(first?.messages().length).toBeGreaterThanOrEqual(2);
		expect(first?.sessionEntries().length).toBeGreaterThanOrEqual(2);
		expect(first?.model.id).toBeTruthy();
		expect(first?.settings.memoryMaintenance).toBeDefined();
		const opensAfterInitialRead = openSpy.mock.calls.length;
		expect(opensAfterInitialRead).toBeGreaterThan(0);
		const second = await loadDetachedMaintenanceContext(makeOptions(appHomeDir, dotDir));
		expect(openSpy).toHaveBeenCalledTimes(opensAfterInitialRead);
		expect(second?.sessionEntries().map((entry) => entry.id)).toEqual(
			first?.sessionEntries().map((entry) => entry.id),
		);

		const dir = testConversation(dotDir).conversationDir;
		const manager = SessionManager.open(join(dir, "context.jsonl"), dir);
		const opensBeforeInvalidationRead = openSpy.mock.calls.length;
		manager.appendMessage({ role: "user", content: "再补一句", timestamp: Date.now() } as never);
		const third = await loadDetachedMaintenanceContext(makeOptions(appHomeDir, dotDir));
		expect(openSpy).toHaveBeenCalledTimes(opensBeforeInvalidationRead + 1);
		expect(third?.sessionEntries().length).toBeGreaterThan(first?.sessionEntries().length ?? 0);
	});
});
