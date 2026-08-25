import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { PipiclawMemoryMaintenanceSettings, PipiclawSessionMemorySettings } from "../settings.js";
import { formatLocalTime } from "../shared/local-time.js";
import { errorMessage } from "../shared/text-utils.js";
import { type ChannelMemoryQueue, getDefaultChannelMemoryQueue } from "./channel-maintenance-queue.js";
import {
	type ConsolidationRunOptions,
	cleanupChannelMemory,
	foldChannelHistory,
	getStructuralMaintenanceStats,
	runInlineConsolidation,
} from "./consolidation.js";
import { readChannelHistory, readChannelMemory } from "./files.js";
import {
	type MaintenanceJobKind,
	shouldRunMemoryCheckpoint,
	shouldRunSessionRefresh,
	shouldRunStructuralMaintenance,
} from "./maintenance-gates.js";
import { readMemoryMaintenanceState, updateMemoryMaintenanceState } from "./maintenance-state.js";
import { readMemoryMetadata } from "./metadata.js";
import { collectExpiredEntryIds, expireMemoryEntries } from "./probation.js";
import { appendMemoryReviewLog, type MemoryReviewReason } from "./review-log.js";
import { updateChannelSessionMemory } from "./session.js";
import { buildIncrementalMemorySourceWindow } from "./source-window.js";
import { hasMeaningfulExchange, sanitizeMessagesForMemory } from "./transcript.js";

export interface MaintenanceJobSettings {
	sessionMemory: PipiclawSessionMemorySettings;
	memoryMaintenance: PipiclawMemoryMaintenanceSettings;
}

interface BaseMaintenanceJobInput {
	appHomeDir: string;
	channelId: string;
	channelDir: string;
	channelActive: boolean;
	now?: Date;
	settings: MaintenanceJobSettings;
	model: Model<Api>;
	resolveApiKey: (model: Model<Api>) => Promise<string>;
	/** Transcript accessors: only called once a gate has decided the job may actually run. */
	messages: () => AgentMessage[];
	sessionEntries: () => SessionEntry[];
	queue?: ChannelMemoryQueue;
}

/** Evaluate `load` at most once, so a gate and the job body can share one expensive read. */
function once<T>(load: () => T): () => T {
	let cached: { value: T } | undefined;
	return () => {
		cached ??= { value: load() };
		return cached.value;
	};
}

export interface SessionRefreshJobInput extends BaseMaintenanceJobInput {}

export interface MemoryCheckpointJobInput extends BaseMaintenanceJobInput {}

export interface StructuralMaintenanceJobInput extends BaseMaintenanceJobInput {}

export interface MaintenanceJobResult {
	jobKind: MaintenanceJobKind;
	ran: boolean;
	skipped: boolean;
	skipReason?: string;
	error?: string;
}

function latestEntryId(entries: SessionEntry[]): string | undefined {
	return entries.at(-1)?.id;
}

function hasMeaningfulMessages(messages: AgentMessage[]): boolean {
	return hasMeaningfulExchange(sanitizeMessagesForMemory(messages));
}

function makeRunOptions(input: BaseMaintenanceJobInput, usageCorrelationId?: string): ConsolidationRunOptions {
	return {
		channelId: input.channelId,
		channelDir: input.channelDir,
		model: input.model,
		resolveApiKey: input.resolveApiKey,
		messages: input.messages(),
		sessionEntries: input.sessionEntries(),
		usageCorrelationId,
		minAutoWriteConfidence: input.settings.memoryMaintenance.minMemoryAutoWriteConfidence,
	};
}

function backoffUntil(now: Date, settings: PipiclawMemoryMaintenanceSettings): string {
	return formatLocalTime(new Date(now.getTime() + Math.max(0, settings.failureBackoffMinutes) * 60_000));
}

async function appendJobReviewLog(
	channelDir: string,
	channelId: string,
	reason: MemoryReviewReason,
	entry: {
		skipped?: unknown[];
		actions?: unknown[];
		error?: string;
		correlationId?: string;
	},
	now: Date,
): Promise<void> {
	await appendMemoryReviewLog(channelDir, {
		timestamp: formatLocalTime(now),
		channelId,
		reason,
		...entry,
	});
}

function skipped(jobKind: MaintenanceJobKind, skipReason: string): MaintenanceJobResult {
	return { jobKind, ran: false, skipped: true, skipReason };
}

function ran(jobKind: MaintenanceJobKind): MaintenanceJobResult {
	return { jobKind, ran: true, skipped: false };
}

function failed(jobKind: MaintenanceJobKind, error: unknown): MaintenanceJobResult {
	return {
		jobKind,
		ran: false,
		skipped: false,
		error: errorMessage(error),
	};
}

async function runQueued<T>(input: BaseMaintenanceJobInput, job: () => Promise<T>): Promise<T> {
	return (input.queue ?? getDefaultChannelMemoryQueue()).run(input.channelId, job);
}

