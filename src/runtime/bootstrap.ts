import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { parseBuiltInCommand } from "../agent/commands.js";
import { type AgentRunner, getOrCreateRunner } from "../agent/index.js";
import { resetRunner } from "../agent/runner-factory.js";
import * as log from "../log.js";
import { ensureChannelMemoryFilesSync } from "../memory/files.js";
import {
	APP_HOME_DIR,
	APP_NAME,
	AUTH_CONFIG_PATH,
	CHANNEL_CONFIG_PATH,
	MODELS_CONFIG_PATH,
	SECURITY_CONFIG_PATH,
	SETTINGS_CONFIG_PATH,
	TOOLS_CONFIG_PATH,
	WORKSPACE_DIR,
} from "../paths.js";
import { createExecutor, type Executor, parseSandboxArg, type SandboxConfig, validateSandbox } from "../sandbox.js";
import { loadSecurityConfigWithDiagnostics } from "../security/config.js";
import { PipiclawSettingsManager } from "../settings.js";
import { formatConfigDiagnostic } from "../shared/config-diagnostics.js";
import { loadToolsConfigWithDiagnostics } from "../tools/config.js";
import { ensureChannelDir } from "./channel-paths.js";
import { createDingTalkContext } from "./delivery.js";
import {
	type BusyMessageMode,
	DingTalkBot,
	type DingTalkConfig,
	type DingTalkEvent,
	type DingTalkHandler,
} from "./dingtalk.js";
import { createEventsWatcher } from "./events.js";
import { ChannelStore } from "./store.js";

export interface BootstrapPaths {
	appName: string;
	appHomeDir: string;
	workspaceDir: string;
	authConfigPath: string;
	channelConfigPath: string;
	modelsConfigPath: string;
	settingsConfigPath: string;
	toolsConfigPath: string;
	securityConfigPath: string;
}

export interface BootstrapIO {
	log: (...args: unknown[]) => void;
	error: (...args: unknown[]) => void;
}

export interface BootstrapOptions {
	env?: NodeJS.ProcessEnv;
	io?: BootstrapIO;
	paths?: BootstrapPaths;
	registerSignalHandlers?: boolean;
	startServices?: boolean;
}

export interface ParsedArgs {
	sandbox: SandboxConfig;
}

export interface BootstrapResult {
	created: string[];
	channelTemplateCreated: boolean;
}

export interface AppContext {
	bot: DingTalkBot;
	store: ChannelStore;
	shutdown: () => Promise<void>;
}

export interface RuntimeContext {
	handler: DingTalkHandler;
	store: ChannelStore;
	shutdown: (reason?: NodeJS.Signals | "manual") => Promise<void>;
}

interface ChannelState {
	running: boolean;
	runner: AgentRunner;
	stopRequested: boolean;
}

const DEFAULT_SOUL = `# SOUL.md

Configure Pipiclaw's identity, voice, and communication style here.

Suggested sections:

- Who the assistant is
- Default language
- Tone and personality
- Reply style
- Formatting preferences

Example topics you may want to define:

- "Answer in Chinese by default."
- "Be concise and direct."
- "Prefer Markdown."
- "Act as an engineering assistant for our team."

Replace this template with your actual identity prompt.
`;

const DEFAULT_AGENT = `# AGENTS.md

Configure Pipiclaw's operating rules here.

This file should define behavior and workflow. Identity, tone, and personality belong in \`SOUL.md\`.

Suggested sections:

- Tool usage policy
- Security constraints
- Scheduling/reminder policy
- Project-specific workflows
- Things the assistant must always or never do

Replace this template with your actual operating instructions.
`;

const DEFAULT_MEMORY = `# Workspace Memory

This file stores stable workspace-level memory.

- It is intended to be managed by a human administrator.
- It is not automatically rewritten by normal runtime consolidation.
- Store durable shared background here when it should apply across channels.
- Keep this file focused on stable facts, policies, and shared context, not transient conversation history.

## Shared Context

<!-- Put team-wide or workspace-wide background here. -->

## Tooling And Environment

<!-- Put durable tool usage rules, environment assumptions, or shared operational conventions here. -->

## Project Notes

<!-- Put long-lived project facts here. -->
`;

