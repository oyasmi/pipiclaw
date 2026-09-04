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
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import * as log from "../log.js";
import { formatLocalTime } from "../shared/local-time.js";
import { clipTextByPromptUnits } from "../shared/prompt-units.js";
import { errorMessage } from "../shared/text-utils.js";
import { type ChannelMemoryQueue, getDefaultChannelMemoryQueue } from "./channel-maintenance-queue.js";
import {
	type MemoryActivityEvent,
	readMemoryMaintenanceState,
	updateMemoryMaintenanceState,
} from "./maintenance-state.js";
import { type ReflectRunResult, runReflect } from "./reflect.js";
import { reviewLogEntryFor } from "./reflect-job.js";
import { appendMemoryReviewLog, type MemoryReviewReason } from "./review-log.js";
import { buildCompactionMemorySourceWindow, buildIncrementalMemorySourceWindow } from "./source-window.js";

/** Boundaries `MemoryLifecycle` reflects on directly, outside the scheduled idle job (spec 050, D7). */
export type ConsolidationReason = "compaction" | "new-session" | "shutdown";

const COMPACTION_INPUT_MAX_UNITS = 48_000;
const COMPACTION_INPUT_MIN_UNITS = 4_000;
const COMPACTION_INPUT_CHARS_PER_TOKEN = 3;
const COMPACTION_INPUT_HEAD_RATIO = 0.35;

/**
 * Bound one standalone summarization request. Provider limits can be lower than a model's
 * advertised context window; sending the whole pre-compaction transcript is therefore not safe.
 * The head preserves the original goal and the larger tail preserves current work. Durable
 * memory is refreshed before this runs, so the omitted middle is still available outside the
 * provider request.
 */
export function boundCompactionMessages(
	messages: AgentMessage[],
	contextWindow: number,
	reserveTokens: number,
): { messages: AgentMessage[]; truncated: boolean; originalChars: number; boundedChars: number } {
	if (messages.length === 0) {
		return { messages, truncated: false, originalChars: 0, boundedChars: 0 };
	}
	const safeWindow = Number.isFinite(contextWindow) && contextWindow > 0 ? Math.floor(contextWindow) : 128_000;
	const safeReserve = Number.isFinite(reserveTokens) && reserveTokens > 0 ? Math.floor(reserveTokens) : 16_384;
	const maxUnits = Math.min(
		COMPACTION_INPUT_MAX_UNITS,
		Math.max(COMPACTION_INPUT_MIN_UNITS, safeWindow - safeReserve - 8_192),
	);
	const serialized = serializeConversation(convertToLlm(messages));
	const clipped = clipTextByPromptUnits(serialized, maxUnits, {
		headRatio: COMPACTION_INPUT_HEAD_RATIO,
		maxChars: maxUnits * COMPACTION_INPUT_CHARS_PER_TOKEN,
		marker:
			"\n\n[... middle omitted from this compaction request; durable channel memory was refreshed before compaction ...]\n\n",
	});
	if (!clipped.truncated) {
		return {
			messages,
			truncated: false,
			originalChars: serialized.length,
			boundedChars: serialized.length,
		};
	}
	return {
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: clipped.text }],
				timestamp: Date.now(),
			},
		],
		truncated: true,
		originalChars: serialized.length,
		boundedChars: clipped.text.length,
	};
}

export interface MemoryLifecycleOptions {
	channelId: string;
	channelDir: string;
	workspaceDir: string;
	appHomeDir?: string;
	getMessages: () => AgentMessage[];
	getSessionEntries: () => SessionEntry[];
	getModel: () => Model<Api>;
	resolveApiKey: (model: Model<Api>) => Promise<string>;
	recordMemoryActivity?: (event: MemoryActivityEvent) => Promise<void> | void;
	channelMemoryQueue?: ChannelMemoryQueue;
}

export class MemoryLifecycle {
	private durableDirty = false;
	private durableRevision = 0;
	private lastDurableConsolidationRevision = 0;
	private readonly channelMemoryQueue: ChannelMemoryQueue;
	// Tracks the detached new-session reflect run so shutdown/tests can await it.
	private backgroundNewSessionReflect: Promise<void> = Promise.resolve();

