/**
 * The contract between the DingTalk transport and the runtime that drives it: what the runtime
 * implements (`DingTalkHandler`) and the slice of the bot it may call back into (`DingTalkBotPort`).
 * Declared here, below `bot.ts`, so the bot and the runtime both depend on it and not on each other.
 */
import type { FinalDelivery, ProgressStyle } from "../channel/channel-context.js";
import type { ChannelEvent, HumanEvent, InboundImage } from "../channel/channel-event.js";
import type { ChannelObservation } from "../channel/channel-index.js";
import type { RuntimeCommandName } from "../commands/catalog.js";
import type { BusyMessageMode } from "./config.js";

/**
 * `DingTalkEvent` is kept as the public name (spec 035 D4: `src/index.ts`'s barrel is a
 * compatibility promise, so exported names there stay stable). Internally the type now lives in
 * `channel-event.ts` as `ChannelEvent`: most producers of this shape are not DingTalk at all
 * (jobs/manager, task-driver, events, subagents/runs all synthesize wakes), so `ChannelEvent` is
 * what the rest of the runtime imports.
 */
export type DingTalkEvent = ChannelEvent;

export type BusyMessageResult = { kind: "handled" } | { kind: "requeue"; text: string };

/**
 * What `/stop` actually did. Stopping a task-driven turn also pauses that task, which the user
 * has to be told: a disabled task is never picked up again until `/tasks resume <id>`, so silence
 * here reads as "the turn was interrupted" while the whole task has in fact gone quiet.
 */
export interface StopOutcome {
	pausedTaskId?: string;
}

/**
 * The part of `DingTalkBot` that the runtime's handler and the delivery controller use. `DingTalkBot`
 * implements it; keeping it structural lets this contract stay free of an import cycle with the bot.
 */
export interface DingTalkBotPort {
	readonly progressStyle: ProgressStyle;
	readonly finalDelivery: FinalDelivery;
	sendPlain(channelId: string, text: string, opts?: { title?: string; markdown?: boolean }): Promise<boolean>;
	getCardGeneration(channelId: string): symbol;
	isCardGenerationCurrent(channelId: string, generation: symbol): boolean;
	replaceCard(
		channelId: string,
		content: string,
		finalize?: boolean,
		failed?: boolean,
		generation?: symbol,
	): Promise<boolean>;
	appendToCard(
		channelId: string,
		content: string,
		finalize?: boolean,
		failed?: boolean,
		generation?: symbol,
	): Promise<boolean>;
	finalizeCard(channelId: string, content: string, generation?: symbol): Promise<boolean>;
	finalizeExistingCard(channelId: string, content: string, generation?: symbol): Promise<boolean>;
	discardCard(channelId: string, generation?: symbol): void;
	clearPendingMessages(channelId: string): number;
	resetChannelQueue(channelId: string): number;
}

export interface DingTalkHandler {
	isRunning(channelId: string): boolean;
	/** After sender authorization, before attachments or commands: establish the default binding. */
	prepareChannel?(channelId: string): Promise<void>;
	/**
	 * Note that a real person just wrote in this channel. Called once per accepted inbound
	 * message, before any busy/command routing, and never for synthetic wakes — see the
	 * maintenance contract in `channel-index.ts`. Must stay synchronous and cheap.
	 */
	noteChannelActivity?(observation: ChannelObservation): void;
	/**
	 * Synchronously reserve an inbound turn before the queued async body yields.
	 * The transport calls this hook, when provided, immediately before `handleEvent`.
	 */
	reserveEvent?(event: DingTalkEvent): void;
	handleEvent(event: DingTalkEvent, bot: DingTalkBotPort): Promise<void>;
	handleStop(channelId: string, bot: DingTalkBotPort): Promise<StopOutcome>;
	/** `/new` bypasses the old per-channel queue and live SDK session. */
	handleNewSession(event: HumanEvent, bot: DingTalkBotPort): Promise<void>;
	/**
	 * Render one of the stateless report commands (events/tasks/status/usage/context/subagents) to
	 * text. Single dispatch point shared by the busy-turn switch below and bootstrap's idle-turn
	 * switch — both used to hand-copy the same six-case table.
	 */
	runRuntimeCommand(event: DingTalkEvent, name: RuntimeCommandName, args: string): Promise<string>;
	handleBusyMessage(
		event: HumanEvent,
		bot: DingTalkBotPort,
		mode: BusyMessageMode,
		queueText: string,
	): Promise<BusyMessageResult>;
	/**
	 * Persist one downloaded inbound image under the channel's `inbox/` (spec 049). Owned by
	 * bootstrap — it holds the workspace root — not the transport, which only knows how to fetch
	 * bytes over the DingTalk API. `mimeType` is `null` when magic-byte sniffing did not recognize
	 * a supported image format; the file is still persisted (for the archive/record) but the
	 * transport excludes it from the model-facing text marker. Returns `null` on a local I/O
	 * failure, surfaced to the user as "保存失败" — the rest of the message is still delivered.
	 */
	persistInboundImage?(
		channelId: string,
		image: { data: Buffer; mimeType: string | null },
	): Promise<InboundImage | null>;
}
