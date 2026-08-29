import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { DingTalkBot, DingTalkEvent } from "../../src/runtime/dingtalk.js";
import { waitFor } from "../e2e/helpers/wait.js";
import { type CapturedDelivery, E2EFakeDingTalkBot } from "./fake-bot.js";
import { HarnessDingTalkBot } from "./harness-bot.js";
import type { CapturedRequest } from "./mock-provider/script.js";
import { startMockProvider } from "./mock-provider/server.js";
import { cleanupE2ETestHome, createDeterministicHome, createE2ETestHome, type E2ETestHome } from "./setup.js";

export { reply } from "./mock-provider/script.js";
export type { MockProvider } from "./mock-provider/server.js";

export interface E2ERuntimeHarness {
	homeDir: string;
	workspaceDir: string;
	channelId: string;
	channelDir: string;
	deliveries: CapturedDelivery[];
	sendUserMessage(text: string, overrides?: Partial<DingTalkEvent>): Promise<void>;
	/**
	 * Reads back the model the runner actually resolved (via `/status`) and throws
	 * if it does not match `expectedModelId`. Guards F4 (spec 048): a "tests the real
	 * model" suite that silently ran a different model than it declared. Call it after
	 * at least one real turn so the session runtime has settled.
	 */
	assertResolvedModel(expectedModelId: string): Promise<void>;
	shutdown(): Promise<void>;
}

function getChannelDirName(channelId: string): string {
	return channelId.replaceAll("/", "__");
}

export async function createRuntimeHarness(options?: {
	channelId?: string;
	enableDebug?: boolean;
	home?: E2ETestHome;
	startServices?: boolean;
	memoryMaintenanceSchedulerIntervalMs?: number;
}): Promise<E2ERuntimeHarness> {
	const home = options?.home ?? createE2ETestHome({ enableDebug: options?.enableDebug });
	process.env.PIPICLAW_HOME = home.homeDir;

	const { createRuntimeContext } = await import("../../src/runtime/bootstrap.js");
	const channelId = options?.channelId ?? "dm_e2e_user";
	const channelDir = join(home.workspaceDir, getChannelDirName(channelId));
	const fakeBot = new E2EFakeDingTalkBot();
	const runtime = await createRuntimeContext({
		paths: {
			appName: "pipiclaw",
			appHomeDir: home.homeDir,
			workspaceDir: home.workspaceDir,
			authConfigPath: join(home.homeDir, "auth.json"),
			channelConfigPath: join(home.homeDir, "channel.json"),
			modelsConfigPath: join(home.homeDir, "models.json"),
			settingsConfigPath: join(home.homeDir, "settings.json"),
			toolsConfigPath: join(home.homeDir, "tools.json"),
			securityConfigPath: join(home.homeDir, "security.json"),
			eventHistoryPath: join(home.homeDir, "state", "events", "history.jsonl"),
		},
		dingtalkConfig: {
			clientId: "e2e-client-id",
			clientSecret: "e2e-client-secret",
			robotCode: "e2e-client-id",
			cardTemplateKey: "content",
			stateDir: home.workspaceDir,
		},
		registerSignalHandlers: false,
		startServices: options?.startServices ?? false,
		memoryMaintenanceSchedulerIntervalMs: options?.memoryMaintenanceSchedulerIntervalMs,
		createBot: () => fakeBot as unknown as DingTalkBot,
		createEventsWatcher: () => ({ start() {}, stop() {} }),
	});

	return {
		homeDir: home.homeDir,
		workspaceDir: home.workspaceDir,
		channelId,
		channelDir,
		deliveries: fakeBot.deliveries,
		async sendUserMessage(text: string, overrides?: Partial<DingTalkEvent>): Promise<void> {
			await runtime.handler.handleEvent(
				{
					type: "dm",
					channelId,
					ts: Date.now().toString(),
					user: "e2e_user",
					userName: "E2E Tester",
					text,
					conversationId: "conv_e2e",
					conversationType: "1",
					...overrides,
				},
				fakeBot as unknown as DingTalkBot,
			);
		},
		async assertResolvedModel(expectedModelId: string): Promise<void> {
			const status = await runtime.handler.runRuntimeCommand(
				{
					type: "dm",
					channelId,
					ts: Date.now().toString(),
					user: "e2e_user",
					userName: "E2E Tester",
					text: "/status",
					conversationId: "conv_e2e",
					conversationType: "1",
				},
				"status",
				"",
			);
			if (!status.includes(expectedModelId)) {
				throw new Error(
					`E2E model mismatch: settings.json declares "${expectedModelId}" but the runner resolved a different model.\n${status}`,
				);
			}
		},
		async shutdown(): Promise<void> {
			await runtime.shutdown("manual");
			cleanupE2ETestHome(home.homeDir);
		},
	};
}

