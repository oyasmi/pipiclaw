import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import {
	formatUnknownCommandMessage,
	isRunnerBuiltInCommand,
	parseBuiltInCommand,
	slashCommandName,
} from "../agent/commands.js";
import { channelEffectCount, noteTaskEffects, taskEffectCount } from "../agent/effect-ledger.js";
import { type AgentRunner, getOrCreateRunner } from "../agent/index.js";
import {
	configureJobRuntime,
	getChannelJobManager,
	type JobSnapshot,
	restoreChannelJobs,
} from "../agent/job-manager.js";
import { loadDetachedMaintenanceContext } from "../agent/maintenance-context.js";
import { resetRunner } from "../agent/runner-factory.js";
import { renderStatus } from "../agent/status-render.js";
import { createExecutor, type Executor } from "../executor.js";
import * as log from "../log.js";
import { ensureChannelMemoryFilesSync } from "../memory/files.js";
import { MemoryMaintenanceScheduler } from "../memory/scheduler.js";
import {
	APP_HOME_DIR,
	APP_NAME,
	AUTH_CONFIG_PATH,
	CHANNEL_CONFIG_PATH,
	DEFAULT_APP_HOME_DIR,
	EVENT_HISTORY_PATH,
	LEGACY_APP_HOME_DIR,
	MODELS_CONFIG_PATH,
	SECURITY_CONFIG_PATH,
	SETTINGS_CONFIG_PATH,
	TOOLS_CONFIG_PATH,
	WORKSPACE_DIR,
} from "../paths.js";
import { loadSecurityConfigWithDiagnostics } from "../security/config.js";
import { flushSecurityLogs } from "../security/logger.js";
import { PipiclawSettingsManager } from "../settings.js";
import { formatConfigDiagnostic } from "../shared/config-diagnostic.js";
import { fileStamp } from "../shared/file-stamp.js";
import { errorMessage } from "../shared/text-utils.js";
import {
	configureSubAgentRuntime,
	getSubAgentRunManager,
	type RunRecord,
	restoreAllSubAgentRuns,
} from "../subagents/runs.js";
import { readActiveTasks } from "../tasks/ledger.js";
import {
	activateWaitingTaskAndClaimAttempt,
	finishTaskAttempt,
	finishWakeTaskActivation,
	rollbackWakeTaskActivation,
	type WakeTaskHandoffInput,
	type WakeTaskTransitionHooks,
} from "../tasks/store.js";
import { getToolsConfigPath, loadToolsConfig, loadToolsConfigWithDiagnostics } from "../tools/config.js";
import { getUsageLedger } from "../usage/ledger.js";
import { parseUsageMode, renderUsageReport } from "../usage/render.js";
import { type ChannelIndex, createChannelIndex } from "./channel-index.js";
import { ensureChannelDir, getChannelDir } from "./channel-paths.js";
import { createDingTalkContext } from "./delivery.js";
import {
	type BusyMessageMode,
	type BusyMessageResult,
	DingTalkBot,
	type DingTalkConfig,
	type DingTalkEvent,
	type DingTalkHandler,
	isBusyMessageDefaultConfig,
	isResponseModeConfig,
	normalizeBusyMessageDefault,
	normalizeResponseMode,
	type StopOutcome,
} from "./dingtalk.js";
import { DurableDispatchService } from "./durable-dispatch.js";
import { handleEventsCommand as runEventsCommand } from "./event-commands.js";
import { createEventsWatcher } from "./events.js";
import { installLlmProxy } from "./proxy.js";
import { ChannelStore } from "./store.js";
import { handleSubagentsCommand as runSubagentsCommand } from "./subagent-commands.js";
import { pauseTask, handleTasksCommand as runTasksCommand } from "./task-commands.js";
import { createTaskDriverEvent, createTaskVerificationEvent, TaskDriver } from "./task-driver.js";
import { migrateLegacyTaskScheduleEvents, migrateLegacyTaskState } from "./task-migration.js";
import { DEFAULT_AGENTS, DEFAULT_SOUL } from "./workspace-templates.js";

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
	eventHistoryPath: string;
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
	/** Production driver instance, exposed so evals can invoke the real scan path. */
	taskDriver: { start(): void; stop(): void; nudge?(): void; runOnce?: (now?: Date) => Promise<void> };
	/**
	 * Production maintenance scheduler, exposed for the same reason as `taskDriver`.
	 *
	 * Evaluation workers run with `startServices: false`, so the background timer never fires and
	 * no trial could otherwise reach `SESSION.md` refresh, the memory checkpoint, or consolidation
	 * — the whole layered memory pipeline was structurally untestable from a behavior eval.
	 * Exposing the instance lets a case drive one real pass at a chosen time instead of faking a
	 * clock or re-implementing the job order.
	 */
	memoryMaintenance: { start(): void; stop(): void; runOnce?: (now?: Date) => Promise<void> };
	shutdown: (reason?: NodeJS.Signals | "manual") => Promise<void>;
}

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
	busyMessageDefault: "steer",
	responseMode: "full_progress_then_plain_final",
	cardAutoLayout: true,
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
		tasks: {
			enabled: true,
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
		"tools.tasks.enabled is the master switch for autonomous long-running tasks (task_manage tool + task driver + task digest).",
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
const SHUTDOWN_LOG_FLUSH_WAIT_MS = 10_000;

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
	eventHistoryPath: EVENT_HISTORY_PATH,
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

export function readCliVersion(): string {
	try {
		const raw = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")) as {
			version?: unknown;
		};
		return typeof raw.version === "string" && raw.version.trim() ? raw.version : "0.0.0";
	} catch {
		return "0.0.0";
	}
}

function writeTextFileIfMissing(
	path: string,
	content: string,
	label: string,
	created: string[],
	mode?: number,
): boolean {
	if (existsSync(path)) {
		return false;
	}
	writeFileSync(path, content, mode !== undefined ? { encoding: "utf-8", mode } : "utf-8");
	created.push(label);
	return true;
}

