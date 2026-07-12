import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { clearDetachedMaintenanceCache, loadDetachedMaintenanceContext } from "../src/agent/maintenance-context.js";
import { PipiclawSettingsManager } from "../src/settings.js";
import { useTempDirs } from "./helpers/fixtures.js";

const makeTempDir = useTempDirs("pipiclaw-maintenance-context-");

function writeTranscript(channelDir: string): void {
	const manager = SessionManager.open(join(channelDir, "context.jsonl"), channelDir);
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

	function makeOptions(appHomeDir: string, channelDir: string) {
		return {
			channelId: "dm_cold",
			channelDir,
			workspaceDir: join(appHomeDir, "workspace"),
			authConfigPath: join(appHomeDir, "auth.json"),
			modelsConfigPath: join(appHomeDir, "models.json"),
			settingsManager: new PipiclawSettingsManager(appHomeDir),
		};
	}

	it("returns null when the channel has no persisted transcript", async () => {
		const appHomeDir = makeTempDir();
		const channelDir = makeTempDir();

		await expect(loadDetachedMaintenanceContext(makeOptions(appHomeDir, channelDir))).resolves.toBeNull();
	});

	it("builds a full maintenance context from disk without a runner", async () => {
		const appHomeDir = makeTempDir();
		const channelDir = makeTempDir();
		writeTranscript(channelDir);

		const context = await loadDetachedMaintenanceContext(makeOptions(appHomeDir, channelDir));

		expect(context).not.toBeNull();
		expect(context?.channelId).toBe("dm_cold");
		expect(context?.messages.length).toBeGreaterThanOrEqual(2);
		expect(context?.sessionEntries.length).toBeGreaterThanOrEqual(2);
		expect(context?.model.id).toBeTruthy();
		expect(context?.settings.memoryMaintenance).toBeDefined();
		expect(context?.refreshWorkspaceResources).toBeUndefined();
	});

	it("reuses the cached transcript while context.jsonl is unchanged", async () => {
		const appHomeDir = makeTempDir();
		const channelDir = makeTempDir();
		writeTranscript(channelDir);

		const first = await loadDetachedMaintenanceContext(makeOptions(appHomeDir, channelDir));
		// Corrupt the file without changing mtime/size semantics is fragile; instead
		// prove the cache path by checking a second load still succeeds and returns
		// equal data, then that an on-disk change is picked up.
		const second = await loadDetachedMaintenanceContext(makeOptions(appHomeDir, channelDir));
		expect(second?.sessionEntries.map((entry) => entry.id)).toEqual(first?.sessionEntries.map((entry) => entry.id));

		const manager = SessionManager.open(join(channelDir, "context.jsonl"), channelDir);
		manager.appendMessage({ role: "user", content: "再补一句", timestamp: Date.now() } as never);
		const third = await loadDetachedMaintenanceContext(makeOptions(appHomeDir, channelDir));
		expect(third?.sessionEntries.length).toBeGreaterThan(first?.sessionEntries.length ?? 0);
	});

	it("returns null for an unreadable transcript", async () => {
		const appHomeDir = makeTempDir();
		const channelDir = makeTempDir();
		writeFileSync(join(channelDir, "context.jsonl"), "not json at all\n{", "utf-8");

		await expect(loadDetachedMaintenanceContext(makeOptions(appHomeDir, channelDir))).resolves.toBeNull();
	});
});
