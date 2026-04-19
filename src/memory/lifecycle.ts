import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type {
	ExtensionFactory,
	SessionBeforeCompactEvent,
	SessionBeforeSwitchEvent,
	SessionCompactEvent,
	SessionEntry,
	SessionSwitchEvent,
} from "@mariozechner/pi-coding-agent";
import * as log from "../log.js";
import type { PipiclawMemoryGrowthSettings, PipiclawSessionMemorySettings } from "../settings.js";
import {
	type BackgroundMaintenanceResult,
	type ConsolidationRunOptions,
	type InlineConsolidationResult,
	runBackgroundMaintenance,
	runInlineConsolidation,
} from "./consolidation.js";
import { runPostTurnReview } from "./post-turn-review.js";
import { appendMemoryReviewLog } from "./review-log.js";
import { updateChannelSessionMemory } from "./session.js";

const IDLE_CONSOLIDATION_DELAY_MS = 60_000;

export type ConsolidationReason = "compaction" | "new-session" | "idle" | "shutdown";

export interface MemoryLifecycleOptions {
	channelId: string;
	channelDir: string;
	getMessages: () => AgentMessage[];
	getSessionEntries: () => SessionEntry[];
	getModel: () => Model<Api>;
	resolveApiKey: (model: Model<Api>) => Promise<string>;
	getSessionMemorySettings: () => PipiclawSessionMemorySettings;
	getMemoryGrowthSettings?: () => PipiclawMemoryGrowthSettings;
	getWorkspaceDir?: () => string;
	getWorkspacePath?: () => string;
	getLoadedSkills?: () => Array<{ name: string; description?: string }>;
	emitNotice?: (notice: string) => Promise<void>;
	refreshWorkspaceResources?: () => Promise<void>;
}

interface SessionMemoryRefreshRequest {
	reason: "threshold" | Exclude<ConsolidationReason, "idle">;
	messages?: AgentMessage[];
}

export class MemoryLifecycle {
	private durableMemoryQueue: Promise<void> = Promise.resolve();
	private sessionRefreshQueue: Promise<void> = Promise.resolve();
	private turnsSinceSessionUpdate = 0;
	private toolCallsSinceSessionUpdate = 0;
	private thresholdFailureBackoffTurnsRemaining = 0;
	private thresholdRefreshQueued = false;
	private sessionRefreshRunning = false;
	private durableDirty = false;
	private durableRevision = 0;
	private lastAssistantTurnRevision = 0;
	private lastDurableConsolidationRevision = 0;
	private idleConsolidationTimer: ReturnType<typeof setTimeout> | null = null;
	private idleConsolidationQueued = false;
	private postTurnReviewQueued = false;
	private postTurnReviewHadActions = false;
	private turnsSinceLastReview = 0;
	private toolCallsSinceLastReview = 0;

	constructor(private options: MemoryLifecycleOptions) {}

	private buildRunOptions(messages?: AgentMessage[], sessionEntries?: SessionEntry[]): ConsolidationRunOptions {
		return {
			channelDir: this.options.channelDir,
			model: this.options.getModel(),
			resolveApiKey: this.options.resolveApiKey,
			messages: messages ?? this.options.getMessages(),
			sessionEntries: sessionEntries ?? this.options.getSessionEntries(),
		};
	}

	createExtensionFactory(): ExtensionFactory {
		return (pi) => {
			pi.on("session_before_compact", async (event: SessionBeforeCompactEvent) => {
				await this.handleSessionBeforeCompact(event);
			});
			pi.on("session_compact", async (event: SessionCompactEvent) => {
				this.handleSessionCompact(event);
			});
			pi.on("session_before_switch", async (event: SessionBeforeSwitchEvent) => {
				await this.handleSessionBeforeSwitch(event);
			});
			pi.on("session_switch", async (event: SessionSwitchEvent) => {
				this.handleSessionSwitch(event);
			});
		};
	}

	noteUserTurnStarted(): void {
		this.clearIdleConsolidationTimer();
	}

