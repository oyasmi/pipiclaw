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
import type { DotConversation } from "../dot/types.js";
import * as log from "../log.js";
import { formatLocalTime } from "../shared/local-time.js";
import { errorMessage } from "../shared/text-utils.js";
import { drainBoundaryReflectWork, enqueueBoundaryReflectWork } from "./boundary-work.js";
import { type DotMemoryQueue, getDotMemoryQueue } from "./dot-memory-queue.js";
import {
	type MemoryActivityEvent,
	readMemoryMaintenanceState,
	updateMemoryMaintenanceState,
} from "./maintenance-state.js";
import { type ReflectRunResult, runReflect } from "./reflect.js";
import { reviewLogEntryFor } from "./reflect-job.js";
import { appendMemoryReviewLog, type MemoryReviewReason } from "./review-log.js";
import { buildIncrementalMemorySourceWindow } from "./source-window.js";

/** Boundaries `MemoryLifecycle` reflects on directly, outside the scheduled idle job (spec 050, D7). */
export type ConsolidationReason = "new-session" | "shutdown";

export interface MemoryLifecycleOptions {
	/** The conversation whose session this lifecycle reflects; its memory lands in the dot. */
	conversation: DotConversation;
	workspaceDir: string;
	appHomeDir?: string;
	getMessages: () => AgentMessage[];
	getSessionEntries: () => SessionEntry[];
	getModel: () => Model<Api>;
	resolveApiKey: (model: Model<Api>) => Promise<string>;
	recordMemoryActivity?: (event: MemoryActivityEvent) => Promise<void> | void;
	memoryQueue?: DotMemoryQueue;
}

export class MemoryLifecycle {
	private durableDirty = false;
	private durableRevision = 0;
	private lastDurableConsolidationRevision = 0;
	private readonly memoryQueue: DotMemoryQueue;
	// Tracks the detached new-session reflect run so shutdown/tests can await it.
	private backgroundNewSessionReflect: Promise<void> = Promise.resolve();

	constructor(private options: MemoryLifecycleOptions) {
		this.memoryQueue = options.memoryQueue ?? getDotMemoryQueue();
	}

	createExtensionFactory(): ExtensionFactory {
		return (pi) => {
			pi.on("session_compact", async (event: SessionCompactEvent) => {
				this.handleSessionCompact(event);
			});
			pi.on("session_compact_failed", () => {
				this.startBoundaryReflect();
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
		await this.resumeBoundaryReflect();
		// Let any detached new-session reflect run finish (and update the durable checkpoint)
		// before deciding whether a final flush is still needed.
		await this.whenNewSessionReflectSettled();
		await this.runDurableMemoryJobSerial(async () => {
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
			await appendMemoryReviewLog(this.options.conversation.dotDir, {
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

	private async runBoundaryReflect(
		reason: ConsolidationReason,
		messages?: AgentMessage[],
		sessionEntries?: SessionEntry[],
	): Promise<void> {
		const messageSnapshot = [...(messages ?? this.options.getMessages())];
		const sessionEntrySnapshot = sessionEntries ? [...sessionEntries] : [...this.options.getSessionEntries()];
		const revisionSnapshot = this.durableRevision;

		await this.runDurableMemoryJobSerial(async () => {
			await this.runBoundaryReflectNow(reason, messageSnapshot, sessionEntrySnapshot, revisionSnapshot);
		});
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
				fallbackMessages: messageSnapshot,
			});
			log.logInfo(`[${this.options.conversation.channelId}] Memory reflect starting (${reason})`);
			const result = await runReflect({
				channelId: this.options.conversation.channelId,
				dotDir: this.options.conversation.dotDir,
				workspaceDir: this.options.workspaceDir,
				model: this.options.getModel(),
				resolveApiKey: this.options.resolveApiKey,
				messages: sourceWindow.messages,
				usageContext: {
					channelId: this.options.conversation.channelId,
					dot: this.options.conversation.dot,
					correlationId: sourceWindow.windowId,
				},
			});
			if (this.options.appHomeDir && sourceWindow.throughEntryId) {
				await updateMemoryMaintenanceState(this.options.appHomeDir, this.options.conversation, (current) => ({
					...current,
					lastReflectedEntryId: sourceWindow.throughEntryId,
					lastReflectAt: formatLocalTime(),
					failureBackoffUntil: null,
				}));
			}
			this.markDurableConsolidationCheckpoint(revisionSnapshot);
			this.logReflectResult(reason, result);
			await this.appendReviewLog({
				reason: "reflect-boundary",
				correlationId: sourceWindow.windowId,
				...reviewLogEntryFor(result),
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
		await enqueueBoundaryReflectWork(
			this.options.conversation,
			event.branchEntries,
			event.preparation.firstKeptEntryId,
			event.signal,
		);
	}

	resumeBoundaryReflect(): Promise<void> {
		this.startBoundaryReflect();
		return this.backgroundNewSessionReflect;
	}

	private startBoundaryReflect(): void {
		if (!this.options.appHomeDir) return;
		this.backgroundNewSessionReflect = drainBoundaryReflectWork({
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

	private handleSessionBeforeSwitch(event: SessionBeforeSwitchEvent): void {
		if (event.reason !== "new") {
			return;
		}
		this.noteNewSessionBoundary();
	}

	/** Snapshot the outgoing state for an out-of-band `/new` before its runner is retired. */
	noteNewSessionBoundary(): void {
		// Snapshot the outgoing session synchronously: the switch has not happened yet, so
		// getMessages()/getSessionEntries() still reference the session about to be replaced.
		// Once we yield, this.session is rebound to the new (empty) session and the snapshot
		// would be lost.
		const messageSnapshot = [...this.options.getMessages()];
		const sessionEntrySnapshot = [...this.options.getSessionEntries()];

		// Run the LLM-backed reflect pass in the background so /new returns immediately.
		// Failures are tolerated: runBoundaryReflectNow catches and logs its own errors, and the
		// serial queue keeps this from racing with idle/maintenance work on the same channel.
		this.backgroundNewSessionReflect = this.runBoundaryReflect(
			"new-session",
			messageSnapshot,
			sessionEntrySnapshot,
		).catch((error) => {
			const message = errorMessage(error);
			log.logWarn("memory.reflect.rejected", "Background new-session reflect rejected", {
				channelId: this.options.conversation.channelId,
				reason: message,
			});
		});
		this.recordActivity("boundary");
	}

	/** Await any in-flight detached new-session reflect run (shutdown/tests). */
	async whenNewSessionReflectSettled(): Promise<void> {
		await this.backgroundNewSessionReflect;
	}

	private handleSessionStart(event: SessionStartEvent): void {
		if (event.reason !== "new") {
			return;
		}

		this.recordActivity("boundary");
	}

	private recordActivity(kind: MemoryActivityEvent["kind"]): void {
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
