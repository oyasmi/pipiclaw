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
import type { DeskConversation } from "../desk/types.js";
import * as log from "../log.js";
import { formatLocalTime } from "../shared/local-time.js";
import { errorMessage } from "../shared/text-utils.js";
import {
	drainBoundaryReflectWork,
	enqueueBoundaryReflectEntries,
	enqueueBoundaryReflectWork,
	hasBoundaryReflectWork,
} from "./boundary-work.js";
import { type DeskMemoryQueue, getDeskMemoryQueue } from "./desk-memory-queue.js";
import {
	type MemoryActivityEvent,
	readMemoryMaintenanceState,
	updateMemoryMaintenanceState,
} from "./maintenance-state.js";
import { type ReflectRunResult, runReflect } from "./reflect.js";
import { appendMemoryReviewLog, type MemoryReviewReason, reviewLogEntryFor } from "./review-log.js";
import { buildIncrementalMemorySourceWindow } from "./source-window.js";

/** Boundaries `MemoryLifecycle` reflects on directly, outside the scheduled idle job (spec 050, D7). */
export type ConsolidationReason = "shutdown";

export interface MemoryLifecycleOptions {
	/** Request-owned sessions must never reflect imported client history. */
	enabled?: boolean;
	/** The conversation whose session this lifecycle reflects; its memory lands in the desk. */
	conversation: DeskConversation;
	workspaceDir: string;
	appHomeDir?: string;
	getMessages: () => AgentMessage[];
	getSessionEntries: () => SessionEntry[];
	getModel: () => Model<Api>;
	resolveApiKey: (model: Model<Api>) => Promise<string>;
	recordMemoryActivity?: (event: MemoryActivityEvent) => Promise<void> | void;
	memoryQueue?: DeskMemoryQueue;
}

export class MemoryLifecycle {
	private durableDirty = false;
	private durableRevision = 0;
	private lastDurableConsolidationRevision = 0;
	private readonly memoryQueue: DeskMemoryQueue;
	// Tracks the current durable-boundary drain so shutdown can await it.
	private boundaryReflect: Promise<void> = Promise.resolve();

	constructor(private options: MemoryLifecycleOptions) {
		this.memoryQueue = options.memoryQueue ?? getDeskMemoryQueue();
	}