	constructor(private options: MemoryLifecycleOptions) {
		this.channelMemoryQueue = options.channelMemoryQueue ?? getDefaultChannelMemoryQueue();
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
		return this.channelMemoryQueue.run(this.options.channelId, job);
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
				ctx: { channelId: this.options.channelId },
				fields: { reason },
			});
			return;
		}
		log.logInfo(
			`[${this.options.channelId}] Memory reflect finished (${reason}): added=${result.added.length} updated=${result.updated.length} deleted=${result.deleted.length} touched=${result.touched.length} journal+=${result.journalAppended}`,
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
			await appendMemoryReviewLog(this.options.channelDir, {
				timestamp: formatLocalTime(),
				channelId: this.options.channelId,
				...entry,
			});
		} catch (error) {
			const message = errorMessage(error);
			log.logWarning(`[${this.options.channelId}] Failed to write memory review log`, message);
		}
	}

	private async runBoundaryReflect(
		reason: ConsolidationReason,
		messages?: AgentMessage[],
		sessionEntries?: SessionEntry[],
		firstKeptEntryId?: string,
	): Promise<void> {
		const messageSnapshot = [...(messages ?? this.options.getMessages())];
		const sessionEntrySnapshot = sessionEntries ? [...sessionEntries] : [...this.options.getSessionEntries()];
		const revisionSnapshot = this.durableRevision;

		await this.runDurableMemoryJobSerial(async () => {
			await this.runBoundaryReflectNow(
				reason,
				messageSnapshot,
				sessionEntrySnapshot,
				revisionSnapshot,
				firstKeptEntryId,
			);
		});
	}

	private async runBoundaryReflectNow(
		reason: ConsolidationReason,
		messageSnapshot: AgentMessage[],
		sessionEntrySnapshot: SessionEntry[] = [],
		revisionSnapshot: number = this.durableRevision,
		firstKeptEntryId?: string,
	): Promise<void> {
		try {
			const maintenanceState = this.options.appHomeDir
				? await readMemoryMaintenanceState(this.options.appHomeDir, this.options.channelId)
				: undefined;
			const lastEntryId = maintenanceState?.lastReflectedEntryId;
			const sourceWindow =
				reason === "compaction"
					? buildCompactionMemorySourceWindow({
							entries: sessionEntrySnapshot,
							messagesToSummarize: messageSnapshot,
							firstKeptEntryId,
							lastEntryId,
						})
					: buildIncrementalMemorySourceWindow({
							entries: sessionEntrySnapshot,
							lastEntryId,
							sourceKind: reason,
							fallbackMessages: messageSnapshot,
						});
			log.logInfo(`[${this.options.channelId}] Memory reflect starting (${reason})`);
			const result = await runReflect({
				channelId: this.options.channelId,
				channelDir: this.options.channelDir,
				workspaceDir: this.options.workspaceDir,
				model: this.options.getModel(),
				resolveApiKey: this.options.resolveApiKey,
				messages: sourceWindow.messages,
				usageContext: { channelId: this.options.channelId, correlationId: sourceWindow.windowId },
			});
			if (this.options.appHomeDir && sourceWindow.throughEntryId) {
				await updateMemoryMaintenanceState(this.options.appHomeDir, this.options.channelId, (current) => ({
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
			log.logWarning(`[${this.options.channelId}] Memory reflect failed (${reason})`, message);
			await this.appendReviewLog({
				reason: "reflect-boundary",
				error: message,
				skipped: [{ target: "reflect", reason: "failed" }],
			});
		}
	}

	private async handleSessionBeforeCompact(event: SessionBeforeCompactEvent): Promise<void> {
		await this.runBoundaryReflect(
			"compaction",
			event.preparation.messagesToSummarize,
			this.options.getSessionEntries(),
			event.preparation.firstKeptEntryId,
		);

		const model = this.options.getModel();
		for (const key of ["messagesToSummarize", "turnPrefixMessages"] as const) {
			const bounded = boundCompactionMessages(
				event.preparation[key] ?? [],
				model.contextWindow,
				event.preparation.settings?.reserveTokens ?? 16_384,
			);
			if (!bounded.truncated) continue;
			event.preparation[key] = bounded.messages;
			log.logWarning(
				`[${this.options.channelId}] Bounded oversized compaction input (${key})`,
				`${bounded.originalChars} -> ${bounded.boundedChars} chars; model=${model.provider}/${model.id}`,
			);
		}
	}

	private handleSessionCompact(_event: SessionCompactEvent): void {
		this.recordActivity("boundary");
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
			log.logWarning(`[${this.options.channelId}] Background new-session reflect rejected`, message);
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
			channelId: this.options.channelId,
			timestamp: formatLocalTime(now),
		};
		try {
			void this.options.recordMemoryActivity?.(event);
		} catch (error) {
			const message = errorMessage(error);
			log.logWarning(`[${this.options.channelId}] Failed to record memory activity`, message);
		}
	}
}