const DEFAULT_ENVIRONMENT = `# Environment

This file records durable environment facts and notable machine-level changes.

- Record installed tools, runtime prerequisites, and important config changes here.
- Keep entries concise and factual.
- Do not use this file for task progress, conversation summaries, or project-specific decisions.

## Environment Facts

<!-- Put stable machine or runtime facts here. -->

## Installed Tools

<!-- Record durable tools or dependencies that were installed for this workspace. -->

## Config Changes

<!-- Record important config or environment changes that affect future work. -->
`;

const CHANNEL_CONFIG_TEMPLATE = {
	clientId: "your-dingtalk-client-id",
	clientSecret: "your-dingtalk-client-secret",
	robotCode: "your-robot-code",
	cardTemplateId: "your-card-template-id",
	cardTemplateKey: "content",
	allowFrom: ["your-staff-id"],
} satisfies DingTalkConfig;

const MODELS_CONFIG_TEMPLATE = { providers: {} };
const TOOLS_CONFIG_TEMPLATE = {
	tools: {
		web: {
			enable: false,
			proxy: null,
			search: {
				provider: "brave",
				apiKey: "",
				maxResults: 5,
			},
		},
	},
	_examples: {
		proxy: "http://127.0.0.1:7890",
		apiKey: "BSA...",
	},
	_notes: [
		"Set tools.web.enable to true to register web_search and web_fetch.",
		"Replace tools.web.search.apiKey with your Brave API key before enabling web tools.",
		"If needed, copy _examples.proxy to tools.web.proxy.",
	],
};

const SECURITY_CONFIG_TEMPLATE = {
	pathGuard: {
		enabled: true,
	},
	commandGuard: {
		enabled: true,
	},
	networkGuard: {
		enabled: false,
	},
};

const SHUTDOWN_WAIT_MS = 15000;
const SHUTDOWN_FLUSH_WAIT_MS = 45000;
const SHUTDOWN_ABORT_WAIT_MS = 5000;

export const DEFAULT_BOOTSTRAP_PATHS: BootstrapPaths = {
	appName: APP_NAME,
	appHomeDir: APP_HOME_DIR,
	workspaceDir: WORKSPACE_DIR,
	authConfigPath: AUTH_CONFIG_PATH,
	channelConfigPath: CHANNEL_CONFIG_PATH,
	modelsConfigPath: MODELS_CONFIG_PATH,
	settingsConfigPath: SETTINGS_CONFIG_PATH,
	toolsConfigPath: TOOLS_CONFIG_PATH,
	securityConfigPath: SECURITY_CONFIG_PATH,
};

export class BootstrapExitError extends Error {
	readonly code: number;

	constructor(code: number, message?: string) {
		super(message ?? `Bootstrap requested exit with code ${code}`);
		this.code = code;
		this.name = "BootstrapExitError";
	}
}

export function isBootstrapExitError(error: unknown): error is BootstrapExitError {
	return error instanceof BootstrapExitError;
}

function readCliVersion(): string {
	try {
		const raw = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")) as {
			version?: unknown;
		};
		return typeof raw.version === "string" && raw.version.trim() ? raw.version : "0.0.0";
	} catch {
		return "0.0.0";
	}
}

function writeTextFileIfMissing(path: string, content: string, label: string, created: string[]): boolean {
	if (existsSync(path)) {
		return false;
	}
	writeFileSync(path, content, "utf-8");
	created.push(label);
	return true;
}

function writeJsonFileIfMissing(path: string, value: unknown, label: string, created: string[]): boolean {
	return writeTextFileIfMissing(path, `${JSON.stringify(value, null, 2)}\n`, label, created);
}

