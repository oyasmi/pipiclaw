import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { DeskConversation } from "../desk/types.js";
import { formatLocalTime } from "../shared/local-time.js";
import { errorMessage } from "../shared/text-utils.js";
import { drainBoundaryReflectWork, hasBoundaryReflectWork } from "./boundary-work.js";
import { type DeskMemoryQueue, getDeskMemoryQueue } from "./desk-memory-queue.js";
import { shouldRunReflect } from "./maintenance-gates.js";
import { readMemoryMaintenanceState, updateMemoryMaintenanceState } from "./maintenance-state.js";
import {
	type MemoryMaintenanceInput,
	type MemoryMaintenanceSettings,
	resolveMemoryMaintenanceSettings,
} from "./maintenance-tuning.js";
import { runReflect } from "./reflect.js";
import { reviewLogEntryFor, tryAppendMemoryReviewLog } from "./review-log.js";
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
	/** The conversation to reflect on; its maintenance state is per conversation, its memory per desk. */
	conversation: DeskConversation;
	workspaceDir: string;
	channelActive: boolean;
	now?: Date;
	settings: { memoryMaintenance: MemoryMaintenanceInput };
	model: Model<Api>;
	resolveApiKey: (model: Model<Api>) => Promise<string>;
	/** Transcript accessors: only called once the gate has decided the job may actually run. */
	messages: () => AgentMessage[];
	sessionEntries: () => SessionEntry[];
	queue?: DeskMemoryQueue;
}

function backoffUntil(now: Date, settings: MemoryMaintenanceSettings): string {
	return formatLocalTime(new Date(now.getTime() + Math.max(0, settings.failureBackoffMinutes) * 60_000));
}

export async function runReflectJob(input: ReflectJobInput): Promise<void> {
	const queue = input.queue ?? getDeskMemoryQueue();
	const { conversation } = input;
	const { channelId, deskDir } = conversation;
	if (await hasBoundaryReflectWork(conversation)) {
		await drainBoundaryReflectWork({ ...input, queue });
		return;
	}
	if (!input.settings.memoryMaintenance.enabled) return;
	return queue.run(conversation, async () => {
		if (await hasBoundaryReflectWork(conversation)) return;
		const now = input.now ?? new Date();
		const maintenance = resolveMemoryMaintenanceSettings(input.settings.memoryMaintenance);
		const state = await readMemoryMaintenanceState(input.appHomeDir, conversation);
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
			maintenance,
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
			await tryAppendMemoryReviewLog(deskDir, {
				timestamp: formatLocalTime(now),
				channelId: channelId,
				reason: "reflect",
				skipped: [{ target: "reflect", reason: decision.skipReason }],
			});
			return;
		}

		const sourceWindow = loadSourceWindow();
		try {
			const result = await runReflect({
				channelId: channelId,
				deskDir: deskDir,
				workspaceDir: input.workspaceDir,
				model: input.model,
				resolveApiKey: input.resolveApiKey,
				messages: sourceWindow.messages,
				usageContext: { channelId, desk: conversation.desk, correlationId: sourceWindow.windowId },
			});
			await updateMemoryMaintenanceState(input.appHomeDir, conversation, (current) => ({
				...current,
				lastReflectAt: sourceWindow.hasMore ? current.lastReflectAt : formatLocalTime(now),
				lastReflectedEntryId: sourceWindow.throughEntryId ?? current.lastReflectedEntryId,
				failureBackoffUntil: null,
			}));
			await tryAppendMemoryReviewLog(deskDir, {
				timestamp: formatLocalTime(now),
				channelId: channelId,
				reason: "reflect",
				correlationId: sourceWindow.windowId,
				...reviewLogEntryFor(result, sourceWindow),
			});
		} catch (error) {
			await updateMemoryMaintenanceState(input.appHomeDir, conversation, (current) => ({
				...current,
				failureBackoffUntil: backoffUntil(now, maintenance),
			}));
			const message = errorMessage(error);
			await tryAppendMemoryReviewLog(deskDir, {
				timestamp: formatLocalTime(now),
				channelId: channelId,
				reason: "reflect",
				error: message,
			});
		}
	});
}
