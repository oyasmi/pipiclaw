import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getChannelJobManager } from "../src/agent/job-manager.js";
import type { AgentRunner } from "../src/agent/types.js";
import type { Executor } from "../src/executor.js";
import { type BootstrapPaths, bootstrapAppHome } from "../src/runtime/app-home.js";
import { createRuntimeContext } from "../src/runtime/bootstrap.js";
import type { DingTalkBot, DingTalkEvent } from "../src/runtime/dingtalk.js";
import { getSubAgentRunManager } from "../src/subagents/runs.js";
import { createDefaultTaskControl } from "../src/tasks/control.js";
import { renderTaskDocument } from "../src/tasks/ledger.js";
import { readStoredTask } from "../src/tasks/store.js";
import { createFakeTurnState } from "./helpers/fake-turn-state.js";
import { useTempDirs } from "./helpers/fixtures.js";

const { createRunnerMock } = vi.hoisted(() => ({ createRunnerMock: vi.fn() }));

vi.mock("../src/agent/index.js", async () => {
	const actual = await vi.importActual("../src/agent/index.js");
	return { ...actual, createRunner: createRunnerMock };
});

const tempDir = useTempDirs("pipiclaw-bootstrap-wake-");

class WakeBot {
	readonly events: DingTalkEvent[] = [];
	start = vi.fn(async () => {});
	stop = vi.fn(async () => {});
	sendPlain = vi.fn(async () => true);
	discardCard = vi.fn();
	clearPendingMessages = vi.fn(() => 0);
	enqueueEvent = vi.fn((event: DingTalkEvent) => {
		this.events.push(event);
		return true;
	});
}

function paths(): BootstrapPaths {
	const appHomeDir = tempDir();
	return {
		appName: "pipiclaw",
		appHomeDir,
		workspaceDir: join(appHomeDir, "workspace"),
		authConfigPath: join(appHomeDir, "auth.json"),
		channelConfigPath: join(appHomeDir, "channel.json"),
		modelsConfigPath: join(appHomeDir, "models.json"),
		settingsConfigPath: join(appHomeDir, "settings.json"),
		toolsConfigPath: join(appHomeDir, "tools.json"),
		securityConfigPath: join(appHomeDir, "security.json"),
		eventHistoryPath: join(appHomeDir, "state", "events", "history.jsonl"),
	};
}

function runner(): AgentRunner {
	return {
		run: vi.fn(async () => ({
			stopReason: "stop",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				total: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			durationMs: 1,
			costKnown: true,
		})),
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
			contextWindow: 1,
			thinkingLevel: "off",
		})),
		renderContextReport: vi.fn(() => "CONTEXT"),
		getSubAgentDiscoverySnapshot: vi.fn(() => ({ directory: "", agents: [], warnings: [] })),
		abort: vi.fn(async () => {}),
		...createFakeTurnState(),
	};
}

async function waitingTask(workspaceDir: string, channelId: string, taskId: string, kind: "job" | "subagent") {
	const channelDir = join(workspaceDir, channelId);
	await writeFile(
		join(channelDir, "tasks", `${taskId}.md`),
		renderTaskDocument(
			{
				status: "waiting",
				control: {
					...createDefaultTaskControl(),
					waitingFor: kind === "job" ? "job" : "external-signal",
				},
			},
			`# ${taskId}\n`,
		),
	);
	return channelDir;
}

async function createHarness(name: string, hooks?: Parameters<typeof createRuntimeContext>[0]["wakeTransitionHooks"]) {
	const runtimePaths = paths();
	bootstrapAppHome(runtimePaths);
	const channelId = `dm_${name}`;
	mkdirSync(join(runtimePaths.workspaceDir, channelId, "tasks", "archive"), { recursive: true });
	const fakeRunner = runner();
	createRunnerMock.mockReturnValue(fakeRunner);
	const bot = new WakeBot();
	const runtime = await createRuntimeContext({
		paths: runtimePaths,
		dingtalkConfig: { clientId: "id", clientSecret: "secret", stateDir: runtimePaths.workspaceDir },
		registerSignalHandlers: false,
		startServices: false,
		createBot: () => bot as unknown as DingTalkBot,
		createEventsWatcher: () => ({ start() {}, stop() {} }),
		wakeTransitionHooks: hooks,
	});
	return { runtimePaths, channelId, fakeRunner, bot, runtime };
}

