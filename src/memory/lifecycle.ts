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
import type { PipiclawSessionMemorySettings } from "../context.js";
import * as log from "../log.js";
import {
	type BackgroundMaintenanceResult,
	type ConsolidationRunOptions,
	type InlineConsolidationResult,
	runBackgroundMaintenance,
	runInlineConsolidation,
} from "./consolidation.js";
import { updateChannelSessionMemory } from "./session.js";

const IDLE_CONSOLIDATION_DELAY_MS = 60_000;

export type ConsolidationReason = "compaction" | "new-session" | "idle";

export interface MemoryLifecycleOptions {
	channelId: string;
	channelDir: string;
	getMessages: () => AgentMessage[];
	getSessionEntries: () => SessionEntry[];
	getModel: () => Model<Api>;
	resolveApiKey: (model: Model<Api>) => Promise<string>;
	getSessionMemorySettings: () => PipiclawSessionMemorySettings;
}

interface SessionMemoryRefreshRequest {
	reason: "threshold" | Exclude<ConsolidationReason, "idle">;
	messages?: AgentMessage[];
}

export class MemoryLifecycle {
	private backgroundQueue: Promise<void> = Promise.resolve();
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
		this.clearIdleConsolidationTimer();
	}

	noteCompletedAssistantTurn(): void {
		this.durableDirty = true;
		this.durableRevision++;
		this.lastAssistantTurnRevision = this.durableRevision;

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
		return reason === "compaction" ? settings.forceRefreshBeforeCompact : settings.forceRefreshBeforeNewSession;
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

	private enqueueBackgroundJob(job: () => Promise<void>, failureMessage: string): void {
		this.backgroundQueue = this.backgroundQueue.then(job).catch((error: unknown) => {
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
			this.enqueueBackgroundJob(async () => {
				try {
					log.logInfo(`[${this.options.channelId}] Memory consolidation starting (idle)`);
					const result = await runInlineConsolidation(this.buildRunOptions(messageSnapshot, sessionEntrySnapshot));
					this.markDurableConsolidationCheckpoint(revisionSnapshot);
					this.logConsolidationResult("idle", result);
					const maintenance = await runBackgroundMaintenance(
						this.buildRunOptions(messageSnapshot, sessionEntrySnapshot),
					);
					this.logBackgroundResult(maintenance);
				} finally {
					this.idleConsolidationQueued = false;
					if (this.durableDirty) {
						this.scheduleIdleConsolidation();
					}
				}
			}, `[${this.options.channelId}] Memory consolidation failed (idle)`);
		}, IDLE_CONSOLIDATION_DELAY_MS);
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

		if (this.shouldForceRefreshFor(reason, settings)) {
			await this.runSessionRefreshSerial({
				reason,
				messages: messageSnapshot,
			});
		}

		try {
			log.logInfo(`[${this.options.channelId}] Memory consolidation starting (${reason})`);
			const result = await runInlineConsolidation(this.buildRunOptions(messageSnapshot, sessionEntrySnapshot));
			this.markDurableConsolidationCheckpoint(revisionSnapshot);
			this.logConsolidationResult(reason, result);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.logWarning(`[${this.options.channelId}] Memory consolidation failed (${reason})`, message);
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
		this.enqueueBackgroundJob(async () => {
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