function writeJsonFileIfMissing(
	path: string,
	value: unknown,
	label: string,
	created: string[],
	mode?: number,
): boolean {
	return writeTextFileIfMissing(path, `${JSON.stringify(value, null, 2)}\n`, label, created, mode);
}

// App-level config files that may hold secrets (DingTalk client secret, provider
// API keys, Brave key). They are created owner-only, and any pre-existing file with
// looser bits is tightened on startup.
const SECRET_FILE_MODE = 0o600;

function hardenExistingSecretFile(path: string): void {
	if (!existsSync(path)) {
		return;
	}
	try {
		const mode = statSync(path).mode & 0o777;
		if ((mode & 0o077) !== 0) {
			chmodSync(path, SECRET_FILE_MODE);
			log.logInfo(`Tightened permissions on ${path} to 0600`);
		}
	} catch (err) {
		log.logWarning(`Failed to tighten permissions on ${path}`, errorMessage(err));
	}
}

// FIXME(0.9.0): remove this legacy-home migration (and LEGACY_APP_HOME_DIR).
// The default app home moved from `~/.pi/pipiclaw` to `~/.pipiclaw`. When the
// new default location is not yet present but a legacy install is, move the old
// directory over so existing users keep their config/workspace/state with no
// manual step. Exported for direct testing; the env-gating (only for the real
// default home, never a custom PIPICLAW_HOME) lives at the call site.
export function migrateLegacyAppHome(targetDir: string, legacyDir: string, io: BootstrapIO): boolean {
	if (existsSync(targetDir) || !existsSync(legacyDir)) {
		return false;
	}
	try {
		renameSync(legacyDir, targetDir);
		io.log(`Migrated existing data from ${legacyDir} to ${targetDir}.`);
		return true;
	} catch (err) {
		io.error(`Failed to migrate ${legacyDir} to ${targetDir}: ${errorMessage(err)}`);
		io.error(`Move it manually, or set PIPICLAW_HOME=${legacyDir} to keep using the old location.`);
		throw new BootstrapExitError(1);
	}
}

export function bootstrapAppHome(
	paths: BootstrapPaths = DEFAULT_BOOTSTRAP_PATHS,
	io: BootstrapIO = console,
): BootstrapResult {
	const created: string[] = [];

	// FIXME(0.9.0): remove alongside migrateLegacyAppHome.
	if (paths.appHomeDir === DEFAULT_APP_HOME_DIR) {
		migrateLegacyAppHome(paths.appHomeDir, LEGACY_APP_HOME_DIR, io);
	}

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
	writeTextFileIfMissing(join(paths.workspaceDir, "AGENTS.md"), DEFAULT_AGENTS, "workspace/AGENTS.md", created);
	writeTextFileIfMissing(join(paths.workspaceDir, "MEMORY.md"), DEFAULT_MEMORY, "workspace/MEMORY.md", created);
	writeTextFileIfMissing(
		join(paths.workspaceDir, "ENVIRONMENT.md"),
		DEFAULT_ENVIRONMENT,
		"workspace/ENVIRONMENT.md",
		created,
	);

	const secretConfigPaths = [
		paths.channelConfigPath,
		paths.authConfigPath,
		paths.modelsConfigPath,
		paths.settingsConfigPath,
		paths.toolsConfigPath,
		paths.securityConfigPath,
	];

	const channelTemplateCreated = writeJsonFileIfMissing(
		paths.channelConfigPath,
		CHANNEL_CONFIG_TEMPLATE,
		"channel.json",
		created,
		SECRET_FILE_MODE,
	);
	writeJsonFileIfMissing(paths.authConfigPath, {}, "auth.json", created, SECRET_FILE_MODE);
	writeJsonFileIfMissing(paths.modelsConfigPath, MODELS_CONFIG_TEMPLATE, "models.json", created, SECRET_FILE_MODE);
	writeJsonFileIfMissing(paths.settingsConfigPath, {}, "settings.json", created, SECRET_FILE_MODE);
	writeJsonFileIfMissing(paths.toolsConfigPath, TOOLS_CONFIG_TEMPLATE, "tools.json", created, SECRET_FILE_MODE);
	writeJsonFileIfMissing(
		paths.securityConfigPath,
		SECURITY_CONFIG_TEMPLATE,
		"security.json",
		created,
		SECRET_FILE_MODE,
	);

	// Tighten any pre-existing config that predates owner-only creation.
	for (const secretPath of secretConfigPaths) {
		hardenExistingSecretFile(secretPath);
	}

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

	const busyMessageDefault = (config as { busyMessageDefault?: unknown }).busyMessageDefault;
	if (busyMessageDefault !== undefined && !isBusyMessageDefaultConfig(busyMessageDefault)) {
		issues.push('Invalid `busyMessageDefault`: expected "steer", "followUp", or "followup".');
	}

	const responseMode = (config as { responseMode?: unknown }).responseMode;
	if (responseMode !== undefined && !isResponseModeConfig(responseMode)) {
		issues.push(
			'Invalid `responseMode`: expected "full_progress_then_plain_final", "rolling_progress_then_plain_final", or "final_card_only".',
		);
	}

	const cardAutoLayout = (config as { cardAutoLayout?: unknown }).cardAutoLayout;
	if (cardAutoLayout !== undefined && typeof cardAutoLayout !== "boolean") {
		issues.push("Invalid `cardAutoLayout`: expected boolean.");
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
		io.error(errorMessage(err));
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
	parsed.busyMessageDefault = normalizeBusyMessageDefault(
		(parsed as { busyMessageDefault?: unknown }).busyMessageDefault,
	);
	parsed.responseMode = normalizeResponseMode((parsed as { responseMode?: unknown }).responseMode);
	parsed.cardAutoLayout = (parsed as { cardAutoLayout?: boolean }).cardAutoLayout ?? true;
	if (Array.isArray(parsed.allowFrom)) {
		parsed.allowFrom = parsed.allowFrom.filter((value) => value.trim().length > 0);
	}

	return parsed;
}

export function parseArgs(
	argv: string[],
	paths: BootstrapPaths = DEFAULT_BOOTSTRAP_PATHS,
	io: BootstrapIO = console,
): void {
	const args = argv.slice(2);

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (index === 0 && arg === "run") {
			// Explicit name for the default daemon mode (`pipiclaw run` == `pipiclaw`).
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			io.log(`Usage: ${paths.appName} [command] [options]`);
			io.log("");
			io.log("Commands:");
			io.log("  run                         Run the long-lived DingTalk daemon (default)");
			io.log("  tui [prompt]                Chat with the agent in the terminal");
			io.log("");
			io.log("Options:");
			io.log("  --version                   Print the current version and exit");
			io.log("  --help, -h                  Show this help and exit");
			io.log("");
			io.log(`Config:    ${paths.channelConfigPath}`);
			io.log(`Workspace: ${paths.workspaceDir}`);
			throw new BootstrapExitError(0);
		} else if (arg === "--version") {
			io.log(readCliVersion());
			throw new BootstrapExitError(0);
		} else {
			io.error(`Unknown option: ${arg}`);
			io.error(`Run \`${paths.appName} --help\` for usage.`);
			throw new BootstrapExitError(1);
		}
	}
}

