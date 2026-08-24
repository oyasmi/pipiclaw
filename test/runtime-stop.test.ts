import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunner } from "../src/agent/types.js";
import { type BootstrapPaths, bootstrapAppHome } from "../src/runtime/app-home.js";
import type { DingTalkBot, DingTalkConfig } from "../src/runtime/dingtalk.js";
import { createFakeTurnState } from "./helpers/fake-turn-state.js";
import { useTempDirs } from "./helpers/fixtures.js";

const { createRunnerMock } = vi.hoisted(() => ({
	createRunnerMock: vi.fn(),
}));

vi.mock("../src/agent/index.js", async () => {
	const actual = await vi.importActual("../src/agent/index.js");
	return {
		...actual,
		createRunner: createRunnerMock,
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
	resetChannelQueue = vi.fn((channelId: string) => {
		this.deliveries.push({ method: "resetChannelQueue", args: [channelId] });
		return 0;
	});
}

afterEach(() => {
	vi.restoreAllMocks();
	createRunnerMock.mockReset();
});

describe("runtime stop handling", () => {
	it("interrupts compaction for new work and lets /new detach the busy generation immediately", async () => {
		const retireForNewSession = vi.fn();
		const interruptCompaction = vi.fn(() => true);
		const runner: AgentRunner = {
			renderContextReport: () => "CONTEXT",
			getSubAgentDiscoverySnapshot: () => ({ directory: "", agents: [], warnings: [] }),
			run: vi.fn(async () => ({ stopReason: "stop" })),
			handleBuiltinCommand: vi.fn(async () => {}),
			isKnownSlashCommand: vi.fn(() => false),
			queueSteer: vi.fn(async () => {}),
			flushMemoryForShutdown: vi.fn(async () => {}),
			dispose: vi.fn(async () => {}),
			getMemoryMaintenanceContext: vi.fn(async () => {
				throw new Error("not used");
			}),
			getStatusSnapshot: vi.fn(() => ({
				model: "test/model",
				contextTokens: 180_000,
				contextWindow: 200_000,
				thinkingLevel: "off",
			})),
			abort: vi.fn(async () => {}),
			interruptCompaction,
			retireForNewSession,
			...createFakeTurnState(),
		};
		createRunnerMock.mockReturnValue(runner);

		const { createRuntimeContext } = await import("../src/runtime/bootstrap.js");
		const paths = createBootstrapPaths();
		bootstrapAppHome(paths);
		const bot = new FakeTestBot();
		const runtime = await createRuntimeContext({
			paths,
			dingtalkConfig: {
				clientId: "client-id",
				clientSecret: "client-secret",
				stateDir: paths.workspaceDir,
			},
			registerSignalHandlers: false,
			startServices: false,
			createBot: () => bot as unknown as DingTalkBot,
			createEventsWatcher: () => ({ start() {}, stop() {} }),
		});
		const event = {
			type: "dm",
			channelId: "dm_tester",
			ts: "1000",
			user: "tester",
			userName: "Tester",
			text: "new work",
			conversationId: "conv_1",
			conversationType: "1",
		} as const;
		runtime.handler.reserveEvent?.(event);

		await expect(
			runtime.handler.handleBusyMessage(event, bot as unknown as DingTalkBot, "steer", event.text),
		).resolves.toEqual({ kind: "requeue", text: "new work" });
		expect(interruptCompaction).toHaveBeenCalledOnce();
		expect(runner.queueSteer).not.toHaveBeenCalled();

		await runtime.handler.handleNewSession({ ...event, text: "/new" }, bot as unknown as DingTalkBot);
		expect(retireForNewSession).toHaveBeenCalledOnce();
		expect(runtime.handler.isRunning("dm_tester")).toBe(false);
		expect(bot.resetChannelQueue).toHaveBeenCalledWith("dm_tester");

		await runtime.shutdown();
		// The in-test dynamic import of the bootstrap graph pays its one-time vite transform
		// cost (~5s) inside this case alone — keep well clear of the default 5s timeout.
	}, 30_000);

	it("discards the active card when a running task is stopped", async () => {
		let releaseRun!: () => void;
		let signalRunStarted!: () => void;
		const runAborted = new Promise<void>((resolve) => {
			releaseRun = resolve;
		});
		const runStarted = new Promise<void>((resolve) => {
			signalRunStarted = resolve;
		});
		const runner: AgentRunner = {
			renderContextReport: () => "CONTEXT",
			getSubAgentDiscoverySnapshot: () => ({ directory: "", agents: [], warnings: [] }),
			run: vi.fn(async () => {
				signalRunStarted();
				await runAborted;
				return { stopReason: "aborted" };
			}),
			handleBuiltinCommand: vi.fn(async () => {}),
			isKnownSlashCommand: vi.fn(() => false),
			queueSteer: vi.fn(async () => {}),
			flushMemoryForShutdown: vi.fn(async () => {}),
			dispose: vi.fn(async () => {}),
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
			...createFakeTurnState(),
		};
		createRunnerMock.mockReturnValue(runner);

		const { createRuntimeContext } = await import("../src/runtime/bootstrap.js");
		const paths = createBootstrapPaths();
		bootstrapAppHome(paths);

		const bot = new FakeTestBot();
		const runtime = await createRuntimeContext({
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

		const event = {
			type: "dm",
			channelId: "dm_tester",
			ts: "1000",
			user: "tester",
			userName: "Tester",
			text: "please keep working",
			conversationId: "conv_1",
			conversationType: "1",
		} as const;
		runtime.handler.reserveEvent?.(event);
		const task = runtime.handler.handleEvent(event, bot as unknown as DingTalkBot);

		await runStarted;
		await runtime.handler.handleStop("dm_tester", bot as unknown as DingTalkBot);
		await task;

		expect(runner.abort).toHaveBeenCalledTimes(1);
		expect(bot.discardCard).toHaveBeenCalledTimes(1);
		expect(bot.discardCard).toHaveBeenCalledWith("dm_tester");
		expect(bot.clearPendingMessages).toHaveBeenCalledWith("dm_tester");

		await runtime.shutdown();
	}, 60_000);

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
			renderContextReport: () => "CONTEXT",
			getSubAgentDiscoverySnapshot: () => ({ directory: "", agents: [], warnings: [] }),
			run: vi.fn(async () => {
				signalRunStarted();
				await runAborted;
				return { stopReason: "aborted" };
			}),
			handleBuiltinCommand: vi.fn(async () => {}),
			isKnownSlashCommand: vi.fn(() => false),
			queueSteer: vi.fn(async () => {}),
			flushMemoryForShutdown: vi.fn(async () => {}),
			dispose: vi.fn(async () => {}),
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
			...createFakeTurnState(),
		};
		createRunnerMock.mockReturnValue(runner);

		const { createRuntimeContext } = await import("../src/runtime/bootstrap.js");
		const paths = createBootstrapPaths();
		bootstrapAppHome(paths);
		const taskPath = join(paths.workspaceDir, "dm_tester", "tasks", "long-run.md");
		mkdirSync(join(paths.workspaceDir, "dm_tester", "tasks"), { recursive: true });
		writeFileSync(taskPath, "---\nstatus: in-progress\n---\n\n# Long running task\n", "utf-8");

		const bot = new FakeTestBot();
		const runtime = await createRuntimeContext({
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

		const event = {
			type: "dm",
			channelId: "dm_tester",
			ts: "1000",
			user: "TASK_DRIVER",
			userName: "TASK_DRIVER",
			text: "[TASK_DRIVER:long-run] Resume task long-run.",
			conversationId: "conv_1",
			conversationType: "1",
		} as const;
		runtime.handler.reserveEvent?.(event);
		const task = runtime.handler.handleEvent(event, bot as unknown as DingTalkBot);

		await runStarted;
		const outcome = await runtime.handler.handleStop("dm_tester", bot as unknown as DingTalkBot);
		await task;

		expect(runner.abort).toHaveBeenCalledTimes(1);
		expect(readFileSync(taskPath, "utf-8")).toContain("status: active");
		expect(readFileSync(taskPath, "utf-8")).toContain("enabled: false");
		// The transport turns this into the user-facing "任务 X 已暂停，用 /tasks resume X 继续" notice.
		expect(outcome).toEqual({ pausedTaskId: "long-run" });

		await runtime.shutdown();
	}, 20_000);

	it("force-releases the channel when a stopped turn never finishes its epilogue", async () => {
		let signalRunStarted!: () => void;
		let releaseRun!: () => void;
		const runStarted = new Promise<void>((resolve) => {
			signalRunStarted = resolve;
		});
		// The turn ignores abort(): it is wedged in its teardown (delivery drain,
		// resource reload, memory flush), which is exactly what /stop cannot reach.
		const wedged = new Promise<void>((resolve) => {
			releaseRun = resolve;
		});
		const runner: AgentRunner = {
			renderContextReport: () => "CONTEXT",
			getSubAgentDiscoverySnapshot: () => ({ directory: "", agents: [], warnings: [] }),
			run: vi.fn(async () => {
				signalRunStarted();
				await wedged;
				return { stopReason: "stop" };
			}),
			handleBuiltinCommand: vi.fn(async () => {}),
			isKnownSlashCommand: vi.fn(() => false),
			queueSteer: vi.fn(async () => {}),
			flushMemoryForShutdown: vi.fn(async () => {}),
			dispose: vi.fn(async () => {}),
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
			...createFakeTurnState(),
		};
		createRunnerMock.mockReturnValue(runner);

		const { createRuntimeContext } = await import("../src/runtime/bootstrap.js");
		const paths = createBootstrapPaths();
		bootstrapAppHome(paths);

		const bot = new FakeTestBot();
		const runtime = await createRuntimeContext({
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
			stopForceEndGraceMs: 50,
			createBot: () => bot as unknown as DingTalkBot,
			createEventsWatcher: () => ({ start() {}, stop() {} }),
		});

		const event = {
			type: "dm",
			channelId: "dm_tester",
			ts: "1000",
			user: "tester",
			userName: "Tester",
			text: "please keep working",
			conversationId: "conv_1",
			conversationType: "1",
		} as const;
		runtime.handler.reserveEvent?.(event);
		const task = runtime.handler.handleEvent(event, bot as unknown as DingTalkBot);

		await runStarted;
		await runtime.handler.handleStop("dm_tester", bot as unknown as DingTalkBot);
		// The wedged turn is still running, so /stop alone leaves the channel busy.
		expect(runtime.handler.isRunning("dm_tester")).toBe(true);

		const deadline = Date.now() + 5_000;
		while (runtime.handler.isRunning("dm_tester") && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(runtime.handler.isRunning("dm_tester")).toBe(false);
		expect(bot.deliveries.some((entry) => String(entry.args[1]).includes("强制结束"))).toBe(true);

		// The wedged turn's own late release must not disturb whatever runs next.
		runner.beginTurn("next message");
		releaseRun();
		await task;
		expect(runtime.handler.isRunning("dm_tester")).toBe(true);
		runner.endTurn();

		await runtime.shutdown();
	}, 20_000);
});