export function bootstrapAppHome(paths: BootstrapPaths = DEFAULT_BOOTSTRAP_PATHS): BootstrapResult {
	const created: string[] = [];

	if (!existsSync(paths.appHomeDir)) {
		mkdirSync(paths.appHomeDir, { recursive: true });
		created.push("app home");
	}
	if (!existsSync(paths.workspaceDir)) {
		mkdirSync(paths.workspaceDir, { recursive: true });
		created.push("workspace/");
	}

	for (const dir of ["skills", "events", "sub-agents"]) {
		const dirPath = join(paths.workspaceDir, dir);
		if (!existsSync(dirPath)) {
			mkdirSync(dirPath, { recursive: true });
			created.push(`workspace/${dir}/`);
		}
	}

	writeTextFileIfMissing(join(paths.workspaceDir, "SOUL.md"), DEFAULT_SOUL, "workspace/SOUL.md", created);
	writeTextFileIfMissing(join(paths.workspaceDir, "AGENTS.md"), DEFAULT_AGENT, "workspace/AGENTS.md", created);
	writeTextFileIfMissing(join(paths.workspaceDir, "MEMORY.md"), DEFAULT_MEMORY, "workspace/MEMORY.md", created);
	writeTextFileIfMissing(
		join(paths.workspaceDir, "ENVIRONMENT.md"),
		DEFAULT_ENVIRONMENT,
		"workspace/ENVIRONMENT.md",
		created,
	);

	const channelTemplateCreated = writeJsonFileIfMissing(
		paths.channelConfigPath,
		CHANNEL_CONFIG_TEMPLATE,
		"channel.json",
		created,
	);
	writeJsonFileIfMissing(paths.authConfigPath, {}, "auth.json", created);
	writeJsonFileIfMissing(paths.modelsConfigPath, MODELS_CONFIG_TEMPLATE, "models.json", created);
	writeJsonFileIfMissing(paths.settingsConfigPath, {}, "settings.json", created);
	writeJsonFileIfMissing(paths.toolsConfigPath, TOOLS_CONFIG_TEMPLATE, "tools.json", created);
	writeJsonFileIfMissing(paths.securityConfigPath, SECURITY_CONFIG_TEMPLATE, "security.json", created);

	return { created, channelTemplateCreated };
}

function isPlaceholderString(value: string): boolean {
	return value.trim().startsWith("your-");
}

function listChannelConfigIssues(config: Partial<DingTalkConfig>): string[] {
	const issues: string[] = [];

	if (!config.clientId) {
		issues.push("Missing required field `clientId`.");
	} else if (isPlaceholderString(config.clientId)) {
		issues.push("Replace placeholder value for `clientId`.");
	}

	if (!config.clientSecret) {
		issues.push("Missing required field `clientSecret`.");
	} else if (isPlaceholderString(config.clientSecret)) {
		issues.push("Replace placeholder value for `clientSecret`.");
	}

	if (config.robotCode && isPlaceholderString(config.robotCode)) {
		issues.push("Replace placeholder value for `robotCode`, or set it to an empty string to reuse `clientId`.");
	}

	if (config.cardTemplateId && isPlaceholderString(config.cardTemplateId)) {
		issues.push(
			"Replace placeholder value for `cardTemplateId`, or set it to an empty string to disable AI Card streaming.",
		);
	}

	if (Array.isArray(config.allowFrom) && config.allowFrom.some((value) => isPlaceholderString(value))) {
		issues.push("Replace placeholder values in `allowFrom`, or set it to an empty array to allow all users.");
	}

	return issues;
}

export function printBootstrapSummary(
	result: BootstrapResult,
	io: BootstrapIO = console,
	paths: BootstrapPaths = DEFAULT_BOOTSTRAP_PATHS,
): void {
	if (result.created.length === 0) {
		return;
	}

	io.log(`Initialized ${paths.appName} under ${paths.appHomeDir}:`);
	for (const item of result.created) {
		io.log(`  - ${item}`);
	}
	io.log("");
}

export function loadConfig(paths: BootstrapPaths = DEFAULT_BOOTSTRAP_PATHS, io: BootstrapIO = console): DingTalkConfig {
	let parsed: DingTalkConfig;

	try {
		parsed = JSON.parse(readFileSync(paths.channelConfigPath, "utf-8")) as DingTalkConfig;
	} catch (err) {
		io.error(`Failed to parse configuration: ${paths.channelConfigPath}`);
		io.error(err instanceof Error ? err.message : String(err));
		throw new BootstrapExitError(1);
	}

	const issues = listChannelConfigIssues(parsed);
	if (issues.length > 0) {
		io.error(`Configuration is not ready: ${paths.channelConfigPath}`);
		for (const issue of issues) {
			io.error(`  - ${issue}`);
		}
		io.error("");
		io.error(`Fill in ${paths.channelConfigPath} and run \`${paths.appName}\` again.`);
		throw new BootstrapExitError(1);
	}

	parsed.cardTemplateKey = parsed.cardTemplateKey || "content";
	parsed.robotCode = parsed.robotCode?.trim() ? parsed.robotCode : parsed.clientId;
	if (Array.isArray(parsed.allowFrom)) {
		parsed.allowFrom = parsed.allowFrom.filter((value) => value.trim().length > 0);
	}

	return parsed;
}

