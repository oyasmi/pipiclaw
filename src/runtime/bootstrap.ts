import { join } from "path";
import { loadDetachedMaintenanceContext } from "../agent/maintenance-context.js";
import { createRunner } from "../agent/runner-factory.js";
import { scanWorkspaceForInterruptedTurns } from "../agent/turn-recovery.js";
import type { AgentRunner } from "../agent/types.js";
import {
	BootstrapExitError,
	type BootstrapIO,
	type BootstrapPaths,
	bootstrapAppHome,
	DEFAULT_BOOTSTRAP_PATHS,
	parseArgs,
	printBootstrapSummary,
	printFirstRunGuide,
	readCliVersion,
} from "../app/home.js";
import { prepareAppServices } from "../app/services.js";
import type { ChannelEvent } from "../channel/channel-event.js";
import { type ChannelIndex, createChannelIndex } from "../channel/channel-index.js";
import { ensureChannelDir, getChannelDir } from "../channel/channel-paths.js";
import { ChannelStore } from "../channel/store.js";
import { PipiclawSettingsManager } from "../config/settings.js";
import { getToolsConfigPath, loadToolsConfig } from "../config/tools.js";
import { DingTalkBot } from "../dingtalk/bot.js";
import { type DingTalkConfig, loadConfig } from "../dingtalk/config.js";
import type { DingTalkHandler } from "../dingtalk/handler.js";
import { createEventsWatcher } from "../events/events.js";
import { createExecutor, type Executor } from "../executor.js";
import { createJobRuntime, type JobRuntime } from "../jobs/manager.js";
import * as log from "../log.js";
import { MemoryMaintenanceScheduler } from "../memory/scheduler.js";
import { defaultModel } from "../models/runtime.js";
import { loadSecurityConfigWithDiagnostics } from "../security/config.js";
import { fileStamp } from "../shared/format.js";
import { errorMessage } from "../shared/text-utils.js";
import { renderRunNotice } from "../subagents/commands.js";
import { createSubAgentRuntime, type SubAgentRuntime } from "../subagents/run-registry.js";
import { getUsageLedger } from "../usage/ledger.js";
import { DurableDispatchService, renderDispatchExhaustedNotice } from "./durable-dispatch.js";
import { createShutdown } from "./shutdown.js";
import { TaskDriver } from "./task-driver.js";
import { migrateTasksToV5 } from "./task-migration.js";
import { createTaskSpawner } from "./task-spawn.js";
import type { WakeTaskTransitionHooks } from "./task-wake.js";
import { createTurnHandler } from "./turn-handler.js";

export interface BootstrapOptions {
	env?: NodeJS.ProcessEnv;
	io?: BootstrapIO;
	paths?: BootstrapPaths;
	registerSignalHandlers?: boolean;
	startServices?: boolean;
}

export interface AppContext {
	bot: DingTalkBot;
	store: ChannelStore;
	shutdown: () => Promise<void>;
}

export interface RuntimeContext {
	jobs: JobRuntime;
	runs: SubAgentRuntime;
	handler: DingTalkHandler;
	store: ChannelStore;
	/** Production driver instance, exposed so evals can invoke the real scan path. */
	taskDriver: { start(): void; stop(): void; nudge?(): void; runOnce?: (now?: Date) => Promise<void> };
	/**
	 * Production maintenance scheduler, exposed for the same reason as `taskDriver`.
	 *
	 * Evaluation workers run with `startServices: false`, so the background timer never fires and
	 * no trial could otherwise reach the reflect pass — the whole memory pipeline was structurally
	 * untestable from a behavior eval.
	 * Exposing the instance lets a case drive one real pass at a chosen time instead of faking a
	 * clock or re-implementing the job order.
	 */
	memoryMaintenance: { start(): void; stop(): void; runOnce?: (now?: Date) => Promise<void> };
	shutdown: (reason?: NodeJS.Signals | "manual") => Promise<void>;
}

/**
 * Ceiling on cached runners per daemon process. A long-lived daemon otherwise accumulates one
 * `ChannelRunner` (session, subscriptions, memory state) per distinct channel it has ever heard
 * from, unbounded, for the life of the process. Eviction below only ever touches idle runners —
 * a busy one is left cached past the cap rather than mid-turn disposed.
 */
const MAX_CACHED_RUNNERS = 50;

/**
 * Drop the least-recently-used *idle* runners until the cache is back at the cap, disposing each
 * one (flush memory, unsubscribe, release the SDK session) before dropping it. `channelRunners`
 * is a `Map`, so insertion order is iteration order; `getRunner` below re-inserts on every cache
 * hit to keep that order equal to recency of use — the standard "LRU via Map" idiom.
 */