export async function runSessionRefreshJob(input: SessionRefreshJobInput): Promise<MaintenanceJobResult> {
	return runQueued(input, async () => {
		const now = input.now ?? new Date();
		const state = await readMemoryMaintenanceState(input.appHomeDir, input.channelId);
		const messages = once(input.messages);
		const latestEntry = once(() => latestEntryId(input.sessionEntries()));
		const decision = shouldRunSessionRefresh({
			now,
			state,
			sessionMemory: input.settings.sessionMemory,
			maintenance: input.settings.memoryMaintenance,
			channelActive: input.channelActive,
			hasNewSessionEntry: () => latestEntry() !== undefined && latestEntry() !== state.lastSessionRefreshedEntryId,
			hasMeaningfulMaterial: () => hasMeaningfulMessages(messages()),
		});
		if (!decision.allowed) {
			await appendJobReviewLog(
				input.channelDir,
				input.channelId,
				"session-refresh-job",
				{ skipped: [{ target: "SESSION.md", reason: decision.skipReason }] },
				now,
			);
			return skipped(decision.jobKind, decision.skipReason ?? "skipped");
		}

		const latestId = latestEntry();
		try {
			const correlationId = `session-refresh:${latestId ?? formatLocalTime(now)}`;
			await updateChannelSessionMemory({
				channelId: input.channelId,
				channelDir: input.channelDir,
				messages: messages(),
				model: input.model,
				resolveApiKey: input.resolveApiKey,
				timeoutMs: input.settings.sessionMemory.timeoutMs,
				usageCorrelationId: correlationId,
			});
			await updateMemoryMaintenanceState(input.appHomeDir, input.channelId, (current) => ({
				...current,
				lastSessionRefreshAt: formatLocalTime(now),
				turnsSinceSessionRefresh: 0,
				toolCallsSinceSessionRefresh: 0,
				lastSessionRefreshedEntryId: latestId ?? current.lastSessionRefreshedEntryId,
				lastSessionEntryId: latestId ?? current.lastSessionEntryId,
				failureBackoffUntil: null,
			}));
			await appendJobReviewLog(
				input.channelDir,
				input.channelId,
				"session-refresh-job",
				{ actions: [{ target: "SESSION.md", action: "rewrite" }], correlationId },
				now,
			);
			return ran("session-refresh");
		} catch (error) {
			await updateMemoryMaintenanceState(input.appHomeDir, input.channelId, (current) => ({
				...current,
				failureBackoffUntil: backoffUntil(now, input.settings.memoryMaintenance),
			}));
			const result = failed("session-refresh", error);
			await appendJobReviewLog(
				input.channelDir,
				input.channelId,
				"session-refresh-job",
				{ error: result.error, skipped: [{ target: "SESSION.md", reason: "failed" }] },
				now,
			);
			return result;
		}
	});
}

export async function runMemoryCheckpointJob(input: MemoryCheckpointJobInput): Promise<MaintenanceJobResult> {
	return runQueued(input, async () => {
		const now = input.now ?? new Date();
		const state = await readMemoryMaintenanceState(input.appHomeDir, input.channelId);
		const loadSourceWindow = once(() =>
			buildIncrementalMemorySourceWindow({
				entries: input.sessionEntries(),
				lastEntryId: state.lastCheckpointEntryId,
				sourceKind: "idle",
				fallbackMessages: input.messages(),
			}),
		);
		const decision = shouldRunMemoryCheckpoint({
			now,
			state,
			maintenance: input.settings.memoryMaintenance,
			channelActive: input.channelActive,
			material: () => {
				const window = loadSourceWindow();
				return {
					hasNewEntry: window.entries.length > 0,
					hasMeaningfulExchange: hasMeaningfulMessages(window.messages),
					batchSize: window.entries.length,
				};
			},
		});
		if (!decision.allowed) {
			await appendJobReviewLog(
				input.channelDir,
				input.channelId,
				"memory-checkpoint-job",
				{ skipped: [{ target: "consolidation", reason: decision.skipReason }] },
				now,
			);
			return skipped(decision.jobKind, decision.skipReason ?? "skipped");
		}

		const sourceWindow = loadSourceWindow();
		try {
			const result = await runInlineConsolidation({
				...makeRunOptions(input),
				sourceWindow,
				mode: "idle",
			});
			await updateMemoryMaintenanceState(input.appHomeDir, input.channelId, (current) => ({
				...current,
				lastCheckpointAt: formatLocalTime(now),
				lastCheckpointEntryId: sourceWindow.throughEntryId ?? current.lastCheckpointEntryId,
				failureBackoffUntil: null,
			}));
			await appendJobReviewLog(
				input.channelDir,
				input.channelId,
				"memory-checkpoint-job",
				result.skipped
					? {
							skipped: [{ target: "consolidation", reason: "no meaningful snapshot" }],
							correlationId: sourceWindow.windowId,
						}
					: {
							actions: [
								{
									target: "MEMORY.md",
									action: "append",
									entries: result.appendedMemoryEntries,
									durableCandidates: result.appendedDurableEntries,
									probationaryCandidates: result.appendedProbationaryEntries,
								},
							],
							skipped: (result.rejectedMemoryOps ?? []).map((candidate) => ({
								target: "MEMORY.md",
								candidate,
								reason: "below auto-write confidence",
							})),
							correlationId: sourceWindow.windowId,
						},
				now,
			);
			return ran("memory-checkpoint");
		} catch (error) {
			await updateMemoryMaintenanceState(input.appHomeDir, input.channelId, (current) => ({
				...current,
				failureBackoffUntil: backoffUntil(now, input.settings.memoryMaintenance),
			}));
			const result = failed("memory-checkpoint", error);
			await appendJobReviewLog(
				input.channelDir,
				input.channelId,
				"memory-checkpoint-job",
				{ error: result.error, skipped: [{ target: "consolidation", reason: "failed" }] },
				now,
			);
			return result;
		}
	});
}

