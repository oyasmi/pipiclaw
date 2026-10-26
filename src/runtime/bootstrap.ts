/**
 * The daemon's composition root: loads config and builds the transports, the ingress, durable
 * dispatch, jobs, delegation runs, the events, memory and task services, then wires the ordered
 * shutdown (`shutdown.ts`).
 */
import { join } from "path";
import { loadDetachedMaintenanceContext } from "../agent/maintenance-context.js";
import { createRunner } from "../agent/runner-factory.js";
import { scanConversationsForInterruptedTurns } from "../agent/turn/turn-recovery.js";
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
import type { WakeEvent } from "../channel/channel-event.js";
import { CHANNELS_INDEX_FILENAME, type ChannelIndex, createChannelIndex } from "../channel/channel-index.js";
import { ChannelStore } from "../channel/store.js";
import type { OutboundMedia, PushMessage, Transport } from "../channel/transport.js";
import { PipiclawSettingsManager } from "../config/settings.js";
import { getToolsConfigPath, loadToolsConfig } from "../config/tools.js";
import { buildDeskList } from "../desk/commands.js";
import { initializeDefaultDesk } from "../desk/default.js";
import { getDeskDir } from "../desk/paths.js";
import { listDesks } from "../desk/registry.js";
import { StartupRefusal } from "../desk/startup-error.js";
import { createEventsWatcher } from "../events/watcher.js";
import { createExecutor, type Executor } from "../executor.js";
import { createJobRuntime, type JobRuntime } from "../jobs/manager.js";
import * as log from "../log.js";
import { MemoryMaintenanceScheduler } from "../memory/scheduler.js";
import { defaultModel } from "../models/runtime.js";
import { loadSecurityConfigWithDiagnostics } from "../security/config.js";
import { logSecurityEvent } from "../security/logger.js";
import type { SecurityLogEvent } from "../security/types.js";
import type { FileLockHandle } from "../shared/file-lock.js";
import { fileStamp } from "../shared/format.js";
import { errorMessage } from "../shared/text-utils.js";
import { renderRunNotice } from "../subagents/commands.js";
import { createSubAgentRuntime, type SubAgentRuntime } from "../subagents/run-registry.js";
import { getUsageLedger } from "../usage/ledger.js";
import { acquireDaemonLock, tryAcquireDaemonLock } from "./daemon-lock.js";
import { DeskRuntime } from "./desk-runtime.js";
import { DurableDispatchService, renderDispatchExhaustedNotice } from "./durable-dispatch.js";
import { createIngress, type IngressService } from "./ingress.js";
import { createRequestExecution } from "./request-execution.js";
import { createShutdown } from "./shutdown.js";
import { TaskDriver } from "./task-driver.js";
import { createTaskSpawner } from "./task-spawn.js";
import type { WakeTaskTransitionHooks } from "./task-wake.js";
import { createTransportRegistry, loadTransports } from "./transports.js";
import type { ArchivedMessage } from "./turn-run.js";

export interface BootstrapOptions {
	env?: NodeJS.ProcessEnv;
	io?: BootstrapIO;
	paths?: BootstrapPaths;
	registerSignalHandlers?: boolean;
	startServices?: boolean;
	/** Host these transports instead of the ones `channel.json` turns on (tests and embedders). */
	transports?: Transport[];
}

export interface AppContext {
	store: ChannelStore;
	shutdown: () => Promise<void>;
}

export interface RuntimeContext {
	jobs: JobRuntime;
	runs: SubAgentRuntime;
	/** Bindings and active desks (spec 058, D6); exposed for the e2e harness and evals. */
	desks: DeskRuntime;
	/** The inbound pipeline; exposed for the e2e harness and evals. */
	ingress: IngressService;
	transports: ReturnType<typeof createTransportRegistry>;
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
		await releaseCachedRunner(channelRunners, channelId);
	}
}

/**
 * Take a channel's runner out of the cache, then dispose it: the next message builds a fresh one
 * from the channel's current binding. Used by LRU eviction and by `/desk bind` (spec 058, D5 step
 * 5), whose final reflect writes into the desk the runner belonged to.
 */
