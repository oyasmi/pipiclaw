/**
 * The DingTalk transport (spec 061, D4/D27): the `Transport` the runtime holds. It composes the
 * Stream bot (connection, inbound, cards, media, plain sends) with the per-turn delivery, and
 * decides nothing about what a message means — that is the runtime's `Ingress`.
 */
import type { ChannelContext } from "../channel/channel-context.js";
import type { Ingress } from "../channel/ingress.js";
import type {
	MediaSendResult,
	OutboundMedia,
	PushMessage,
	Transport,
	TransportPolicy,
	TurnInfo,
} from "../channel/transport.js";
import type { ConversationKind } from "../desk/types.js";
import { DingTalkBot } from "./bot.js";
import { describeDingTalkChannel, parseDingTalkChannelId } from "./channel-ids.js";
import type { DingTalkConfig } from "./config.js";
import { type ArchiveBotResponse, createDingTalkContext } from "./delivery.js";

export interface DingTalkTransportDeps {
	config: DingTalkConfig;
	/** Records a delivered answer in the channel's conversation log (log.jsonl). */
	archiveBotResponse: ArchiveBotResponse;
	/** Tests replace the bot to run the real delivery against a fake DingTalk API. */
	createBot?: (ingress: Pick<Ingress, "receive">, config: DingTalkConfig) => DingTalkBot;
}

export class DingTalkTransport implements Transport {
	readonly name = "dingtalk" as const;
	readonly policy: TransportPolicy;
	readonly bot: DingTalkBot;
	private ingress: Ingress | undefined;

	constructor(private readonly deps: DingTalkTransportDeps) {
		const ingress = {
			receive: (message: Parameters<Ingress["receive"]>[0]) => this.requireIngress().receive(message),
		};
		this.bot = deps.createBot ? deps.createBot(ingress, deps.config) : new DingTalkBot(ingress, deps.config);
		this.policy = { whenBusy: this.bot.busyMessageDefault, textControlCommands: true };
	}

	private requireIngress(): Ingress {
		if (!this.ingress) throw new Error("DingTalk transport received a message before it was started");
		return this.ingress;
	}

	/**
	 * Begin the Stream connection. Not awaited: the first connect has its own timeout and keeps
	 * retrying in the background, and a daemon whose DingTalk is briefly unreachable still boots.
	 */
	async start(ingress: Ingress): Promise<void> {
		this.ingress = ingress;
		void this.bot.start();
	}

	async stop(): Promise<void> {
		await this.bot.stop();
	}

	openTurn(turn: TurnInfo, opts: { quiet: boolean }): ChannelContext {
		const releaseConnection = this.bot.holdConnection();
		const inner = createDingTalkContext(turn, this.bot, this.deps.archiveBotResponse, opts.quiet);
		return {
			emit: (event) => inner.emit(event),
			finish: async (outcome) => {
				try {
					await inner.finish(outcome);
				} finally {
					releaseConnection();
				}
			},
		};
	}

	push(channelId: string, message: PushMessage): Promise<boolean> {
		const opts =
			message.title !== undefined || message.markdown !== undefined
				? {
						...(message.title !== undefined ? { title: message.title } : {}),
						...(message.markdown !== undefined ? { markdown: message.markdown } : {}),
					}
				: undefined;
		return this.bot.sendPlain(channelId, message.text, opts);
	}

	sendMedia(channelId: string, media: OutboundMedia): Promise<MediaSendResult> {
		return this.bot.sendMedia(channelId, media);
	}

	describe(channelId: string, knownName?: string): string {
		return describeDingTalkChannel(channelId, knownName);
	}

	conversationKindOf(channelId: string): ConversationKind | undefined {
		return parseDingTalkChannelId(channelId)?.kind;
	}
}