	noteToolCall(): void {
		this.durableDirty = true;
		this.durableRevision++;
		this.toolCallsSinceSessionUpdate++;
		this.toolCallsSinceLastReview++;
		this.clearIdleConsolidationTimer();
	}

	noteCompletedAssistantTurn(): void {
		this.durableDirty = true;
		this.durableRevision++;
		this.lastAssistantTurnRevision = this.durableRevision;
		this.turnsSinceLastReview++;

		const settings = this.options.getSessionMemorySettings();
		if (settings.enabled) {
			this.turnsSinceSessionUpdate++;
			let canTriggerThresholdRefresh = true;
			if (this.thresholdFailureBackoffTurnsRemaining > 0) {
				this.thresholdFailureBackoffTurnsRemaining--;
				canTriggerThresholdRefresh = this.thresholdFailureBackoffTurnsRemaining === 0;
			}
			if (
				canTriggerThresholdRefresh &&
				(this.turnsSinceSessionUpdate >= settings.minTurnsBetweenUpdate ||
					this.toolCallsSinceSessionUpdate >= settings.minToolCallsBetweenUpdate)
			) {
				this.requestThresholdSessionRefresh();
			}
		}

		this.scheduleIdleConsolidation();
		this.schedulePostTurnReviewIfDue();
	}

	async flushForShutdown(): Promise<void> {
		this.clearIdleConsolidationTimer();
		await this.runDurableMemoryJobSerial(async () => {
			if (!this.hasPendingAssistantSnapshot()) {
				return;
			}
			const messageSnapshot = [...this.options.getMessages()];
			const sessionEntrySnapshot = [...this.options.getSessionEntries()];
			const revisionSnapshot = this.durableRevision;
			const settings = this.options.getSessionMemorySettings();
			await this.runPreflightConsolidationNow(
				"shutdown",
				messageSnapshot,
				sessionEntrySnapshot,
				revisionSnapshot,
				settings,
			);
		});
	}

	private clearIdleConsolidationTimer(): void {
		if (!this.idleConsolidationTimer) {
			return;
		}
		clearTimeout(this.idleConsolidationTimer);
		this.idleConsolidationTimer = null;
	}

	private shouldForceRefreshFor(
		reason: Exclude<ConsolidationReason, "idle">,
		settings: PipiclawSessionMemorySettings,
	): boolean {
		if (!settings.enabled) {
			return false;
		}
		if (reason === "compaction") {
			return settings.forceRefreshBeforeCompact;
		}
		if (reason === "new-session") {
			return settings.forceRefreshBeforeNewSession;
		}
		return false;
	}

	private async refreshSessionMemory(request: SessionMemoryRefreshRequest): Promise<boolean> {
		const settings = this.options.getSessionMemorySettings();
		if (!settings.enabled) {
			return false;
		}

		const { reason } = request;
		this.sessionRefreshRunning = true;
		try {
			await updateChannelSessionMemory({
				channelDir: this.options.channelDir,
				messages: request.messages ?? this.options.getMessages(),
				model: this.options.getModel(),
				resolveApiKey: this.options.resolveApiKey,
				timeoutMs: settings.timeoutMs,
			});
			this.turnsSinceSessionUpdate = 0;
			this.toolCallsSinceSessionUpdate = 0;
			this.thresholdFailureBackoffTurnsRemaining = 0;
			log.logInfo(`[${this.options.channelId}] Session memory updated (${reason})`);
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (reason === "threshold") {
				this.thresholdFailureBackoffTurnsRemaining = Math.max(0, settings.failureBackoffTurns);
			}
			log.logWarning(`[${this.options.channelId}] Session memory update failed (${reason})`, message);
			return false;
		} finally {
			this.sessionRefreshRunning = false;
		}
	}

	private runSessionRefreshSerial(request: SessionMemoryRefreshRequest): Promise<boolean> {
		const run = async (): Promise<boolean> => this.refreshSessionMemory(request);
		const resultPromise = this.sessionRefreshQueue.then(run, run);
		this.sessionRefreshQueue = resultPromise.then(
			() => undefined,
			() => undefined,
		);
		return resultPromise;
	}

