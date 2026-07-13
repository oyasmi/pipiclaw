import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
	PipiclawMemoryGrowthSettings,
	PipiclawMemoryMaintenanceSettings,
	PipiclawSessionMemorySettings,
} from "../settings.js";
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
	shouldRunDurableConsolidation,
	shouldRunGrowthReview,
	shouldRunSessionRefresh,
	shouldRunStructuralMaintenance,
} from "./maintenance-gates.js";
import { readMemoryMaintenanceState, updateMemoryMaintenanceState } from "./maintenance-state.js";
import { runPostTurnReview } from "./post-turn-review.js";
import { scanPromotionSignals } from "./promotion-signals.js";
import { appendMemoryReviewLog, type MemoryReviewReason } from "./review-log.js";
import { updateChannelSessionMemory } from "./session.js";
import { buildIncrementalMemorySourceWindow } from "./source-window.js";
import { sanitizeMessagesForMemory } from "./transcript.js";

export interface MaintenanceJobSettings {
	sessionMemory: PipiclawSessionMemorySettings;
	memoryGrowth: PipiclawMemoryGrowthSettings;
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
	messages: AgentMessage[];
	sessionEntries: SessionEntry[];
	queue?: ChannelMemoryQueue;
}

export interface SessionRefreshJobInput extends BaseMaintenanceJobInput {}

export interface DurableConsolidationJobInput extends BaseMaintenanceJobInput {}

export interface GrowthReviewJobInput extends BaseMaintenanceJobInput {
	workspaceDir: string;
	loadedSkills: Array<{ name: string; description?: string }>;
	emitNotice?: (notice: string) => Promise<void>;
	refreshWorkspaceResources?: () => Promise<void>;
}

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