function waitForTasks(tasks: Promise<void>[], timeoutMs: number): Promise<boolean> {
	if (tasks.length === 0) {
		return Promise.resolve(true);
	}

	return new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => resolve(false), timeoutMs);
		timer.unref?.();
		void Promise.allSettled(tasks).then(() => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

function flushInactiveChannelMemory(channelRunners: Map<string, AgentRunner>): Promise<void>[] {
	const flushes: Promise<void>[] = [];
	for (const [channelId, runner] of channelRunners) {
		if (runner.isBusy()) {
			continue;
		}
		flushes.push(
			runner.flushMemoryForShutdown().catch((err) => {
				log.logWarning(`[${channelId}] Failed to flush memory during shutdown`, errorMessage(err));
			}),
		);
	}
	return flushes;
}

function isNoRunningTaskQueueError(err: unknown): boolean {
	return err instanceof Error && err.message === "No task is currently running.";
}

/**
 * Whether a `[JOB:<jobId>] ... belongs to task <taskId>.` wake actually names a job that: exists
 * on this channel, has actually finished (a still-`running` job cannot have produced this wake —
 * accepting it anyway would let a message merely mentioning a live job's id activate a task
 * early), and really is the one whose own contract names `taskId` (spec 040, T9). The text itself
 * is never sufficient — it can be typed by any user, or echoed back by an external agent's own
 * untrusted stdout.
 */
export function isVerifiedJobWake(jobs: JobSnapshot[], jobId: string, taskId: string): boolean {
	const job = jobs.find((candidate) => candidate.id === jobId);
	return job !== undefined && job.status !== "running" && job.taskId === taskId;
}

/**
 * Same check as `isVerifiedJobWake`, for a `[SUBAGENT:<runId>] ... belongs to task <taskId>.`
 * delegation wake. `settledAt` (rather than `status !== "running"`) is the terminal marker here
 * because it is the one field `SubAgentRunManager.settle()` sets unconditionally and first, before
 * usage/archive/wake side effects — the same idempotency guard the manager itself relies on.
 */
export function isVerifiedDelegationWake(record: RunRecord | undefined, taskId: string): boolean {
	return record !== undefined && record.settledAt !== undefined && record.taskId === taskId;
}

/** Plain wake text is untrusted. Only an event carrying the producer-created structured envelope
 * and its exact durable dispatch id may enter task activation; normal DingTalk inbound events do
 * not populate `internalWake`, so copying a real wake's text is insufficient. */
export function isTrustedInternalWake(
	event: DingTalkEvent,
	kind: "job" | "subagent",
	resourceId: string,
	taskId: string,
): event is DingTalkEvent & { dispatchId: string } {
	const wake = event.internalWake;
	return (
		wake?.kind === kind &&
		wake.resourceId === resourceId &&
		wake.taskId === taskId &&
		typeof event.dispatchId === "string" &&
		wake.dispatchId === event.dispatchId
	);
}

export interface ClaimedDelegationWake {
	taskId: string;
	generation?: number;
	activated: boolean;
	finish(): Promise<void>;
	rollback(): Promise<void>;
}

/** Claim and activate a producer-created delegation wake without consuming it yet. Keeping the
 * final marker separate lets transports such as TUI mark it consumed only after they have accepted
 * the corresponding turn; a rejected submit remains replayable in the same or next process. */
export async function claimVerifiedDelegationWake(
	event: DingTalkEvent,
	workspaceDir: string,
	hooks?: WakeTaskTransitionHooks,
): Promise<ClaimedDelegationWake | undefined> {
	const wake = event.internalWake;
	if (wake?.kind !== "subagent") return undefined;
	const runManager = getSubAgentRunManager(event.channelId);
	const record = runManager.get(wake.resourceId);
	if (
		!isTrustedInternalWake(event, "subagent", wake.resourceId, wake.taskId) ||
		!isVerifiedDelegationWake(record, wake.taskId) ||
		!(await runManager.beginWakeConsumption(wake.resourceId, wake.taskId, event.dispatchId))
	) {
		return undefined;
	}
	const channelDir = getChannelDir(workspaceDir, event.channelId);
	const handoff: WakeTaskHandoffInput = {
		kind: "subagent",
		resourceId: wake.resourceId,
		dispatchId: event.dispatchId,
	};
	const activated = await activateWaitingTaskAndClaimAttempt(
		channelDir,
		wake.taskId,
		"external-signal",
		new Date(),
		hooks,
		handoff,
	);
	return {
		taskId: wake.taskId,
		generation: activated?.generation,
		activated: activated !== undefined,
		finish: async () => {
			await runManager.finishWakeConsumption(wake.resourceId, event.dispatchId);
			await finishWakeTaskActivation(channelDir, wake.taskId, handoff);
		},
		rollback: () => rollbackWakeTaskActivation(channelDir, wake.taskId, handoff),
	};
}

interface RuntimeContextOptions {
	paths: BootstrapPaths;
	dingtalkConfig: DingTalkConfig;
	createBot?: (handler: DingTalkHandler, config: DingTalkConfig) => DingTalkBot;
	createEventsWatcher?: (
		workspaceDir: string,
		bot: DingTalkBot,
		executor: Executor,
		eventHistoryPath: string,
	) => { start(): void; stop(): void; flush?(): Promise<void> };
	createMemoryMaintenanceScheduler?: () => { start(): void; stop(): void };
	memoryMaintenanceSchedulerIntervalMs?: number;
	createTaskDriver?: () => { start(): void; stop(): void; nudge?(): void };
	/** Receives raw SDK session events after subscription, without changing runtime handling. */
	observer?: (event: unknown, channelId: string) => void;
	/** Receives TaskDriver dispatch outcomes; used only by isolated evaluation workers. */
	onTaskDriverDispatch?: (event: DingTalkEvent, accepted: boolean) => void;
	startServices?: boolean;
	registerSignalHandlers?: boolean;
	/** Test-only fault seams for the atomic structured-wake task transition. */
	wakeTransitionHooks?: Partial<Record<"job" | "subagent", WakeTaskTransitionHooks>>;
}

export function createRuntimeContext(options: RuntimeContextOptions): RuntimeContext & { bot: DingTalkBot } {
	const startServices = options.startServices ?? true;
	const registerSignalHandlers = options.registerSignalHandlers ?? true;
	const store = new ChannelStore({ workingDir: options.paths.workspaceDir });
	const runtimeSettingsManager = new PipiclawSettingsManager(options.paths.appHomeDir);
	log.configureLogging(runtimeSettingsManager.getLoggingSettings());
	const startedAt = Date.now();
	const cliVersion = readCliVersion();
	const channelRunners = new Map<string, AgentRunner>();
	const activeTasks = new Set<Promise<void>>();
	// `workspace/CHANNELS.md`: names every channel id so the workspace, the logs and the agent
	// stop dealing in `group_cid...`. Writes are debounced internally (see channel-index.ts).
	const channelIndex: ChannelIndex = createChannelIndex({ workspaceDir: options.paths.workspaceDir });
	let durableDispatch: DurableDispatchService | undefined;
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
			log.logWarning(`[${channelId}] Failed to archive ${contextLabel}`, errorMessage(err));
		}
	};

	const getRunner = (channelId: string): AgentRunner => {
		let runner = channelRunners.get(channelId);
		if (!runner) {
			const channelDir = ensureChannelDir(options.paths.workspaceDir, channelId);
			ensureChannelMemoryFilesSync(channelDir);
			runner = getOrCreateRunner(channelId, channelDir, {
				appHomeDir: options.paths.appHomeDir,
				authConfigPath: options.paths.authConfigPath,
				modelsConfigPath: options.paths.modelsConfigPath,
				onSessionEvent: options.observer,
				// The DingTalk bot is the media sender for this transport; enables `send_media`.
				// `bot` is defined below in this same scope and initialized before any message
				// (and thus any getRunner call) can arrive.
				mediaSender: bot,
				dispatchVerification: async (taskId) => {
					const entries = await readActiveTasks(join(channelDir, "tasks"));
					const entry = entries.find((candidate) => candidate.id === taskId);
					if (!entry) return false;
					const verificationEvent = createTaskVerificationEvent(channelId, entry, Date.now());
					return (await durableDispatch?.dispatch(verificationEvent)) ?? false;
				},
			});
			channelRunners.set(channelId, runner);
		}
		return runner;
	};

	const handler: DingTalkHandler = {
		isRunning(channelId: string): boolean {
			return channelRunners.get(channelId)?.isBusy() ?? false;
		},

		noteChannelActivity(observation): void {
			if (shuttingDown) return;
			channelIndex.note(observation);
		},

		async handleStop(channelId: string, _bot: DingTalkBot): Promise<StopOutcome> {
			const runner = channelRunners.get(channelId);
			let pausedTaskId: string | undefined;
			if (runner?.isBusy()) {
				runner.requestStop();
				const taskId = /^\[TASK_DRIVER:([A-Za-z0-9._-]+)\]/.exec(runner.getTurnStatus().taskText ?? "")?.[1];
				if (taskId) {
					const pauseResult = await pauseTask(
						{
							args: "",
							channelDir: getChannelDir(options.paths.workspaceDir, channelId),
						},
						taskId,
					);
					pausedTaskId = taskId;
					log.logInfo(`[${channelId}] ${pauseResult}`);
				}
				_bot.discardCard(channelId);
				// Drop queued-but-not-started messages so a burst does not keep
				// running after the user asked to halt; abort the in-flight one.
				const dropped = _bot.clearPendingMessages(channelId);
				if (dropped > 0) {
					log.logInfo(`[${channelId}] Dropped ${dropped} queued message(s) on stop`);
				}
				void runner.abort().catch((err) => {
					log.logWarning(`[${channelId}] Failed to abort run`, errorMessage(err));
				});
				void durableDispatch
					?.cancelChannel(channelId)
					.then((canceled) => {
						if (canceled) log.logInfo(`[${channelId}] Reset ${canceled} durable-dispatch lease(s) on stop`);
					})
					.catch((err) => {
						log.logWarning(`[${channelId}] Failed to reset durable-dispatch leases on stop`, errorMessage(err));
					});
				log.logInfo(`[${channelId}] Stop requested`);
			}
			return { pausedTaskId };
		},

		async handleEventsCommand(event: DingTalkEvent, bot: DingTalkBot, args: string): Promise<void> {
			const response = await runEventsCommand({
				args,
				workspaceDir: options.paths.workspaceDir,
				historyPath: options.paths.eventHistoryPath,
			});
			await bot.sendPlain(event.channelId, response);
		},

		async handleTasksCommand(event: DingTalkEvent, bot: DingTalkBot, args: string): Promise<void> {
			const response = await runTasksCommand({
				args,
				channelDir: getChannelDir(options.paths.workspaceDir, event.channelId),
				workspaceDir: options.paths.workspaceDir,
				channelId: event.channelId,
				dispatchTask: async (id, attemptGeneration) => {
					const channelDir = getChannelDir(options.paths.workspaceDir, event.channelId);
					const entry = (await readActiveTasks(join(channelDir, "tasks"))).find(
						(candidate) => candidate.id === id,
					);
					if (!entry) return false;
					// A human asking to run a task twice means twice, so this key is deliberately
					// unique per invocation rather than sharing the driver's occurrence key (D1).
					const now = Date.now();
					const driverEvent = createTaskDriverEvent(event.channelId, entry, now, attemptGeneration);
					return (
						(await durableDispatch?.dispatch({
							...driverEvent,
							dispatchId: `task:${event.channelId}:${entry.id}:manual:${new Date(now).toISOString()}`,
						})) ?? false
					);
				},
			});
			await bot.sendPlain(event.channelId, response);
		},

		async handleStatusCommand(event: DingTalkEvent, bot: DingTalkBot): Promise<void> {
			const response = renderStatus({
				runner: channelRunners.get(event.channelId),
				version: cliVersion,
				uptimeMs: Date.now() - startedAt,
			});
			await bot.sendPlain(event.channelId, response);
		},

		async handleUsageCommand(event: DingTalkEvent, bot: DingTalkBot, args: string): Promise<void> {
			const response = await renderUsageReport(getUsageLedger(), event.channelId, parseUsageMode(args), new Date());
			await bot.sendPlain(event.channelId, response);
		},

		// Read-only prompt accounting; safe mid-turn, so it is answered here rather than by
		// the runner's idle command path.
		async handleContextCommand(event: DingTalkEvent, bot: DingTalkBot, args: string): Promise<void> {
			await bot.sendPlain(event.channelId, getRunner(event.channelId).renderContextReport(args));
		},

		// A human control path independent of the model (spec 040, D6): `/stop` no longer kills a
		// dispatched delegation, so cancel must work whether or not a runner is currently active.
		async handleSubagentsCommand(event: DingTalkEvent, bot: DingTalkBot, args: string): Promise<void> {
			const response = await runSubagentsCommand({
				args,
				channelId: event.channelId,
				discovery: channelRunners.get(event.channelId)?.getSubAgentDiscoverySnapshot(),
			});
			await bot.sendPlain(event.channelId, response);
		},

		async handleBusyMessage(
			event: DingTalkEvent,
			bot: DingTalkBot,
			mode: BusyMessageMode,
			queueText: string,
		): Promise<BusyMessageResult> {
			if (shuttingDown) {
				return { kind: "handled" };
			}

			const runner = getRunner(event.channelId);
			const trimmedQueueText = queueText.trim();

			if (!trimmedQueueText) {
				const commandName = mode === "followUp" ? "followup" : "steer";
				await bot.sendPlain(event.channelId, `无法排队：/${commandName} 需要带上消息内容。`);
				return { kind: "handled" };
			}

			if (mode === "followUp") {
				log.logEvent("info", "agent.turn.followup_queued", "Follow-up queued", {
					ctx: { channelId: event.channelId, userName: event.userName },
					fields: { messageLength: trimmedQueueText.length },
				});
				return { kind: "requeue", text: trimmedQueueText };
			}

			try {
				await runner.queueSteer(trimmedQueueText, event.userName);

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

				const confirmation = event.text.trim().startsWith("/")
					? "已作为 steer 排队，当前工具步骤结束后生效。"
					: "已作为 steer 排队，当前工具步骤结束后生效。想等整个回合结束再执行，用 `/followup <消息>`。";
				await bot.sendPlain(event.channelId, confirmation);
				log.logEvent("info", "agent.turn.steer_queued", "Steer queued", {
					ctx: { channelId: event.channelId, userName: event.userName },
					fields: { messageLength: trimmedQueueText.length },
				});
				return { kind: "handled" };
			} catch (err) {
				const errMsg = errorMessage(err);
				if (isNoRunningTaskQueueError(err)) {
					log.logInfo(`[${event.channelId}] Busy ${mode} window closed; requeueing as a normal message`);
					return { kind: "requeue", text: trimmedQueueText };
				}
				log.logWarning(`[${event.channelId}] Failed to queue ${mode}`, errMsg);
				await bot.sendPlain(event.channelId, `无法排队这条消息：${errMsg}`);
				return { kind: "handled" };
			}
		},

		reserveEvent(event: DingTalkEvent): void {
			// This must remain synchronous. DingTalkBot calls it before awaiting the queued
			// handler, making the busy state observable to another message in the same tick.
			getRunner(event.channelId).beginTurn(event.text);
		},

		async handleEvent(event: DingTalkEvent, bot: DingTalkBot, _isEvent?: boolean): Promise<void> {
			if (shuttingDown) {
				log.logInfo(`[${event.channelId}] Ignoring event during shutdown`);
				return;
			}

			const runner = getRunner(event.channelId);
			await durableDispatch?.markStarted(event.dispatchId);
			let structuredWakeFinalized = event.internalWake === undefined;
			const task = (async () => {
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

					// Background wakes deliver their result, not their process: no progress card,
					// no thinking stream, nothing to delete when the check-in ends `[SILENT]`.
					const ctx = createDingTalkContext(event, bot, store, _isEvent ? "none" : undefined);
					const builtInCommand = parseBuiltInCommand(event.text);

					if (builtInCommand) {
						log.logEvent("info", "runtime.command.started", "Executing command", {
							ctx: { channelId: event.channelId, userName: event.userName },
							fields: { command: builtInCommand.name },
						});
						if (builtInCommand.name === "events") {
							await handler.handleEventsCommand(event, bot, builtInCommand.args);
							return;
						}
						if (builtInCommand.name === "tasks") {
							await handler.handleTasksCommand(event, bot, builtInCommand.args);
							return;
						}
						if (builtInCommand.name === "status") {
							await handler.handleStatusCommand(event, bot);
							return;
						}
						if (builtInCommand.name === "usage") {
							await handler.handleUsageCommand(event, bot, builtInCommand.args);
							return;
						}
						if (builtInCommand.name === "subagents") {
							await handler.handleSubagentsCommand(event, bot, builtInCommand.args);
							return;
						}
						if (isRunnerBuiltInCommand(builtInCommand)) {
							await runner.handleBuiltinCommand(ctx, builtInCommand);
						}
						return;
					}

					// Reject an unknown slash command instead of spending a full LLM turn
					// letting the model guess what `/modle` meant. Session commands,
					// skills, and prompt templates are recognized by isKnownSlashCommand.
					if (event.text.trim().startsWith("/") && !runner.isKnownSlashCommand(event.text)) {
						const name = slashCommandName(event.text) ?? "";
						await bot.sendPlain(event.channelId, formatUnknownCommandMessage(name));
						return;
					}

					log.logEvent("info", "agent.turn.started", "Starting turn", {
						ctx: { channelId: event.channelId, userName: event.userName },
						fields: { messageLength: event.text.length, source: _isEvent ? "event" : "message" },
					});
					if (!_isEvent) {
						ctx.primeCard(350);
					}
					// Effects are tallied per channel; the governor needs them per task, so one
					// task-driver turn is measured as a delta (turns on a channel are serialized)
					// and credited to the task it was dispatched for.
					const effectsBefore = channelEffectCount(event.channelId);
					// Both wake formats below carry an unauthenticated claim in plain text: anything
					// that can put a message on this channel can *write* "[JOB:x] ... belongs to task
					// y." or "[SUBAGENT:x] ... belongs to task y." — including another user, or an
					// external agent's own untrusted stdout (spec 040, D8's threat model explicitly
					// treats external output as untrusted). Activating a waiting task on text pattern
					// alone lets that forged claim advance an unrelated task's attempt generation. The
					// pattern match only extracts a *candidate* id pair now; both paths verify the
					// named run/job actually exists, is done, and really is the one that names this
					// taskId before ever calling `activateWaitingTask` (T9).
					const jobTextMatch = /^\[JOB:([^\]]+)\][\s\S]*?belongs to task ([A-Za-z0-9._-]+)\./.exec(event.text);
					const jobMatch =
						event.internalWake?.kind === "job"
							? [event.text, event.internalWake.resourceId, event.internalWake.taskId]
							: jobTextMatch;
					let recoveredJobTaskId: string | undefined;
					if (jobMatch) {
						const [, jobId, jobTaskId] = jobMatch;
						const jobManager = getChannelJobManager(event.channelId, executor);
						const jobs = await jobManager.list();
						const verified =
							isTrustedInternalWake(event, "job", jobId, jobTaskId) &&
							isVerifiedJobWake(jobs, jobId, jobTaskId) &&
							(await jobManager.beginWakeConsumption(jobId, jobTaskId, event.dispatchId));
						if (verified) {
							const channelDir = getChannelDir(options.paths.workspaceDir, event.channelId);
							const activated = await activateWaitingTaskAndClaimAttempt(
								channelDir,
								jobTaskId,
								"job",
								new Date(),
								options.wakeTransitionHooks?.job,
							);
							if (activated) {
								recoveredJobTaskId = jobTaskId;
								event.taskAttemptGeneration = activated.generation;
							}
							await jobManager.finishWakeConsumption(jobId, event.dispatchId);
							structuredWakeFinalized = true;
							if (event.internalWake?.kind === "job" && !activated) return;
						} else {
							log.logWarning(
								`[${event.channelId}] Ignored an unverifiable [JOB:${jobId}] wake claiming task ${jobTaskId}`,
							);
							if (event.internalWake?.kind === "job") {
								structuredWakeFinalized = true;
								return;
							}
						}
					}
					// Spec 040, D7: a delegation run's completion wake carries the same "belongs to
					// task" contract as a background job's, and reactivates a task parked with
					// waitingFor="external-signal" the same way — verified the same way (T9).
					const delegationTextMatch = /^\[SUBAGENT:([^\]]+)\][\s\S]*?belongs to task ([A-Za-z0-9._-]+)\./.exec(
						event.text,
					);
					const delegationMatch =
						event.internalWake?.kind === "subagent"
							? [event.text, event.internalWake.resourceId, event.internalWake.taskId]
							: delegationTextMatch;
					let recoveredDelegationTaskId: string | undefined;
					if (delegationMatch) {
						const [, runId, delegationTaskId] = delegationMatch;
						const claimed = await claimVerifiedDelegationWake(
							event,
							options.paths.workspaceDir,
							options.wakeTransitionHooks?.subagent,
						);
						if (claimed) {
							if (claimed.activated) recoveredDelegationTaskId = claimed.taskId;
							if (claimed.generation !== undefined) event.taskAttemptGeneration = claimed.generation;
							await claimed.finish();
							structuredWakeFinalized = true;
							if (event.internalWake?.kind === "subagent" && !claimed.activated) return;
						} else {
							log.logWarning(
								`[${event.channelId}] Ignored an unverifiable [SUBAGENT:${runId}] wake claiming task ${delegationTaskId}`,
							);
							if (event.internalWake?.kind === "subagent") {
								structuredWakeFinalized = true;
								return;
							}
						}
					}
					const result = await runner.run(ctx, store);
					const taskDriverMatch = /^\[TASK_DRIVER:([A-Za-z0-9._-]+)\]/.exec(event.text);
					const taskAttemptId = taskDriverMatch?.[1] ?? recoveredJobTaskId ?? recoveredDelegationTaskId;
					if (taskDriverMatch?.[1]) {
						noteTaskEffects(
							event.channelId,
							taskDriverMatch[1],
							channelEffectCount(event.channelId) - effectsBefore,
						);
					}
					if (recoveredJobTaskId) {
						noteTaskEffects(
							event.channelId,
							recoveredJobTaskId,
							channelEffectCount(event.channelId) - effectsBefore,
						);
					}
					if (recoveredDelegationTaskId) {
						noteTaskEffects(
							event.channelId,
							recoveredDelegationTaskId,
							channelEffectCount(event.channelId) - effectsBefore,
						);
					}
					if (taskAttemptId && result.usage && result.durationMs !== undefined) {
						await finishTaskAttempt(getChannelDir(options.paths.workspaceDir, event.channelId), taskAttemptId, {
							tokens: result.usage.total,
							costUsd: result.usage.cost.total,
							costKnown: result.costKnown === true,
							wallTimeMinutes: result.durationMs / 60_000,
							failed: result.stopReason === "error" || result.stopReason === "aborted",
							silent: result.silent,
							finishedAt: new Date(),
							generation: event.taskAttemptGeneration,
						});
					}

					if (result.stopReason === "aborted" && runner.getTurnStatus().stopRequested) {
						log.logInfo(`[${event.channelId}] Stopped`);
					}
				} catch (err) {
					log.logEvent("error", "agent.turn.failed", "Turn failed", {
						ctx: { channelId: event.channelId, userName: event.userName },
						fields: { error: errorMessage(err) },
					});
				} finally {
					if (structuredWakeFinalized) await durableDispatch?.markCompleted(event.dispatchId);
					else await durableDispatch?.markRetryable(event.dispatchId);
					runner.endTurn();
					// A finished turn may have written task files (progress/complete/set); rescan
					// now so a continuing task chain advances immediately instead of after a full sleep.
					taskDriver.nudge?.();
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
	durableDispatch = new DurableDispatchService({
		stateDir: join(options.paths.appHomeDir, "state", "dispatch"),
		bot,
	});
	const executor = createExecutor();
	// Background jobs get their persistence root and their way to wake a channel before any turn
	// can start one, then re-adopt whatever survived the last shutdown (spec 031, D6).
	configureJobRuntime({
		jobsStateDir: join(options.paths.appHomeDir, "state", "jobs"),
		dispatch: (event) => durableDispatch?.dispatch(event) ?? false,
	});
	void restoreChannelJobs(executor);
	// Delegation runs get the same treatment (spec 040, D1/D7): persistence root, wake delivery,
	// and the usage/archive authority, wired before any turn can start a run.
	configureSubAgentRuntime({
		stateDir: join(options.paths.appHomeDir, "state", "subagent-runs"),
		dispatch: (event) => durableDispatch?.dispatch(event) ?? false,
		ledger: getUsageLedger(),
		store,
	});
	void restoreAllSubAgentRuns();
	const eventsWatcher = options.createEventsWatcher
		? options.createEventsWatcher(options.paths.workspaceDir, bot, executor, options.paths.eventHistoryPath)
		: createEventsWatcher(
				options.paths.workspaceDir,
				bot,
				executor,
				loadSecurityConfigWithDiagnostics(options.paths.appHomeDir).config.commandGuard,
				options.paths.eventHistoryPath,
				(event) => durableDispatch?.dispatch(event) ?? false,
			);
	const memoryMaintenanceScheduler = options.createMemoryMaintenanceScheduler
		? options.createMemoryMaintenanceScheduler()
		: new MemoryMaintenanceScheduler({
				appHomeDir: options.paths.appHomeDir,
				workspaceDir: options.paths.workspaceDir,
				getKnownChannelIds: () => channelRunners.keys(),
				// Channels active this boot reuse their runner's in-memory context; every
				// other discovered channel gets a lightweight disk-backed context instead
				// of resurrecting a full ChannelRunner (session, tools, sub-agents) that
				// would then sit in the runner cache forever.
				getRuntimeContext: async (channelId) => {
					const runner = channelRunners.get(channelId);
					if (runner) {
						return runner.getMemoryMaintenanceContext();
					}
					return loadDetachedMaintenanceContext({
						channelId,
						channelDir: getChannelDir(options.paths.workspaceDir, channelId),
						authConfigPath: options.paths.authConfigPath,
						modelsConfigPath: options.paths.modelsConfigPath,
						settingsManager: runtimeSettingsManager,
					});
				},
				isChannelActive: (channelId) => channelRunners.get(channelId)?.isBusy() ?? false,
				getSettings: () => {
					runtimeSettingsManager.reload();
					return {
						memoryMaintenance: runtimeSettingsManager.getMemoryMaintenanceSettings(),
					};
				},
				intervalMs: options.memoryMaintenanceSchedulerIntervalMs,
			});
	// `tools.json` is re-read on every driver tick — and a tick follows every turn — so cache the
	// parse behind the file's change token. `settings.json` gets the same treatment inside
	// `PipiclawSettingsManager.reload()`, which is why the getSettings closure below stays as-is.
	let cachedToolsStamp: string | undefined;
	let cachedTasksEnabled = true;
	const tasksToolEnabled = (): boolean => {
		const stamp = fileStamp(getToolsConfigPath(options.paths.appHomeDir));
		if (stamp !== cachedToolsStamp) {
			cachedToolsStamp = stamp;
			cachedTasksEnabled = loadToolsConfig(options.paths.appHomeDir).tools.tasks.enabled;
		}
		return cachedTasksEnabled;
	};
	const taskDriver = options.createTaskDriver
		? options.createTaskDriver()
		: new TaskDriver({
				workspaceDir: options.paths.workspaceDir,
				getKnownChannelIds: () => channelRunners.keys(),
				isChannelActive: (channelId) => channelRunners.get(channelId)?.isBusy() ?? false,
				dispatch: (event) => durableDispatch?.dispatch(event) ?? false,
				onDispatch: options.onTaskDriverDispatch,
				getEffectCount: taskEffectCount,
				notify: (receipt) => bot.sendPlain(receipt.channelId, receipt.text),
				getSettings: () => {
					runtimeSettingsManager.reload();
					return runtimeSettingsManager.getTaskDriverSettings();
				},
				isEnabled: tasksToolEnabled,
			});

	const shutdownWithReason = async (reason: NodeJS.Signals | "manual" = "manual"): Promise<void> => {
		if (shutdownPromise) {
			return shutdownPromise;
		}

		shutdownPromise = (async () => {
			shuttingDown = true;
			log.logInfo(`Shutting down (${reason})...`);

			taskDriver.stop();
			durableDispatch?.stop();
			memoryMaintenanceScheduler.stop();
			eventsWatcher.stop();
			await bot.stop();

			const runningTasks = Array.from(activeTasks);
			if (runningTasks.length > 0) {
				log.logInfo(`Waiting for ${runningTasks.length} active task(s) to finish`);
				const completed = await waitForTasks(runningTasks, SHUTDOWN_WAIT_MS);

				if (!completed) {
					log.logWarning(`Shutdown grace period exceeded ${SHUTDOWN_WAIT_MS}ms, aborting active runs`);
					const aborts: Promise<void>[] = [];
					for (const [channelId, runner] of channelRunners) {
						if (!runner.isBusy()) continue;
						runner.requestStop();
						log.logInfo(`[${channelId}] Aborting active run for shutdown`);
						aborts.push(
							runner.abort().catch((err) => {
								log.logWarning(`[${channelId}] Failed to abort run during shutdown`, errorMessage(err));
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

			const flushes = flushInactiveChannelMemory(channelRunners);
			if (flushes.length > 0) {
				log.logInfo(`Flushing memory for ${flushes.length} inactive channel(s) before shutdown`);
				const flushed = await waitForTasks(flushes, SHUTDOWN_FLUSH_WAIT_MS);
				if (!flushed) {
					log.logWarning(`Shutdown memory flush exceeded ${SHUTDOWN_FLUSH_WAIT_MS}ms`);
				}
			}

			for (const channelId of channelRunners.keys()) {
				const channelDir = ensureChannelDir(options.paths.workspaceDir, channelId);
				resetRunner(
					channelId,
					{
						appHomeDir: options.paths.appHomeDir,
						authConfigPath: options.paths.authConfigPath,
						modelsConfigPath: options.paths.modelsConfigPath,
						onSessionEvent: options.observer,
					},
					channelDir,
				);
			}

			const storageFlushes = [
				store.close(),
				// Cancels the debounce timer and lands the last activity times.
				channelIndex.close(),
				getUsageLedger().flush?.() ?? Promise.resolve(),
				flushSecurityLogs(),
				...(eventsWatcher.flush ? [eventsWatcher.flush()] : []),
			];
			const storageFlushed = await waitForTasks(storageFlushes, SHUTDOWN_LOG_FLUSH_WAIT_MS);
			if (!storageFlushed) {
				log.logWarning(`Shutdown log flush exceeded ${SHUTDOWN_LOG_FLUSH_WAIT_MS}ms`);
			}
			await waitForTasks([log.flushLogging()], SHUTDOWN_LOG_FLUSH_WAIT_MS);
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
		// One-time close of the 027 migration window: fold any residual legacy `.schedule`
		// events into task frontmatter before the driver relies on frontmatter as the only cadence.
		void migrateLegacyTaskScheduleEvents(options.paths.workspaceDir);
		void migrateLegacyTaskState(options.paths.workspaceDir);
		eventsWatcher.start();
		memoryMaintenanceScheduler.start();
		taskDriver.start();
		durableDispatch.start();
		void bot.start();
	}

	return {
		handler,
		store,
		bot,
		taskDriver,
		memoryMaintenance: memoryMaintenanceScheduler,
		shutdown: shutdownWithReason,
	};
}

/**
 * Transport-neutral app services shared by the DingTalk runtime and the terminal
 * TUI: loads settings (surfacing load errors) and reports tool/security config
 * diagnostics. Does NOT touch DingTalk config, so the TUI can call it without any
 * DingTalk credentials.
 *
 * Extracted verbatim from `bootstrap()`; the DingTalk path calls it in the same
 * position (after `loadConfig`, before `logStartup`) so its behavior is
 * unchanged. Logging configuration is intentionally left to each caller
 * (DingTalk: `createRuntimeContext`; TUI: right after this) to preserve the
 * existing "diagnostics logged with default logging config" ordering.
 */
export function prepareAppServices(paths: BootstrapPaths = DEFAULT_BOOTSTRAP_PATHS): {
	settingsManager: PipiclawSettingsManager;
} {
	// Shared by the DingTalk daemon and the TUI (both call prepareAppServices), so this
	// covers every entrypoint that talks to an LLM provider.
	installLlmProxy();

	const settingsManager = new PipiclawSettingsManager(paths.appHomeDir);
	for (const { scope, error } of settingsManager.drainErrors()) {
		log.logWarning(`Failed to load ${scope} settings`, `${error.message}\n${paths.settingsConfigPath}`);
	}
	// Errors already went out above with a richer message; this pass exists for the
	// warnings, chiefly retired settings keys (spec 035 D3).
	for (const diagnostic of settingsManager.getDiagnostics()) {
		if (diagnostic.severity === "error") continue;
		log.logWarning(formatConfigDiagnostic(diagnostic), diagnostic.path);
	}
	for (const diagnostic of loadToolsConfigWithDiagnostics(paths.appHomeDir).diagnostics) {
		log.logWarning(formatConfigDiagnostic(diagnostic), diagnostic.path);
	}
	for (const diagnostic of loadSecurityConfigWithDiagnostics(paths.appHomeDir).diagnostics) {
		log.logWarning(formatConfigDiagnostic(diagnostic), diagnostic.path);
	}

	return { settingsManager };
}

export async function bootstrap(argv: string[], options: BootstrapOptions = {}): Promise<AppContext> {
	const io = options.io ?? console;
	const paths = options.paths ?? DEFAULT_BOOTSTRAP_PATHS;
	const registerSignalHandlers = options.registerSignalHandlers ?? true;
	const startServices = options.startServices ?? true;

	parseArgs(argv, paths, io);
	const bootstrapResult = bootstrapAppHome(paths, io);
	printBootstrapSummary(bootstrapResult, io, paths);

	if (bootstrapResult.channelTemplateCreated) {
		io.error(`Fill in ${paths.channelConfigPath} and run \`${paths.appName}\` again.`);
		throw new BootstrapExitError(1);
	}

	const dingtalkConfig = loadConfig(paths, io);
	dingtalkConfig.stateDir = paths.workspaceDir;
	prepareAppServices(paths);

	log.logStartup(paths.workspaceDir);
	const runtime = createRuntimeContext({
		paths,
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