export interface DeterministicHarness {
	homeDir: string;
	workspaceDir: string;
	channelId: string;
	channelDir: string;
	deliveries: CapturedDelivery[];
	/** The in-process mock provider. Register routes on `model.script` before sending. */
	model: import("./mock-provider/server.js").MockProvider;
	/** Send a message and wait for the channel queue + turn to fully settle. */
	sendUserMessage(text: string, overrides?: Partial<DingTalkEvent>): Promise<void>;
	/** Enqueue a message but return immediately — for stacking messages during a `hold`. */
	sendUserMessageNoWait(text: string, overrides?: Partial<DingTalkEvent>): Promise<void>;
	/** Wait until no channel queue has pending/in-flight work and the runner is idle. */
	waitForIdle(): Promise<void>;
	/** Wait for a captured delivery matching `predicate`. */
	waitForDelivery(predicate: (d: CapturedDelivery) => boolean): Promise<CapturedDelivery>;
	/** Restart the runtime against the same home + mock (daemon restart / re-adoption). */
	restart(): Promise<void>;
	/** Count of chat-completions requests the provider has received so far. */
	modelRequestCount(): number;
	/** Just the main-turn requests (those carrying tools). */
	mainTurnRequests(): CapturedRequest[];
	/** The most recent main-turn request body the provider received. */
	lastMainTurnRequest(): CapturedRequest | undefined;
	/** Throws if the provider saw a request no route matched. Call in `afterEach`. */
	assertNoUnmatchedRequests(): void;
	shutdown(): Promise<void>;
}

/**
 * The deterministic e2e harness (spec 048 P1/P2): a real `DingTalkBot` (real
 * `ChannelQueue`, real busy / `/steer` / `/stop` / `/new` routing) with captured
 * delivery and no socket, plus the in-process mock provider as the model. Full
 * runtime, real memory, real persistence — no network, no cost.
 */