function messageToText(message: Message): string {
	if (message.role === "user") {
		return typeof message.content === "string"
			? message.content
			: message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
	}
	if (message.role === "assistant") {
		return message.content
			.map((part) => (part.type === "text" ? part.text : ""))
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

function hasMeaningfulMessages(messages: AgentMessage[]): boolean {
	const standardMessages = sanitizeMessagesForMemory(messages);
	let userSeen = false;
	let assistantSeen = false;
	for (const message of standardMessages) {
		const text = messageToText(message).trim();
		if (!text) {
			continue;
		}
		if (message.role === "user") {
			userSeen = true;
		}
		if (message.role === "assistant") {
			assistantSeen = true;
		}
		if (userSeen && assistantSeen) {
			return true;
		}
	}
	return false;
}

function renderMessagesForSignalScan(messages: AgentMessage[]): string {
	return sanitizeMessagesForMemory(messages).map(messageToText).join("\n");
}

function makeRunOptions(input: BaseMaintenanceJobInput, usageCorrelationId?: string): ConsolidationRunOptions {
	return {
		channelId: input.channelId,
		channelDir: input.channelDir,
		model: input.model,
		resolveApiKey: input.resolveApiKey,
		messages: input.messages,
		sessionEntries: input.sessionEntries,
		usageCorrelationId,
	};
}

function backoffUntil(now: Date, settings: PipiclawMemoryMaintenanceSettings): string {
	return new Date(now.getTime() + Math.max(0, settings.failureBackoffMinutes) * 60_000).toISOString();
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
		timestamp: now.toISOString(),
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
		const latestId = latestEntryId(input.sessionEntries);
		const decision = shouldRunSessionRefresh({
			now,
			state,
			sessionMemory: input.settings.sessionMemory,
			maintenance: input.settings.memoryMaintenance,
			channelActive: input.channelActive,
			hasNewSessionEntry: latestId !== undefined && latestId !== state.lastSessionRefreshedEntryId,
			hasMeaningfulMaterial: hasMeaningfulMessages(input.messages),
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

		try {
			const correlationId = `session-refresh:${latestId ?? now.toISOString()}`;
			await updateChannelSessionMemory({
				channelId: input.channelId,
				channelDir: input.channelDir,
				messages: input.messages,
				model: input.model,
				resolveApiKey: input.resolveApiKey,
				timeoutMs: input.settings.sessionMemory.timeoutMs,
				usageCorrelationId: correlationId,
			});
			await updateMemoryMaintenanceState(input.appHomeDir, input.channelId, (current) => ({
				...current,
				lastSessionRefreshAt: now.toISOString(),
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

export async function runDurableConsolidationJob(input: DurableConsolidationJobInput): Promise<MaintenanceJobResult> {
	return runQueued(input, async () => {
		const now = input.now ?? new Date();
		const state = await readMemoryMaintenanceState(input.appHomeDir, input.channelId);
		const sourceWindow = buildIncrementalMemorySourceWindow({
			entries: input.sessionEntries,
			lastEntryId: state.lastConsolidatedEntryId,
			sourceKind: "idle",
			fallbackMessages: input.messages,
		});
		const newEntries = sourceWindow.entries;
		const latestId = latestEntryId(input.sessionEntries);
		const decision = shouldRunDurableConsolidation({
			now,
			state,
			maintenance: input.settings.memoryMaintenance,
			channelActive: input.channelActive,
			hasNewEntry: newEntries.length > 0,
			hasMeaningfulExchange: hasMeaningfulMessages(sourceWindow.messages),
			batchSize: newEntries.length,
			coveredByGrowthReview: Boolean(latestId && state.lastReviewedEntryId === latestId),
		});
		if (!decision.allowed) {
			await appendJobReviewLog(
				input.channelDir,
				input.channelId,
				"durable-consolidation-job",
				{ skipped: [{ target: "consolidation", reason: decision.skipReason }] },
				now,
			);
			return skipped(decision.jobKind, decision.skipReason ?? "skipped");
		}

		try {
			const result = await runInlineConsolidation({
				...makeRunOptions(input),
				sourceWindow,
				mode: "idle",
			});
			await updateMemoryMaintenanceState(input.appHomeDir, input.channelId, (current) => ({
				...current,
				lastDurableConsolidationAt: now.toISOString(),
				lastConsolidatedEntryId: sourceWindow.throughEntryId ?? current.lastConsolidatedEntryId,
				failureBackoffUntil: null,
			}));
			await appendJobReviewLog(
				input.channelDir,
				input.channelId,
				"durable-consolidation-job",
				result.skipped
					? {
							skipped: [{ target: "consolidation", reason: "no meaningful snapshot" }],
							correlationId: sourceWindow.windowId,
						}
					: {
							actions: [{ target: "MEMORY.md", action: "append", entries: result.appendedMemoryEntries }],
							correlationId: sourceWindow.windowId,
						},
				now,
			);
			return ran("durable-consolidation");
		} catch (error) {
			await updateMemoryMaintenanceState(input.appHomeDir, input.channelId, (current) => ({
				...current,
				failureBackoffUntil: backoffUntil(now, input.settings.memoryMaintenance),
			}));
			const result = failed("durable-consolidation", error);
			await appendJobReviewLog(
				input.channelDir,
				input.channelId,
				"durable-consolidation-job",
				{ error: result.error, skipped: [{ target: "consolidation", reason: "failed" }] },
				now,
			);
			return result;
		}
	});
}

export async function runGrowthReviewJob(input: GrowthReviewJobInput): Promise<MaintenanceJobResult> {
	return runQueued(input, async () => {
		const now = input.now ?? new Date();
		const state = await readMemoryMaintenanceState(input.appHomeDir, input.channelId);
		const sourceWindow = buildIncrementalMemorySourceWindow({
			entries: input.sessionEntries,
			lastEntryId: state.lastReviewedEntryId,
			sourceKind: "growth-review",
			fallbackMessages: input.messages,
		});
		const newEntries = sourceWindow.entries;
		const signalScan = scanPromotionSignals(renderMessagesForSignalScan(sourceWindow.messages));
		const decision = shouldRunGrowthReview({
			now,
			state,
			memoryGrowth: input.settings.memoryGrowth,
			maintenance: input.settings.memoryMaintenance,
			channelActive: input.channelActive,
			hasNewEntry: newEntries.length > 0,
			hasMeaningfulMaterial: hasMeaningfulMessages(sourceWindow.messages),
			hasPromotionSignal: signalScan.hasSignal,
		});
		if (!decision.allowed) {
			await appendJobReviewLog(
				input.channelDir,
				input.channelId,
				"growth-review-job",
				{ skipped: [{ target: "post-turn-review", reason: decision.skipReason }] },
				now,
			);
			return skipped(decision.jobKind, decision.skipReason ?? "skipped");
		}

		try {
			const notices: string[] = [];
			const result = await runPostTurnReview({
				channelId: input.channelId,
				channelDir: input.channelDir,
				workspaceDir: input.workspaceDir,
				messages: sourceWindow.messages,
				sourceEntryIds: sourceWindow.entries.map((entry) => entry.id),
				suppressAutomaticWrites: sourceWindow.hasExternalToolContent,
				model: input.model,
				resolveApiKey: input.resolveApiKey,
				timeoutMs: input.settings.sessionMemory.timeoutMs,
				autoWriteChannelMemory: input.settings.memoryGrowth.autoWriteChannelMemory,
				autoWriteWorkspaceSkills: input.settings.memoryGrowth.autoWriteWorkspaceSkills,
				minMemoryAutoWriteConfidence: input.settings.memoryGrowth.minMemoryAutoWriteConfidence,
				minSkillAutoWriteConfidence: input.settings.memoryGrowth.minSkillAutoWriteConfidence,
				loadedSkills: input.loadedSkills,
				correlationId: sourceWindow.windowId,
				emitNotice: async (notice) => {
					notices.push(notice);
				},
				refreshWorkspaceResources: input.refreshWorkspaceResources,
			});
			if (result.status === "failed") {
				throw new Error(`Growth review failed: ${result.error}. Retry this memory window after backoff.`);
			}
			const appliedResult = result.result;
			await updateMemoryMaintenanceState(input.appHomeDir, input.channelId, (current) => ({
				...current,
				lastGrowthReviewAt: now.toISOString(),
				turnsSinceGrowthReview: 0,
				toolCallsSinceGrowthReview: 0,
				lastReviewedEntryId: sourceWindow.throughEntryId ?? current.lastReviewedEntryId,
				failureBackoffUntil: null,
			}));
			if (notices.length > 0) {
				const uniqueNotices = Array.from(new Set(notices));
				await input.emitNotice?.(uniqueNotices.join("\n"));
			}
			await appendJobReviewLog(
				input.channelDir,
				input.channelId,
				"growth-review-job",
				{
					actions: appliedResult.actions,
					skipped: appliedResult.skipped,
					correlationId: sourceWindow.windowId,
				},
				now,
			);
			return ran("growth-review");
		} catch (error) {
			await updateMemoryMaintenanceState(input.appHomeDir, input.channelId, (current) => ({
				...current,
				failureBackoffUntil: backoffUntil(now, input.settings.memoryMaintenance),
			}));
			const result = failed("growth-review", error);
			await appendJobReviewLog(
				input.channelDir,
				input.channelId,
				"growth-review-job",
				{ error: result.error, skipped: [{ target: "post-turn-review", reason: "failed" }] },
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
		const [currentMemory, currentHistory] = await Promise.all([
			readChannelMemory(input.channelDir),
			readChannelHistory(input.channelDir),
		]);
		const stats = getStructuralMaintenanceStats(currentMemory, currentHistory);
		const decision = shouldRunStructuralMaintenance({
			now,
			state,
			maintenance: input.settings.memoryMaintenance,
			channelActive: input.channelActive,
			...stats,
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
			const correlationId = `structural-maintenance:${now.toISOString()}`;
			const options = makeRunOptions(input, correlationId);
			const cleanedMemory = decision.runMemoryCleanup
				? await cleanupChannelMemory(options, currentMemory, {
						cleanupShrinkGuardMinRatio: input.settings.memoryMaintenance.cleanupShrinkGuardMinRatio,
						cleanupShrinkGuardMinChars: input.settings.memoryMaintenance.cleanupShrinkGuardMinChars,
					})
				: false;
			const foldedHistory = decision.runHistoryFolding ? await foldChannelHistory(options, currentHistory) : false;
			await updateMemoryMaintenanceState(input.appHomeDir, input.channelId, (current) => ({
				...current,
				lastStructuralMaintenanceAt: now.toISOString(),
				failureBackoffUntil: null,
			}));
			await appendJobReviewLog(
				input.channelDir,
				input.channelId,
				"structural-maintenance-job",
				{
					correlationId,
					actions: [
						...(cleanedMemory ? [{ target: "MEMORY.md", action: "rewrite" }] : []),
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
