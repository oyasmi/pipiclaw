import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { WakeEvent } from "../channel/channel-event.js";
import { getDeskDir, getDeskLogsDir, isDeskName } from "../desk/paths.js";
import type { Executor } from "../executor.js";
import type { FileStore } from "../file-store.js";
import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";
import { DeskJobManager } from "./manager.js";
import type { JobManagerOptions } from "./types.js";

interface JobRuntimeConfig {
	/** Root of the per-desk record directories (`<jobsStateDir>/<desk>/`). */
	jobsStateDir?: string;
	/**
	 * The agent workspace root. A job's full-output spill goes to `<desk>/logs/` so the
	 * "Full output: …" pointer is a file the model can read (fix plan §2.2). The path is stable
	 * across restarts, so a re-adopted job's spill is still found.
	 */
	workspaceDir?: string;
	dispatch?: (event: WakeEvent) => boolean | Promise<boolean>;
	isBoundTo?: JobManagerOptions["isBoundTo"];
	onTaskInput?: JobManagerOptions["onTaskInput"];
	/** Sweep cadence override for the lazily-built desk managers (tests). */
	sweepIntervalMs?: number;
	fileStore?: FileStore;
}

/** One application's jobs; the executor and configuration cannot change after construction. */
export function createJobRuntime(executor: Executor, options: JobRuntimeConfig = {}) {
	const config = { ...options };
	const managers = new Map<string, DeskJobManager>();
	let stopped = false;

	function get(desk: string): DeskJobManager {
		let manager = managers.get(desk);
		if (!manager) {
			const deskDir = config.workspaceDir ? getDeskDir(config.workspaceDir, desk) : undefined;
			manager = new DeskJobManager({ desk, deskDir }, executor, {
				...(config.jobsStateDir ? { stateDir: join(config.jobsStateDir, desk) } : {}),
				...(deskDir ? { spillDir: getDeskLogsDir(deskDir) } : {}),
				...(config.dispatch ? { dispatch: config.dispatch } : {}),
				...(config.isBoundTo ? { isBoundTo: config.isBoundTo } : {}),
				...(config.onTaskInput ? { onTaskInput: config.onTaskInput } : {}),
				...(config.fileStore ? { fileStore: config.fileStore } : {}),
				...(config.sweepIntervalMs ? { sweepIntervalMs: config.sweepIntervalMs } : {}),
			});
			managers.set(desk, manager);
			if (stopped) manager.stop();
		}
		return manager;
	}

	/**
	 * Re-adopt every desk's persisted jobs at startup. Desks are the record directories themselves,
	 * and restore does not depend on bindings (spec 058, D6): a job still running when its desk went
	 * dormant survives the restart too.
	 */
	async function restore(): Promise<number> {
		const jobsStateDir = config.jobsStateDir;
		if (!jobsStateDir) return 0;
		let desks: string[];
		try {
			await mkdir(jobsStateDir, { recursive: true });
			desks = (await readdir(jobsStateDir, { withFileTypes: true }))
				.filter((entry) => entry.isDirectory() && isDeskName(entry.name))
				.map((entry) => entry.name);
		} catch (error) {
			log.logWarn("job.scan.failed", "Persisted background job scan failed", { reason: errorMessage(error) });
			return 0;
		}

		let restored = 0;
		for (const desk of desks) {
			restored += await get(desk).restore();
		}
		if (restored > 0) {
			log.logInfoEvent("job.restore.done", "Background job records restored", { fields: { count: restored } });
		}
		return restored;
	}

	return {
		get,
		restore,
		stop: () => {
			stopped = true;
			for (const manager of managers.values()) manager.stop();
		},
	};
}

export type JobRuntime = ReturnType<typeof createJobRuntime>;