async function releaseCachedRunner(channelRunners: Map<string, AgentRunner>, channelId: string): Promise<void> {
	const runner = channelRunners.get(channelId);
	if (!runner) return;
	channelRunners.delete(channelId);
	await runner.dispose().catch((err) => {
		log.logWarn("runtime.runner.dispose_failed", "Released runner dispose failed", {
			channelId: channelId,
			reason: errorMessage(err),
		});
	});
}

/** The real `TaskDriver` class, or the minimal test-injectable shape `createTaskDriver` may
 * supply instead — `taskDriver.nudge?.()` is the only member either side needs to guarantee. */
type TaskDriverLike = TaskDriver | { start(): void; stop(): void; nudge?(): void };

interface RuntimeContextOptions {
	executor?: Executor;
	paths: BootstrapPaths;
	/** Replaces the transports `channel.json` turns on (tests and embedders). */
	transports?: Transport[];
	/** A `state/daemon.lock` the caller already holds (the embedded runtime); taken here when absent. */
	daemonLock?: FileLockHandle;
	/** Builds one desk's events watcher (tests pass an inert one). */
	createEventsWatcher?: (target: { desk: string; deskDir: string }) => {
		start(): void;
		stop(): void;
		flush?(): Promise<void>;
	};
	createMemoryMaintenanceScheduler?: () => { start(): void; stop(): void };
	memoryMaintenanceSchedulerIntervalMs?: number;
	/** Background-job sweep cadence override (tests use a short one for timely completion wakes). */
	jobSweepIntervalMs?: number;
	createTaskDriver?: () => TaskDriverLike;
	/** Receives raw SDK session events after subscription, without changing runtime handling. */
	observer?: (event: unknown, channelId: string) => void;
	/** Receives TaskDriver dispatch outcomes; used only by isolated evaluation workers. */
	onTaskDriverDispatch?: (event: WakeEvent, accepted: boolean) => void;
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

/** The security audit log as a transport's `audit` callback; the config is read when the first event arrives. */
function securityAudit(paths: BootstrapPaths): (event: SecurityLogEvent) => void {
	let config: ReturnType<typeof loadSecurityConfigWithDiagnostics>["config"] | undefined;
	return (event) => {
		config ??= loadSecurityConfigWithDiagnostics(paths.appHomeDir).config;
		void logSecurityEvent(paths.workspaceDir, config, event);
	};
}

export async function createRuntimeContext(options: RuntimeContextOptions): Promise<RuntimeContext> {
	// One runtime per app home (INV-11): a second one would write the same desks, sessions and
	// state files with no lock between them. Taken before anything is touched.
	const daemonLock = options.daemonLock ?? (await acquireDaemonLock(options.paths.appHomeDir));
	try {
		initializeDefaultDesk(options.paths);
		return await buildRuntimeContext(options, daemonLock);
	} catch (error) {
		await daemonLock.release();
		throw error;
	}
}

async function buildRuntimeContext(
	options: RuntimeContextOptions,
	daemonLock: FileLockHandle,
): Promise<RuntimeContext> {
	const startServices = options.startServices ?? true;
	const registerSignalHandlers = options.registerSignalHandlers ?? true;
	const { workspaceDir, appHomeDir } = options.paths;
	const runtimeSettingsManager = options.settingsManager ?? new PipiclawSettingsManager(appHomeDir);
	log.configureLogging(runtimeSettingsManager.getLoggingSettings());
	const startedAt = Date.now();
	const cliVersion = readCliVersion();
	const channelRunners = new Map<string, AgentRunner>();
	const sessionResetChains = new Map<string, Promise<void>>();
	const activeTasks = new Set<Promise<void>>();
	/** Channels with a `/stop` watchdog in flight, so a burst of `/stop` starts only one. */
	const stopWatchdogs = new Set<string>();
	let durableDispatch: DurableDispatchService | undefined;
	let shuttingDown = false;
	const executor = options.executor ?? createExecutor();
	const dispatch = (event: WakeEvent) => durableDispatch?.dispatch(event) ?? false;

	// The transports this process hosts. A delivered answer is archived through `store`, which is
	// built below: the closure only runs once a turn is under way.
	const transports = createTransportRegistry(
		options.transports ??
			(await loadTransports({
				paths: options.paths,
				stateDir: join(appHomeDir, "state"),
				audit: securityAudit(options.paths),
				archiveBotResponse: (channelId, text) => store.logBotResponse(channelId, text, Date.now().toString()),
			})),
	);
	/** Say something to a channel outside any turn; whether it was delivered. */
	const pushTo = (channelId: string, message: PushMessage): Promise<boolean> =>
		transports.forChannel(channelId)?.push(channelId, message) ?? Promise.resolve(false);

	// The one authority on bindings and active desks (spec 058, D6). `ingress`, `taskDriver` and the
	// spawner are resolved lazily by its callbacks: none of them runs before this function returns.
	const deskRuntime: DeskRuntime = new DeskRuntime({
		workspaceDir,
		conversationKindOf: (channelId) => transports.conversationKindOf(channelId),
		recover: async (conversations) => {
			// Spec 043, D10 point 1: repair turns interrupted by the last shutdown/crash before any of
			// these channels takes traffic — a dangling session would 400 against the provider on
			// every attempt until a human ran /new.
			const report = await scanConversationsForInterruptedTurns(conversations, {
				api: defaultModel.api,
				provider: defaultModel.provider,
				model: defaultModel.id,
			});
			if (report.repaired.length > 0) {
				log.logWarn("runtime.recovery.repaired", "Interrupted turns repaired on restart", {
					fields: {
						repaired: report.repaired.length,
						scanned: report.scanned,
						channels: report.repaired.map((r) => r.conversation.channelId),
					},
				});
			}
			if (report.blocked.length > 0) {
				log.logWarn("runtime.recovery.blocked", "Channels with an unrecoverable session will refuse new turns", {
					reason: report.blocked.map((b) => `${b.conversation.channelId}: ${b.reason}`).join("; "),
				});
			}
		},
		createWatcher: (target) =>
			options.createEventsWatcher
				? options.createEventsWatcher(target)
				: createEventsWatcher({
						...target,
						isBound: (channelId) => deskRuntime.isBoundTo(channelId, target.desk),
						isReachable: (channelId) => transports.isReachable(channelId),
						sink: ingress,
						executor,
						commandGuardConfig: loadSecurityConfigWithDiagnostics(appHomeDir).config.commandGuard,
						historyPath: options.paths.eventHistoryPath,
						dispatch,
						spawnTask: createTaskSpawner({
							getDeskDir: (desk) => getDeskDir(workspaceDir, desk),
							nudge: () => getTaskDriver().nudge?.(),
							notify: (desk, channelId, text) => deskRuntime.sendFromDesk(desk, channelId, text),
						}),
					}),
		send: (channelId, text) => pushTo(channelId, { text }),
		isChannelBusy: (channelId) => channelRunners.get(channelId)?.isBusy() ?? false,
		releaseRunner: (channelId) => releaseCachedRunner(channelRunners, channelId),
		onBindingChanged: () => channelIndex.noteBindingChanged(),
	});
	await deskRuntime.load();
	const isBoundTo = (channelId: string, desk: string) => deskRuntime.isBoundTo(channelId, desk);

	const store = new ChannelStore({
		resolveArchiveDir: (channelId) => {
			const resolution = deskRuntime.resolve(channelId);
			return resolution.kind === "bound" ? resolution.conversation.conversationDir : undefined;
		},
	});
	// `workspace/CHANNELS.md`: names every channel id (and shows its desk) so the workspace, the logs
	// and `/desk` stop dealing in `group_cid...`. Writes are debounced internally.
	const channelIndex: ChannelIndex = createChannelIndex({
		workspaceDir,
		getBoundDesk: (channelId) => deskRuntime.boundDesk(channelId),
	});
	await channelIndex.load();
	// How a channel is named to a user: its transport says.
	const labelOf = (channelId: string) => transports.describeChannel(channelId, channelIndex.nameOf(channelId));
	const describeChannel = (desk: string, channelId: string) => ({
		label: labelOf(channelId),
		boundHere: deskRuntime.isBoundTo(channelId, desk),
	});

	const archiveIncomingMessage = async (
		channelId: string,
		message: ArchivedMessage,
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

	/**
	 * The channel's runner, or `undefined` when it is not bound to an available desk — the runtime
	 * never builds a runner (or a directory) for an unbound channel (INV-2).
	 */
	const getRunner = (channelId: string): AgentRunner | undefined => {
		const resolution = deskRuntime.resolve(channelId);
		if (resolution.kind !== "bound") return undefined;
		const { conversation } = resolution;
		const existing = channelRunners.get(channelId);
		if (existing && existing.conversation.desk === conversation.desk) {
			// Re-insert to move this channel to the end (most-recently-used) of the Map's
			// iteration order, which evictIdleRunnersOverCap relies on.
			channelRunners.delete(channelId);
			channelRunners.set(channelId, existing);
			return existing;
		}

		const runner = createRunner(conversation, {
			jobManager: jobs.get(conversation.desk),
			runManager: runs.get(conversation.desk),
			appHomeDir,
			workspaceDir,
			authConfigPath: options.paths.authConfigPath,
			modelsConfigPath: options.paths.modelsConfigPath,
			settingsManager: runtimeSettingsManager,
			onSessionEvent: options.observer,
			describeChannel: (id) => (channelIndex.nameOf(id) ? labelOf(id) : undefined),
			describeConversation: (dir) => {
				const owner = deskRuntime.channelOfConversation(conversation.desk, dir);
				return owner ? labelOf(owner) : undefined;
			},
			// Enables `send_media`: the file goes out through the transport that owns this channel.
			...(transports.forChannel(channelId)?.sendsMedia === false
				? {}
				: {
						sendMedia: async (id: string, media: OutboundMedia) =>
							(await transports.forChannel(id)?.sendMedia(id, media)) ?? {
								ok: false,
								error: "This channel cannot receive attachments. Tell the user the file's path on the server instead.",
							},
					}),
		});
		channelRunners.set(channelId, runner);
		void evictIdleRunnersOverCap(channelRunners);
		return runner;
	};

	const isShuttingDown = (): boolean => shuttingDown;
	const getDurableDispatch = (): DurableDispatchService | undefined => durableDispatch;
	// `jobs`/`runs`/`taskDriver` are declared further down; these closures resolve them lazily.
	const getJobs = (): JobRuntime => jobs;
	const getRuns = (): SubAgentRuntime => runs;
	const getTaskDriver = (): TaskDriverLike => taskDriver;

	const ingress = createIngress({
		requestExecution: createRequestExecution({
			workspaceDir,
			runners: channelRunners,
			activeTasks,
			transports,
			store,
			isShuttingDown,
			createRunner: (conversation) =>
				createRunner(conversation, {
					requestScoped: true,
					jobManager: jobs.get(conversation.desk),
					runManager: runs.get(conversation.desk),
					appHomeDir,
					workspaceDir,
					authConfigPath: options.paths.authConfigPath,
					modelsConfigPath: options.paths.modelsConfigPath,
					settingsManager: runtimeSettingsManager,
					onSessionEvent: options.observer,
				}),
		}),
		options,
		transports,
		store,
		channelRunners,
		sessionResetChains,
		activeTasks,
		stopWatchdogs,
		channelIndex,
		archiveIncomingMessage,
		getRunner,
		resolveChannel: (channelId) => deskRuntime.resolve(channelId),
		ensureBinding: (channelId, desk) => deskRuntime.ensureDefaultBinding(channelId, desk),
		deskPort: (channelId) => ({
			list: async () =>
				buildDeskList(
					await listDesks(workspaceDir),
					deskRuntime.bindingTable(),
					deskRuntime.boundDesk(channelId),
					labelOf,
				),
			channelIndexPath: join(workspaceDir, CHANNELS_INDEX_FILENAME),
			create: (name) => deskRuntime.create(name),
			bind: (name) => deskRuntime.bind(channelId, name),
		}),
		describeChannel,
		cliVersion,
		startedAt,
		isShuttingDown,
		getDurableDispatch,
		getJobs,
		getRuns,
		getTaskDriver,
		pushTo,
	});

	const dispatchStateDir = join(appHomeDir, "state", "dispatch");
	durableDispatch = new DurableDispatchService({
		stateDir: dispatchStateDir,
		bot: ingress,
		isReachable: (channelId) => transports.isReachable(channelId),
		// A structured wake that keeps failing before it can mark itself complete would otherwise
		// redeliver forever. Surface it once instead of looping silently; the record stays on disk
		// for inspection until a human clears it. Like every background notice, only to a channel
		// still bound to the wake's desk (D7).
		onExhausted: async (record) => {
			log.logEvent("warn", "dispatch.exhausted", "Dispatch exhausted", {
				ctx: { channelId: record.event.channelId },
				details: record.event.text.slice(0, 500),
				fields: { dispatchId: record.id, deliveries: record.deliveries, producer: record.event.producer },
			});
			await deskRuntime.sendFromDesk(
				record.event.desk,
				record.event.channelId,
				renderDispatchExhaustedNotice(record, dispatchStateDir),
			);
		},
	});
	// Background jobs and delegation runs are owned per desk (spec 058, D15); their completion wakes
	// pass the producer-side binding check before they are dispatched.
	const jobs = createJobRuntime(executor, {
		jobsStateDir: join(appHomeDir, "state", "jobs"),
		workspaceDir,
		dispatch,
		isBoundTo,
		...(options.jobSweepIntervalMs ? { sweepIntervalMs: options.jobSweepIntervalMs } : {}),
	});
	const runs = createSubAgentRuntime({
		stateDir: join(appHomeDir, "state", "subagent-runs"),
		workspaceDir,
		dispatch,
		isBoundTo,
		// A best-effort out-of-band notice, independent of the completion wake. `notices: "off"`
		// (settings.json) restores the silent behavior.
		notify: (desk, channelId, notice) => {
			const level = runtimeSettingsManager.getDelegationSettings().notices;
			if (level === "off") return;
			if (level === "settled" && notice.kind === "progress") return;
			const text = renderRunNotice(notice);
			if (text) void deskRuntime.sendFromDesk(desk, channelId, text);
		},
		ledger: getUsageLedger(),
		store,
	});
	// Admission (bot.start() below) must not open until every persisted job and run is back in
	// memory, and restore is independent of bindings (D6): a dormant desk's runs still settle.
	await jobs.restore();
	await runs.restore();
	runs.start();
	// Activation repairs each bound desk's conversations before its channels can take traffic.
	await deskRuntime.activateBound();

	const memoryMaintenanceScheduler = options.createMemoryMaintenanceScheduler
		? options.createMemoryMaintenanceScheduler()
		: new MemoryMaintenanceScheduler({
				appHomeDir,
				getConversations: () => deskRuntime.boundConversations(),
				// Conversations active this boot reuse their runner's in-memory context; every other one
				// gets a lightweight disk-backed context instead of resurrecting a full runner.
				getRuntimeContext: async (conversation) => {
					const runner = channelRunners.get(conversation.channelId);
					if (runner && runner.conversation.desk === conversation.desk) {
						return runner.getMemoryMaintenanceContext();
					}
					return loadDetachedMaintenanceContext({
						conversation,
						workspaceDir,
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
		const stamp = fileStamp(getToolsConfigPath(appHomeDir));
		if (stamp !== cachedToolsStamp) {
			cachedToolsStamp = stamp;
			cachedTasksEnabled = loadToolsConfig(appHomeDir).tools.tasks.enabled;
		}
		return cachedTasksEnabled;
	};
	const taskDriver = options.createTaskDriver
		? options.createTaskDriver()
		: new TaskDriver({
				getActiveDesks: () => deskRuntime.activeDesks(),
				isBoundTo,
				isReachable: (channelId) => transports.isReachable(channelId),
				isChannelActive: (channelId) => channelRunners.get(channelId)?.isBusy() ?? false,
				dispatch,
				onDispatch: options.onTaskDriverDispatch,
				notify: (receipt) =>
					receipt.desk ? deskRuntime.sendFromDesk(receipt.desk, receipt.channelId, receipt.text) : false,
				isEnabled: tasksToolEnabled,
			});

	const shutdownWithReason = createShutdown({
		taskDriver,
		getDurableDispatch,
		memoryMaintenanceScheduler,
		deskRuntime,
		runs,
		jobs,
		transports,
		ingress,
		store,
		channelIndex,
		channelRunners,
		activeTasks,
		markShuttingDown: () => {
			shuttingDown = true;
		},
		releaseDaemonLock: () => daemonLock.release(),
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
		deskRuntime.startServices();
		memoryMaintenanceScheduler.start();
		taskDriver.start();
		durableDispatch.start();
		await transports.startAll(ingress);
	}

	return {
		ingress,
		transports,
		jobs,
		runs,
		desks: deskRuntime,
		store,
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
	// A template that exists but is still unfilled is caught by the transport loader (`loadTransports`) and exits 1.
	if (bootstrapResult.channelTemplateCreated) {
		printFirstRunGuide(io, paths);
		throw new BootstrapExitError(0);
	}

	const { settingsManager } = prepareAppServices(paths);

	log.logStartup(paths.workspaceDir);
	let runtime: RuntimeContext;
	try {
		runtime = await createRuntimeContext({
			paths,
			...(options.transports ? { transports: options.transports } : {}),
			registerSignalHandlers,
			startServices,
			settingsManager,
		});
	} catch (error) {
		if (!(error instanceof StartupRefusal)) throw error;
		io.error(error.message);
		throw new BootstrapExitError(1);
	}

	return {
		store: runtime.store,
		shutdown: async () => {
			await runtime.shutdown("manual");
		},
	};
}

/** A runtime started inside the terminal process (spec 061, D26). */
export interface EmbeddedRuntime {
	/** Shut the runtime down in the daemon's order and release the app home. */
	stop(): Promise<void>;
}

/**
 * Start the runtime for `pipiclaw tui` when no daemon is running: only the Web API's local socket
 * is switched on (the terminal is its client), whatever `channel.json` says. Returns `undefined`
 * when another process already holds the app home — a daemon is running and the terminal should
 * connect to it. The lock is taken exactly once and handed to the runtime.
 */
export async function bootstrapEmbedded(paths: BootstrapPaths, io: BootstrapIO): Promise<EmbeddedRuntime | undefined> {
	printBootstrapSummary(bootstrapAppHome(paths), io, paths);
	const lock = await tryAcquireDaemonLock(paths.appHomeDir);
	if (lock.kind === "held") return undefined;
	// The full-screen terminal owns stdout: the runtime logs to its file sink only.
	log.setConsoleLoggingEnabled(false);
	const { settingsManager } = prepareAppServices(paths);
	log.logStartup(paths.workspaceDir);
	const { WebApiTransport } = await import("../webapi/transport.js");
	let runtime: RuntimeContext;
	try {
		runtime = await createRuntimeContext({
			paths,
			daemonLock: lock.handle,
			transports: [
				new WebApiTransport({
					config: { socket: true, keys: [] },
					stateDir: join(paths.appHomeDir, "state", "webapi"),
					audit: securityAudit(paths),
				}),
			],
			registerSignalHandlers: false,
			startServices: true,
			settingsManager,
		});
	} catch (error) {
		await lock.handle.release();
		throw error;
	}
	return { stop: () => runtime.shutdown("manual") };
}
