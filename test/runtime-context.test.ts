import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type BootstrapPaths, bootstrapAppHome, createRuntimeContext } from "../src/runtime/bootstrap.js";
import type { DingTalkBot, DingTalkConfig, DingTalkHandler } from "../src/runtime/dingtalk.js";
import { useTempDirs } from "./helpers/fixtures.js";

const createTempDir = useTempDirs("pipiclaw-runtime-");

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
		eventHistoryPath: join(appHomeDir, "state", "events", "history.jsonl"),
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
	appendToCard = vi.fn(async (channelId: string, text: string) => {
		this.deliveries.push({ method: "appendToCard", args: [channelId, text] });
		return true;
	});
	replaceCard = vi.fn(async (channelId: string, text: string, finalize: boolean = false) => {
		this.deliveries.push({ method: "replaceCard", args: [channelId, text, finalize] });
		return true;
	});
	streamToCard = vi.fn(async (channelId: string, text: string) => {
		this.deliveries.push({ method: "streamToCard", args: [channelId, text] });
		return true;
	});
	ensureCard = vi.fn(async (channelId: string) => {
		this.deliveries.push({ method: "ensureCard", args: [channelId] });
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

function createDmEvent(text: string, ts: string) {
	return {
		type: "dm" as const,
		channelId: "dm_tester",
		ts,
		user: "tester",
		userName: "Tester",
		text,
		conversationId: "conv_1",
		conversationType: "1",
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("createRuntimeContext", () => {
	it("creates a reusable handler with a real store and processes built-in commands", async () => {
		const paths = createBootstrapPaths();
		bootstrapAppHome(paths);
		const bot = new FakeTestBot();
		const eventsWatcher = { start: vi.fn(), stop: vi.fn() };
		const taskDriver = { start: vi.fn(), stop: vi.fn() };

		const runtime = createRuntimeContext({
			paths,
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
			createTaskDriver: () => taskDriver,
		});

		await runtime.handler.handleEvent(createDmEvent("/help", "1000"), bot as unknown as DingTalkBot);
		await runtime.store.flush();

		const channelDir = join(paths.workspaceDir, "dm_tester");
		expect(readFileSync(join(channelDir, "log.jsonl"), "utf-8")).toContain('"text":"/help"');
		expect(bot.sendPlain).toHaveBeenCalled();

		await runtime.shutdown();
		expect(bot.stop).toHaveBeenCalled();
		expect(eventsWatcher.stop).toHaveBeenCalled();
		expect(taskDriver.stop).toHaveBeenCalled();
	});

	it("starts the native task driver with the other runtime services", async () => {
		const paths = createBootstrapPaths();
		bootstrapAppHome(paths);
		const bot = new FakeTestBot();
		const eventsWatcher = { start: vi.fn(), stop: vi.fn() };
		const memoryScheduler = { start: vi.fn(), stop: vi.fn() };
		const taskDriver = { start: vi.fn(), stop: vi.fn() };
		const runtime = createRuntimeContext({
			paths,
			dingtalkConfig: {
				clientId: "client-id",
				clientSecret: "client-secret",
				stateDir: paths.workspaceDir,
			},
			registerSignalHandlers: false,
			startServices: true,
			createBot: () => bot as unknown as DingTalkBot,
			createEventsWatcher: () => eventsWatcher,
			createMemoryMaintenanceScheduler: () => memoryScheduler,
			createTaskDriver: () => taskDriver,
		});

		expect(eventsWatcher.start).toHaveBeenCalledOnce();
		expect(memoryScheduler.start).toHaveBeenCalledOnce();
		expect(taskDriver.start).toHaveBeenCalledOnce();
		await runtime.shutdown();
		expect(taskDriver.stop).toHaveBeenCalledOnce();
	});

	it("recovers when archiving an incoming message fails", async () => {
		const paths = createBootstrapPaths();
		bootstrapAppHome(paths);
		const bot = new FakeTestBot();
		const eventsWatcher = { start: vi.fn(), stop: vi.fn() };

		const runtime = createRuntimeContext({
			paths,
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

		const event = createDmEvent("/help", "1000");

		await runtime.handler.handleEvent(event, bot as unknown as DingTalkBot);
		await runtime.handler.handleEvent({ ...event, ts: "1001" }, bot as unknown as DingTalkBot);

		expect(bot.sendPlain).toHaveBeenCalledTimes(2);
		await runtime.shutdown();
	});

	it("handles event administration commands in the runtime layer", async () => {
		const paths = createBootstrapPaths();
		bootstrapAppHome(paths);
		const bot = new FakeTestBot();
		const eventsWatcher = { start: vi.fn(), stop: vi.fn() };
		const eventsDir = join(paths.workspaceDir, "events");
		mkdirSync(eventsDir, { recursive: true });
		writeFileSync(
			join(eventsDir, "weekly-review.json"),
			JSON.stringify({
				type: "periodic",
				channelId: "dm_tester",
				text: "Review memory.",
				schedule: "0 9 * * 1",
				timezone: "Asia/Shanghai",
			}),
		);

		const runtime = createRuntimeContext({
			paths,
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

		await runtime.handler.handleEvent(createDmEvent("/events list", "1000"), bot as unknown as DingTalkBot);

		expect(bot.sendPlain).toHaveBeenCalledWith("dm_tester", expect.stringContaining("weekly-review"));
		await runtime.shutdown();
	});
});