async function evictIdleRunnersOverCap(channelRunners: Map<string, AgentRunner>): Promise<void> {
	if (channelRunners.size <= MAX_CACHED_RUNNERS) return;
	for (const [channelId, runner] of channelRunners) {
		if (channelRunners.size <= MAX_CACHED_RUNNERS) break;
		if (runner.isBusy()) continue;
		channelRunners.delete(channelId);
		await runner.dispose().catch((err) => {
			log.logWarn("runtime.runner.evict_dispose_failed", "Evicted runner dispose failed", {
				channelId: channelId,
				reason: errorMessage(err),
			});
		});
	}
}

/** The real `TaskDriver` class, or the minimal test-injectable shape `createTaskDriver` may
 * supply instead — `taskDriver.nudge?.()` is the only member either side needs to guarantee. */
type TaskDriverLike = TaskDriver | { start(): void; stop(): void; nudge?(): void };

interface RuntimeContextOptions {
	executor?: Executor;
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
	/** Background-job sweep cadence override (tests use a short one for timely completion wakes). */
	jobSweepIntervalMs?: number;
	createTaskDriver?: () => TaskDriverLike;
	/** Receives raw SDK session events after subscription, without changing runtime handling. */
	observer?: (event: unknown, channelId: string) => void;
	/** Receives TaskDriver dispatch outcomes; used only by isolated evaluation workers. */
	onTaskDriverDispatch?: (event: ChannelEvent, accepted: boolean) => void;
	startServices?: boolean;
	registerSignalHandlers?: boolean;
	/** Test-only fault seams for the atomic structured-wake task transition. */
	wakeTransitionHooks?: Partial<Record<"job" | "subagent", WakeTaskTransitionHooks>>;
	/** Override the `/stop` watchdog's grace window (tests use a short one). */
	stopForceEndGraceMs?: number;
	/**
	 * The app-level settings manager, shared by every channel's runner (see
	 * `agent/runner-factory.ts`'s `RunnerFactoryPaths.settingsManager`). `bootstrap()` passes the
	 * same instance `prepareAppServices()` already constructed and diagnosed; a caller that skips
	 * `prepareAppServices()` (tests) gets one built here instead.
	 */
	settingsManager?: PipiclawSettingsManager;
}

