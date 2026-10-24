import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboundMessage, IngressResult } from "../src/channel/ingress.js";

const { axiosMock, fakeClientState } = vi.hoisted(() => {
	const post = vi.fn();
	const put = vi.fn();
	const get = vi.fn();
	const defaults = { proxy: true };
	const instance = {
		post,
		put,
		get,
		defaults,
		isAxiosError: (error: unknown) => Boolean((error as { isAxiosError?: boolean })?.isAxiosError),
	};
	return {
		axiosMock: {
			...instance,
			// axios.create() returns a configured instance; route it back to the same
			// spies so tests assert on a single post/put mock regardless of call site.
			create: vi.fn(() => instance),
		},
		fakeClientState: {
			connectImpl: null as null | ((state: any) => Promise<void>),
			disconnectImpl: null as null | ((state: any) => Promise<void>),
			instances: [] as Array<{
				config: Record<string, unknown>;
				connect: ReturnType<typeof vi.fn>;
				disconnect: ReturnType<typeof vi.fn>;
				socket: {
					readyState: number;
					ping: ReturnType<typeof vi.fn>;
					on: ReturnType<typeof vi.fn>;
					close: ReturnType<typeof vi.fn>;
					terminate: ReturnType<typeof vi.fn>;
					removeAllListeners: ReturnType<typeof vi.fn>;
				};
			}>,
		},
	};
});

vi.mock("axios", () => ({
	default: axiosMock,
}));

vi.mock("dingtalk-stream", () => ({
	DWClient: class {
		socket;
		config;
		registerCallbackListener = vi.fn();
		socketCallBackResponse = vi.fn();
		connect;
		disconnect;

		constructor(config: unknown) {
			this.config = config as Record<string, unknown>;
			const createSocket = () => ({
				readyState: 1,
				ping: vi.fn(),
				on: vi.fn(),
				close: vi.fn(() => {
					this.socket.readyState = 3;
				}),
				terminate: vi.fn(() => {
					this.socket.readyState = 3;
				}),
				removeAllListeners: vi.fn(),
			});
			this.socket = createSocket();
			this.connect = vi.fn(() => {
				if (fakeClientState.connectImpl) {
					return fakeClientState.connectImpl(this);
				}
				if (!this.socket || this.socket.readyState === 3) {
					this.socket = createSocket();
				} else {
					this.socket.readyState = 1;
				}
				return Promise.resolve();
			});
			this.disconnect = vi.fn(() => fakeClientState.disconnectImpl?.(this) ?? Promise.resolve());
			fakeClientState.instances.push(this);
		}
	},
	TOPIC_ROBOT: "TOPIC_ROBOT",
}));

import { DingTalkBot } from "../src/dingtalk/bot.js";
import { ConversationMetaStore } from "../src/dingtalk/conversation-meta.js";
import { useTempDirs } from "./helpers/fixtures.js";

const createTempDir = useTempDirs("pipiclaw-dingtalk-");

function createIngress() {
	return { receive: vi.fn(async (_message: InboundMessage): Promise<IngressResult> => ({ kind: "started" })) };
}

function createBot(configOverrides: Partial<ConstructorParameters<typeof DingTalkBot>[1]> = {}): {
	bot: DingTalkBot;
	ingress: ReturnType<typeof createIngress>;
	stateDir: string;
} {
	const stateDir = createTempDir();
	const ingress = createIngress();
	const bot = new DingTalkBot(ingress, {
		clientId: "client-id",
		clientSecret: "client-secret",
		cardTemplateId: "tmpl",
		cardTemplateKey: "content",
		stateDir,
		...configOverrides,
	});
	return { bot, ingress, stateDir };
}

