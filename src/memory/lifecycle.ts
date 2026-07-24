import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionFactory,
	SessionBeforeCompactEvent,
	SessionBeforeSwitchEvent,
	SessionCompactEvent,
	SessionEntry,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import * as log from "../log.js";
import type { PipiclawSessionMemorySettings } from "../settings.js";
import { errorMessage } from "../shared/text-utils.js";
import { type ChannelMemoryQueue, getDefaultChannelMemoryQueue } from "./channel-maintenance-queue.js";
import {
	type ConsolidationRunOptions,
	type InlineConsolidationResult,
	runInlineConsolidation,
} from "./consolidation.js";
import {
	type MemoryActivityEvent,
	readMemoryMaintenanceState,
	updateMemoryMaintenanceState,
} from "./maintenance-state.js";
import { appendMemoryReviewLog } from "./review-log.js";
import { updateChannelSessionMemory } from "./session.js";
import {
	buildCompactionMemorySourceWindow,
	buildIncrementalMemorySourceWindow,
	type MemorySourceWindow,
} from "./source-window.js";

export type ConsolidationReason = "compaction" | "new-session" | "idle" | "shutdown";

export interface MemoryLifecycleOptions {
	channelId: string;
	channelDir: string;
	appHomeDir?: string;
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
	private lastDurableConsolidationRevision = 0;
	private readonly channelMemoryQueue: ChannelMemoryQueue;
	// Tracks the detached new-session consolidation so shutdown/tests can await it.
	private backgroundNewSessionConsolidation: Promise<void> = Promise.resolve();

	constructor(private options: MemoryLifecycleOptions) {
		this.channelMemoryQueue = options.channelMemoryQueue ?? getDefaultChannelMemoryQueue();
	}

