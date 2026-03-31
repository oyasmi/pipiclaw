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
import type { PipiclawSessionMemorySettings } from "./context.js";
import * as log from "./log.js";
import {
	type BackgroundMaintenanceResult,
	type ConsolidationRunOptions,
	runBackgroundMaintenance,
	runInlineConsolidation,
} from "./memory-consolidation.js";
import { updateChannelSessionMemory } from "./session-memory.js";

export type ConsolidationReason = "compaction" | "new-session";

export interface MemoryLifecycleOptions {
	channelId: string;
	channelDir: string;
	getMessages: () => AgentMessage[];
	getSessionEntries: () => SessionEntry[];
	getModel: () => Model<Api>;
	resolveApiKey: (model: Model<Api>) => Promise<string>;
	getSessionMemorySettings: () => PipiclawSessionMemorySettings;
}

export class MemoryLifecycle {
	private backgroundQueue: Promise<void> = Promise.resolve();
	private turnsSinceSessionUpdate = 0;
	private toolCallsSinceSessionUpdate = 0;
	private sessionUpdatePending = false;

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

	noteToolCall(): void {
		if (!this.options.getSessionMemorySettings().enabled) {
			return;
		}
		this.toolCallsSinceSessionUpdate++;
	}

	noteCompletedAssistantTurn(): void {
		const settings = this.options.getSessionMemorySettings();
		if (!settings.enabled) {
			return;
		}

		this.turnsSinceSessionUpdate++;
		if (
			this.turnsSinceSessionUpdate >= settings.minTurnsBetweenUpdate ||
			this.toolCallsSinceSessionUpdate >= settings.minToolCallsBetweenUpdate
		) {
			this.enqueueSessionMemoryUpdate("threshold");
		}
	}

	private async refreshSessionMemory(reason: "threshold" | ConsolidationReason): Promise<boolean> {
		const settings = this.options.getSessionMemorySettings();
		if (!settings.enabled) {
			return false;
		}

		try {
			await updateChannelSessionMemory({
				channelDir: this.options.channelDir,
				messages: this.options.getMessages(),
				model: this.options.getModel(),
				resolveApiKey: this.options.resolveApiKey,
			});
			this.turnsSinceSessionUpdate = 0;
			this.toolCallsSinceSessionUpdate = 0;
			log.logInfo(`[${this.options.channelId}] Session memory updated (${reason})`);
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.logWarning(`[${this.options.channelId}] Session memory update failed (${reason})`, message);
			return false;
		}
	}

	private enqueueSessionMemoryUpdate(reason: "threshold"): void {
		if (this.sessionUpdatePending) {
			return;
		}

		this.sessionUpdatePending = true;
		this.backgroundQueue = this.backgroundQueue
			.then(async () => {
				await this.refreshSessionMemory(reason);
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				log.logWarning(`[${this.options.channelId}] Session memory queue failed`, message);
			})
			.finally(() => {
				this.sessionUpdatePending = false;
			});
	}

	private async consolidateBeforeContextDrop(
		reason: ConsolidationReason,
		messages?: AgentMessage[],
		sessionEntries?: SessionEntry[],
	): Promise<void> {
		const settings = this.options.getSessionMemorySettings();
		if (
			(reason === "compaction" && settings.forceRefreshBeforeCompact) ||
			(reason === "new-session" && settings.forceRefreshBeforeNewSession)
		) {
			await this.refreshSessionMemory(reason);
		}

		log.logInfo(`[${this.options.channelId}] Memory consolidation starting (${reason})`);
		try {
			const result = await runInlineConsolidation(this.buildRunOptions(messages, sessionEntries));
			log.logInfo(
				`[${this.options.channelId}] Memory consolidation finished (${reason}): memory entries=${result.appendedMemoryEntries}, history=${result.appendedHistoryBlock ? "yes" : "no"}`,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.logWarning(`[${this.options.channelId}] Memory consolidation failed (${reason})`, message);
		}
	}

	private async handleSessionBeforeCompact(event: SessionBeforeCompactEvent): Promise<void> {
		await this.consolidateBeforeContextDrop("compaction", event.preparation.messagesToSummarize);
	}

	private handleSessionCompact(_event: SessionCompactEvent): void {
		this.enqueueBackgroundMaintenance();
	}

	private async handleSessionBeforeSwitch(event: SessionBeforeSwitchEvent): Promise<void> {
		if (event.reason !== "new") {
			return;
		}

		await this.consolidateBeforeContextDrop("new-session");
	}

	private handleSessionSwitch(event: SessionSwitchEvent): void {
		if (event.reason !== "new") {
			return;
		}

		this.enqueueBackgroundMaintenance();
	}

	private enqueueBackgroundMaintenance(): void {
		this.backgroundQueue = this.backgroundQueue
			.then(async () => {
				const result = await runBackgroundMaintenance(this.buildRunOptions([], []));
				this.logBackgroundResult(result);
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				log.logWarning(`[${this.options.channelId}] Background memory maintenance failed`, message);
			});
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