export function parseArgs(
	argv: string[],
	paths: BootstrapPaths = DEFAULT_BOOTSTRAP_PATHS,
	io: BootstrapIO = console,
): ParsedArgs {
	const args = argv.slice(2);
	let sandbox: SandboxConfig = { type: "host" };

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg.startsWith("--sandbox=")) {
			sandbox = parseSandboxArg(arg.slice("--sandbox=".length));
		} else if (arg === "--sandbox") {
			sandbox = parseSandboxArg(args[index + 1] || "");
			index += 1;
		} else if (arg === "--help" || arg === "-h") {
			io.log(`Usage: ${paths.appName} [options]`);
			io.log("");
			io.log("Options:");
			io.log("  --sandbox=host              Run tools on host (default)");
			io.log("  --sandbox=docker:<name>     Run tools in Docker container");
			io.log("  --version                   Print the current version and exit");
			io.log("");
			io.log(`Config:    ${paths.channelConfigPath}`);
			io.log(`Workspace: ${paths.workspaceDir}`);
			throw new BootstrapExitError(0);
		} else if (arg === "--version") {
			io.log(readCliVersion());
			throw new BootstrapExitError(0);
		}
	}

	return { sandbox };
}

function waitForTasks(tasks: Promise<void>[], timeoutMs: number): Promise<boolean> {
	if (tasks.length === 0) {
		return Promise.resolve(true);
	}

	return Promise.race([
		Promise.allSettled(tasks).then(() => true),
		new Promise<boolean>((resolve) => {
			setTimeout(() => resolve(false), timeoutMs);
		}),
	]);
}

function flushInactiveChannelMemory(channelStates: Map<string, ChannelState>): Promise<void>[] {
	const flushes: Promise<void>[] = [];
	for (const [channelId, state] of channelStates) {
		if (state.running) {
			continue;
		}
		flushes.push(
			state.runner.flushMemoryForShutdown().catch((err) => {
				log.logWarning(
					`[${channelId}] Failed to flush memory during shutdown`,
					err instanceof Error ? err.message : String(err),
				);
			}),
		);
	}
	return flushes;
}

interface RuntimeContextOptions {
	paths: BootstrapPaths;
	sandbox: SandboxConfig;
	dingtalkConfig: DingTalkConfig;
	createBot?: (handler: DingTalkHandler, config: DingTalkConfig) => DingTalkBot;
	createEventsWatcher?: (
		workspaceDir: string,
		bot: DingTalkBot,
		executor: Executor,
	) => { start(): void; stop(): void };
	startServices?: boolean;
	registerSignalHandlers?: boolean;
}

