/**
 * The application's registry of per-desk run managers: lazy creation, the host-wide admission
 * count, startup restore across every persisted desk, and the daily garbage-collection timer.
 */
import { mkdir, readdir } from "node:fs/promises";
import { getDeskDir, isDeskName } from "../desk/paths.js";
import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";
import { type RunManagerOptions, SubAgentRunManager } from "./runs.js";

/** Owns this application's desk managers and their maintenance timer. */
export function createSubAgentRuntime(options: RunManagerOptions & { workspaceDir: string }) {
	const { workspaceDir, ...config } = options;
	const managers = new Map<string, SubAgentRunManager>();
	let stopped = false;

	/** Host-wide running count for the D10.2 admission check, summed across every known desk. */
	function totalRunningSubAgentRuns(): number {
		let total = 0;
		for (const manager of managers.values()) {
			total += manager.runningCount();
		}
		return total;
	}

	const GARBAGE_COLLECTION_INTERVAL_MS = 24 * 60 * 60_000;
	let garbageCollectionTimer: ReturnType<typeof setInterval> | undefined;
	let collectingGarbage = false;

	async function collectGarbageAllChannels(): Promise<void> {
		if (collectingGarbage) return;
		collectingGarbage = true;
		try {
			for (const manager of managers.values()) {
				await manager.collectGarbage().catch((error) =>
					log.logWarn("subagent.gc.failed", "Run garbage collection pass failed", {
						reason: errorMessage(error),
					}),
				);
			}
		} finally {
			collectingGarbage = false;
		}
	}

	function startSubAgentGarbageCollector(): void {
		if (stopped) return;
		if (garbageCollectionTimer) clearInterval(garbageCollectionTimer);
		garbageCollectionTimer = setInterval(() => void collectGarbageAllChannels(), GARBAGE_COLLECTION_INTERVAL_MS);
		garbageCollectionTimer.unref?.();
	}

	/** Stop the host-wide daily garbage collector during shutdown or test teardown. */
	function stop(): void {
		stopped = true;
		for (const manager of managers.values()) manager.stop();
		if (garbageCollectionTimer) {
			clearInterval(garbageCollectionTimer);
			garbageCollectionTimer = undefined;
		}
	}

	function get(desk: string): SubAgentRunManager {
		let manager = managers.get(desk);
		if (!manager) {
			manager = new SubAgentRunManager(
				{ desk, deskDir: getDeskDir(workspaceDir, desk) },
				{ ...config, runningCount: totalRunningSubAgentRuns },
			);
			managers.set(desk, manager);
			if (stopped) manager.stop();
		}
		return manager;
	}

	/**
	 * Re-adopt every desk's persisted runs at startup, settling any internal run still marked
	 * `running` as `lost` (D10.3). Desks are the record directories themselves — a desk name *is* the
	 * directory name — and restore does not depend on bindings (spec 058, D6): a run still going
	 * when its desk went dormant still has an owner to adopt and settle it.
	 */
	async function restore(): Promise<number> {
		const stateDir = config.stateDir;
		if (!stateDir) return 0;
		let desks: string[];
		try {
			await mkdir(stateDir, { recursive: true });
			desks = (await readdir(stateDir, { withFileTypes: true }))
				.filter((entry) => entry.isDirectory() && isDeskName(entry.name))
				.map((entry) => entry.name);
		} catch (error) {
			log.logWarn("subagent.scan.failed", "Persisted run scan failed", { reason: errorMessage(error) });
			return 0;
		}

		let restored = 0;
		for (const desk of desks) {
			restored += await get(desk).restore();
		}
		// Reclaim stale runs once as a host-wide startup batch; subsequent batches run daily.
		await collectGarbageAllChannels();
		if (restored > 0) {
			log.logInfoEvent("subagent.restore.done", "Sub-agent run records restored", { fields: { count: restored } });
		}
		return restored;
	}

	return { get, restore, start: startSubAgentGarbageCollector, stop };
}

export type SubAgentRuntime = ReturnType<typeof createSubAgentRuntime>;
