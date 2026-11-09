/**
 * Ordered daemon shutdown: stop the schedulers, stop admission (the transports still deliver), wait
 * for active turns (aborting them past a grace window), dispose idle runners, close the transports,
 * then flush storage and logs. Idempotent: every
 * call after the first returns the first call's promise.
 */
import type { AgentRunner } from "../agent/types.js";
import type { ChannelIndex } from "../channel/channel-index.js";
import type { ChannelStore } from "../channel/store.js";
import * as log from "../log.js";
import { flushSecurityLogs } from "../security/logger.js";
import { errorMessage } from "../shared/text-utils.js";
import { getUsageLedger } from "../usage/ledger.js";

const SHUTDOWN_WAIT_MS = 15000;
const SHUTDOWN_FLUSH_WAIT_MS = 45000;
const SHUTDOWN_ABORT_WAIT_MS = 5000;
const SHUTDOWN_LOG_FLUSH_WAIT_MS = 10_000;
const SHUTDOWN_TOTAL_MS = 90_000;

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

export interface ShutdownDeps {
	deliveryScopes?: { stop(): Promise<void> };
	taskLane: { stop(): void };
	getDurableDispatch: () => { stop(): void; flush?(): Promise<void> } | undefined;
	memoryMaintenanceScheduler: { stop(): void };
	deskRuntime: { stop(): void; flush?(): Promise<void> };
	runs: { stop(): void };
	jobs: { stop(): void };
	transports: { stopAcceptingAll(): Promise<void>; stopAll(): Promise<void> };
	/** The inbound pipeline: stops taking work. */
	ingress: { stop(): void };
	store: ChannelStore;
	channelIndex: ChannelIndex;
	channelRunners: Map<string, AgentRunner>;
	activeTasks: Set<Promise<void>>;
	/** Flips the runtime's `isShuttingDown()` the moment shutdown begins. */
	markShuttingDown: () => void;
	/** Frees `state/daemon.lock`, last of all: until then no other runtime may open this app home. */
	releaseDaemonLock: () => Promise<void>;
}

