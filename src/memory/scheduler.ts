import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { DeskConversation } from "../desk/types.js";
import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";
import { hasBoundaryReflectWork } from "./boundary-work.js";
import { shouldRunReflect } from "./maintenance-gates.js";
import { readMemoryMaintenanceState } from "./maintenance-state.js";
import { type MemoryMaintenanceInput, resolveMemoryMaintenanceSettings } from "./maintenance-tuning.js";
import { runReflectJob } from "./reflect-job.js";

export interface MemoryMaintenanceRuntimeContext {
	conversation: DeskConversation;
	workspaceDir: string;
	/**
	 * Transcript accessors, not arrays: the scheduler visits a conversation every tick but almost
	 * every tick is denied by a cheap schedule gate. Copying (and then scanning) the whole
	 * transcript before that verdict was the entire steady-state cost of an idle daemon.
	 */
	messages: () => AgentMessage[];
	sessionEntries: () => SessionEntry[];
	model: Model<Api>;
	resolveApiKey: (model: Model<Api>) => Promise<string>;
	settings: { memoryMaintenance: MemoryMaintenanceInput };
}

export interface MemoryMaintenanceSchedulerOptions {
	appHomeDir: string;
	/**
	 * The candidates (spec 058, D12): every conversation that is currently bound, in an active
	 * desk. An unbound conversation already got its last reflect when its runner was disposed at
	 * rebind, and a dormant desk does no background work.
	 */
	getConversations: () => DeskConversation[];
	getRuntimeContext: (conversation: DeskConversation) => Promise<MemoryMaintenanceRuntimeContext | null>;
	isChannelActive: (channelId: string) => boolean;
	getSettings: () => { memoryMaintenance: MemoryMaintenanceInput };
	intervalMs?: number;
}

const DEFAULT_TICK_INTERVAL_MS = 60_000;

/**
 * Cheap due-time predicate, evaluated before `getRuntimeContext` (transcript access, model
 * resolution, settings reload) is paid for.
 *
 * Reuses the real gate with optimistic material (transcript-derived checks always pass), so the
 * only work here is one state-file read plus timestamp arithmetic. The gate's material check is a
 * purely additive restriction on top of the cheap checks (interval/backoff/idle/dirty), so
 * optimistic material can only ever make this predicate *more* permissive than the real job would
 * be — it never wrongly skips a channel the job would actually run for.
 */
async function mightReflectBeDue(input: {
	appHomeDir: string;
	conversation: DeskConversation;
	settings: { memoryMaintenance: MemoryMaintenanceInput };
	now: Date;
}): Promise<boolean> {
	if (await hasBoundaryReflectWork(input.conversation)) return true;
	if (!input.settings.memoryMaintenance.enabled) return false;
	const state = await readMemoryMaintenanceState(input.appHomeDir, input.conversation);
	return shouldRunReflect({
		now: input.now,
		state,
		maintenance: resolveMemoryMaintenanceSettings(input.settings.memoryMaintenance),
		channelActive: false,
		material: () => ({ hasNewEntry: true, hasMeaningfulExchange: true }),
	}).allowed;
}

export class MemoryMaintenanceScheduler {
	private timer: ReturnType<typeof setInterval> | null = null;
	private running = false;
	private nextIndex = 0;

	constructor(private readonly options: MemoryMaintenanceSchedulerOptions) {}

	start(): void {
		if (this.timer) {
			return;
		}
		// `enabled` is re-checked on every tick inside `runOnce`, which is nearly free when
		// disabled (one cached settings read, no channel scan). Gating `start()` on it too would
		// mean flipping `memoryMaintenance.enabled` on at runtime never actually starts the timer.
		this.timer = setInterval(() => {
			void this.runOnce().catch((error) => {
				log.logWarn("memory.scheduler.tick_failed", "Memory maintenance tick failed", {
					reason: errorMessage(error),
				});
			});
		}, this.options.intervalMs ?? DEFAULT_TICK_INTERVAL_MS);
		this.timer.unref?.();
	}

	stop(): void {
		if (!this.timer) {
			return;
		}
		clearInterval(this.timer);
		this.timer = null;
	}

	async runOnce(now = new Date()): Promise<void> {
		const settings = this.options.getSettings();
		if (this.running) {
			return;
		}

		this.running = true;
		try {
			const conversations = this.options.getConversations();
			if (conversations.length === 0) {
				return;
			}
			// One conversation per tick, round-robin: a reflect pass is an LLM call, and the first
			// due conversation is as good a place to spend it as any.
			let selected: DeskConversation | undefined;
			let index = this.nextIndex % conversations.length;
			for (let scanned = 0; scanned < conversations.length && !selected; scanned++) {
				const conversation = conversations[index];
				if (
					conversation &&
					!this.options.isChannelActive(conversation.channelId) &&
					(await mightReflectBeDue({ appHomeDir: this.options.appHomeDir, conversation, settings, now }))
				) {
					selected = conversation;
				}
				index = (index + 1) % conversations.length;
			}
			this.nextIndex = index;
			if (selected) await this.runConversationOnce(selected, now);
		} finally {
			this.running = false;
		}
	}

	private async runConversationOnce(conversation: DeskConversation, now: Date): Promise<void> {
		if (this.options.isChannelActive(conversation.channelId)) {
			return;
		}
		const context = await this.options.getRuntimeContext(conversation);
		if (!context) {
			return;
		}
		await runReflectJob({
			appHomeDir: this.options.appHomeDir,
			conversation: context.conversation,
			workspaceDir: context.workspaceDir,
			channelActive: this.options.isChannelActive(conversation.channelId),
			now,
			settings: context.settings,
			model: context.model,
			resolveApiKey: context.resolveApiKey,
			messages: context.messages,
			sessionEntries: context.sessionEntries,
		});
	}
}
