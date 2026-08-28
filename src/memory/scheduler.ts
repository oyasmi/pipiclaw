import { readdir } from "node:fs/promises";
import { basename } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
// The channel index is a runtime-owned workspace artifact; the scheduler is one of its two
// read-only consumers (see `discoverWorkspaceChannelIds`).
import { discoverWorkspaceChannelIds } from "../channel/channel-index.js";
import { isChannelId } from "../channel/channel-paths.js";
import * as log from "../log.js";
import type { PipiclawMemoryMaintenanceSettings, PipiclawSessionMemorySettings } from "../settings.js";
import { errorMessage } from "../shared/text-utils.js";
import {
	shouldRunMemoryCheckpoint,
	shouldRunSessionRefresh,
	shouldRunStructuralMaintenance,
} from "./maintenance-gates.js";
import { runMemoryCheckpointJob, runSessionRefreshJob, runStructuralMaintenanceJob } from "./maintenance-jobs.js";
import { getMemoryMaintenanceStateDir, readMemoryMaintenanceState } from "./maintenance-state.js";

export interface MemoryMaintenanceRuntimeContext {
	channelId: string;
	channelDir: string;
	/**
	 * Transcript accessors, not arrays: the scheduler visits a channel every tick but almost
	 * every tick is denied by a cheap schedule gate. Copying (and then scanning) the whole
	 * transcript before that verdict was the entire steady-state cost of an idle daemon.
	 */
	messages: () => AgentMessage[];
	sessionEntries: () => SessionEntry[];
	model: Model<Api>;
	resolveApiKey: (model: Model<Api>) => Promise<string>;
	settings: {
		sessionMemory: PipiclawSessionMemorySettings;
		memoryMaintenance: PipiclawMemoryMaintenanceSettings;
	};
}

export interface MemoryMaintenanceSchedulerOptions {
	appHomeDir: string;
	workspaceDir: string;
	getKnownChannelIds?: () => Iterable<string>;
	getRuntimeContext: (channelId: string) => Promise<MemoryMaintenanceRuntimeContext | null>;
	isChannelActive: (channelId: string) => boolean;
	getSettings: () => {
		memoryMaintenance: PipiclawMemoryMaintenanceSettings;
		sessionMemory: PipiclawSessionMemorySettings;
	};
	intervalMs?: number;
}

const DEFAULT_TICK_INTERVAL_MS = 60_000;

/**
 * Cheap due-time predicate, evaluated before `getRuntimeContext` (transcript access, model
 * resolution, settings reload) is paid for.
 *
 * Reuses the real gates with optimistic material (transcript-derived checks always pass), so the
 * only work here is one state-file read plus timestamp arithmetic. A gate's material checks are
 * purely additive restrictions on top of the cheap checks (interval/backoff/idle/dirty), so
 * optimistic material can only ever make this predicate *more* permissive than the real job would
 * be — it never wrongly skips a channel that a job would actually run for.
 */
async function mightAnyMaintenanceJobBeDue(input: {
	appHomeDir: string;
	channelId: string;
	settings: {
		sessionMemory: PipiclawSessionMemorySettings;
		memoryMaintenance: PipiclawMemoryMaintenanceSettings;
	};
	now: Date;
}): Promise<boolean> {
	const state = await readMemoryMaintenanceState(input.appHomeDir, input.channelId);

	const sessionRefresh = shouldRunSessionRefresh({
		now: input.now,
		state,
		sessionMemory: input.settings.sessionMemory,
		maintenance: input.settings.memoryMaintenance,
		channelActive: false,
		hasNewSessionEntry: () => true,
		hasMeaningfulMaterial: () => true,
	});
	if (sessionRefresh.allowed) return true;

	const checkpoint = shouldRunMemoryCheckpoint({
		now: input.now,
		state,
		maintenance: input.settings.memoryMaintenance,
		channelActive: false,
		material: () => ({ hasNewEntry: true, hasMeaningfulExchange: true, batchSize: Number.MAX_SAFE_INTEGER }),
	});
	if (checkpoint.allowed) return true;

	const structural = await shouldRunStructuralMaintenance({
		now: input.now,
		state,
		maintenance: input.settings.memoryMaintenance,
		channelActive: false,
		material: async () => ({
			memoryCleanupNeeded: true,
			historyFoldingNeeded: true,
			hasMemoryContent: true,
			hasHistoryContent: true,
			expiredEntryCount: 1,
		}),
	});
	return structural.allowed;
}