async function createWake(
	harness: Awaited<ReturnType<typeof createHarness>>,
	kind: "job" | "subagent",
	taskId: string,
): Promise<DingTalkEvent> {
	if (kind === "subagent") {
		const manager = getSubAgentRunManager(harness.channelId);
		const runId = `run-${taskId}`;
		await manager.register({
			runId,
			channelId: harness.channelId,
			runtime: "internal",
			agent: "builder",
			label: "build",
			source: "inline",
			tools: [],
			purpose: "work",
			taskId,
			workingDirectory: harness.runtimePaths.workspaceDir,
			artifactDir: join(harness.runtimePaths.workspaceDir, "artifacts", runId),
		});
		await manager.settle(
			runId,
			{
				status: "completed",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				usageKnown: true,
				costKnown: true,
				turns: 0,
				toolCalls: 0,
				durationMs: 1,
				outputText: "done",
			},
			{ announce: true },
		);
	} else {
		let jobId = "";
		const executor: Executor = {
			exec: async (command) => {
				if (command.includes("nohup")) return { stdout: "12345\n", stderr: "", code: 0 };
				if (command.includes("if [ -f")) return { stdout: `${jobId} EXIT:0\n`, stderr: "", code: 0 };
				return { stdout: "", stderr: "", code: 0 };
			},
		};
		const manager = getChannelJobManager(harness.channelId, executor);
		jobId = (await manager.start("true", "job", 60, { taskId })).id;
		await manager.list();
	}
	const wake = harness.bot.events.at(-1);
	if (!wake?.internalWake || wake.internalWake.kind !== kind) throw new Error(`missing ${kind} wake`);
	return wake;
}

afterEach(() => {
	createRunnerMock.mockReset();
	vi.restoreAllMocks();
});

describe("runtime structured wake delivery", () => {
	it.each(["job", "subagent"] as const)(
		"does not run the model for an already-consumed duplicate %s wake",
		async (kind) => {
			const harness = await createHarness(`duplicate_${kind}`);
			const taskId = `T-duplicate-${kind}`;
			const channelDir = await waitingTask(harness.runtimePaths.workspaceDir, harness.channelId, taskId, kind);
			const wake = await createWake(harness, kind, taskId);

			await harness.runtime.handler.handleEvent(wake, harness.bot as unknown as DingTalkBot, true);
			expect(harness.fakeRunner.run).toHaveBeenCalledTimes(1);
			expect((await readStoredTask(channelDir, taskId))?.fields.control?.usage.attempts).toBe(1);

			await harness.runtime.handler.handleEvent(
				{ ...wake, text: `[REDELIVERY:2] ${wake.text}` },
				harness.bot as unknown as DingTalkBot,
				true,
			);
			expect(harness.fakeRunner.run).toHaveBeenCalledTimes(1);
			expect((await readStoredTask(channelDir, taskId))?.fields.control?.usage.attempts).toBe(1);
			await harness.runtime.shutdown();
		},
	);

	it("still sends ordinary text without internalWake through runner.run", async () => {
		const harness = await createHarness("ordinary_text");
		await harness.runtime.handler.handleEvent(
			{
				type: "dm",
				channelId: harness.channelId,
				user: "user",
				userName: "User",
				text: "ordinary text",
				ts: "1",
				conversationId: "",
				conversationType: "1",
			},
			harness.bot as unknown as DingTalkBot,
		);
		expect(harness.fakeRunner.run).toHaveBeenCalledOnce();
		await harness.runtime.shutdown();
	});

	it.each([
		["job", "activation"],
		["job", "attempt"],
		["subagent", "activation"],
		["subagent", "attempt"],
	] as const)("keeps a %s wake durable after a retryable %s failure", async (kind, stage) => {
		let fail = true;
		const fault = () => {
			if (fail) throw new Error(`${stage} persist rejected`);
		};
		const harness = await createHarness(`retry_${kind}_${stage}`, {
			[kind]: stage === "activation" ? { beforeActivation: fault } : { beforeAttemptClaim: fault },
		});
		const taskId = `T-retry-${kind}-${stage}`;
		const channelDir = await waitingTask(harness.runtimePaths.workspaceDir, harness.channelId, taskId, kind);
		const wake = await createWake(harness, kind, taskId);
		const dispatchPath = join(harness.runtimePaths.appHomeDir, "state", "dispatch", `${wake.dispatchId}.json`);

		await harness.runtime.handler.handleEvent(wake, harness.bot as unknown as DingTalkBot, true);
		expect(harness.fakeRunner.run).not.toHaveBeenCalled();
		expect(existsSync(dispatchPath)).toBe(true);
		expect(JSON.parse(readFileSync(dispatchPath, "utf-8"))).toMatchObject({ status: "pending" });
		expect((await readStoredTask(channelDir, taskId))?.fields.control?.usage.attempts).toBe(0);

		fail = false;
		await harness.runtime.handler.handleEvent(wake, harness.bot as unknown as DingTalkBot, true);
		expect(harness.fakeRunner.run).toHaveBeenCalledOnce();
		expect(existsSync(dispatchPath)).toBe(false);
		expect((await readStoredTask(channelDir, taskId))?.fields.control?.usage.attempts).toBe(1);
		await harness.runtime.shutdown();
	});
});
