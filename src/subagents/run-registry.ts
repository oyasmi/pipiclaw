/**
 * The application's registry of per-channel run managers: lazy creation, the host-wide admission
 * count, startup restore across every persisted channel, and the daily garbage-collection timer.
 */
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isChannelId } from "../channel/channel-paths.js";
import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";
import { parseRunRecord } from "./run-record.js";
import { type RunManagerOptions, SubAgentRunManager } from "./runs.js";

async function listRecordChannelIds(stateDir: string): Promise<string[]> {
	const channelIds: string[] = [];
	for (const entry of await readdir(stateDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = join(stateDir, entry.name);
		let channelId: string | undefined;
		try {
			for (const filename of (await readdir(dir)).filter((name) => name.endsWith(".json"))) {
				channelId = parseRunRecord(await readFile(join(dir, filename), "utf-8"))?.channelId;
				if (channelId) break;
			}
		} catch {
			channelId = undefined;
		}
		const resolved = channelId && isChannelId(channelId) ? channelId : entry.name;
		if (isChannelId(resolved)) channelIds.push(resolved);
	}
	return channelIds;
}

/** Owns this application's channel managers and their maintenance timer. */
export function createSubAgentRuntime(options: RunManagerOptions = {}) {
	const config = { ...options };
	const managers = new Map<string, SubAgentRunManager>();
	let stopped = false;

	/** Host-wide running count for the D10.2 admission check, summed across every known channel. */
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

	function get(channelId: string): SubAgentRunManager {
		let manager = managers.get(channelId);
		if (!manager) {
			manager = new SubAgentRunManager(channelId, { ...config, runningCount: totalRunningSubAgentRuns });
			managers.set(channelId, manager);
			if (stopped) manager.stop();
		}
		return manager;
	}

	/**
	 * Re-adopt every channel's persisted runs at startup, settling any internal run still marked
	 * `running` as `lost` (D10.3). Channels are discovered from the state directory itself, exactly
	 * like `restoreChannelJobs` — but by reading the records rather than trusting directory names,
	 * so a channel is adopted under the id the rest of the runtime can act on.
	 */
	async function restore(): Promise<number> {
		const stateDir = config.stateDir;
		if (!stateDir) return 0;
		let channelIds: string[];
		try {
			await mkdir(stateDir, { recursive: true });
			channelIds = await listRecordChannelIds(stateDir);
		} catch (error) {
			log.logWarn("subagent.scan.failed", "Persisted run scan failed", { reason: errorMessage(error) });
			return 0;
		}

		let restored = 0;
		for (const channelId of channelIds) {
			restored += await get(channelId).restore();
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