/** The bot's collaborators, reached through their private fields (the bot keeps no state of its own for them). */
type PrivateBotApi = {
	tokens: { accessToken: string | null; tokenExpiry: number; get(): Promise<string | null> };
	conversations: {
		get(channelId: string): { conversationId: string; conversationType: string; senderId: string } | null;
		set(channelId: string, meta: { conversationId: string; conversationType: string; senderId: string }): void;
	};
	inbound: {
		onStreamMessage(data: Record<string, unknown>): Promise<void>;
		handleRawMessage(message: { headers?: { messageId?: string }; data: unknown }): {
			status: "SUCCESS";
			message: string;
		};
	};
	connection: { client: unknown; isReconnecting: boolean; doReconnect(immediate?: boolean): Promise<boolean> };
};

function getPrivateApi(bot: DingTalkBot): PrivateBotApi {
	return bot as unknown as PrivateBotApi;
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function createSocketMock(readyState = 1) {
	const socket = {
		readyState,
		ping: vi.fn(),
		on: vi.fn(),
		close: vi.fn(() => {
			socket.readyState = 3;
		}),
		terminate: vi.fn(() => {
			socket.readyState = 3;
		}),
		removeAllListeners: vi.fn(),
	};
	return socket;
}

beforeEach(() => {
	vi.useFakeTimers();
	axiosMock.post.mockReset();
	axiosMock.put.mockReset();
	axiosMock.get.mockReset();
	axiosMock.defaults.proxy = true;
	fakeClientState.connectImpl = null;
	fakeClientState.disconnectImpl = null;
	fakeClientState.instances.length = 0;
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("dingtalk", () => {
	// `parseInboundMessage` itself (text/picture/richText shapes, marker placement) is covered by
	// its own unit tests in test/inbound-media.test.ts (spec 049); these cases drive the transport.
	it("hands authorized messages to the ingress as DM and group channels and persists metadata", async () => {
		const { bot, ingress, stateDir } = createBot();
		const privateApi = getPrivateApi(bot);

		await privateApi.inbound.onStreamMessage({
			text: { content: "check dm" },
			senderStaffId: "staff_1",
			senderNick: "Alice",
			conversationId: "conv_dm",
			conversationType: "1",
		});
		await flushMicrotasks();

		expect(ingress.receive).toHaveBeenCalledWith(
			expect.objectContaining({
				channelId: "dingtalk:dm:staff_1",
				user: "staff_1",
				userName: "Alice",
				text: "check dm",
				// A DM has no title, so the peer's nickname is the only handle it will ever have.
				channelName: "Alice",
			}),
		);

		await privateApi.inbound.onStreamMessage({
			text: { content: "check group" },
			senderStaffId: "staff_2",
			senderNick: "Bob",
			conversationId: "conv_group",
			conversationType: "2",
			conversationTitle: "  投资理财  ",
		});
		await flushMicrotasks();

		expect(ingress.receive).toHaveBeenCalledWith(
			expect.objectContaining({
				channelId: "dingtalk:group:conv_group",
				text: "check group",
				channelName: "投资理财",
			}),
		);

		// Spec 058, D17: one file for every channel, keyed by channel id.
		const metadataPath = join(stateDir, "dingtalk", "conversations.json");
		expect(existsSync(metadataPath)).toBe(true);
		expect(JSON.parse(readFileSync(metadataPath, "utf-8"))["dingtalk:group:conv_group"]).toMatchObject({
			conversationId: "conv_group",
			conversationType: "2",
			senderId: "staff_2",
		});
	});

	it("ignores senders outside the allow-list entirely", async () => {
		const guarded = createBot({ allowFrom: ["staff_ok"] });
		const api = getPrivateApi(guarded.bot);
		const message = (sender: string) => ({
			text: { content: "hello" },
			senderStaffId: sender,
			senderNick: "X",
			conversationId: "conv_group",
			conversationType: "2",
			conversationTitle: "投资理财",
		});

		await api.inbound.onStreamMessage(message("staff_nope"));
		await flushMicrotasks();
		expect(guarded.ingress.receive).not.toHaveBeenCalled();

		await api.inbound.onStreamMessage(message("staff_ok"));
		await flushMicrotasks();
		expect(guarded.ingress.receive).toHaveBeenCalledTimes(1);
	});

	it("refreshes, caches, and coalesces access token requests", async () => {
		const { bot } = createBot();
		const privateApi = getPrivateApi(bot);

		axiosMock.post.mockResolvedValueOnce({
			data: { accessToken: "token-1", expireIn: 7200 },
		});

		await expect(privateApi.tokens.get()).resolves.toBe("token-1");
		await expect(privateApi.tokens.get()).resolves.toBe("token-1");
		expect(axiosMock.post).toHaveBeenCalledTimes(1);

		privateApi.tokens.accessToken = null;
		privateApi.tokens.tokenExpiry = 0;

		let resolveToken: ((value: { data: { accessToken: string; expireIn: number } }) => void) | null = null;
		axiosMock.post.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveToken = resolve;
				}),
		);

		const first = privateApi.tokens.get();
		const second = privateApi.tokens.get();
		expect(axiosMock.post).toHaveBeenCalledTimes(2);

		expect(resolveToken).not.toBeNull();
		resolveToken!({ data: { accessToken: "token-2", expireIn: 7200 } });
		await expect(first).resolves.toBe("token-2");
		await expect(second).resolves.toBe("token-2");
		expect(axiosMock.post).toHaveBeenCalledTimes(2);
	});

	// spec 049: inbound image download + persistence. `parseInboundMessage`'s own shape/marker
	// coverage lives in test/inbound-media.test.ts; these exercise the network round-trip and the
	// per-channel serialization the transport wraps around it.
	describe("inbound image attachments", () => {
		const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

		function setCachedToken(bot: DingTalkBot): void {
			getPrivateApi(bot).tokens.accessToken = "cached-token";
			getPrivateApi(bot).tokens.tokenExpiry = Date.now() / 1000 + 3600;
		}

		function mockDownload(fileBytes: Buffer): void {
			axiosMock.post.mockResolvedValueOnce({ data: { downloadUrl: "https://example.invalid/file" } });
			axiosMock.get.mockResolvedValueOnce({ data: fileBytes });
		}

		it("downloads a picture message and hands its bytes to the ingress as an attachment", async () => {
			const { bot, ingress } = createBot();
			setCachedToken(bot);
			mockDownload(JPEG_BYTES);
			const privateApi = getPrivateApi(bot);

			await privateApi.inbound.onStreamMessage({
				msgtype: "picture",
				senderStaffId: "staff_1",
				senderNick: "Alice",
				conversationId: "conv_dm",
				conversationType: "1",
				content: { downloadCode: "code-1" },
			});
			await flushMicrotasks();

			// The transport only downloads: persisting, sniffing the format and settling the marker
			// are the runtime's (`inbound-images.test.ts`).
			expect(ingress.receive).toHaveBeenCalledWith(
				expect.objectContaining({
					text: "[图片1]",
					attachments: [{ kind: "image", index: 1, data: JPEG_BYTES }],
				}),
			);
			// The credential exchange must name the message's own downloadCode, not a stray value.
			expect(axiosMock.post).toHaveBeenCalledWith(
				expect.stringContaining("/v1.0/robot/messageFiles/download"),
				expect.objectContaining({ downloadCode: "code-1" }),
				expect.anything(),
			);
		});

		it("keeps the rest of the message when one image fails to download", async () => {
			const { bot, ingress } = createBot();
			setCachedToken(bot);
			axiosMock.post.mockResolvedValueOnce({ data: { downloadUrl: "https://example.invalid/file" } });
			axiosMock.get.mockRejectedValueOnce(new Error("network down"));
			const privateApi = getPrivateApi(bot);

			await privateApi.inbound.onStreamMessage({
				msgtype: "picture",
				senderStaffId: "staff_1",
				senderNick: "Alice",
				conversationId: "conv_dm",
				conversationType: "1",
				content: { downloadCode: "code-1" },
			});
			await flushMicrotasks();

			expect(ingress.receive).toHaveBeenCalledWith(expect.objectContaining({ text: "[图片1：接收失败]" }));
			const sent = ingress.receive.mock.calls[0]?.[0];
			expect(sent && "attachments" in sent).toBe(false);
		});

		it("never overtakes a download in the channel's delivery order (spec 049 D3)", async () => {
			const { bot, ingress } = createBot();
			setCachedToken(bot);
			const privateApi = getPrivateApi(bot);

			// The first message's file download hangs until released below; a second, download-free
			// message on the *same* channel arrives while it is still in flight.
			const download: { release?: () => void } = {};
			axiosMock.post.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						download.release = () => resolve({ data: { downloadUrl: "https://example.invalid/file" } });
					}),
			);
			axiosMock.get.mockResolvedValueOnce({ data: JPEG_BYTES });

			const firstMessage = privateApi.inbound.onStreamMessage({
				msgtype: "picture",
				senderStaffId: "staff_1",
				senderNick: "Alice",
				conversationId: "conv_dm",
				conversationType: "1",
				content: { downloadCode: "code-1" },
			});
			await flushMicrotasks();
			expect(ingress.receive).not.toHaveBeenCalled();

			// Fire-and-forget, exactly like the production socket callback (`handleRawMessage`
			// never awaits `onStreamMessage`) — the second message's own ingestion job is chained
			// behind the first's on the same channel, so awaiting it here would itself hang until
			// the first message's download is released below.
			const secondMessage = privateApi.inbound.onStreamMessage({
				text: { content: "second, no image" },
				senderStaffId: "staff_1",
				senderNick: "Alice",
				conversationId: "conv_dm",
				conversationType: "1",
			});
			await flushMicrotasks();

			// Without the per-channel ingestion queue (spec 049 D3), the second message — which
			// needs no download — would already have reached the ingress here.
			expect(ingress.receive).not.toHaveBeenCalled();

			download.release?.();
			await firstMessage;
			await secondMessage;
			await flushMicrotasks();

			expect(ingress.receive).toHaveBeenNthCalledWith(1, expect.objectContaining({ text: "[图片1]" }));
			expect(ingress.receive).toHaveBeenNthCalledWith(2, expect.objectContaining({ text: "second, no image" }));
		});

		it("reports in-flight downloads as pending ingest", async () => {
			const { bot } = createBot();
			setCachedToken(bot);
			const privateApi = getPrivateApi(bot);

			const download: { release?: () => void } = {};
			axiosMock.post.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						download.release = () => resolve({ data: { downloadUrl: "https://example.invalid/file" } });
					}),
			);
			axiosMock.get.mockResolvedValueOnce({ data: JPEG_BYTES });

			const pending = privateApi.inbound.onStreamMessage({
				msgtype: "picture",
				senderStaffId: "staff_1",
				senderNick: "Alice",
				conversationId: "conv_dm",
				conversationType: "1",
				content: { downloadCode: "code-1" },
			});
			await flushMicrotasks();

			expect(bot.hasPendingIngest()).toBe(true);

			download.release?.();
			await pending;
			await flushMicrotasks();

			expect(bot.hasPendingIngest()).toBe(false);
		});
	});

	it("persists conversation metadata, reloads it after a restart, writes only on change or after a failed write", () => {
		const { bot, stateDir } = createBot();
		const privateApi = getPrivateApi(bot);
		const meta = { conversationId: "conv_1", conversationType: "1", senderId: "staff_1" };

		privateApi.conversations.set("dingtalk:dm:staff_1", meta);
		// A fresh store — the next process — routes the channel from disk alone.
		expect(new ConversationMetaStore({ stateDir }, () => {}).get("dingtalk:dm:staff_1")).toEqual(meta);

		// D17: every inbound message calls set(); an unchanged entry must not rewrite the file.
		const metadataPath = join(stateDir, "dingtalk", "conversations.json");
		writeFileSync(metadataPath, JSON.stringify({ "dingtalk:dm:staff_1": meta, marker: meta }));
		privateApi.conversations.set("dingtalk:dm:staff_1", meta);
		expect(JSON.parse(readFileSync(metadataPath, "utf-8")).marker).toEqual(meta);

		// …but after a failed write, the same value is written again once the disk recovers, or the
		// channel would route only until the next restart.
		const dm2 = { ...meta, senderId: "staff_2" };
		rmSync(metadataPath);
		mkdirSync(join(metadataPath, "blocker"), { recursive: true });
		privateApi.conversations.set("dingtalk:dm:staff_2", dm2);
		rmSync(metadataPath, { recursive: true });
		privateApi.conversations.set("dingtalk:dm:staff_2", dm2);
		expect(new ConversationMetaStore({ stateDir }, () => {}).get("dingtalk:dm:staff_2")).toEqual(dm2);
	});

	it("sends plain DM and group messages using cached metadata", async () => {
		const { bot } = createBot();
		const privateApi = getPrivateApi(bot);
		getPrivateApi(bot).tokens.accessToken = "cached-token";
		getPrivateApi(bot).tokens.tokenExpiry = Date.now() / 1000 + 3600;
		axiosMock.post.mockResolvedValue({ data: {} });

		privateApi.conversations.set("dingtalk:dm:staff_1", {
			conversationId: "conv_1",
			conversationType: "1",
			senderId: "staff_1",
		});
		await expect(bot.sendPlain("dingtalk:dm:staff_1", "hello")).resolves.toBe(true);
		expect(axiosMock.post).toHaveBeenLastCalledWith(
			expect.stringContaining("/oToMessages/batchSend"),
			expect.objectContaining({
				msgKey: "sampleText",
				userIds: ["staff_1"],
			}),
			expect.any(Object),
		);

		privateApi.conversations.set("dingtalk:group:conv_2", {
			conversationId: "conv_2",
			conversationType: "2",
			senderId: "staff_2",
		});
		await expect(bot.sendPlain("dingtalk:group:conv_2", "# title")).resolves.toBe(true);
		expect(axiosMock.post).toHaveBeenLastCalledWith(
			expect.stringContaining("/groupMessages/send"),
			expect.objectContaining({
				msgKey: "sampleMarkdown",
				openConversationId: "conv_2",
			}),
			expect.any(Object),
		);
	});

	it("supports append and replace card streaming payloads", async () => {
		const { bot } = createBot();
		const privateApi = getPrivateApi(bot);
		getPrivateApi(bot).tokens.accessToken = "cached-token";
		getPrivateApi(bot).tokens.tokenExpiry = Date.now() / 1000 + 3600;
		axiosMock.post.mockResolvedValue({ data: {} });
		axiosMock.put.mockResolvedValue({ data: {} });

		privateApi.conversations.set("dingtalk:dm:staff_1", {
			conversationId: "conv_1",
			conversationType: "1",
			senderId: "staff_1",
		});

		await expect(bot.appendToCard("dingtalk:dm:staff_1", "hello")).resolves.toBe(true);
		expect(axiosMock.post).toHaveBeenCalledWith(
			expect.stringContaining("/card/instances/createAndDeliver"),
			expect.objectContaining({
				cardData: {
					cardParamMap: {
						content: expect.stringMatching(/\S/),
						sys_full_json_obj: JSON.stringify({
							config: {
								autoLayout: true,
							},
						}),
					},
				},
			}),
			expect.any(Object),
		);
		expect(axiosMock.put).toHaveBeenLastCalledWith(
			expect.stringContaining("/card/streaming"),
			expect.objectContaining({
				content: "hello",
				append: true,
				finished: false,
				failed: false,
				isFull: false,
				isFinalize: false,
				isError: false,
			}),
			expect.any(Object),
		);

		await expect(bot.replaceCard("dingtalk:dm:staff_1", "hello world", true)).resolves.toBe(true);
		expect(axiosMock.put).toHaveBeenLastCalledWith(
			expect.stringContaining("/card/streaming"),
			expect.objectContaining({
				content: "hello world",
				append: false,
				finished: true,
				failed: false,
				isFull: true,
				isFinalize: true,
				isError: false,
			}),
			expect.any(Object),
		);
	});

	it("acks downstream messages and deduplicates repeated deliveries", async () => {
		const { bot } = createBot();
		const client = { socketCallBackResponse: vi.fn() };
		const privateApi = getPrivateApi(bot);
		privateApi.connection.client = client;
		const onStreamMessage = vi.spyOn(privateApi.inbound, "onStreamMessage").mockResolvedValue(undefined as never);

		expect(
			privateApi.inbound.handleRawMessage({
				headers: { messageId: "mid-1" },
				data: JSON.stringify({ msgId: "biz-1", text: { content: "hello" } }),
			}),
		).toEqual({ status: "SUCCESS", message: "OK" });
		expect(client.socketCallBackResponse).toHaveBeenCalledWith("mid-1", { status: "SUCCESS", message: "OK" });
		expect(onStreamMessage).toHaveBeenCalledTimes(1);

		privateApi.inbound.handleRawMessage({
			headers: { messageId: "mid-1" },
			data: JSON.stringify({ msgId: "biz-1", text: { content: "hello" } }),
		});
		expect(onStreamMessage).toHaveBeenCalledTimes(1);
	});

	it("coalesces reconnect timers and cancels them on stop", async () => {
		const { bot } = createBot();

		await bot.start();
		expect(axiosMock.defaults.proxy).toBe(true);
		const client = fakeClientState.instances[0];
		expect(client.config.autoReconnect).toBe(false);
		expect(client.connect).toHaveBeenCalledTimes(1);

		const closeHandler = client.socket.on.mock.calls.find((call) => call[0] === "close")?.[1] as
			| ((code: number, reason: string) => void)
			| undefined;
		expect(closeHandler).toBeDefined();

		closeHandler!(1006, "first");
		closeHandler!(1006, "second");
		await vi.advanceTimersByTimeAsync(1000);
		await flushMicrotasks();
		expect(client.connect).toHaveBeenCalledTimes(2);

		closeHandler!(1006, "third");
		await bot.stop();
		await vi.advanceTimersByTimeAsync(1000);
		await flushMicrotasks();
		expect(client.connect).toHaveBeenCalledTimes(2);
	});

	it("force-cleans stale sockets before reconnecting", async () => {
		const { bot } = createBot();

		await bot.start();
		const client = fakeClientState.instances[0];
		const staleSocket = client.socket;
		staleSocket.readyState = 0;
		staleSocket.close.mockImplementation(() => {
			// Simulate a half-open socket that ignores normal close.
		});

		const reconnectPromise = getPrivateApi(bot).connection.doReconnect(true);
		await vi.advanceTimersByTimeAsync(1000);
		await reconnectPromise;

		expect(staleSocket.removeAllListeners).toHaveBeenCalledTimes(1);
		expect(staleSocket.close).toHaveBeenCalledTimes(1);
		expect(staleSocket.terminate).toHaveBeenCalledTimes(1);
		expect(client.connect).toHaveBeenCalledTimes(2);
	});

	it("absorbs the asynchronous error from closing a connecting socket", async () => {
		const emitter = new EventEmitter();
		const connectingSocket = {
			readyState: 0,
			ping: vi.fn(),
			on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
				emitter.on(event, listener);
			}),
			close: vi.fn(() => {
				queueMicrotask(() => {
					emitter.emit("error", new Error("WebSocket was closed before the connection was established"));
					connectingSocket.readyState = 3;
				});
			}),
			terminate: vi.fn(() => {
				connectingSocket.readyState = 3;
			}),
			removeAllListeners: vi.fn(() => {
				emitter.removeAllListeners();
			}),
			removeListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
				emitter.removeListener(event, listener);
			}),
		};
		fakeClientState.connectImpl = (client) => {
			client.socket = connectingSocket;
			return new Promise<void>(() => {});
		};

		const { bot } = createBot();
		const startPromise = bot.start();
		await vi.advanceTimersByTimeAsync(11_250);
		await startPromise;

		expect(connectingSocket.close).toHaveBeenCalledTimes(1);
		expect(connectingSocket.terminate).not.toHaveBeenCalled();
		expect(emitter.listenerCount("error")).toBe(0);
	});

	it("times out hanging connect attempts and allows a later retry", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0);
		let hangingSocket: ReturnType<typeof createSocketMock> | null = null;
		fakeClientState.connectImpl = (client) => {
			hangingSocket = createSocketMock(0);
			hangingSocket.close.mockImplementation(() => {
				// Simulate a socket that ignores graceful close until forced.
			});
			client.socket = hangingSocket;
			return new Promise<void>(() => {});
		};

		const { bot } = createBot();
		const startPromise = bot.start();
		const client = fakeClientState.instances[0];
		await vi.advanceTimersByTimeAsync(11_250);
		await startPromise;

		expect(hangingSocket).not.toBeNull();
		expect(hangingSocket!.close).toHaveBeenCalledTimes(1);
		expect(hangingSocket!.terminate).toHaveBeenCalledTimes(1);
		expect(client.connect).toHaveBeenCalledTimes(1);

		fakeClientState.connectImpl = (state) => {
			state.socket = createSocketMock(1);
			return Promise.resolve();
		};

		await vi.advanceTimersByTimeAsync(2_000);
		await flushMicrotasks();
		expect(client.connect).toHaveBeenCalledTimes(2);
	});

	it("keeps retrying when a close event arrives during the reconnect backoff", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0);
		const { bot } = createBot();

		await bot.start();
		const client = fakeClientState.instances[0];
		expect(client.connect).toHaveBeenCalledTimes(1);

		const closeHandler = client.socket.on.mock.calls.find((call) => call[0] === "close")?.[1] as
			| ((code: number, reason: string) => void)
			| undefined;
		expect(closeHandler).toBeDefined();

		// Subsequent attempts fail (socket never reaches OPEN), forcing the
		// exponential-backoff retry path.
		fakeClientState.connectImpl = (state) => {
			state.socket = createSocketMock(3);
			return Promise.resolve();
		};

		const reconnecting = () => getPrivateApi(bot).connection.isReconnecting;

		// Socket drops -> immediate reconnect after 1s, which fails.
		closeHandler!(1006, "drop");
		await vi.advanceTimersByTimeAsync(1000);
		await flushMicrotasks();
		expect(client.connect).toHaveBeenCalledTimes(2);

		// The failed attempt scheduled a 0ms retry which then enters the ~2s
		// exponential backoff sleep; let that run so an attempt is genuinely
		// in-flight (isReconnecting=true) and parked in waitForDelay.
		await vi.advanceTimersByTimeAsync(10);
		await flushMicrotasks();
		expect(reconnecting()).toBe(true);

		// A second close event arrives mid-backoff. The old shared-timer code
		// cleared the backoff sleep here, wedging isReconnecting=true forever so
		// the bot never reconnected again.
		closeHandler!(1006, "drop-again");

		// Connectivity is restored; the in-flight attempt must recover on its own.
		fakeClientState.connectImpl = (state) => {
			state.socket = createSocketMock(1);
			return Promise.resolve();
		};

		await vi.advanceTimersByTimeAsync(5000);
		await flushMicrotasks();

		// Pre-fix: stuck at 2 with isReconnecting wedged true. Post-fix: the
		// backoff resolves, it reconnects, and the flag clears.
		expect(client.connect.mock.calls.length).toBeGreaterThan(2);
		expect(reconnecting()).toBe(false);
	});
});
