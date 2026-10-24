/**
 * The channel registry (spec 061, D9): which transports this process hosts and how a channel id
 * finds its transport. The runtime never names a concrete transport anywhere else — it asks here.
 */
import { transportOf } from "../channel/channel-id.js";
import type { Ingress } from "../channel/ingress.js";
import type { Transport } from "../channel/transport.js";
import type { ConversationKind } from "../desk/types.js";
import type { DingTalkConfig } from "../dingtalk/config.js";
import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";

export interface TransportRegistry {
	/** The transport that owns `channelId`; `undefined` when its transport is not hosted by this process. */
	forChannel(channelId: string): Transport | undefined;
	/** Whether a message can be delivered to `channelId` right now. */
	isReachable(channelId: string): boolean;
	all(): readonly Transport[];
	conversationKindOf(channelId: string): ConversationKind | undefined;
	/** How a channel is named to a user; an unreachable channel falls back to its id. */
	describeChannel(channelId: string, knownName?: string): string;
	startAll(ingress: Ingress): Promise<void>;
	stopAll(): Promise<void>;
}

export function createTransportRegistry(transports: readonly Transport[]): TransportRegistry {
	const byName = new Map(transports.map((transport) => [transport.name as string, transport]));
	const forChannel = (channelId: string): Transport | undefined => {
		const name = transportOf(channelId);
		return name === undefined ? undefined : byName.get(name);
	};
	return {
		forChannel,
		isReachable: (channelId) => forChannel(channelId) !== undefined,
		all: () => transports,
		conversationKindOf: (channelId) => forChannel(channelId)?.conversationKindOf(channelId),
		describeChannel: (channelId, knownName) =>
			forChannel(channelId)?.describe(channelId, knownName) ?? `\`${channelId}\``,
		async startAll(ingress) {
			for (const transport of transports) {
				await transport.start(ingress);
			}
		},
		async stopAll() {
			// Every transport gets its stop even when an earlier one fails: shutdown must not strand a listener.
			await Promise.all(
				transports.map((transport) =>
					transport.stop().catch((error: unknown) => {
						log.logWarn("runtime.transport.stop_failed", "Transport stop failed", {
							reason: errorMessage(error),
							fields: { transport: transport.name },
						});
					}),
				),
			);
		},
	};
}

/**
 * Build the transports the configuration turns on. A transport's code is imported only when its
 * turn comes, so a disabled transport costs nothing (INV-7).
 */
export async function loadTransports(deps: {
	dingtalkConfig: DingTalkConfig;
	archiveBotResponse: (channelId: string, text: string) => Promise<void>;
}): Promise<Transport[]> {
	const { DingTalkTransport } = await import("../dingtalk/transport.js");
	return [new DingTalkTransport({ config: deps.dingtalkConfig, archiveBotResponse: deps.archiveBotResponse })];
}