async function listStateChannels(appHomeDir: string): Promise<string[]> {
	try {
		const entries = await readdir(getMemoryMaintenanceStateDir(appHomeDir), { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
			.map((entry) => basename(entry.name, ".json"))
			.filter(isChannelId);
	} catch {
		return [];
	}
}

export async function discoverMemoryMaintenanceChannels(input: {
	appHomeDir: string;
	workspaceDir: string;
	knownChannelIds?: Iterable<string>;
}): Promise<string[]> {
	const channels = new Set<string>();
	for (const channelId of input.knownChannelIds ?? []) {
		if (isChannelId(channelId)) {
			channels.add(channelId);
		}
	}
	for (const channelId of await discoverWorkspaceChannelIds(input.workspaceDir)) {
		channels.add(channelId);
	}
	for (const channelId of await listStateChannels(input.appHomeDir)) {
		channels.add(channelId);
	}
	return Array.from(channels).sort();
}

function normalizeMaxConcurrentChannels(value: number): number {
	return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

export class MemoryMaintenanceScheduler {
	private timer: ReturnType<typeof setInterval> | null = null;
	private running = false;
	private nextChannelIndex = 0;

	constructor(private readonly options: MemoryMaintenanceSchedulerOptions) {}

	start(): void {
		if (this.timer) {
			return;
		}
		// `enabled` is re-checked on every tick inside `runOnce`, which is nearly free when
		// disabled (one cached settings read, no channel scan). Gating `start()` on it too would
		// mean flipping `memoryMaintenance.enabled` on at runtime never actually starts the timer.
		this.timer = setInterval(() => {
			void this.runOnce().catch((error) => {
				log.logWarning("Memory maintenance scheduler tick failed", errorMessage(error));
			});
		}, this.options.intervalMs ?? DEFAULT_TICK_INTERVAL_MS);
		this.timer.unref?.();
	}

	stop(): void {
		if (!this.timer) {
			return;
		}
		clearInterval(this.timer);
		this.timer = null;
	}

	async runOnce(now = new Date()): Promise<void> {
		const settings = this.options.getSettings();
		if (!settings.memoryMaintenance.enabled || this.running) {
			return;
		}

		this.running = true;
		try {
			const channelIds = await discoverMemoryMaintenanceChannels({
				appHomeDir: this.options.appHomeDir,
				workspaceDir: this.options.workspaceDir,
				knownChannelIds: this.options.getKnownChannelIds?.(),
			});
			const maxConcurrent = normalizeMaxConcurrentChannels(settings.memoryMaintenance.maxConcurrentChannels);
			if (channelIds.length === 0) {
				return;
			}
			const selected: string[] = [];
			let scanned = 0;
			let index = this.nextChannelIndex % channelIds.length;
			while (scanned < channelIds.length && selected.length < maxConcurrent) {
				const channelId = channelIds[index];
				if (
					channelId &&
					!this.options.isChannelActive(channelId) &&
					(await mightAnyMaintenanceJobBeDue({
						appHomeDir: this.options.appHomeDir,
						channelId,
						settings,
						now,
					}))
				) {
					selected.push(channelId);
				}
				index = (index + 1) % channelIds.length;
				scanned++;
			}
			this.nextChannelIndex = index;
			await Promise.all(selected.map((channelId) => this.runChannelOnce(channelId, now)));
		} finally {
			this.running = false;
		}
	}

	private async runChannelOnce(channelId: string, now: Date): Promise<void> {
		if (this.options.isChannelActive(channelId)) {
			return;
		}
		const context = await this.options.getRuntimeContext(channelId);
		if (!context) {
			return;
		}
		const common = {
			appHomeDir: this.options.appHomeDir,
			channelId,
			channelDir: context.channelDir,
			channelActive: this.options.isChannelActive(channelId),
			now,
			settings: context.settings,
			model: context.model,
			resolveApiKey: context.resolveApiKey,
			messages: context.messages,
			sessionEntries: context.sessionEntries,
		};

		const session = await runSessionRefreshJob(common);
		if (session.ran) {
			return;
		}
		const checkpoint = await runMemoryCheckpointJob(common);
		if (checkpoint.ran) {
			return;
		}
		await runStructuralMaintenanceJob(common);
	}
}
