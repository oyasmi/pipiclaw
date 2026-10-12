/**
 * Ordered daemon shutdown: stop the schedulers, stop admission, wait for active turns (aborting
 * them past a grace window), dispose idle runners, then flush storage and logs. Idempotent: every
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
	taskDriver: { stop(): void };
	getDurableDispatch: () => { stop(): void } | undefined;
	memoryMaintenanceScheduler: { stop(): void };
	eventsWatcher: { stop(): void; flush?(): Promise<void> };
	runs: { stop(): void };
	jobs: { stop(): void };
	bot: { stop(): Promise<void> };
	store: ChannelStore;
	channelIndex: ChannelIndex;
	channelRunners: Map<string, AgentRunner>;
	activeTasks: Set<Promise<void>>;
	/** Flips the runtime's `isShuttingDown()` the moment shutdown begins. */
	markShuttingDown: () => void;
}

export function createShutdown(deps: ShutdownDeps): (reason?: NodeJS.Signals | "manual") => Promise<void> {
	const {
		taskDriver,
		memoryMaintenanceScheduler,
		eventsWatcher,
		runs,
		jobs,
		bot,
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
			deps.markShuttingDown();
			log.logInfoEvent("runtime.shutdown.started", "Shutting down", { fields: { reason } });

			taskDriver.stop();
			deps.getDurableDispatch()?.stop();
			memoryMaintenanceScheduler.stop();
			eventsWatcher.stop();
			runs.stop();
			jobs.stop();
			await bot.stop();

			const runningTasks = Array.from(activeTasks);
			if (runningTasks.length > 0) {
				log.logInfoEvent("runtime.shutdown.waiting", "Waiting for active turns to finish", {
					fields: { activeTurns: runningTasks.length },
				});
				const completed = await waitForTasks(runningTasks, SHUTDOWN_WAIT_MS);

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
								log.logWarn("runtime.shutdown.abort_failed", "Turn abort during shutdown failed", {
									channelId: channelId,
									reason: errorMessage(err),
								});
							}),
						);
					}
					await Promise.allSettled(aborts);

					const remainingTasks = Array.from(activeTasks);
					if (remainingTasks.length > 0) {
						const abortedCompleted = await waitForTasks(remainingTasks, SHUTDOWN_ABORT_WAIT_MS);
						if (!abortedCompleted) {
							log.logWarn("runtime.shutdown.forced", "Shutdown forced with turns still active", {
								fields: { activeTurns: remainingTasks.length },
							});
						}
					}
				}
			}

			// Idle runners are disposed (flush memory, unsubscribe, release the SDK session); a
			// still-busy one — its turn already aborted above — is just dropped from the cache and
			// left to unwind on its own as the process exits.
			const disposals: Promise<void>[] = [];
			for (const [channelId, runner] of channelRunners) {
				if (runner.isBusy()) continue;
				disposals.push(
					runner.dispose().catch((err) => {
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
				const disposed = await waitForTasks(disposals, SHUTDOWN_FLUSH_WAIT_MS);
				if (!disposed) {
					log.logWarn("runtime.shutdown.dispose_timeout", "Runner disposal during shutdown timed out", {
						fields: { waitMs: SHUTDOWN_FLUSH_WAIT_MS },
					});
				}
			}
			channelRunners.clear();

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
				log.logWarn("runtime.shutdown.flush_timeout", "Log flush during shutdown timed out", {
					fields: { waitMs: SHUTDOWN_LOG_FLUSH_WAIT_MS },
				});
			}
			await waitForTasks([log.flushLogging()], SHUTDOWN_LOG_FLUSH_WAIT_MS);
		})();

		return shutdownPromise;
	};
}
