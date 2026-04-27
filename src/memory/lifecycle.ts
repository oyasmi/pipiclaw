import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type {
	ExtensionFactory,
	SessionBeforeCompactEvent,
	SessionBeforeSwitchEvent,
	SessionCompactEvent,
	SessionEntry,
	SessionStartEvent,
} from "@mariozechner/pi-coding-agent";
import * as log from "../log.js";
import type { PipiclawSessionMemorySettings } from "../settings.js";
import { type ChannelMemoryQueue, getDefaultChannelMemoryQueue } from "./channel-maintenance-queue.js";
import {
	type ConsolidationRunOptions,
	type InlineConsolidationResult,
	runInlineConsolidation,
} from "./consolidation.js";
import type { MemoryActivityEvent } from "./maintenance-state.js";
import { appendMemoryReviewLog } from "./review-log.js";
import { updateChannelSessionMemory } from "./session.js";

export type ConsolidationReason = "compaction" | "new-session" | "idle" | "shutdown";

export interface MemoryLifecycleOptions {
	channelId: string;
	channelDir: string;
	getMessages: () => AgentMessage[];
	getSessionEntries: () => SessionEntry[];
	getModel: () => Model<Api>;
	resolveApiKey: (model: Model<Api>) => Promise<string>;
	getSessionMemorySettings: () => PipiclawSessionMemorySettings;
	recordMemoryActivity?: (event: MemoryActivityEvent) => Promise<void> | void;
	channelMemoryQueue?: ChannelMemoryQueue;
}

interface SessionMemoryRefreshRequest {
	reason: Exclude<ConsolidationReason, "idle">;
	messages?: AgentMessage[];
}

export class MemoryLifecycle {
	private sessionRefreshQueue: Promise<void> = Promise.resolve();
	private durableDirty = false;
	private durableRevision = 0;
	private lastAssistantTurnRevision = 0;
	private lastDurableConsolidationRevision = 0;
	private readonly channelMemoryQueue: ChannelMemoryQueue;

	constructor(private options: MemoryLifecycleOptions) {
		this.channelMemoryQueue = options.channelMemoryQueue ?? getDefaultChannelMemoryQueue();
	}

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
			pi.on("session_start", async (event: SessionStartEvent) => {
				this.handleSessionStart(event);
			});
		};
	}

	noteUserTurnStarted(): void {
		this.recordActivity("user-turn-started");
	}

	noteToolCall(): void {
		this.durableDirty = true;
		this.durableRevision++;
		this.recordActivity("tool-call");
	}

	noteCompletedAssistantTurn(): void {
		this.durableDirty = true;
		this.durableRevision++;
		this.lastAssistantTurnRevision = this.durableRevision;
		this.recordActivity("assistant-turn-completed");
	}

	async flushForShutdown(): Promise<void> {
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
		try {
			await updateChannelSessionMemory({
				channelDir: this.options.channelDir,
				messages: request.messages ?? this.options.getMessages(),
				model: this.options.getModel(),
				resolveApiKey: this.options.resolveApiKey,
				timeoutMs: settings.timeoutMs,
			});
			log.logInfo(`[${this.options.channelId}] Session memory updated (${reason})`);
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.logWarning(`[${this.options.channelId}] Session memory update failed (${reason})`, message);
			return false;
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

	private runDurableMemoryJobSerial<T>(job: () => Promise<T>): Promise<T> {
		return this.channelMemoryQueue.run(this.options.channelId, job);
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

	private async runPreflightConsolidation(
		reason: Exclude<ConsolidationReason, "idle">,
		messages?: AgentMessage[],
		sessionEntries?: SessionEntry[],
	): Promise<void> {
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
		this.recordActivity("boundary");
	}

	private async handleSessionBeforeSwitch(event: SessionBeforeSwitchEvent): Promise<void> {
		if (event.reason !== "new") {
			return;
		}

		await this.runPreflightConsolidation("new-session");
	}

	private handleSessionStart(event: SessionStartEvent): void {
		if (event.reason !== "new") {
			return;
		}

		this.recordActivity("boundary");
	}

	private recordActivity(kind: MemoryActivityEvent["kind"]): void {
		const now = new Date();
		const latestSessionEntryId = this.options.getSessionEntries().at(-1)?.id;
		const event: MemoryActivityEvent = {
			kind,
			channelId: this.options.channelId,
			timestamp: now.toISOString(),
			latestSessionEntryId,
		};
		try {
			void this.options.recordMemoryActivity?.(event);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.logWarning(`[${this.options.channelId}] Failed to record memory activity`, message);
		}
	}
}
