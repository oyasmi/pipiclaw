import type { ChannelContext, TurnEvent, TurnOutcome } from "../../src/channel/channel-context.js";
import type { InboundMessage, Ingress, IngressResult } from "../../src/channel/ingress.js";
import type {
	MediaSendResult,
	OutboundMedia,
	PushMessage,
	Transport,
	TransportPolicy,
	TurnInfo,
} from "../../src/channel/transport.js";
import type { ConversationKind } from "../../src/desk/types.js";
import { parseDingTalkChannelId } from "../../src/dingtalk/channel-ids.js";

export interface RecordedTurn {
	turn: TurnInfo;
	quiet: boolean;
	events: TurnEvent[];
	outcome?: TurnOutcome;
}

/**
 * A real `Transport` for tests that drive the runtime without any wire protocol. It stands in for
 * DingTalk (`name: "dingtalk"`, so `dingtalk:…` channel ids route to it) and records what the
 * runtime asks of a transport: every opened turn with its events and outcome, every push, every
 * media send. Inbound messages go through the real `Ingress` it was started with.
 */
export class RecordingTransport implements Transport {
	readonly name = "dingtalk" as const;
	readonly turns: RecordedTurn[] = [];
	readonly pushes: Array<{ channelId: string; message: PushMessage }> = [];
	readonly media: Array<{ channelId: string; media: OutboundMedia }> = [];
	ingress: Ingress | undefined;
	pushResult = true;

	constructor(public policy: TransportPolicy = { whenBusy: "steer", textControlCommands: true }) {}

	async start(ingress: Ingress): Promise<void> {
		this.ingress = ingress;
	}

	async stop(): Promise<void> {}

	openTurn(turn: TurnInfo, opts: { quiet: boolean }): ChannelContext {
		const recorded: RecordedTurn = { turn, quiet: opts.quiet, events: [] };
		this.turns.push(recorded);
		return {
			emit: (event) => {
				recorded.events.push(event);
			},
			finish: async (outcome) => {
				recorded.outcome ??= outcome;
			},
		};
	}

	async push(channelId: string, message: PushMessage): Promise<boolean> {
		this.pushes.push({ channelId, message });
		return this.pushResult;
	}

	async sendMedia(channelId: string, media: OutboundMedia): Promise<MediaSendResult> {
		this.media.push({ channelId, media });
		return { ok: true };
	}

	describe(channelId: string, knownName?: string): string {
		return knownName ? `「${knownName}」` : `\`${channelId}\``;
	}

	conversationKindOf(channelId: string): ConversationKind | undefined {
		return parseDingTalkChannelId(channelId)?.kind;
	}

	/** A message from `user` on `channelId`, through the real ingress. */
	receive(text: string, overrides: Partial<InboundMessage> = {}): Promise<IngressResult> {
		if (!this.ingress) throw new Error("RecordingTransport is not started");
		return this.ingress.receive({
			channelId: "dingtalk:dm:tester",
			user: "tester",
			userName: "Tester",
			text,
			ts: Date.now().toString(),
			...overrides,
		});
	}

	pushedTexts(): string[] {
		return this.pushes.map((entry) => entry.message.text);
	}
}