export function createRuntimeContext(options: RuntimeContextOptions): RuntimeContext & { bot: DingTalkBot } {
	const startServices = options.startServices ?? true;
	const registerSignalHandlers = options.registerSignalHandlers ?? true;
	const store = new ChannelStore({ workingDir: options.paths.workspaceDir });
	const channelStates = new Map<string, ChannelState>();
	const activeTasks = new Set<Promise<void>>();
	let shuttingDown = false;
	let shutdownPromise: Promise<void> | null = null;

	const archiveIncomingMessage = async (
		channelId: string,
		message: {
			date: string;
			ts: string;
			user: string;
			userName?: string;
			text: string;
			isBot: boolean;
			deliveryMode?: "steer" | "followUp";
			skipContextSync?: boolean;
		},
		contextLabel: string,
	): Promise<void> => {
		try {
			await store.logMessage(channelId, message);
		} catch (err) {
			log.logWarning(
				`[${channelId}] Failed to archive ${contextLabel}`,
				err instanceof Error ? err.message : String(err),
			);
		}
	};

	const getState = (channelId: string): ChannelState => {
		let state = channelStates.get(channelId);
		if (!state) {
			const channelDir = ensureChannelDir(options.paths.workspaceDir, channelId);
			ensureChannelMemoryFilesSync(channelDir);
			state = {
				running: false,
				runner: getOrCreateRunner(options.sandbox, channelId, channelDir),
				stopRequested: false,
			};
			channelStates.set(channelId, state);
		}
		return state;
	};

	const handler: DingTalkHandler = {
		isRunning(channelId: string): boolean {
			const state = channelStates.get(channelId);
			return state?.running ?? false;
		},

		async handleStop(channelId: string, _bot: DingTalkBot): Promise<void> {
			const state = channelStates.get(channelId);
			if (state?.running) {
				state.stopRequested = true;
				_bot.discardCard(channelId);
				void state.runner.abort().catch((err) => {
					log.logWarning(`[${channelId}] Failed to abort run`, err instanceof Error ? err.message : String(err));
				});
				log.logInfo(`[${channelId}] Stop requested`);
			}
		},

		async handleBusyMessage(
			event: DingTalkEvent,
			bot: DingTalkBot,
			mode: BusyMessageMode,
			queueText: string,
		): Promise<void> {
			if (shuttingDown) {
				return;
			}

			const state = getState(event.channelId);
			const trimmedQueueText = queueText.trim();

			await archiveIncomingMessage(
				event.channelId,
				{
					date: new Date().toISOString(),
					ts: event.ts,
					user: event.user,
					userName: event.userName,
					text: event.text,
					isBot: false,
					deliveryMode: mode,
					skipContextSync: true,
				},
				`${mode} message`,
			);

			try {
				if (mode === "followUp") {
					await state.runner.queueFollowUp(trimmedQueueText, event.userName);
				} else {
					await state.runner.queueSteer(trimmedQueueText, event.userName);
				}

				const confirmation =
					mode === "followUp"
						? "Queued as follow-up. I’ll handle it after the current task completes."
						: event.text.trim().startsWith("/")
							? "Queued as steer. I’ll apply it after the current tool step finishes."
							: "Queued as steer. I’ll apply this after the current tool step finishes. Use `/followup <message>` to queue it after completion.";
				await bot.sendPlain(event.channelId, confirmation);
				log.logInfo(`[${event.channelId}] Queued ${mode}: ${trimmedQueueText.substring(0, 80)}`);
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				log.logWarning(`[${event.channelId}] Failed to queue ${mode}`, errMsg);
				await bot.sendPlain(event.channelId, `Could not queue this message: ${errMsg}`);
			}
		},

		async handleEvent(event: DingTalkEvent, bot: DingTalkBot, _isEvent?: boolean): Promise<void> {
			if (shuttingDown) {
				log.logInfo(`[${event.channelId}] Ignoring event during shutdown`);
				return;
			}

			const state = getState(event.channelId);
			const task = (async () => {
				state.running = true;
				state.stopRequested = false;

				try {
					await archiveIncomingMessage(
						event.channelId,
						{
							date: new Date().toISOString(),
							ts: event.ts,
							user: event.user,
							userName: event.userName,
							text: event.text,
							isBot: false,
						},
						"user message",
					);

					const ctx = createDingTalkContext(event, bot, store);
					const builtInCommand = parseBuiltInCommand(event.text);

					if (builtInCommand) {
						log.logInfo(`[${event.channelId}] Executing command: ${builtInCommand.rawText}`);
						await state.runner.handleBuiltinCommand(ctx, builtInCommand);
						return;
					}

					log.logInfo(`[${event.channelId}] Starting run: ${event.text.substring(0, 50)}`);
					if (!_isEvent) {
						ctx.primeCard(350);
					}
					const result = await state.runner.run(ctx, store);

					if (result.stopReason === "aborted" && state.stopRequested) {
						log.logInfo(`[${event.channelId}] Stopped`);
					}
				} catch (err) {
					log.logWarning(`[${event.channelId}] Run error`, err instanceof Error ? err.message : String(err));
				} finally {
					state.running = false;
				}
			})();

			activeTasks.add(task);
			try {
				await task;
			} finally {
				activeTasks.delete(task);
			}
		},
	};

	const bot = options.createBot
		? options.createBot(handler, options.dingtalkConfig)
		: new DingTalkBot(handler, options.dingtalkConfig);
	const executor = createExecutor(options.sandbox);
	const eventsWatcher = options.createEventsWatcher
		? options.createEventsWatcher(options.paths.workspaceDir, bot, executor)
		: createEventsWatcher(
				options.paths.workspaceDir,
				bot,
				executor,
				loadSecurityConfigWithDiagnostics(options.paths.appHomeDir).config.commandGuard,
			);

	const shutdownWithReason = async (reason: NodeJS.Signals | "manual" = "manual"): Promise<void> => {
		if (shutdownPromise) {
			return shutdownPromise;
		}

		shutdownPromise = (async () => {
			shuttingDown = true;
			log.logInfo(`Shutting down (${reason})...`);

			eventsWatcher.stop();
			await bot.stop();

			const runningTasks = Array.from(activeTasks);
			if (runningTasks.length > 0) {
				log.logInfo(`Waiting for ${runningTasks.length} active task(s) to finish`);
				const completed = await waitForTasks(runningTasks, SHUTDOWN_WAIT_MS);

				if (!completed) {
					log.logWarning(`Shutdown grace period exceeded ${SHUTDOWN_WAIT_MS}ms, aborting active runs`);
					const aborts: Promise<void>[] = [];
					for (const [channelId, state] of channelStates) {
						if (!state.running) continue;
						state.stopRequested = true;
						log.logInfo(`[${channelId}] Aborting active run for shutdown`);
						aborts.push(
							state.runner.abort().catch((err) => {
								log.logWarning(
									`[${channelId}] Failed to abort run during shutdown`,
									err instanceof Error ? err.message : String(err),
								);
							}),
						);
					}
					await Promise.allSettled(aborts);

					const remainingTasks = Array.from(activeTasks);
					if (remainingTasks.length > 0) {
						const abortedCompleted = await waitForTasks(remainingTasks, SHUTDOWN_ABORT_WAIT_MS);
						if (!abortedCompleted) {
							log.logWarning(`Shutdown forced exit with ${remainingTasks.length} task(s) still active`);
						}
					}
				}
			}

			const flushes = flushInactiveChannelMemory(channelStates);
			if (flushes.length > 0) {
				log.logInfo(`Flushing memory for ${flushes.length} inactive channel(s) before shutdown`);
				const flushed = await waitForTasks(flushes, SHUTDOWN_FLUSH_WAIT_MS);
				if (!flushed) {
					log.logWarning(`Shutdown memory flush exceeded ${SHUTDOWN_FLUSH_WAIT_MS}ms`);
				}
			}

			for (const channelId of channelStates.keys()) {
				resetRunner(channelId);
			}
		})();

		return shutdownPromise;
	};

	if (registerSignalHandlers) {
		process.once("SIGINT", () => {
			void shutdownWithReason("SIGINT").finally(() => {
				process.exit(0);
			});
		});

		process.once("SIGTERM", () => {
			void shutdownWithReason("SIGTERM").finally(() => {
				process.exit(0);
			});
		});
	}

	if (startServices) {
		eventsWatcher.start();
		void bot.start();
	}

	return {
		handler,
		store,
		bot,
		shutdown: shutdownWithReason,
	};
}