	createExtensionFactory(): ExtensionFactory {
		return (pi) => {
			if (this.options.enabled === false) return;
			pi.on("session_compact", async (event: SessionCompactEvent) => {
				this.handleSessionCompact(event);
			});
			pi.on("session_compact_failed", () => {
				this.startBoundaryReflect();
			});
			pi.on("session_before_switch", async (event: SessionBeforeSwitchEvent) => {
				if (event.reason === "new") await this.prepareNewSession();
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
		if (this.options.enabled === false) return;
		this.durableDirty = true;
		this.durableRevision++;
		this.recordActivity("tool-call");
	}

	noteCompletedAssistantTurn(): void {
		if (this.options.enabled === false) return;
		this.durableDirty = true;
		this.durableRevision++;
		this.recordActivity("assistant-turn-completed");
	}

	async flushForShutdown(): Promise<void> {
		if (this.options.enabled === false) return;
		await this.resumeBoundaryReflect();
		await this.runDurableMemoryJobSerial(async () => {
			if (await hasBoundaryReflectWork(this.options.conversation)) return;
			// Shutdown is the last chance to persist, so use a looser gate than the
			// idle/compaction path: reflect on any unconsolidated durable activity, including a
			// session that only produced tool output with no final assistant turn.
			if (!this.hasPendingDurableSnapshot()) {
				return;
			}
			const messageSnapshot = [...this.options.getMessages()];
			const sessionEntrySnapshot = [...this.options.getSessionEntries()];
			const revisionSnapshot = this.durableRevision;
			await this.runBoundaryReflectNow("shutdown", messageSnapshot, sessionEntrySnapshot, revisionSnapshot);
		});
	}

	private runDurableMemoryJobSerial<T>(job: () => Promise<T>): Promise<T> {
		return this.memoryQueue.run(this.options.conversation, job);
	}

	// Any unconsolidated durable activity since the last checkpoint, regardless of whether it
	// ended on an assistant turn. Used only for the shutdown flush.
	private hasPendingDurableSnapshot(): boolean {
		return this.durableDirty && this.durableRevision > this.lastDurableConsolidationRevision;
	}

	private markDurableConsolidationCheckpoint(revision: number): void {
		this.lastDurableConsolidationRevision = Math.max(this.lastDurableConsolidationRevision, revision);
		this.durableDirty = this.durableRevision > this.lastDurableConsolidationRevision;
	}

	private logReflectResult(reason: ConsolidationReason, result: ReflectRunResult): void {
		if (result.skipped) {
			log.logEvent("debug", "memory.reflect.skipped", "No meaningful snapshot", {
				ctx: { channelId: this.options.conversation.channelId },
				fields: { reason },
			});
			return;
		}
		log.logInfo(
			`[${this.options.conversation.channelId}] Memory reflect finished (${reason}): added=${result.added.length} updated=${result.updated.length} deleted=${result.deleted.length} touched=${result.touched.length} journal+=${result.journalAppended}`,
		);
	}

	private async appendReviewLog(entry: {
		reason: MemoryReviewReason;
		actions?: unknown[];
		skipped?: unknown[];
		error?: string;
		correlationId?: string;
	}): Promise<void> {
		try {
			await appendMemoryReviewLog(this.options.conversation.deskDir, {
				timestamp: formatLocalTime(),
				channelId: this.options.conversation.channelId,
				...entry,
			});
		} catch (error) {
			const message = errorMessage(error);
			log.logWarn("memory.review_log.write_failed", "Memory review log write failed", {
				channelId: this.options.conversation.channelId,
				reason: message,
			});
		}
	}

	private async runBoundaryReflectNow(
		reason: ConsolidationReason,
		messageSnapshot: AgentMessage[],
		sessionEntrySnapshot: SessionEntry[] = [],
		revisionSnapshot: number = this.durableRevision,
	): Promise<void> {
		try {
			const maintenanceState = this.options.appHomeDir
				? await readMemoryMaintenanceState(this.options.appHomeDir, this.options.conversation)
				: undefined;
			const lastEntryId = maintenanceState?.lastReflectedEntryId;
			const sourceWindow = buildIncrementalMemorySourceWindow({
				entries: sessionEntrySnapshot,
				lastEntryId,
				sourceKind: reason,
				closed: true,
				fallbackMessages: messageSnapshot,
			});
			log.logInfo(`[${this.options.conversation.channelId}] Memory reflect starting (${reason})`);
			const result = await runReflect({
				channelId: this.options.conversation.channelId,
				deskDir: this.options.conversation.deskDir,
				workspaceDir: this.options.workspaceDir,
				model: this.options.getModel(),
				resolveApiKey: this.options.resolveApiKey,
				messages: sourceWindow.messages,
				sourceClosed: true,
				usageContext: {
					channelId: this.options.conversation.channelId,
					desk: this.options.conversation.desk,
					correlationId: sourceWindow.windowId,
				},
			});
			if (this.options.appHomeDir && sourceWindow.throughEntryId) {
				await updateMemoryMaintenanceState(this.options.appHomeDir, this.options.conversation, (current) => ({
					...current,
					lastReflectedEntryId: sourceWindow.throughEntryId,
					lastReflectAt: sourceWindow.hasMore ? current.lastReflectAt : formatLocalTime(),
					failureBackoffUntil: null,
				}));
			}
			if (!sourceWindow.hasMore) this.markDurableConsolidationCheckpoint(revisionSnapshot);
			this.logReflectResult(reason, result);
			await this.appendReviewLog({
				reason: "reflect-boundary",
				correlationId: sourceWindow.windowId,
				...reviewLogEntryFor(result, sourceWindow),
			});
		} catch (error) {
			const message = errorMessage(error);
			log.logWarn("memory.reflect.failed", "Memory reflect failed", {
				channelId: this.options.conversation.channelId,
				reason: message,
				fields: { trigger: reason },
			});
			await this.appendReviewLog({
				reason: "reflect-boundary",
				error: message,
				skipped: [{ target: "reflect", reason: "failed" }],
			});
		}
	}

	/** The agent's bounded compaction operation awaits only durable snapshot persistence. */
	async prepareCompaction(event: SessionBeforeCompactEvent): Promise<void> {
		if (this.options.enabled === false) return;
		await enqueueBoundaryReflectWork(
			this.options.conversation,
			event.branchEntries,
			event.preparation.firstKeptEntryId,
			event.signal,
		);
	}

	resumeBoundaryReflect(): Promise<void> {
		this.startBoundaryReflect();
		return this.boundaryReflect;
	}

	private startBoundaryReflect(): void {
		if (this.options.enabled === false) return;
		if (!this.options.appHomeDir) return;
		this.boundaryReflect = drainBoundaryReflectWork({
			conversation: this.options.conversation,
			workspaceDir: this.options.workspaceDir,
			appHomeDir: this.options.appHomeDir,
			model: this.options.getModel(),
			resolveApiKey: this.options.resolveApiKey,
			queue: this.memoryQueue,
		});
	}

	private handleSessionCompact(_event: SessionCompactEvent): void {
		this.recordActivity("boundary");
		this.startBoundaryReflect();
	}

	/** Persist the outgoing branch before a switch; never wait for inference or the desk queue. */
	async prepareNewSession(): Promise<void> {
		if (this.options.enabled === false) return;
		await enqueueBoundaryReflectEntries(this.options.conversation, [...this.options.getSessionEntries()]);
		this.recordActivity("boundary");
	}

	private handleSessionStart(event: SessionStartEvent): void {
		if (event.reason !== "new") {
			return;
		}

		this.recordActivity("boundary");
		this.startBoundaryReflect();
	}

	private recordActivity(kind: MemoryActivityEvent["kind"]): void {
		if (this.options.enabled === false) return;
		const now = new Date();
		const event: MemoryActivityEvent = {
			kind,
			ref: this.options.conversation,
			timestamp: formatLocalTime(now),
		};
		try {
			void this.options.recordMemoryActivity?.(event);
		} catch (error) {
			const message = errorMessage(error);
			log.logWarn("memory.activity.record_failed", "Memory activity record failed", {
				channelId: this.options.conversation.channelId,
				reason: message,
			});
		}
	}
}