	private buildRunOptions(
		messages?: AgentMessage[],
		sessionEntries?: SessionEntry[],
		sourceWindow?: MemorySourceWindow,
	): ConsolidationRunOptions {
		return {
			channelId: this.options.channelId,
			channelDir: this.options.channelDir,
			model: this.options.getModel(),
			resolveApiKey: this.options.resolveApiKey,
			messages: messages ?? this.options.getMessages(),
			sessionEntries: sessionEntries ?? this.options.getSessionEntries(),
			sourceWindow,
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
			pi.on("session_before_switch", (event: SessionBeforeSwitchEvent) => {
				this.handleSessionBeforeSwitch(event);
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
		this.recordActivity("assistant-turn-completed");
	}

	async flushForShutdown(): Promise<void> {
		// Let any detached new-session consolidation finish (and update the durable
		// checkpoint) before deciding whether a final flush is still needed.
		await this.whenNewSessionConsolidationSettled();
		await this.runDurableMemoryJobSerial(async () => {
			// Shutdown is the last chance to persist, so use a looser gate than the
			// idle/compaction path: consolidate any unconsolidated durable activity,
			// including a session that only produced tool output with no final
			// assistant turn (which hasPendingAssistantSnapshot would skip).
			if (!this.hasPendingDurableSnapshot()) {
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
				channelId: this.options.channelId,
				channelDir: this.options.channelDir,
				messages: request.messages ?? this.options.getMessages(),
				model: this.options.getModel(),
				resolveApiKey: this.options.resolveApiKey,
				timeoutMs: settings.timeoutMs,
			});
			log.logInfo(`[${this.options.channelId}] Session memory updated (${reason})`);
			return true;
		} catch (error) {
			const message = errorMessage(error);
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

	// Any unconsolidated durable activity since the last checkpoint, regardless of
	// whether it ended on an assistant turn. Used only for the shutdown flush.
	private hasPendingDurableSnapshot(): boolean {
		return this.durableDirty && this.durableRevision > this.lastDurableConsolidationRevision;
	}

	private markDurableConsolidationCheckpoint(revision: number): void {
		this.lastDurableConsolidationRevision = Math.max(this.lastDurableConsolidationRevision, revision);
		this.durableDirty = this.durableRevision > this.lastDurableConsolidationRevision;
	}

	private logConsolidationResult(reason: ConsolidationReason, result: InlineConsolidationResult): void {
		if (result.skipped) {
			log.logEvent("debug", "memory.consolidation.skipped", "No meaningful snapshot", {
				ctx: { channelId: this.options.channelId },
				fields: { reason },
			});
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
			const message = errorMessage(error);
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
		// Defensive: review-log bookkeeping runs after the consolidation has already been
		// applied and checkpointed, so a shape surprise here must not report success as failure.
		for (const candidate of result.rejectedMemoryOps ?? []) {
			skipped.push({ target: "MEMORY.md", candidate, reason: "below auto-write confidence" });
		}

		await this.appendReviewLog({ reason, actions, skipped });
	}

	private async runPreflightConsolidation(
		reason: Exclude<ConsolidationReason, "idle">,
		messages?: AgentMessage[],
		sessionEntries?: SessionEntry[],
		firstKeptEntryId?: string,
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
				firstKeptEntryId,
			);
		});
	}

	private async runPreflightConsolidationNow(
		reason: Exclude<ConsolidationReason, "idle">,
		messageSnapshot: AgentMessage[],
		sessionEntrySnapshot?: SessionEntry[],
		revisionSnapshot: number = this.durableRevision,
		settings: PipiclawSessionMemorySettings = this.options.getSessionMemorySettings(),
		firstKeptEntryId?: string,
	): Promise<void> {
		if (this.shouldForceRefreshFor(reason, settings)) {
			await this.runSessionRefreshSerial({
				reason,
				messages: messageSnapshot,
			});
		}

		try {
			const maintenanceState = this.options.appHomeDir
				? await readMemoryMaintenanceState(this.options.appHomeDir, this.options.channelId)
				: undefined;
			const lastEntryId = maintenanceState?.lastCheckpointEntryId;
			const sourceWindow =
				reason === "compaction"
					? buildCompactionMemorySourceWindow({
							entries: sessionEntrySnapshot ?? [],
							messagesToSummarize: messageSnapshot,
							firstKeptEntryId,
							lastEntryId,
						})
					: buildIncrementalMemorySourceWindow({
							entries: sessionEntrySnapshot ?? [],
							lastEntryId,
							sourceKind: reason,
							fallbackMessages: messageSnapshot,
						});
			log.logInfo(`[${this.options.channelId}] Memory consolidation starting (${reason})`);
			const result = await runInlineConsolidation({
				...this.buildRunOptions(messageSnapshot, sessionEntrySnapshot, sourceWindow),
				mode: "boundary",
			});
			if (this.options.appHomeDir && sourceWindow.throughEntryId) {
				await updateMemoryMaintenanceState(this.options.appHomeDir, this.options.channelId, (current) => ({
					...current,
					lastCheckpointEntryId: sourceWindow.throughEntryId,
					lastCheckpointAt: new Date().toISOString(),
					failureBackoffUntil: null,
				}));
			}
			this.markDurableConsolidationCheckpoint(revisionSnapshot);
			this.logConsolidationResult(reason, result);
			await this.recordConsolidationReview(reason, result);
		} catch (error) {
			const message = errorMessage(error);
			log.logWarning(`[${this.options.channelId}] Memory consolidation failed (${reason})`, message);
			await this.appendReviewLog({
				reason,
				error: message,
				skipped: [{ target: "consolidation", reason: "failed" }],
			});
		}
	}

	private async handleSessionBeforeCompact(event: SessionBeforeCompactEvent): Promise<void> {
		await this.runPreflightConsolidation(
			"compaction",
			event.preparation.messagesToSummarize,
			this.options.getSessionEntries(),
			event.preparation.firstKeptEntryId,
		);
	}

	private handleSessionCompact(_event: SessionCompactEvent): void {
		this.recordActivity("boundary");
	}

	private handleSessionBeforeSwitch(event: SessionBeforeSwitchEvent): void {
		if (event.reason !== "new") {
			return;
		}

		// Snapshot the outgoing session synchronously: the switch has not happened
		// yet, so getMessages()/getSessionEntries() still reference the session that
		// is about to be replaced. Once we yield, this.session is rebound to the new
		// (empty) session and the snapshot would be lost.
		const messageSnapshot = [...this.options.getMessages()];
		const sessionEntrySnapshot = [...this.options.getSessionEntries()];

		// Run the LLM-backed consolidation in the background so /new returns
		// immediately. Failures are tolerated: runPreflightConsolidationNow catches
		// and logs its own errors, and the serial queue keeps this from racing with
		// idle/maintenance work on the same channel.
		this.backgroundNewSessionConsolidation = this.runPreflightConsolidation(
			"new-session",
			messageSnapshot,
			sessionEntrySnapshot,
		).catch((error) => {
			const message = errorMessage(error);
			log.logWarning(`[${this.options.channelId}] Background new-session consolidation rejected`, message);
		});
	}

	/** Await any in-flight detached new-session consolidation (shutdown/tests). */
	async whenNewSessionConsolidationSettled(): Promise<void> {
		await this.backgroundNewSessionConsolidation;
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
			const message = errorMessage(error);
			log.logWarning(`[${this.options.channelId}] Failed to record memory activity`, message);
		}
	}
}
