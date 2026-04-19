import { readdir } from "node:fs/promises";
import { basename } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import * as log from "../log.js";
import type {
	PipiclawMemoryGrowthSettings,
	PipiclawMemoryMaintenanceSettings,
	PipiclawSessionMemorySettings,
} from "../settings.js";
import {
	runDurableConsolidationJob,
	runGrowthReviewJob,
	runSessionRefreshJob,
	runStructuralMaintenanceJob,
} from "./maintenance-jobs.js";
import { getMemoryMaintenanceStateDir } from "./maintenance-state.js";

export interface MemoryMaintenanceRuntimeContext {
	channelId: string;
	channelDir: string;
	workspaceDir: string;
	workspacePath: string;
	messages: AgentMessage[];
	sessionEntries: SessionEntry[];
	model: Model<Api>;
	resolveApiKey: (model: Model<Api>) => Promise<string>;
	settings: {
		sessionMemory: PipiclawSessionMemorySettings;
		memoryGrowth: PipiclawMemoryGrowthSettings;
		memoryMaintenance: PipiclawMemoryMaintenanceSettings;
	};
	loadedSkills: Array<{ name: string; description?: string }>;
	refreshWorkspaceResources?: () => Promise<void>;
}

export interface MemoryMaintenanceSchedulerOptions {
	appHomeDir: string;
	workspaceDir: string;
	getKnownChannelIds?: () => Iterable<string>;
	getRuntimeContext: (channelId: string) => Promise<MemoryMaintenanceRuntimeContext | null>;
	isChannelActive: (channelId: string) => boolean;
	getSettings: () => {
		memoryMaintenance: PipiclawMemoryMaintenanceSettings;
	};
	emitNotice?: (channelId: string, notice: string) => Promise<void>;
	intervalMs?: number;
}

const DEFAULT_TICK_INTERVAL_MS = 60_000;
const CHANNEL_ID_PATTERN = /^(dm|group)_[A-Za-z0-9._:-]+$/;

function isChannelId(value: string): boolean {
	return CHANNEL_ID_PATTERN.test(value);
}

async function listWorkspaceChannels(workspaceDir: string): Promise<string[]> {
	try {
		const entries = await readdir(workspaceDir, { withFileTypes: true });
		return entries.filter((entry) => entry.isDirectory() && isChannelId(entry.name)).map((entry) => entry.name);
	} catch {
		return [];
	}
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
	for (const channelId of await listWorkspaceChannels(input.workspaceDir)) {
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
		if (this.timer || !this.options.getSettings().memoryMaintenance.enabled) {
			return;
		}
		this.timer = setInterval(() => {
			void this.runOnce().catch((error) => {
				log.logWarning(
					"Memory maintenance scheduler tick failed",
					error instanceof Error ? error.message : String(error),
				);
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
		const settings = this.options.getSettings().memoryMaintenance;
		if (!settings.enabled || this.running) {
			return;
		}

		this.running = true;
		try {
			const channelIds = await discoverMemoryMaintenanceChannels({
				appHomeDir: this.options.appHomeDir,
				workspaceDir: this.options.workspaceDir,
				knownChannelIds: this.options.getKnownChannelIds?.(),
			});
			const maxConcurrent = normalizeMaxConcurrentChannels(settings.maxConcurrentChannels);
			if (channelIds.length === 0) {
				return;
			}
			const selected: string[] = [];
			for (let offset = 0; offset < Math.min(maxConcurrent, channelIds.length); offset++) {
				selected.push(channelIds[(this.nextChannelIndex + offset) % channelIds.length]);
			}
			this.nextChannelIndex = (this.nextChannelIndex + selected.length) % channelIds.length;
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
		const durable = await runDurableConsolidationJob(common);
		if (durable.ran) {
			return;
		}
		const growth = await runGrowthReviewJob({
			...common,
			workspaceDir: context.workspaceDir,
			workspacePath: context.workspacePath,
			loadedSkills: context.loadedSkills,
			emitNotice: this.options.emitNotice
				? async (notice) => this.options.emitNotice?.(channelId, notice)
				: undefined,
			refreshWorkspaceResources: context.refreshWorkspaceResources,
		});
		if (growth.ran) {
			return;
		}
		await runStructuralMaintenanceJob(common);
	}
}
