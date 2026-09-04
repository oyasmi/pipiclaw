import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { PipiclawMemoryMaintenanceSettings } from "../settings.js";
import { formatLocalTime } from "../shared/local-time.js";
import { errorMessage } from "../shared/text-utils.js";
import { type ChannelMemoryQueue, getDefaultChannelMemoryQueue } from "./channel-maintenance-queue.js";
import { type MaintenanceJobKind, shouldRunReflect } from "./maintenance-gates.js";
import { readMemoryMaintenanceState, updateMemoryMaintenanceState } from "./maintenance-state.js";
import { runReflect } from "./reflect.js";
import { appendMemoryReviewLog } from "./review-log.js";
import { buildIncrementalMemorySourceWindow } from "./source-window.js";
import { hasMeaningfulExchange, sanitizeMessagesForMemory } from "./transcript.js";

/**
 * Spec 050, D7/D9: the scheduler's idle-tick entry point into the reflect pass. Boundary
 * triggers (compaction, `/new`, shutdown) bypass this job entirely and call `reflect.js`
 * directly from `lifecycle.ts`, the same split `maintenance-jobs.ts` used to have between the
 * idle checkpoint job and `MemoryLifecycle`'s preflight consolidation.
 */
export interface ReflectJobInput {
	appHomeDir: string;
	channelId: string;
	channelDir: string;
	workspaceDir: string;
	channelActive: boolean;
	now?: Date;
	settings: { memoryMaintenance: PipiclawMemoryMaintenanceSettings };
	model: Model<Api>;
	resolveApiKey: (model: Model<Api>) => Promise<string>;
	/** Transcript accessors: only called once the gate has decided the job may actually run. */
	messages: () => AgentMessage[];
	sessionEntries: () => SessionEntry[];
	queue?: ChannelMemoryQueue;
}

export interface ReflectJobResult {
	jobKind: MaintenanceJobKind;
	ran: boolean;
	skipped: boolean;
	skipReason?: string;
	error?: string;
}

function backoffUntil(now: Date, settings: PipiclawMemoryMaintenanceSettings): string {
	return formatLocalTime(new Date(now.getTime() + Math.max(0, settings.failureBackoffMinutes) * 60_000));
}

export async function runReflectJob(input: ReflectJobInput): Promise<ReflectJobResult> {
	const queue = input.queue ?? getDefaultChannelMemoryQueue();
	return queue.run(input.channelId, async () => {
		const now = input.now ?? new Date();
		const state = await readMemoryMaintenanceState(input.appHomeDir, input.channelId);
		let cachedWindow: ReturnType<typeof buildIncrementalMemorySourceWindow> | undefined;
		const loadSourceWindow = () => {
			cachedWindow ??= buildIncrementalMemorySourceWindow({
				entries: input.sessionEntries(),
				lastEntryId: state.lastReflectedEntryId,
				sourceKind: "idle",
				fallbackMessages: input.messages(),
			});
			return cachedWindow;
		};

		const decision = shouldRunReflect({
			now,
			state,
			maintenance: input.settings.memoryMaintenance,
			channelActive: input.channelActive,
			material: () => {
				const window = loadSourceWindow();
				return {
					hasNewEntry: window.entries.length > 0,
					hasMeaningfulExchange: hasMeaningfulExchange(sanitizeMessagesForMemory(window.messages)),
				};
			},
		});
		if (!decision.allowed) {
			await appendMemoryReviewLog(input.channelDir, {
				timestamp: formatLocalTime(now),
				channelId: input.channelId,
				reason: "reflect",
				skipped: [{ target: "reflect", reason: decision.skipReason }],
			});
			return { jobKind: decision.jobKind, ran: false, skipped: true, skipReason: decision.skipReason };
		}

		const sourceWindow = loadSourceWindow();
		try {
			const result = await runReflect({
				channelId: input.channelId,
				channelDir: input.channelDir,
				workspaceDir: input.workspaceDir,
				model: input.model,
				resolveApiKey: input.resolveApiKey,
				messages: sourceWindow.messages,
				usageContext: { channelId: input.channelId, correlationId: sourceWindow.windowId },
			});
			await updateMemoryMaintenanceState(input.appHomeDir, input.channelId, (current) => ({
				...current,
				lastReflectAt: formatLocalTime(now),
				lastReflectedEntryId: sourceWindow.throughEntryId ?? current.lastReflectedEntryId,
				failureBackoffUntil: null,
			}));
			await appendMemoryReviewLog(input.channelDir, {
				timestamp: formatLocalTime(now),
				channelId: input.channelId,
				reason: "reflect",
				correlationId: sourceWindow.windowId,
				...reviewLogEntryFor(result),
			});
			return { jobKind: "reflect", ran: !result.skipped, skipped: result.skipped };
		} catch (error) {
			await updateMemoryMaintenanceState(input.appHomeDir, input.channelId, (current) => ({
				...current,
				failureBackoffUntil: backoffUntil(now, input.settings.memoryMaintenance),
			}));
			const message = errorMessage(error);
			await appendMemoryReviewLog(input.channelDir, {
				timestamp: formatLocalTime(now),
				channelId: input.channelId,
				reason: "reflect",
				error: message,
			});
			return { jobKind: "reflect", ran: false, skipped: false, error: message };
		}
	});
}

/** Shared by the idle job and `lifecycle.ts`'s boundary calls, so both write the same shape. */
export function reviewLogEntryFor(result: Awaited<ReturnType<typeof runReflect>>): {
	actions?: unknown[];
	skipped?: unknown[];
} {
	if (result.skipped) {
		return { skipped: [{ target: "reflect", reason: "no meaningful exchange" }] };
	}
	const actions: unknown[] = [];
	if (result.added.length || result.updated.length || result.deleted.length || result.touched.length) {
		actions.push({
			target: "memory",
			action: "reflect",
			added: result.added,
			updated: result.updated,
			deleted: result.deleted,
			touched: result.touched,
			condensed: result.condensed,
		});
	}
	if (result.journalAppended > 0) {
		actions.push({ target: "journal", action: "append", count: result.journalAppended });
	}
	if (result.expiredProbation.length > 0) {
		actions.push({ target: "memory", action: "expire", entries: result.expiredProbation });
	}
	const skipped = result.rejected.map((item) => ({ target: "memory", ...item }));
	return { actions, skipped: skipped.length > 0 ? skipped : undefined };
}