export async function createRuntimeContext(
	options: RuntimeContextOptions,
): Promise<RuntimeContext & { bot: DingTalkBot }> {
	const startServices = options.startServices ?? true;
	const registerSignalHandlers = options.registerSignalHandlers ?? true;
	const store = new ChannelStore({ workingDir: options.paths.workspaceDir });
	const runtimeSettingsManager = options.settingsManager ?? new PipiclawSettingsManager(options.paths.appHomeDir);
	log.configureLogging(runtimeSettingsManager.getLoggingSettings());
	const startedAt = Date.now();
	const cliVersion = readCliVersion();
	const channelRunners = new Map<string, AgentRunner>();
	const sessionResetChains = new Map<string, Promise<void>>();
	const activeTasks = new Set<Promise<void>>();
	/** Channels with a `/stop` watchdog in flight, so a burst of `/stop` starts only one. */
	const stopWatchdogs = new Set<string>();
	// `workspace/CHANNELS.md`: names every channel id so the workspace, the logs and the agent
	// stop dealing in `group_cid...`. Writes are debounced internally (see channel-index.ts).
	const channelIndex: ChannelIndex = createChannelIndex({ workspaceDir: options.paths.workspaceDir });
	let durableDispatch: DurableDispatchService | undefined;
	let shuttingDown = false;

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
			images?: string[];
		},
		contextLabel: string,
	): Promise<void> => {
		try {
			await store.logMessage(channelId, message);
		} catch (err) {
			log.logWarn("channel.archive.write_failed", "Message archive failed", {
				channelId: channelId,
				reason: errorMessage(err),
				fields: { label: contextLabel },
			});
		}
	};

	const getRunner = (channelId: string): AgentRunner => {
		const existing = channelRunners.get(channelId);
		if (existing) {
			// Re-insert to move this channel to the end (most-recently-used) of the Map's
			// iteration order, which evictIdleRunnersOverCap relies on.
			channelRunners.delete(channelId);
			channelRunners.set(channelId, existing);
			return existing;
		}

		const channelDir = ensureChannelDir(options.paths.workspaceDir, channelId);
		const runner = createRunner(channelId, channelDir, {
			jobManager: jobs.get(channelId),
			runManager: runs.get(channelId),
			appHomeDir: options.paths.appHomeDir,
			authConfigPath: options.paths.authConfigPath,
			modelsConfigPath: options.paths.modelsConfigPath,
			settingsManager: runtimeSettingsManager,
			onSessionEvent: options.observer,
			// The DingTalk bot is the media sender for this transport; enables `send_media`.
			// `bot` is defined below in this same scope and initialized before any message
			// (and thus any getRunner call) can arrive.
			mediaSender: bot,
		});
		channelRunners.set(channelId, runner);
		void evictIdleRunnersOverCap(channelRunners);
		return runner;
	};

	const isShuttingDown = (): boolean => shuttingDown;
	const getDurableDispatch = (): DurableDispatchService | undefined => durableDispatch;
	// `executor`/`taskDriver` are declared further down this function (after `bot`, which the
	// task driver's own `notify` needs) — these two closures resolve them lazily, the same way
	// `getRunner` above already resolves `bot` before its own declaration: nothing here calls
	// through them until long after the whole function has finished setting up.
	const getJobs = (): JobRuntime => jobs;
	const getRuns = (): SubAgentRuntime => runs;
	const getTaskDriver = (): TaskDriverLike => taskDriver;

	const handler = createTurnHandler({
		options,
		store,
		channelRunners,
		sessionResetChains,
		activeTasks,
		stopWatchdogs,
		channelIndex,
		archiveIncomingMessage,
		getRunner,
		cliVersion,
		startedAt,
		isShuttingDown,
		getDurableDispatch,
		getJobs,
		getRuns,
		getTaskDriver,
	});

	const bot = options.createBot
		? options.createBot(handler, options.dingtalkConfig)
		: new DingTalkBot(handler, options.dingtalkConfig);
	const dispatchStateDir = join(options.paths.appHomeDir, "state", "dispatch");
	durableDispatch = new DurableDispatchService({
		stateDir: dispatchStateDir,
		bot,
		// A structured wake (job/subagent completion, task-driver) that keeps failing before it can
		// ever mark itself complete would otherwise redeliver forever (30s tick, no backoff prior to
		// this notice). Surface it once instead of looping silently; the record stays on disk for
		// inspection until a human clears it.
		onExhausted: async (record) => {
			log.logEvent("warn", "dispatch.exhausted", "Dispatch exhausted", {
				ctx: { channelId: record.event.channelId },
				details: record.event.text.slice(0, 500),
				fields: { dispatchId: record.id, deliveries: record.deliveries, producer: record.event.user },
			});
			await bot.sendPlain(record.event.channelId, renderDispatchExhaustedNotice(record, dispatchStateDir));
		},
	});
	const executor = options.executor ?? createExecutor();
	// Background jobs get their persistence root and their way to wake a channel before any turn
	// can start one, then re-adopt whatever survived the last shutdown (spec 031, D6).
	const jobs = createJobRuntime(executor, {
		jobsStateDir: join(options.paths.appHomeDir, "state", "jobs"),
		workspaceDir: options.paths.workspaceDir,
		dispatch: (event) => durableDispatch?.dispatch(event) ?? false,
		...(options.jobSweepIntervalMs ? { sweepIntervalMs: options.jobSweepIntervalMs } : {}),
	});
	// Delegation runs get the same treatment (spec 040, D1/D7): persistence root, wake delivery,
	// and the usage/archive authority, wired before any turn can start a run.
	const runs = createSubAgentRuntime({
		stateDir: join(options.paths.appHomeDir, "state", "subagent-runs"),
		dispatch: (event) => durableDispatch?.dispatch(event) ?? false,
		// P0-1/P1a: a best-effort out-of-band notice, independent of the completion wake — it reaches
		// the channel in roughly the time the run itself takes, not the wake turn's own LLM latency
		// on top of that. `notices: "off"` (settings.json) restores today's silent behavior.
		notify: (channelId, notice) => {
			const level = runtimeSettingsManager.getDelegationSettings().notices;
			if (level === "off") return;
			if (level === "settled" && notice.kind === "progress") return;
			const text = renderRunNotice(notice);
			if (text) void bot.sendPlain(channelId, text);
		},
		ledger: getUsageLedger(),
		store,
	});
	// Admission (bot.start() below) must not open until every persisted job and run is back in
	// memory: a message arriving mid-restore would see partial running-count/short-id/lease state,
	// and durableDispatch's redelivery of a pending completion wake would find no record to claim.
	// Spec 042 D11: `restoreChannelJobs` used to be a bare `void` while `restoreAllSubAgentRuns`
	// was already awaited — the same admission race P0-1 closed for delegation runs was still open
	// for background jobs.
	await jobs.restore();
	await runs.restore();
	runs.start();
	// Spec 043, D10 point 1: repair any turn interrupted by the last shutdown/crash before opening
	// admission — a message routed to a still-dangling session would 400 against the provider on
	// every attempt (F3) until a human ran /new. Runs before bot.start() for the same reason as
	// the job/run restores above: admission must see a structurally legal session, not a partial one.
	const recoveryReport = await scanWorkspaceForInterruptedTurns(options.paths.workspaceDir, {
		api: defaultModel.api,
		provider: defaultModel.provider,
		model: defaultModel.id,
	});
	if (recoveryReport.repaired.length > 0) {
		log.logWarn("runtime.recovery.repaired", "Interrupted turns repaired on restart", {
			fields: {
				repaired: recoveryReport.repaired.length,
				scanned: recoveryReport.scanned,
				channels: recoveryReport.repaired.map((r) => r.channelDir),
			},
		});
	}
	if (recoveryReport.blocked.length > 0) {
		log.logWarn("runtime.recovery.blocked", "Channels with an unrecoverable session will refuse new turns", {
			reason: recoveryReport.blocked.map((b) => `${b.channelDir}: ${b.reason}`).join("; "),
		});
	}
	const eventsWatcher = options.createEventsWatcher
		? options.createEventsWatcher(options.paths.workspaceDir, bot, executor, options.paths.eventHistoryPath)
		: createEventsWatcher(
				options.paths.workspaceDir,
				bot,
				executor,
				loadSecurityConfigWithDiagnostics(options.paths.appHomeDir).config.commandGuard,
				options.paths.eventHistoryPath,
				(event) => durableDispatch?.dispatch(event) ?? false,
				createTaskSpawner({
					getChannelDir: (channelId) => getChannelDir(options.paths.workspaceDir, channelId),
					nudge: () => getTaskDriver().nudge?.(),
					notify: (channelId, text) => bot.sendPlain(channelId, text),
				}),
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
					return { memoryMaintenance: runtimeSettingsManager.getMemoryMaintenanceSettings() };
				},
				intervalMs: options.memoryMaintenanceSchedulerIntervalMs,
			});
	// `tools.json` is re-read on every driver tick — and a tick follows every turn — so cache the
	// parse behind the file's change token.
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
				notify: (receipt) => bot.sendPlain(receipt.channelId, receipt.text),
				isEnabled: tasksToolEnabled,
			});

	const shutdownWithReason = createShutdown({
		taskDriver,
		getDurableDispatch,
		memoryMaintenanceScheduler,
		eventsWatcher,
		runs,
		jobs,
		bot,
		store,
		channelIndex,
		channelRunners,
		activeTasks,
		markShuttingDown: () => {
			shuttingDown = true;
		},
	});

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
		// Convert supported v3 task files and their schedules (v4 beta files are skipped) before services rely
		// on the v5 layout (spec 052, D12). Marker-gated and awaited: the pass writes event
		// templates the watcher is about to load, so the services must not start underneath it.
		// A failed or partial conversion throws and aborts startup: nothing may run on half-migrated state.
		await migrateTasksToV5(options.paths.workspaceDir, join(options.paths.appHomeDir, "state"));
		eventsWatcher.start();
		memoryMaintenanceScheduler.start();
		taskDriver.start();
		durableDispatch.start();
		void bot.start();
	}

	return {
		handler,
		jobs,
		runs,
		store,
		bot,
		taskDriver,
		memoryMaintenance: memoryMaintenanceScheduler,
		shutdown: shutdownWithReason,
	};
}

