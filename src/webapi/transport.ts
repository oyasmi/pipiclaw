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
import { StartupRefusal } from "../desk/startup-error.js";
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
	/** Optional path to `channel.json` so `webapi.keys` updates take effect without restarting the daemon. */
	channelConfigPath?: string;
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
			throw new StartupRefusal(
				`Web API 本机 socket 路径过长（${this.socketPath}），超出系统 Unix Socket 长度限制；请通过 PIPICLAW_HOME 指定更短的目录路径。`,
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
			channelConfigPath: this.deps.channelConfigPath,
			audit: this.deps.audit,
			...(this.deps.maxWebSocketMs ? { maxWebSocketMs: this.deps.maxWebSocketMs } : {}),
		});
		try {
			await server.start();
		} catch (error) {
			// Nothing is kept on `this`, so `stop()` could not reach these: release them here.
			await service.shutdown().catch(() => undefined);
			await store.close().catch(() => undefined);
			const code =
				error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
			if (this.deps.config.tcp && (code === "EADDRINUSE" || code === "EACCES")) {
				const address = `${this.deps.config.tcp.host}:${this.deps.config.tcp.port}`;
				const where = this.deps.channelConfigPath ?? "channel.json";
				throw new StartupRefusal(
					code === "EADDRINUSE"
						? `Web API 无法监听 ${address}：该端口已被其他进程占用。\n请关闭占用该端口的程序，或在 ${where} 中修改 \`webapi.tcp\` 端口（若仅使用终端 TUI，也可将 \`webapi.tcp\` 设为 null）。`
						: `Web API 无权限监听 ${address}。\n请在 ${where} 中将 \`webapi.tcp\` 修改为 1024 以上的可用端口。`,
				);
			}
			throw error;
		}
		this.service = service;
		this.server = server;
	}

	/**
	 * New requests are refused from now on (503), while connections stay open: a running response
	 * keeps streaming to its caller until the runtime has let the turn finish.
	 */
	async stopAccepting(): Promise<void> {
		this.service?.stopAccepting();
	}

	async stop(): Promise<void> {
		const server = this.server;
		const service = this.service;
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

	/** No download endpoint exists for a produced file, so `send_media` is not offered here. */
	readonly sendsMedia = false;

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