	private requestThresholdSessionRefresh(): void {
		if (this.thresholdRefreshQueued || this.sessionRefreshRunning) {
			return;
		}

		this.thresholdRefreshQueued = true;
		void this.runSessionRefreshSerial({ reason: "threshold" }).finally(() => {
			this.thresholdRefreshQueued = false;
		});
	}

	private runDurableMemoryJobSerial<T>(job: () => Promise<T>): Promise<T> {
		const resultPromise = this.durableMemoryQueue.then(job, job);
		this.durableMemoryQueue = resultPromise.then(
			() => undefined,
			() => undefined,
		);
		return resultPromise;
	}

	private enqueueDurableMemoryJob(job: () => Promise<void>, failureMessage: string): void {
		void this.runDurableMemoryJobSerial(job).catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			log.logWarning(failureMessage, message);
		});
	}

	private hasPendingAssistantSnapshot(): boolean {
		return this.durableDirty && this.lastAssistantTurnRevision > this.lastDurableConsolidationRevision;
	}

	private markDurableConsolidationCheckpoint(revision: number): void {
		this.lastDurableConsolidationRevision = Math.max(this.lastDurableConsolidationRevision, revision);
		this.durableDirty = this.durableRevision > this.lastDurableConsolidationRevision;
	}

	private logConsolidationResult(reason: ConsolidationReason, result: InlineConsolidationResult): void {
		if (result.skipped) {
			log.logInfo(`[${this.options.channelId}] Memory consolidation skipped (${reason}): no meaningful snapshot`);
			return;
		}

		log.logInfo(
			`[${this.options.channelId}] Memory consolidation finished (${reason}): memory entries=${result.appendedMemoryEntries}, history=${result.appendedHistoryBlock ? "yes" : "no"}`,
		);
	}

	private async appendReviewLog(entry: {
		reason: ConsolidationReason;
		actions?: unknown[];
		skipped?: unknown[];
		error?: string;
	}): Promise<void> {
		try {
			await appendMemoryReviewLog(this.options.channelDir, {
				timestamp: new Date().toISOString(),
				channelId: this.options.channelId,
				...entry,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.logWarning(`[${this.options.channelId}] Failed to write memory review log`, message);
		}
	}

	private async recordConsolidationReview(
		reason: ConsolidationReason,
		result: InlineConsolidationResult,
	): Promise<void> {
		if (result.skipped) {
			await this.appendReviewLog({
				reason,
				skipped: [{ target: "consolidation", reason: "no meaningful snapshot" }],
			});
			return;
		}

		const actions: unknown[] = [];
		const skipped: unknown[] = [];
		if (result.appendedMemoryEntries > 0) {
			actions.push({ target: "MEMORY.md", action: "append", entries: result.appendedMemoryEntries });
		}
		if (result.appendedHistoryBlock) {
			actions.push({ target: "HISTORY.md", action: "append" });
		} else if (reason === "idle") {
			skipped.push({ target: "HISTORY.md", reason: "idle does not write HISTORY.md" });
		}

		await this.appendReviewLog({ reason, actions, skipped });
	}

	private scheduleIdleConsolidation(): void {
		this.clearIdleConsolidationTimer();
		if (!this.hasPendingAssistantSnapshot() || this.idleConsolidationQueued) {
			return;
		}

		this.idleConsolidationTimer = setTimeout(() => {
			this.idleConsolidationTimer = null;
			if (!this.hasPendingAssistantSnapshot() || this.idleConsolidationQueued) {
				return;
			}

			this.idleConsolidationQueued = true;
			const messageSnapshot = [...this.options.getMessages()];
			const sessionEntrySnapshot = [...this.options.getSessionEntries()];
			const revisionSnapshot = this.durableRevision;
			const skipMemoryExtraction = this.postTurnReviewHadActions;
			this.enqueueDurableMemoryJob(async () => {
				try {
					if (skipMemoryExtraction) {
						log.logInfo(
							`[${this.options.channelId}] Idle consolidation skipping memory extraction (post-turn review already applied)`,
						);
						this.markDurableConsolidationCheckpoint(revisionSnapshot);
						await this.recordConsolidationReview("idle", {
							skipped: true,
							appendedMemoryEntries: 0,
							appendedHistoryBlock: false,
						});
					} else {
						log.logInfo(`[${this.options.channelId}] Memory consolidation starting (idle)`);
						const result = await runInlineConsolidation({
							...this.buildRunOptions(messageSnapshot, sessionEntrySnapshot),
							mode: "idle",
						});
						this.markDurableConsolidationCheckpoint(revisionSnapshot);
						this.logConsolidationResult("idle", result);
						await this.recordConsolidationReview("idle", result);
					}
					const maintenance = await runBackgroundMaintenance(
						this.buildRunOptions(messageSnapshot, sessionEntrySnapshot),
					);
					this.logBackgroundResult(maintenance);
					this.postTurnReviewHadActions = false;
				} finally {
					this.idleConsolidationQueued = false;
					if (this.durableDirty) {
						this.scheduleIdleConsolidation();
					}
				}
			}, `[${this.options.channelId}] Memory consolidation failed (idle)`);
		}, IDLE_CONSOLIDATION_DELAY_MS);
	}

	private canRunPostTurnReview(): boolean {
		const growthSettings = this.options.getMemoryGrowthSettings?.();
		return Boolean(
			growthSettings?.postTurnReviewEnabled &&
				this.options.getWorkspaceDir &&
				this.options.getWorkspacePath &&
				this.options.getLoadedSkills,
		);
	}

	private schedulePostTurnReviewIfDue(): void {
		if (!this.canRunPostTurnReview() || this.postTurnReviewQueued) {
			return;
		}
		const growthSettings = this.options.getMemoryGrowthSettings?.();
		if (!growthSettings) {
			return;
		}
		if (
			this.turnsSinceLastReview < growthSettings.minTurnsBetweenReview &&
			this.toolCallsSinceLastReview < growthSettings.minToolCallsBetweenReview
		) {
			return;
		}

		this.postTurnReviewQueued = true;
		this.turnsSinceLastReview = 0;
		this.toolCallsSinceLastReview = 0;
		const messageSnapshot = [...this.options.getMessages()];
		this.enqueueDurableMemoryJob(async () => {
			try {
				const currentGrowthSettings = this.options.getMemoryGrowthSettings?.();
				const workspaceDir = this.options.getWorkspaceDir?.();
				const workspacePath = this.options.getWorkspacePath?.();
				if (!currentGrowthSettings?.postTurnReviewEnabled || !workspaceDir || !workspacePath) {
					return;
				}
				const result = await runPostTurnReview({
					channelId: this.options.channelId,
					channelDir: this.options.channelDir,
					workspaceDir,
					workspacePath,
					messages: messageSnapshot,
					model: this.options.getModel(),
					resolveApiKey: this.options.resolveApiKey,
					timeoutMs: this.options.getSessionMemorySettings().timeoutMs,
					autoWriteChannelMemory: currentGrowthSettings.autoWriteChannelMemory,
					autoWriteWorkspaceSkills: currentGrowthSettings.autoWriteWorkspaceSkills,
					minMemoryAutoWriteConfidence: currentGrowthSettings.minMemoryAutoWriteConfidence,
					minSkillAutoWriteConfidence: currentGrowthSettings.minSkillAutoWriteConfidence,
					loadedSkills: this.options.getLoadedSkills?.() ?? [],
					emitNotice: this.options.emitNotice,
					refreshWorkspaceResources: this.options.refreshWorkspaceResources,
				});
				if (result.actions.length > 0) {
					this.postTurnReviewHadActions = true;
				}
				if (result.actions.length > 0 || result.suggestions.length > 0 || result.skipped.length > 0) {
					log.logInfo(
						`[${this.options.channelId}] Post-turn memory review complete: actions=${result.actions.length}, suggestions=${result.suggestions.length}, skipped=${result.skipped.length}`,
					);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log.logWarning(`[${this.options.channelId}] Post-turn memory review failed`, message);
			} finally {
				this.postTurnReviewQueued = false;
			}
		}, `[${this.options.channelId}] Post-turn memory review failed`);
	}

	private async runPreflightConsolidation(
		reason: Exclude<ConsolidationReason, "idle">,
		messages?: AgentMessage[],
		sessionEntries?: SessionEntry[],
	): Promise<void> {
		this.clearIdleConsolidationTimer();
		const messageSnapshot = [...(messages ?? this.options.getMessages())];
		const sessionEntrySnapshot = sessionEntries ? [...sessionEntries] : [...this.options.getSessionEntries()];
		const revisionSnapshot = this.durableRevision;
		const settings = this.options.getSessionMemorySettings();

		await this.runDurableMemoryJobSerial(async () => {
			await this.runPreflightConsolidationNow(
				reason,
				messageSnapshot,
				sessionEntrySnapshot,
				revisionSnapshot,
				settings,
			);
		});
	}

	private async runPreflightConsolidationNow(
		reason: Exclude<ConsolidationReason, "idle">,
		messageSnapshot: AgentMessage[],
		sessionEntrySnapshot?: SessionEntry[],
		revisionSnapshot: number = this.durableRevision,
		settings: PipiclawSessionMemorySettings = this.options.getSessionMemorySettings(),
	): Promise<void> {
		if (this.shouldForceRefreshFor(reason, settings)) {
			await this.runSessionRefreshSerial({
				reason,
				messages: messageSnapshot,
			});
		}

		try {
			log.logInfo(`[${this.options.channelId}] Memory consolidation starting (${reason})`);
			const result = await runInlineConsolidation({
				...this.buildRunOptions(messageSnapshot, sessionEntrySnapshot),
				mode: "boundary",
			});
			this.markDurableConsolidationCheckpoint(revisionSnapshot);
			this.logConsolidationResult(reason, result);
			await this.recordConsolidationReview(reason, result);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.logWarning(`[${this.options.channelId}] Memory consolidation failed (${reason})`, message);
			await this.appendReviewLog({
				reason,
				error: message,
				skipped: [{ target: "consolidation", reason: "failed" }],
			});
		}
	}

	private async handleSessionBeforeCompact(event: SessionBeforeCompactEvent): Promise<void> {
		await this.runPreflightConsolidation("compaction", event.preparation.messagesToSummarize);
	}

	private handleSessionCompact(_event: SessionCompactEvent): void {
		this.enqueueBackgroundMaintenance();
	}

	private async handleSessionBeforeSwitch(event: SessionBeforeSwitchEvent): Promise<void> {
		if (event.reason !== "new") {
			return;
		}

		await this.runPreflightConsolidation("new-session");
	}

	private handleSessionSwitch(event: SessionSwitchEvent): void {
		if (event.reason !== "new") {
			return;
		}

		this.enqueueBackgroundMaintenance();
	}

	private enqueueBackgroundMaintenance(): void {
		this.enqueueDurableMemoryJob(async () => {
			const result = await runBackgroundMaintenance(this.buildRunOptions([], []));
			this.logBackgroundResult(result);
		}, `[${this.options.channelId}] Background memory maintenance failed`);
	}

	private logBackgroundResult(result: BackgroundMaintenanceResult): void {
		if (!result.cleanedMemory && !result.foldedHistory) {
			return;
		}

		const details = [
			`memory cleanup=${result.cleanedMemory ? "yes" : "no"}`,
			`history fold=${result.foldedHistory ? "yes" : "no"}`,
		].join(", ");
		log.logInfo(`[${this.options.channelId}] Background memory maintenance complete: ${details}`);
	}
}
