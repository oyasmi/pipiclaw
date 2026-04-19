import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunner } from "../src/agent/types.js";
import type { BootstrapPaths } from "../src/runtime/bootstrap.js";
import type { DingTalkBot, DingTalkConfig } from "../src/runtime/dingtalk.js";

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

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pipiclaw-runtime-stop-"));
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

afterEach(() => {
	vi.restoreAllMocks();
	getOrCreateRunnerMock.mockReset();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
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
			queueFollowUp: vi.fn(async () => {}),
			flushMemoryForShutdown: vi.fn(async () => {}),
			getMemoryMaintenanceContext: vi.fn(async () => {
				throw new Error("not used");
			}),
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

		await runtime.shutdown();
	});
});