export async function runStructuralMaintenanceJob(input: StructuralMaintenanceJobInput): Promise<MaintenanceJobResult> {
	return runQueued(input, async () => {
		const now = input.now ?? new Date();
		const state = await readMemoryMaintenanceState(input.appHomeDir, input.channelId);
		const loadFiles = once(() =>
			Promise.all([readChannelMemory(input.channelDir), readChannelHistory(input.channelDir)]),
		);
		const loadExpiredCount = once(async () => {
			const metadata = await readMemoryMetadata(input.channelDir);
			return collectExpiredEntryIds(metadata, now).length;
		});
		const decision = await shouldRunStructuralMaintenance({
			now,
			state,
			maintenance: input.settings.memoryMaintenance,
			channelActive: input.channelActive,
			material: async () => ({
				...getStructuralMaintenanceStats(...(await loadFiles())),
				expiredEntryCount: await loadExpiredCount(),
			}),
		});
		if (!decision.allowed) {
			await appendJobReviewLog(
				input.channelDir,
				input.channelId,
				"structural-maintenance-job",
				{ skipped: [{ target: "structural-maintenance", reason: decision.skipReason }] },
				now,
			);
			return skipped(decision.jobKind, decision.skipReason ?? "skipped");
		}

		try {
			const correlationId = `structural-maintenance:${formatLocalTime(now)}`;
			const options = makeRunOptions(input, correlationId);
			// Probation eviction runs first, deterministically, before the LLM cleanup pass sees the
			// file — no point spending a cleanup prompt on entries about to be invalidated (spec 037, D8).
			const expiredCount = decision.runProbationExpiry ? await expireMemoryEntries(input.channelDir, now) : 0;
			const [cachedMemory, currentHistory] = await loadFiles();
			// `loadFiles`'s cached read predates the expiry write above, so a fresh read is needed
			// whenever expiry actually changed the file; otherwise the cache is still accurate.
			const currentMemory = expiredCount > 0 ? await readChannelMemory(input.channelDir) : cachedMemory;
			const cleanup = decision.runMemoryCleanup
				? await cleanupChannelMemory(options, currentMemory, {
						cleanupShrinkGuardMinRatio: input.settings.memoryMaintenance.cleanupShrinkGuardMinRatio,
						cleanupShrinkGuardMinChars: input.settings.memoryMaintenance.cleanupShrinkGuardMinChars,
					})
				: null;
			const foldedHistory = decision.runHistoryFolding ? await foldChannelHistory(options, currentHistory) : false;
			await updateMemoryMaintenanceState(input.appHomeDir, input.channelId, (current) => ({
				...current,
				lastStructuralMaintenanceAt: formatLocalTime(now),
				failureBackoffUntil: null,
			}));
			await appendJobReviewLog(
				input.channelDir,
				input.channelId,
				"structural-maintenance-job",
				{
					correlationId,
					actions: [
						...(expiredCount > 0 ? [{ target: "MEMORY.md", action: "expire", entries: expiredCount }] : []),
						...(cleanup?.rewritten
							? [{ target: "MEMORY.md", action: "rewrite", droppedEntryIds: cleanup.droppedEntryIds }]
							: []),
						...(foldedHistory ? [{ target: "HISTORY.md", action: "rewrite" }] : []),
					],
				},
				now,
			);
			return ran("structural-maintenance");
		} catch (error) {
			await updateMemoryMaintenanceState(input.appHomeDir, input.channelId, (current) => ({
				...current,
				failureBackoffUntil: backoffUntil(now, input.settings.memoryMaintenance),
			}));
			const result = failed("structural-maintenance", error);
			await appendJobReviewLog(
				input.channelDir,
				input.channelId,
				"structural-maintenance-job",
				{ error: result.error, skipped: [{ target: "structural-maintenance", reason: "failed" }] },
				now,
			);
			return result;
		}
	});
}