export async function bootstrap(argv: string[], options: BootstrapOptions = {}): Promise<AppContext> {
	const io = options.io ?? console;
	const paths = options.paths ?? DEFAULT_BOOTSTRAP_PATHS;
	const registerSignalHandlers = options.registerSignalHandlers ?? true;
	const startServices = options.startServices ?? true;

	const parsedArgs = parseArgs(argv, paths, io);
	const sandbox = parsedArgs.sandbox;
	const bootstrapResult = bootstrapAppHome(paths);
	printBootstrapSummary(bootstrapResult, io, paths);

	if (bootstrapResult.channelTemplateCreated) {
		io.error(`Fill in ${paths.channelConfigPath} and run \`${paths.appName}\` again.`);
		throw new BootstrapExitError(1);
	}

	const dingtalkConfig = loadConfig(paths, io);
	dingtalkConfig.stateDir = paths.workspaceDir;
	const settingsManager = new PipiclawSettingsManager(paths.appHomeDir);
	for (const { scope, error } of settingsManager.drainErrors()) {
		log.logWarning(`Failed to load ${scope} settings`, `${error.message}\n${paths.settingsConfigPath}`);
	}
	for (const diagnostic of loadToolsConfigWithDiagnostics(paths.appHomeDir).diagnostics) {
		log.logWarning(formatConfigDiagnostic(diagnostic), diagnostic.path);
	}
	for (const diagnostic of loadSecurityConfigWithDiagnostics(paths.appHomeDir).diagnostics) {
		log.logWarning(formatConfigDiagnostic(diagnostic), diagnostic.path);
	}

	await validateSandbox(sandbox);

	log.logStartup(paths.workspaceDir, sandbox.type === "host" ? "host" : `docker:${sandbox.container}`);
	const runtime = createRuntimeContext({
		paths,
		sandbox,
		dingtalkConfig,
		registerSignalHandlers,
		startServices,
	});

	return {
		bot: runtime.bot,
		store: runtime.store,
		shutdown: async () => {
			await runtime.shutdown("manual");
		},
	};
}