export async function bootstrap(argv: string[], options: BootstrapOptions = {}): Promise<AppContext> {
	const io = options.io ?? console;
	const paths = options.paths ?? DEFAULT_BOOTSTRAP_PATHS;
	const registerSignalHandlers = options.registerSignalHandlers ?? true;
	const startServices = options.startServices ?? true;

	parseArgs(argv, paths, io);
	const bootstrapResult = bootstrapAppHome(paths);
	printBootstrapSummary(bootstrapResult, io, paths);

	// A freshly written template is the expected first-run outcome, not a failure: guide and exit 0.
	// A template that exists but is still unfilled is caught by `loadConfig` below and exits 1.
	if (bootstrapResult.channelTemplateCreated) {
		printFirstRunGuide(io, paths);
		throw new BootstrapExitError(0);
	}

	const dingtalkConfig = loadConfig(paths, io);
	dingtalkConfig.stateDir = paths.workspaceDir;
	const { settingsManager } = prepareAppServices(paths);

	log.logStartup(paths.workspaceDir);
	const runtime = await createRuntimeContext({
		paths,
		dingtalkConfig,
		registerSignalHandlers,
		startServices,
		settingsManager,
	});

	return {
		bot: runtime.bot,
		store: runtime.store,
		shutdown: async () => {
			await runtime.shutdown("manual");
		},
	};
}