export function createShutdown(deps: ShutdownDeps): (reason?: NodeJS.Signals | "manual") => Promise<void> {
	const {
		taskLane,
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
	} = deps;
	let shutdownPromise: Promise<void> | null = null;

	return async (reason: NodeJS.Signals | "manual" = "manual"): Promise<void> => {
		if (shutdownPromise) {
			return shutdownPromise;
		}

		shutdownPromise = (async () => {
			const deadline = Date.now() + SHUTDOWN_TOTAL_MS;
			let closed = false;
			let quiescent = true;
			const wait = (tasks: Promise<void>[], budget: number) =>
				waitForTasks(tasks, Math.max(0, Math.min(budget, deadline - Date.now())));
			const phase = async (name: string, work: () => Promise<void>, budget: number) => {
				const settled = await wait(
					[
						Promise.resolve()
							.then(work)
							.catch((error) => {
								quiescent = false;
								if (!closed)
									log.logWarn("runtime.shutdown.phase_failed", "Shutdown phase failed", {
										reason: errorMessage(error),
										fields: { phase: name },
									});
							}),
					],
					budget,
				);
				if (!settled) {
					quiescent = false;
					log.logWarn("runtime.shutdown.phase_timeout", "Shutdown phase failed", {
						reason: "deadline exceeded",
						fields: { phase: name },
					});
				}
			};
			deps.markShuttingDown();
			log.logInfoEvent("runtime.shutdown.started", "Shutting down", { fields: { reason } });

			taskLane.stop();
			deps.getDurableDispatch()?.stop();
			memoryMaintenanceScheduler.stop();
			deskRuntime.stop();
			runs.stop();
			jobs.stop();
			// Admission closes first; the transports keep delivering, so a turn that finishes inside
			// the grace window below still reaches its channel (its card, its Web API response).
			await phase("stop-accepting", () => transports.stopAcceptingAll(), SHUTDOWN_ABORT_WAIT_MS);
			ingress.stop();

			const runningTasks = Array.from(activeTasks);
			if (runningTasks.length > 0) {
				log.logInfoEvent("runtime.shutdown.waiting", "Waiting for active turns to finish", {
					fields: { activeTurns: runningTasks.length },
				});
				const completed = await wait(runningTasks, SHUTDOWN_WAIT_MS);

				if (!completed) {
					log.logWarn("runtime.shutdown.grace_exceeded", "Shutdown grace period exceeded; aborting active turns", {
						fields: { waitMs: SHUTDOWN_WAIT_MS },
					});
					const aborts: Promise<void>[] = [];
					for (const [channelId, runner] of channelRunners) {
						if (!runner.isBusy()) continue;
						runner.requestStop();
						log.logInfoEvent("runtime.shutdown.aborting", "Aborting active turn for shutdown", {
							channelId: channelId,
						});
						aborts.push(
							runner.abort().catch((err) => {
								if (!closed)
									log.logWarn("runtime.shutdown.abort_failed", "Turn abort during shutdown failed", {
										channelId: channelId,
										reason: errorMessage(err),
									});
							}),
						);
					}
					// abort() can itself hang before reaching the SDK. It shares the same
					// abort window with the turns; it never extends the shutdown deadline.
					await wait([...aborts, ...activeTasks], SHUTDOWN_ABORT_WAIT_MS);
					const remainingTasks = Array.from(activeTasks);
					if (remainingTasks.length > 0) {
						quiescent = false;
						log.logWarn("runtime.shutdown.forced", "Shutdown turn drain failed", {
							reason: "deadline exceeded",
							fields: { activeTurns: remainingTasks.length },
						});
					}
				}
			}

			// Idle runners are disposed (flush memory, unsubscribe, release the SDK session); a
			// still-busy one — its turn already aborted above — is just dropped from the cache and
			// left to unwind on its own as the process exits.
			const disposals: Promise<void>[] = [];
			for (const [channelId, runner] of channelRunners) {
				if (runner.isBusy()) {
					runner.retireForRecovery();
					continue;
				}
				disposals.push(
					runner.dispose().catch((err) => {
						quiescent = false;
						if (!closed)
							log.logWarn("runtime.shutdown.dispose_failed", "Runner dispose during shutdown failed", {
								channelId: channelId,
								reason: errorMessage(err),
							});
					}),
				);
			}
			if (disposals.length > 0) {
				log.logInfoEvent("runtime.shutdown.disposing", "Disposing idle channel runners", {
					fields: { count: disposals.length },
				});
				const disposed = await wait(disposals, SHUTDOWN_FLUSH_WAIT_MS);
				if (!disposed) {
					quiescent = false;
					log.logWarn("runtime.shutdown.dispose_timeout", "Runner disposal during shutdown timed out", {
						fields: { waitMs: SHUTDOWN_FLUSH_WAIT_MS },
					});
				}
			}
			channelRunners.clear();
			// Only now do connections close: what is still unfinished ends as interrupted.
			await phase("delivery-scopes", () => deps.deliveryScopes?.stop() ?? Promise.resolve(), SHUTDOWN_FLUSH_WAIT_MS);
			await phase("stop-transports", () => transports.stopAll(), SHUTDOWN_ABORT_WAIT_MS);

			await phase(
				"storage",
				async () => {
					await Promise.all([
						deps.getDurableDispatch()?.flush?.() ?? Promise.resolve(),
						store.close(),
						channelIndex.close(),
						getUsageLedger().flush?.() ?? Promise.resolve(),
						flushSecurityLogs(),
						...(deskRuntime.flush ? [deskRuntime.flush()] : []),
					]);
				},
				SHUTDOWN_LOG_FLUSH_WAIT_MS,
			);
			await phase("logging", () => log.flushLogging(), SHUTDOWN_LOG_FLUSH_WAIT_MS);
			// A deadline cannot cancel an arbitrary storage promise. Do not hand this home to
			// a new writer while such work (or an active turn) can still mutate it. Process exit
			// makes the retained PID lock reclaimable; an embedded caller must exit before reopen.
			// A task drive can finish by starting its runner's asynchronous disposal. That
			// cleanup joins activeTasks synchronously and must also fence lock hand-off.
			quiescent &&= activeTasks.size === 0;
			closed = true;
			if (quiescent) {
				const released = await wait(
					[
						deps.releaseDaemonLock().catch((error) => {
							log.logWarn("runtime.shutdown.unlock_failed", "Daemon lock release failed", {
								reason: errorMessage(error),
							});
						}),
					],
					Math.max(0, deadline - Date.now()),
				);
				if (!released)
					log.logWarn("runtime.shutdown.unlock_timeout", "Daemon lock release failed", {
						reason: "deadline exceeded",
					});
			} else
				log.logWarn("runtime.shutdown.lock_retained", "Shutdown quiescence failed", {
					reason: "unfinished work may still write; daemon lock retained until process exit",
				});
		})();

		return shutdownPromise;
	};
}