export async function createDeterministicHarness(options?: {
	channelId?: string;
	registerSidecarDefaults?: boolean;
	/** Transport default for a plain message that arrives mid-turn. Default: "followup". */
	busyMessageDefault?: "steer" | "followup";
}): Promise<DeterministicHarness> {
	const model = await startMockProvider({ registerDefaults: options?.registerSidecarDefaults });
	const home = createDeterministicHome({ mockBaseUrl: model.baseUrl });
	const channelId = options?.channelId ?? "dm_e2e_user";
	const channelDir = join(home.workspaceDir, getChannelDirName(channelId));
	const deliveries: CapturedDelivery[] = [];

	const { createRuntimeContext } = await import("../../src/runtime/bootstrap.js");
	const dingtalkConfig = {
		clientId: "e2e-client-id",
		clientSecret: "e2e-client-secret",
		robotCode: "e2e-client-id",
		cardTemplateKey: "content",
		stateDir: home.workspaceDir,
		busyMessageDefault: options?.busyMessageDefault ?? "followup",
	};
	const paths = {
		appName: "pipiclaw",
		appHomeDir: home.homeDir,
		workspaceDir: home.workspaceDir,
		authConfigPath: join(home.homeDir, "auth.json"),
		channelConfigPath: join(home.homeDir, "channel.json"),
		modelsConfigPath: join(home.homeDir, "models.json"),
		settingsConfigPath: join(home.homeDir, "settings.json"),
		toolsConfigPath: join(home.homeDir, "tools.json"),
		securityConfigPath: join(home.homeDir, "security.json"),
		eventHistoryPath: join(home.homeDir, "state", "events", "history.jsonl"),
	};

	let bot!: HarnessDingTalkBot;
	let runtime!: Awaited<ReturnType<typeof createRuntimeContext>>;

	async function boot(): Promise<void> {
		process.env.PIPICLAW_HOME = home.homeDir;
		runtime = await createRuntimeContext({
			paths,
			dingtalkConfig,
			registerSignalHandlers: false,
			startServices: false,
			createBot: (handler) => {
				bot = new HarnessDingTalkBot(handler, dingtalkConfig as never, deliveries);
				return bot as unknown as import("../../src/runtime/dingtalk.js").DingTalkBot;
			},
			createEventsWatcher: () => ({ start() {}, stop() {} }),
		});
	}
	await boot();

	function buildEvent(text: string, overrides?: Partial<DingTalkEvent>): DingTalkEvent {
		return {
			type: "dm",
			channelId,
			ts: Date.now().toString(),
			user: "e2e_user",
			userName: "E2E Tester",
			text,
			conversationId: "conv_e2e",
			conversationType: "1",
			...overrides,
		};
	}

	async function waitForIdle(): Promise<void> {
		await waitFor("channel idle", () => bot.allChannelQueuesIdle() && !runtime.handler.isRunning(channelId), {
			timeoutMs: 30_000,
			intervalMs: 25,
		});
	}

	return {
		homeDir: home.homeDir,
		workspaceDir: home.workspaceDir,
		channelId,
		channelDir,
		deliveries,
		model,
		async sendUserMessage(text, overrides): Promise<void> {
			await bot.routeInboundEvent(buildEvent(text, overrides));
			await waitForIdle();
		},
		async sendUserMessageNoWait(text, overrides): Promise<void> {
			await bot.routeInboundEvent(buildEvent(text, overrides));
		},
		waitForIdle,
		waitForDelivery: (predicate) =>
			waitFor("delivery", () => deliveries.find(predicate) ?? null, { timeoutMs: 30_000, intervalMs: 25 }),
		async restart(): Promise<void> {
			await runtime.shutdown("manual");
			await boot();
		},
		modelRequestCount: () => model.requests.length,
		mainTurnRequests: () => model.requests.filter((r) => r.isMainTurn),
		lastMainTurnRequest: () => [...model.requests].reverse().find((r) => r.isMainTurn),
		assertNoUnmatchedRequests(): void {
			const bad = model.unmatched();
			if (bad.length > 0) {
				const lines = bad
					.map(
						(r) =>
							`  - ${r.isMainTurn ? "main" : "sidecar"}: ${(r.lastUserText || r.systemPrompt).slice(0, 200)}`,
					)
					.join("\n");
				throw new Error(`mock provider received ${bad.length} unmatched request(s):\n${lines}`);
			}
		},
		async shutdown(): Promise<void> {
			await runtime.shutdown("manual");
			await model.close();
			cleanupE2ETestHome(home.homeDir);
		},
	};
}

export function writeWorkspaceFile(
	harness: Pick<E2ERuntimeHarness, "workspaceDir">,
	relativePath: string,
	content: string,
): string {
	const path = join(harness.workspaceDir, relativePath);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, "utf-8");
	return path;
}

/** Write a minimal workspace skill so `/<name>` is a known slash command. */
export function writeWorkspaceSkill(
	harness: Pick<E2ERuntimeHarness, "workspaceDir">,
	name: string,
	body = "Reply with the word SKILL_RAN and nothing else.",
): void {
	const dir = join(harness.workspaceDir, "skills", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		`---\nname: ${name}\ndescription: e2e fixture skill ${name}\n---\n\n${body}\n`,
		"utf-8",
	);
}

export function getChannelFile(harness: Pick<E2ERuntimeHarness, "channelDir">, filename: string): string {
	return join(harness.channelDir, filename);
}

export function channelFileExists(harness: Pick<E2ERuntimeHarness, "channelDir">, filename: string): boolean {
	return existsSync(getChannelFile(harness, filename));
}
