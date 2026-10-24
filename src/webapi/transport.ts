/**
 * The Web API transport (spec 061, D4/D12): the `Transport` the runtime holds for the OpenAI
 * Responses-shaped API. A conversation is a `webapi:conv_…` channel, a request is one message to
 * the runtime's ingress, a Response is what that message turned into. The runtime never learns
 * about HTTP; this file and its neighbours never learn what a command means.
 */
import { join } from "node:path";
import type { ChannelContext } from "../channel/channel-context.js";
import type { Ingress } from "../channel/ingress.js";
import type { MediaSendResult, PushMessage, Transport, TransportPolicy, TurnInfo } from "../channel/transport.js";
import type { ConversationKind } from "../desk/types.js";
import type { SecurityLogEvent } from "../security/types.js";
import type { WebApiConfig } from "./config.js";
import { conversationIdOf } from "./ids.js";
import { WebApiServer } from "./server.js";
import { WebApiService } from "./service.js";
import { WebApiStore } from "./store.js";

export interface WebApiTransportDeps {
	config: WebApiConfig;
	/** `<app home>/state/webapi` */
	stateDir: string;
	/** Where requests and refused requests are recorded (the security audit log). */
	audit: (event: SecurityLogEvent) => void;
	/** Test overrides. */
	maxWebSocketMs?: number;
	replayTtlMs?: number;
}

/** The longest a unix socket path may be on Linux (108) with room to spare; macOS allows 104. */
const MAX_SOCKET_PATH_BYTES = 100;

export class WebApiTransport implements Transport {
	readonly name = "webapi" as const;
	readonly policy: TransportPolicy = { whenBusy: "queue", textControlCommands: false };
	private service: WebApiService | undefined;
	private server: WebApiServer | undefined;

	constructor(private readonly deps: WebApiTransportDeps) {}

	get socketPath(): string {
		return join(this.deps.stateDir, "api.sock");
	}

	private requireService(): WebApiService {
		if (!this.service) throw new Error("The Web API transport is not started");
		return this.service;
	}

	async start(ingress: Ingress): Promise<void> {
		if (this.deps.config.socket && Buffer.byteLength(this.socketPath) > MAX_SOCKET_PATH_BYTES) {
			throw new Error(
				`The Web API socket path ${this.socketPath} is too long for a unix socket; use a shorter PIPICLAW_HOME.`,
			);
		}
		const store = await WebApiStore.open(this.deps.stateDir);
		const service = new WebApiService({
			store,
			...(this.deps.replayTtlMs ? { replayTtlMs: this.deps.replayTtlMs } : {}),
		});
		service.setIngress(ingress);
		const server = new WebApiServer({
			config: this.deps.config,
			service,
			socketPath: this.socketPath,
			audit: this.deps.audit,
			...(this.deps.maxWebSocketMs ? { maxWebSocketMs: this.deps.maxWebSocketMs } : {}),
		});
		await server.start();
		this.service = service;
		this.server = server;
	}

	async stop(): Promise<void> {
		const { server, service } = this;
		this.server = undefined;
		this.service = undefined;
		await server?.stop();
		await service?.shutdown();
		await service?.store.close();
	}

	openTurn(turn: TurnInfo, opts: { quiet: boolean }): ChannelContext {
		return this.requireService().openTurn(turn, opts);
	}

	async push(channelId: string, message: PushMessage): Promise<boolean> {
		return this.service?.push(channelId, message) ?? false;
	}

	dropped(_channelId: string, refs: string[]): void {
		this.service?.dropped(refs);
	}

	async sendMedia(): Promise<MediaSendResult> {
		return {
			ok: false,
			error: "This channel cannot receive attachments. Tell the user the file's path on the server instead.",
		};
	}

	describe(channelId: string): string {
		const conversationId = conversationIdOf(channelId);
		const owner = conversationId ? this.service?.store.getConversation(conversationId)?.owner : undefined;
		if (owner === "local") return "终端";
		return owner ? `API「${owner}」` : "API 会话";
	}

	conversationKindOf(channelId: string): ConversationKind | undefined {
		return conversationIdOf(channelId) ? "webapi" : undefined;
	}
}
