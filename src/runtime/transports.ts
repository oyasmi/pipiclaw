/**
 * The channel registry (spec 061, D9): which transports this process hosts and how a channel id
 * finds its transport. The runtime never names a concrete transport anywhere else — it asks here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BootstrapPaths } from "../app/home.js";
import { transportOf } from "../channel/channel-id.js";
import { ChannelConfigError, type EnabledChannelSections, parseChannelConfig } from "../channel/config.js";
import type { Ingress } from "../channel/ingress.js";
import type { Transport } from "../channel/transport.js";
import { StartupRefusal } from "../desk/startup-error.js";
import type { ConversationKind } from "../desk/types.js";
import * as log from "../log.js";
import { docsUrl } from "../paths.js";
import type { SecurityLogEvent } from "../security/types.js";
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
	/** Every transport stops taking messages and keeps delivering (see `Transport.stopAccepting`). */
	stopAcceptingAll(): Promise<void>;
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
		stopAcceptingAll: () => eachTransport(transports, (transport) => transport.stopAccepting()),
		stopAll: () => eachTransport(transports, (transport) => transport.stop()),
	};
}

/** Every transport gets the call even when an earlier one fails: shutdown must not strand a listener. */
async function eachTransport(
	transports: readonly Transport[],
	call: (transport: Transport) => Promise<void>,
): Promise<void> {
	await Promise.all(
		transports.map((transport) =>
			call(transport).catch((error: unknown) => {
				log.logWarn("runtime.transport.stop_failed", "Transport stop failed", {
					reason: errorMessage(error),
					fields: { transport: transport.name },
				});
			}),
		),
	);
}

/**
 * Build the transports `channel.json` turns on. A transport's code is imported only when its turn
 * comes, so a disabled transport costs nothing — not its module, not its dependencies, not a
 * listener (INV-7). A configuration that cannot be used, or that turns nothing on, refuses to start.
 */
export async function loadTransports(deps: {
	paths: BootstrapPaths;
	stateDir: string;
	archiveBotResponse: (channelId: string, text: string) => Promise<void>;
	/** The security audit log, for the transports that take requests from the network. */
	audit: (event: SecurityLogEvent) => void;
}): Promise<Transport[]> {
	const { channelConfigPath, appName } = deps.paths;
	let sections: EnabledChannelSections;
	try {
		sections = parseChannelConfig(readFileSync(channelConfigPath, "utf-8"));
	} catch (error) {
		if (!(error instanceof ChannelConfigError)) {
			throw new StartupRefusal(`Cannot read ${channelConfigPath}: ${errorMessage(error)}`);
		}
		throw new StartupRefusal(configurationRefusal(channelConfigPath, appName, error.issues));
	}

	const transports: Transport[] = [];
	try {
		if (sections.dingtalk !== undefined) {
			const [{ DingTalkTransport }, { parseDingTalkConfig }] = await Promise.all([
				import("../dingtalk/transport.js"),
				import("../dingtalk/config.js"),
			]);
			const config = parseDingTalkConfig(sections.dingtalk);
			config.stateDir = deps.stateDir;
			transports.push(new DingTalkTransport({ config, archiveBotResponse: deps.archiveBotResponse }));
		}
		if (sections.webapi !== undefined) {
			const [{ WebApiTransport }, { parseWebApiConfig }] = await Promise.all([
				import("../webapi/transport.js"),
				import("../webapi/config.js"),
			]);
			transports.push(
				new WebApiTransport({
					config: parseWebApiConfig(sections.webapi),
					stateDir: join(deps.stateDir, "webapi"),
					audit: deps.audit,
				}),
			);
		}
	} catch (error) {
		if (!(error instanceof ChannelConfigError)) throw error;
		throw new StartupRefusal(configurationRefusal(channelConfigPath, appName, error.issues));
	}

	if (transports.length === 0) {
		throw new StartupRefusal(
			`No channel is switched on in ${channelConfigPath}. Set \`dingtalk.enabled\` or \`webapi.enabled\` to true, then run \`${appName}\` again.\nDocs: ${docsUrl("configuration.md")}`,
		);
	}
	return transports;
}

function configurationRefusal(path: string, appName: string, issues: readonly string[]): string {
	return [
		`Configuration is not ready: ${path}`,
		...issues.map((issue) => `  - ${issue}`),
		"",
		`Fix ${path} and run \`${appName}\` again.`,
		`Docs: ${docsUrl("configuration.md")}`,
	].join("\n");
}
