/**
 * The channel plane's transport contract (spec 061, D4): what the runtime asks of a transport.
 * A transport does two things — hand normalized inbound messages to the runtime's `Ingress`, and
 * render the runtime's structured output in its own protocol. Everything after authorization
 * (binding, commands, busy handling, queueing) is the runtime's, never a transport's.
 */
import type { ConversationKind } from "../desk/types.js";
import type { ChannelContext } from "./channel-context.js";
import type { InboundImage } from "./channel-event.js";
import type { Ingress } from "./ingress.js";

export type TransportName = "dingtalk" | "webapi";

export interface TransportPolicy {
	/** How a plain message is handled while its channel is busy. */
	whenBusy: "steer" | "followUp" | "queue";
	/** Whether the text `/stop`, `/steer` and `/followup` are accepted; a transport with its own control calls says false. */
	textControlCommands: boolean;
}

/** What one turn is about; the transport needs it to find the right conversation to answer into. */
export interface TurnInfo {
	channelId: string;
	user: string;
	userName?: string;
	text: string;
	images?: InboundImage[];
	/** The transport's correlation reference (`InboundMessage.ref`); a wake has none. */
	ref?: string;
	ts: string;
}

export interface PushMessage {
	text: string;
	/** Names the message where the transport shows a title (DingTalk's conversation list). */
	title?: string;
	/** The text is already markdown (a command reply); a transport that would otherwise guess honours it. */
	markdown?: boolean;
	/** Answering this inbound message: the `ref` it carried. */
	ref?: string;
}

/**
 * A file the agent wants to push to a channel as a native attachment. Bytes travel in-band
 * (`data`) so the sender is decoupled from where the file physically lives: the `send_media`
 * tool reads it through its `Executor` (which may be remote) and hands over the bytes.
 */
export interface OutboundMedia {
	data: Buffer;
	/** Display name shown to the recipient (e.g. "report.pdf"). */
	fileName: string;
	/** `image` renders inline; `file` is a downloadable attachment. */
	kind: "image" | "file";
}

/** The `send_media` tool's exit: the channel's transport sends the file. */
export type SendMedia = (channelId: string, media: OutboundMedia) => Promise<MediaSendResult>;

export interface MediaSendResult {
	ok: boolean;
	/** Why it failed, written for the agent: it says what to do instead. */
	error?: string;
}

export interface Transport {
	readonly name: TransportName;
	readonly policy: TransportPolicy;
	/** Start receiving. `ingress` is the one place inbound messages go. */
	start(ingress: Ingress): Promise<void>;
	/** Stop receiving, finish what is being delivered; `ingress` is not called afterwards. */
	stop(): Promise<void>;
	/** One turn's output port. A `quiet` turn shows no progress; only its answer is delivered. */
	openTurn(turn: TurnInfo, opts: { quiet: boolean }): ChannelContext;
	/** Outside any turn: command replies, receipts, task reports, wake-failure notices. Whether it was delivered. */
	push(channelId: string, message: PushMessage): Promise<boolean>;
	/** The `send_media` tool's exit. */
	sendMedia(channelId: string, media: OutboundMedia): Promise<MediaSendResult>;
	/** How a user sees this channel in `/desk`, `/tasks`, `/events` and CHANNELS.md. */
	describe(channelId: string, knownName?: string): string;
	/** The conversation kind (`conversations/<kind>-<n>/`) this transport gives the channel; `undefined` if it is not its address. */
	conversationKindOf(channelId: string): ConversationKind | undefined;
}
