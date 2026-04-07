import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type BootstrapPaths, bootstrapAppHome, createRuntimeContext } from "../src/runtime/bootstrap.js";
import type { DingTalkBot, DingTalkConfig, DingTalkHandler } from "../src/runtime/dingtalk.js";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pipiclaw-runtime-"));
	tempDirs.push(dir);
	return dir;
}

function createBootstrapPaths(): BootstrapPaths {
	const appHomeDir = createTempDir();
	const workspaceDir = join(appHomeDir, "workspace");
	return {
		appName: "pipiclaw",
		appHomeDir,
		workspaceDir,
		authConfigPath: join(appHomeDir, "auth.json"),
		channelConfigPath: join(appHomeDir, "channel.json"),
		modelsConfigPath: join(appHomeDir, "models.json"),
		settingsConfigPath: join(appHomeDir, "settings.json"),
		toolsConfigPath: join(appHomeDir, "tools.json"),
		securityConfigPath: join(appHomeDir, "security.json"),
	};
}

class FakeTestBot {
	deliveries: Array<{ method: string; args: unknown[] }> = [];
	start = vi.fn(async () => {});
	stop = vi.fn(async () => {});
	sendPlain = vi.fn(async (channelId: string, text: string) => {
		this.deliveries.push({ method: "sendPlain", args: [channelId, text] });
		return true;
	});
	streamToCard = vi.fn(async (channelId: string, text: string) => {
		this.deliveries.push({ method: "streamToCard", args: [channelId, text] });
		return true;
	});
	finalizeExistingCard = vi.fn(async (channelId: string, text: string) => {
		this.deliveries.push({ method: "finalizeExistingCard", args: [channelId, text] });
		return true;
	});
	finalizeCard = vi.fn(async (channelId: string, text: string) => {
		this.deliveries.push({ method: "finalizeCard", args: [channelId, text] });
		return true;
	});
	discardCard = vi.fn((channelId: string) => {
		this.deliveries.push({ method: "discardCard", args: [channelId] });
	});
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("createRuntimeContext", () => {
	it("creates a reusable handler with a real store and processes built-in commands", async () => {
		const paths = createBootstrapPaths();
		bootstrapAppHome(paths);
		const bot = new FakeTestBot();
		const eventsWatcher = { start: vi.fn(), stop: vi.fn() };

		const runtime = createRuntimeContext({
			paths,
			sandbox: { type: "host" },
			dingtalkConfig: {
				clientId: "client-id",
				clientSecret: "client-secret",
				robotCode: "client-id",
				cardTemplateKey: "content",
				stateDir: paths.workspaceDir,
			} satisfies DingTalkConfig,
			registerSignalHandlers: false,
			startServices: false,
			createBot: (handler: DingTalkHandler, _config: DingTalkConfig) => {
				expect(typeof handler.handleEvent).toBe("function");
				return bot as unknown as DingTalkBot;
			},
			createEventsWatcher: () => eventsWatcher,
		});

		await runtime.handler.handleEvent(
			{
				type: "dm",
				channelId: "dm_tester",
				ts: "1000",
				user: "tester",
				userName: "Tester",
				text: "/help",
				conversationId: "conv_1",
				conversationType: "1",
			},
			bot as unknown as DingTalkBot,
		);

		const channelDir = join(paths.workspaceDir, "dm_tester");
		expect(readFileSync(join(channelDir, "log.jsonl"), "utf-8")).toContain('"text":"/help"');
		expect(bot.sendPlain).toHaveBeenCalled();

		await runtime.shutdown();
		expect(bot.stop).toHaveBeenCalled();
		expect(eventsWatcher.stop).toHaveBeenCalled();
	});

	it("recovers when archiving an incoming message fails", async () => {
		const paths = createBootstrapPaths();
		bootstrapAppHome(paths);
		const bot = new FakeTestBot();
		const eventsWatcher = { start: vi.fn(), stop: vi.fn() };

		const runtime = createRuntimeContext({
			paths,
			sandbox: { type: "host" },
			dingtalkConfig: {
				clientId: "client-id",
				clientSecret: "client-secret",
				robotCode: "client-id",
				cardTemplateKey: "content",
				stateDir: paths.workspaceDir,
			} satisfies DingTalkConfig,
			registerSignalHandlers: false,
			startServices: false,
			createBot: () => bot as unknown as DingTalkBot,
			createEventsWatcher: () => eventsWatcher,
		});

		vi.spyOn(runtime.store, "logMessage").mockRejectedValueOnce(new Error("disk full"));

		const event = {
			type: "dm" as const,
			channelId: "dm_tester",
			ts: "1000",
			user: "tester",
			userName: "Tester",
			text: "/help",
			conversationId: "conv_1",
			conversationType: "1",
		};

		await runtime.handler.handleEvent(event, bot as unknown as DingTalkBot);
		await runtime.handler.handleEvent({ ...event, ts: "1001" }, bot as unknown as DingTalkBot);

		expect(bot.sendPlain).toHaveBeenCalledTimes(2);
		await runtime.shutdown();
	});
});
