import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunner } from "../src/agent/types.js";
import type { BootstrapPaths } from "../src/runtime/bootstrap.js";
import type { DingTalkBot, DingTalkConfig } from "../src/runtime/dingtalk.js";
import { useTempDirs } from "./helpers/fixtures.js";

const { getOrCreateRunnerMock } = vi.hoisted(() => ({
	getOrCreateRunnerMock: vi.fn(),
}));

vi.mock("../src/agent/index.js", async () => {
	const actual = await vi.importActual("../src/agent/index.js");
	return {
		...actual,
		getOrCreateRunner: getOrCreateRunnerMock,
	};
});

const createTempDir = useTempDirs("pipiclaw-runtime-stop-");

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
	clearPendingMessages = vi.fn((channelId: string) => {
		this.deliveries.push({ method: "clearPendingMessages", args: [channelId] });
		return 0;
	});
}

afterEach(() => {
	vi.restoreAllMocks();
	getOrCreateRunnerMock.mockReset();
});

describe("runtime stop handling", () => {
	it("discards the active card when a running task is stopped", async () => {
		let releaseRun!: () => void;
		const runAborted = new Promise<void>((resolve) => {
			releaseRun = resolve;
		});
		const runner: AgentRunner = {
			run: vi.fn(async () => {
				await runAborted;
				return { stopReason: "aborted" };
			}),
			handleBuiltinCommand: vi.fn(async () => {}),
			queueSteer: vi.fn(async () => {}),
			flushMemoryForShutdown: vi.fn(async () => {}),
			getMemoryMaintenanceContext: vi.fn(async () => {
				throw new Error("not used");
			}),
			getStatusSnapshot: vi.fn(() => ({
				model: "test/model",
				contextTokens: 0,
				contextWindow: 200000,
				thinkingLevel: "off",
			})),
			abort: vi.fn(async () => {
				releaseRun();
			}),
		};
		getOrCreateRunnerMock.mockReturnValue(runner);

		const { bootstrapAppHome, createRuntimeContext } = await import("../src/runtime/bootstrap.js");
		const paths = createBootstrapPaths();
		bootstrapAppHome(paths);

		const bot = new FakeTestBot();
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
			createEventsWatcher: () => ({ start() {}, stop() {} }),
		});

		const task = runtime.handler.handleEvent(
			{
				type: "dm",
				channelId: "dm_tester",
				ts: "1000",
				user: "tester",
				userName: "Tester",
				text: "please keep working",
				conversationId: "conv_1",
				conversationType: "1",
			},
			bot as unknown as DingTalkBot,
		);

		await Promise.resolve();
		await runtime.handler.handleStop("dm_tester", bot as unknown as DingTalkBot);
		await task;

		expect(runner.abort).toHaveBeenCalledTimes(1);
		expect(bot.discardCard).toHaveBeenCalledTimes(1);
		expect(bot.discardCard).toHaveBeenCalledWith("dm_tester");
		expect(bot.clearPendingMessages).toHaveBeenCalledWith("dm_tester");

		await runtime.shutdown();
	}, 20_000);

	it("durably pauses a task-driver task before aborting it", async () => {
		let releaseRun!: () => void;
		let signalRunStarted!: () => void;
		const runAborted = new Promise<void>((resolve) => {
			releaseRun = resolve;
		});
		const runStarted = new Promise<void>((resolve) => {
			signalRunStarted = resolve;
		});
		const runner: AgentRunner = {
			run: vi.fn(async () => {
				signalRunStarted();
				await runAborted;
				return { stopReason: "aborted" };
			}),
			handleBuiltinCommand: vi.fn(async () => {}),
			queueSteer: vi.fn(async () => {}),
			flushMemoryForShutdown: vi.fn(async () => {}),
			getMemoryMaintenanceContext: vi.fn(async () => {
				throw new Error("not used");
			}),
			getStatusSnapshot: vi.fn(() => ({
				model: "test/model",
				contextTokens: 0,
				contextWindow: 200000,
				thinkingLevel: "off",
			})),
			abort: vi.fn(async () => {
				releaseRun();
			}),
		};
		getOrCreateRunnerMock.mockReturnValue(runner);

		const { bootstrapAppHome, createRuntimeContext } = await import("../src/runtime/bootstrap.js");
		const paths = createBootstrapPaths();
		bootstrapAppHome(paths);
		const taskPath = join(paths.workspaceDir, "dm_tester", "tasks", "long-run.md");
		mkdirSync(join(paths.workspaceDir, "dm_tester", "tasks"), { recursive: true });
		writeFileSync(taskPath, "---\nstatus: in-progress\n---\n\n# Long running task\n", "utf-8");

		const bot = new FakeTestBot();
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
			createEventsWatcher: () => ({ start() {}, stop() {} }),
		});

		const task = runtime.handler.handleEvent(
			{
				type: "dm",
				channelId: "dm_tester",
				ts: "1000",
				user: "TASK_DRIVER",
				userName: "TASK_DRIVER",
				text: "[TASK_DRIVER:long-run] Resume task long-run.",
				conversationId: "conv_1",
				conversationType: "1",
			},
			bot as unknown as DingTalkBot,
		);

		await runStarted;
		await runtime.handler.handleStop("dm_tester", bot as unknown as DingTalkBot);
		await task;

		expect(runner.abort).toHaveBeenCalledTimes(1);
		expect(readFileSync(taskPath, "utf-8")).toContain("status: paused");

		await runtime.shutdown();
	}, 20_000);

	it("returns follow-up busy messages for normal queued processing", async () => {
		const runner: AgentRunner = {
			run: vi.fn(async () => ({ stopReason: "stop" })),
			handleBuiltinCommand: vi.fn(async () => {}),
			queueSteer: vi.fn(async () => {}),
			flushMemoryForShutdown: vi.fn(async () => {}),
			getMemoryMaintenanceContext: vi.fn(async () => {
				throw new Error("not used");
			}),
			getStatusSnapshot: vi.fn(() => ({
				model: "test/model",
				contextTokens: 0,
				contextWindow: 200000,
				thinkingLevel: "off",
			})),
			abort: vi.fn(async () => {}),
		};
		getOrCreateRunnerMock.mockReturnValue(runner);

		const { bootstrapAppHome, createRuntimeContext } = await import("../src/runtime/bootstrap.js");
		const paths = createBootstrapPaths();
		bootstrapAppHome(paths);

		const bot = new FakeTestBot();
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
			createEventsWatcher: () => ({ start() {}, stop() {} }),
		});

		const result = await runtime.handler.handleBusyMessage(
			{
				type: "dm",
				channelId: "dm_tester",
				ts: "1001",
				user: "tester",
				userName: "Tester",
				text: "second message",
				conversationId: "conv_1",
				conversationType: "1",
			},
			bot as unknown as DingTalkBot,
			"followUp",
			"second message",
		);

		expect(result).toEqual({ kind: "requeue", text: "second message" });
		expect(runner.queueSteer).not.toHaveBeenCalled();
		expect(bot.sendPlain).not.toHaveBeenCalled();

		await runtime.shutdown();
	});
});
