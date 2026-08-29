import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DingTalkEvent, DingTalkHandler } from "../src/runtime/dingtalk.js";
import { parseInboundMessage } from "../src/runtime/inbound-media.js";

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

import { DingTalkBot } from "../src/runtime/dingtalk.js";
import { useTempDirs } from "./helpers/fixtures.js";

const createTempDir = useTempDirs("pipiclaw-dingtalk-");

function createHandler(overrides: Partial<DingTalkHandler> = {}): DingTalkHandler {
	return {
		isRunning: vi.fn(() => false),
		handleEvent: vi.fn(async () => {}),
		handleStop: vi.fn(async () => ({})),
		handleNewSession: vi.fn(async () => {}),
		runRuntimeCommand: vi.fn(async () => ""),
		handleBusyMessage: vi.fn(async () => ({ kind: "handled" as const })),
		...overrides,
	};
}

function createBot(
	handlerOverrides: Partial<DingTalkHandler> = {},
	configOverrides: Partial<ConstructorParameters<typeof DingTalkBot>[1]> = {},
): {
	bot: DingTalkBot;
	handler: DingTalkHandler;
	stateDir: string;
} {
	const stateDir = createTempDir();
	const handler = createHandler(handlerOverrides);
	const bot = new DingTalkBot(handler, {
		clientId: "client-id",
		clientSecret: "client-secret",
		cardTemplateId: "tmpl",
		cardTemplateKey: "content",
		stateDir,
		...configOverrides,
	});
	return { bot, handler, stateDir };
}

type PrivateBotApi = {
	onStreamMessage(data: Record<string, unknown>): Promise<void>;
	downloadMessageFile(downloadCode: string): Promise<{ data: Buffer } | null>;
	getAccessToken(): Promise<string | null>;
	setConversationMeta(
		channelId: string,
		meta: { conversationId: string; conversationType: string; senderId: string },
	): void;
	getConversationMeta(
		channelId: string,
	): { conversationId: string; conversationType: string; senderId: string } | null;
	cleanupIdleChannelCaches(now?: number): void;
	handleRawMessage(message: { headers?: { messageId?: string }; data: unknown }): {
		status: "SUCCESS";
		message: string;
	};
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
	// its own unit tests in test/inbound-media.test.ts (spec 049) — this only checks the transport
	// still wires plain text and richText-without-images through unchanged.
	it("extracts plain text and richText content", () => {
		expect(parseInboundMessage({ text: { content: " hello " } })).toEqual({ text: "hello", downloadCodes: [] });
		expect(
			parseInboundMessage({
				content: {
					richText: [{ text: "Hello" }, { text: " " }, { text: "World" }],
				},
			}),
		).toEqual({ text: "Hello World", downloadCodes: [] });
		expect(parseInboundMessage({ msgtype: "empty" })).toEqual({ text: "", downloadCodes: [] });
	});

	it("routes authorized messages to DM and group channels and persists metadata", async () => {
		const { bot, handler, stateDir } = createBot();
		const privateApi = getPrivateApi(bot);

		await privateApi.onStreamMessage({
			text: { content: "check dm" },
			senderStaffId: "staff_1",
			senderNick: "Alice",
			conversationId: "conv_dm",
			conversationType: "1",
		});
		await flushMicrotasks();

		expect(handler.handleEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				channelId: "dm_staff_1",
				type: "dm",
				text: "check dm",
			}),
			bot,
		);

		await privateApi.onStreamMessage({
			text: { content: "check group" },
			senderStaffId: "staff_2",
			senderNick: "Bob",
			conversationId: "conv_group",
			conversationType: "2",
		});
		await flushMicrotasks();

		expect(handler.handleEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				channelId: "group_conv_group",
				type: "group",
				text: "check group",
			}),
			bot,
		);

		const metadataPath = join(stateDir, "group_conv_group", ".channel-meta.json");
		expect(existsSync(metadataPath)).toBe(true);
		expect(JSON.parse(readFileSync(metadataPath, "utf-8"))).toMatchObject({
			conversationId: "conv_group",
			conversationType: "2",
			senderId: "staff_2",
		});
	});

	it("names channels from group titles or nicknames, records busy-path activity, and ignores unauthorized senders", async () => {
		const noteChannelActivity = vi.fn();
		const { bot, handler } = createBot({ noteChannelActivity });
		const privateApi = getPrivateApi(bot);

		await privateApi.onStreamMessage({
			text: { content: "hi" },
			senderStaffId: "staff_1",
			senderNick: "Alice",
			conversationId: "conv_group",
			conversationType: "2",
			conversationTitle: "  投资理财  ",
		});
		await flushMicrotasks();

		expect(noteChannelActivity).toHaveBeenCalledWith(
			expect.objectContaining({ channelId: "group_conv_group", name: "投资理财" }),
		);
		expect(handler.handleEvent).toHaveBeenCalledWith(
			expect.objectContaining({ channelId: "group_conv_group", channelName: "投资理财" }),
			bot,
		);

		// A DM carries no title, so the peer's nickname is the only handle it will ever have.
		await privateApi.onStreamMessage({
			text: { content: "hi" },
			senderStaffId: "staff_2",
			senderNick: "Bob",
			conversationId: "conv_dm",
			conversationType: "1",
		});
		await flushMicrotasks();

		expect(noteChannelActivity).toHaveBeenLastCalledWith(
			expect.objectContaining({ channelId: "dm_staff_2", name: "Bob" }),
		);

		// The hook sits before busy/command routing, so a steer still counts as human activity,
		// while an unauthorized sender is ignored entirely.
		const guardedActivity = vi.fn();
		const guarded = createBot(
			{ noteChannelActivity: guardedActivity, isRunning: vi.fn(() => true) },
			{ allowFrom: ["staff_ok"] },
		);
		guarded.bot.sendPlain = vi.fn(async () => true);
		const guardedApi = getPrivateApi(guarded.bot);

		await guardedApi.onStreamMessage({
			text: { content: "blocked" },
			senderStaffId: "staff_nope",
			senderNick: "Mallory",
			conversationId: "conv_group",
			conversationType: "2",
			conversationTitle: "投资理财",
		});
		await flushMicrotasks();
		expect(guardedActivity).not.toHaveBeenCalled();
		expect(guarded.handler.handleEvent).not.toHaveBeenCalled();

		await guardedApi.onStreamMessage({
			text: { content: "keep going" },
			senderStaffId: "staff_ok",
			senderNick: "Alice",
			conversationId: "conv_group",
			conversationType: "2",
			conversationTitle: "投资理财",
		});
		await flushMicrotasks();
		expect(guardedActivity).toHaveBeenCalledWith(
			expect.objectContaining({ channelId: "group_conv_group", name: "投资理财" }),
		);
	});

	it("routes busy transport commands correctly", async () => {
		const { bot, handler } = createBot({
			isRunning: vi.fn(() => true),
		});
		bot.sendPlain = vi.fn(async () => true);
		const privateApi = getPrivateApi(bot);

		await privateApi.onStreamMessage({
			text: { content: "/stop" },
			senderStaffId: "staff_1",
			senderNick: "Alice",
			conversationId: "conv_1",
			conversationType: "1",
		});
		expect(handler.handleStop).toHaveBeenCalledWith("dm_staff_1", bot);
		expect(bot.sendPlain).toHaveBeenCalledWith("dm_staff_1", "已停止当前回合。", { title: "/stop", markdown: true });

		await privateApi.onStreamMessage({
			text: { content: "/steer focus src" },
			senderStaffId: "staff_1",
			senderNick: "Alice",
			conversationId: "conv_1",
			conversationType: "1",
		});
		expect(handler.handleBusyMessage).toHaveBeenCalledWith(
			expect.objectContaining({ channelId: "dm_staff_1" }),
			bot,
			"steer",
			"focus src",
		);

		await privateApi.onStreamMessage({
			text: { content: "/followup next task" },
			senderStaffId: "staff_1",
			senderNick: "Alice",
			conversationId: "conv_1",
			conversationType: "1",
		});
		expect(handler.handleBusyMessage).toHaveBeenCalledWith(
			expect.objectContaining({ channelId: "dm_staff_1" }),
			bot,
			"followUp",
			"next task",
		);

		await privateApi.onStreamMessage({
			text: { content: "/events list" },
			senderStaffId: "staff_1",
			senderNick: "Alice",
			conversationId: "conv_1",
			conversationType: "1",
		});
		expect(handler.runRuntimeCommand).toHaveBeenCalledWith(
			expect.objectContaining({ channelId: "dm_staff_1" }),
			"events",
			"list",
		);

		await privateApi.onStreamMessage({
			text: { content: "/status" },
			senderStaffId: "staff_1",
			senderNick: "Alice",
			conversationId: "conv_1",
			conversationType: "1",
		});
		expect(handler.runRuntimeCommand).toHaveBeenCalledWith(
			expect.objectContaining({ channelId: "dm_staff_1" }),
			"status",
			"",
		);

		await privateApi.onStreamMessage({
			text: { content: "plain busy text" },
			senderStaffId: "staff_1",
			senderNick: "Alice",
			conversationId: "conv_1",
			conversationType: "1",
		});
		expect(handler.handleBusyMessage).toHaveBeenCalledWith(
			expect.objectContaining({ text: "plain busy text" }),
			bot,
			"steer",
			"plain busy text",
		);

		// Read-only runtime commands like /context answer while a turn is streaming too —
		// no reason to make the user wait for the turn to finish.
		await privateApi.onStreamMessage({
			text: { content: "/context detail" },
			senderStaffId: "staff_1",
			senderNick: "Alice",
			conversationId: "conv_1",
			conversationType: "1",
		});
		expect(handler.runRuntimeCommand).toHaveBeenCalledWith(
			expect.objectContaining({ text: "/context detail" }),
			"context",
			"detail",
		);
	});

	it("tells the user a session command is idle-only when busy", async () => {
		const { bot, handler } = createBot({
			isRunning: vi.fn(() => true),
		});
		bot.sendPlain = vi.fn(async () => true);
		const privateApi = getPrivateApi(bot);

		await privateApi.onStreamMessage({
			text: { content: "/model anthropic/x" },
			senderStaffId: "staff_1",
			senderNick: "Alice",
			conversationId: "conv_1",
			conversationType: "1",
		});

		expect(handler.handleBusyMessage).not.toHaveBeenCalled();
		const reply = (bot.sendPlain as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as string;
		expect(reply).toContain("当前已有回合在运行");
		expect(reply).toContain("`/status`");
		expect(reply).toContain("`/model`");
	});

	it("routes /new around a busy turn instead of rejecting or queueing it", async () => {
		const handleNewSession = vi.fn(async () => {});
		const { bot, handler } = createBot({
			isRunning: vi.fn(() => true),
			handleNewSession,
		});
		const privateApi = getPrivateApi(bot);

		await privateApi.onStreamMessage({
			text: { content: "/new" },
			senderStaffId: "staff_1",
			senderNick: "Alice",
			conversationId: "conv_1",
			conversationType: "1",
		});

		expect(handleNewSession).toHaveBeenCalledWith(expect.objectContaining({ text: "/new" }), bot);
		expect(handler.handleBusyMessage).not.toHaveBeenCalled();
		expect(handler.handleEvent).not.toHaveBeenCalled();
	});

	it("requeues a busy plain message as normal work when the busy window has closed", async () => {
		const { bot, handler } = createBot(
			{
				isRunning: vi.fn(() => true),
				handleBusyMessage: vi.fn(async () => ({ kind: "requeue" as const, text: "second message" })),
			},
			{ busyMessageDefault: "followUp" },
		);
		bot.sendPlain = vi.fn(async () => true);
		const privateApi = getPrivateApi(bot);

		await privateApi.onStreamMessage({
			text: { content: "second message" },
			senderStaffId: "staff_1",
			senderNick: "Alice",
			conversationId: "conv_1",
			conversationType: "1",
		});
		await flushMicrotasks();

		expect(handler.handleBusyMessage).toHaveBeenCalledWith(
			expect.objectContaining({ text: "second message" }),
			bot,
			"followUp",
			"second message",
		);
		expect(handler.handleEvent).toHaveBeenCalledWith(expect.objectContaining({ text: "second message" }), bot);
		expect(bot.sendPlain).not.toHaveBeenCalledWith(
			"dm_staff_1",
			expect.stringContaining("Could not queue this message"),
		);
	});

	it("refreshes, caches, and coalesces access token requests", async () => {
		const { bot } = createBot();
		const privateApi = getPrivateApi(bot);

		axiosMock.post.mockResolvedValueOnce({
			data: { accessToken: "token-1", expireIn: 7200 },
		});

		await expect(privateApi.getAccessToken()).resolves.toBe("token-1");
		await expect(privateApi.getAccessToken()).resolves.toBe("token-1");
		expect(axiosMock.post).toHaveBeenCalledTimes(1);

		(
			bot as unknown as {
				accessToken: string | null;
				tokenExpiry: number;
				tokenRefreshPromise: Promise<string | null> | null;
			}
		).accessToken = null;
		(
			bot as unknown as {
				accessToken: string | null;
				tokenExpiry: number;
				tokenRefreshPromise: Promise<string | null> | null;
			}
		).tokenExpiry = 0;

		let resolveToken: ((value: { data: { accessToken: string; expireIn: number } }) => void) | null = null;
		axiosMock.post.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveToken = resolve;
				}),
		);

		const first = privateApi.getAccessToken();
		const second = privateApi.getAccessToken();
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
			(bot as unknown as { accessToken: string | null; tokenExpiry: number }).accessToken = "cached-token";
			(bot as unknown as { accessToken: string | null; tokenExpiry: number }).tokenExpiry = Date.now() / 1000 + 3600;
		}

		function mockDownload(fileBytes: Buffer): void {
			axiosMock.post.mockResolvedValueOnce({ data: { downloadUrl: "https://example.invalid/file" } });
			axiosMock.get.mockResolvedValueOnce({ data: fileBytes });
		}

		it("downloads a picture message, persists it, and attaches it to the event", async () => {
			const persistInboundImage = vi.fn(
				async (_channelId: string, image: { data: Buffer; mimeType: string | null }) => ({
					path: "/workspace/dm_staff_1/inbox/image-1.jpg",
					mimeType: image.mimeType ?? "application/octet-stream",
					byteSize: image.data.byteLength,
				}),
			);
			const { bot, handler } = createBot({ persistInboundImage });
			setCachedToken(bot);
			mockDownload(JPEG_BYTES);
			const privateApi = getPrivateApi(bot);

			await privateApi.onStreamMessage({
				msgtype: "picture",
				senderStaffId: "staff_1",
				senderNick: "Alice",
				conversationId: "conv_dm",
				conversationType: "1",
				content: { downloadCode: "code-1" },
			});
			await flushMicrotasks();

			expect(persistInboundImage).toHaveBeenCalledWith("dm_staff_1", {
				data: expect.any(Buffer),
				mimeType: "image/jpeg",
			});
			expect(handler.handleEvent).toHaveBeenCalledWith(
				expect.objectContaining({
					text: "[图片1]",
					images: [expect.objectContaining({ mimeType: "image/jpeg" })],
				}),
				bot,
			);
			// The credential exchange must name the message's own downloadCode, not a stray value.
			expect(axiosMock.post).toHaveBeenCalledWith(
				expect.stringContaining("/v1.0/robot/messageFiles/download"),
				expect.objectContaining({ downloadCode: "code-1" }),
				expect.anything(),
			);
		});

		it("keeps the rest of the message when one image fails to download", async () => {
			const { bot, handler } = createBot();
			setCachedToken(bot);
			axiosMock.post.mockResolvedValueOnce({ data: { downloadUrl: "https://example.invalid/file" } });
			axiosMock.get.mockRejectedValueOnce(new Error("network down"));
			const privateApi = getPrivateApi(bot);

			await privateApi.onStreamMessage({
				msgtype: "picture",
				senderStaffId: "staff_1",
				senderNick: "Alice",
				conversationId: "conv_dm",
				conversationType: "1",
				content: { downloadCode: "code-1" },
			});
			await flushMicrotasks();

			expect(handler.handleEvent).toHaveBeenCalledWith(expect.objectContaining({ text: "[图片1：接收失败]" }), bot);
			const sentEvent = vi.mocked(handler.handleEvent).mock.calls[0]?.[0];
			expect(sentEvent && "images" in sentEvent).toBe(false);
		});

		it("persists an unrecognized format but excludes it from the model-facing images list", async () => {
			const persistInboundImage = vi.fn(
				async (_channelId: string, image: { data: Buffer; mimeType: string | null }) => ({
					path: "/workspace/dm_staff_1/inbox/image-1.bin",
					mimeType: "application/octet-stream",
					byteSize: image.data.byteLength,
					unsupportedFormat: true,
				}),
			);
			const { bot, handler } = createBot({ persistInboundImage });
			setCachedToken(bot);
			mockDownload(Buffer.from("this is not an image"));
			const privateApi = getPrivateApi(bot);

			await privateApi.onStreamMessage({
				msgtype: "picture",
				senderStaffId: "staff_1",
				senderNick: "Alice",
				conversationId: "conv_dm",
				conversationType: "1",
				content: { downloadCode: "code-1" },
			});
			await flushMicrotasks();

			expect(persistInboundImage).toHaveBeenCalledWith("dm_staff_1", { data: expect.any(Buffer), mimeType: null });
			expect(handler.handleEvent).toHaveBeenCalledWith(
				expect.objectContaining({
					text: "[图片1：格式不支持，已保存]",
					images: [expect.objectContaining({ unsupportedFormat: true })],
				}),
				bot,
			);
		});

		it("never overtakes a download in the channel's delivery order (spec 049 D3)", async () => {
			const persistInboundImage = vi.fn(
				async (_channelId: string, image: { data: Buffer; mimeType: string | null }) => ({
					path: "/workspace/dm_staff_1/inbox/image-1.jpg",
					mimeType: image.mimeType ?? "application/octet-stream",
					byteSize: image.data.byteLength,
				}),
			);
			const { bot, handler } = createBot({ persistInboundImage });
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

			const firstMessage = privateApi.onStreamMessage({
				msgtype: "picture",
				senderStaffId: "staff_1",
				senderNick: "Alice",
				conversationId: "conv_dm",
				conversationType: "1",
				content: { downloadCode: "code-1" },
			});
			await flushMicrotasks();
			expect(handler.handleEvent).not.toHaveBeenCalled();

			// Fire-and-forget, exactly like the production socket callback (`handleRawMessage`
			// never awaits `onStreamMessage`) — the second message's own ingestion job is chained
			// behind the first's on the same channel, so awaiting it here would itself hang until
			// the first message's download is released below.
			const secondMessage = privateApi.onStreamMessage({
				text: { content: "second, no image" },
				senderStaffId: "staff_1",
				senderNick: "Alice",
				conversationId: "conv_dm",
				conversationType: "1",
			});
			await flushMicrotasks();

			// Without the per-channel ingestion queue (spec 049 D3), the second message — which
			// needs no download — would already have reached handleEvent here.
			expect(handler.handleEvent).not.toHaveBeenCalled();

			download.release?.();
			await firstMessage;
			await secondMessage;
			await flushMicrotasks();

			expect(handler.handleEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({ text: "[图片1]" }), bot);
			expect(handler.handleEvent).toHaveBeenNthCalledWith(
				2,
				expect.objectContaining({ text: "second, no image" }),
				bot,
			);
		});

		it("reflects in-flight downloads in allChannelQueuesIdle()", async () => {
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

			const pending = privateApi.onStreamMessage({
				msgtype: "picture",
				senderStaffId: "staff_1",
				senderNick: "Alice",
				conversationId: "conv_dm",
				conversationType: "1",
				content: { downloadCode: "code-1" },
			});
			await flushMicrotasks();

			expect(bot.allChannelQueuesIdle()).toBe(false);

			download.release?.();
			await pending;
			await flushMicrotasks();

			expect(bot.allChannelQueuesIdle()).toBe(true);
		});
	});

	it("persists and reloads conversation metadata from disk, then reclaims idle per-channel caches", () => {
		const { bot } = createBot();
		const privateApi = getPrivateApi(bot);

		privateApi.setConversationMeta("dm_staff_1", {
			conversationId: "conv_1",
			conversationType: "1",
			senderId: "staff_1",
		});

		(bot as unknown as { convMeta: Map<string, unknown> }).convMeta.clear();

		expect(privateApi.getConversationMeta("dm_staff_1")).toEqual({
			conversationId: "conv_1",
			conversationType: "1",
			senderId: "staff_1",
		});

		privateApi.setConversationMeta("dm_staff_1", {
			conversationId: "conv_1",
			conversationType: "1",
			senderId: "staff_1",
		});
		(bot as unknown as { getQueue(channelId: string): unknown }).getQueue("dm_staff_1");

		privateApi.cleanupIdleChannelCaches(Date.now() + 2 * 60 * 60 * 1000);

		expect((bot as unknown as { convMeta: Map<string, unknown> }).convMeta.has("dm_staff_1")).toBe(false);
		expect((bot as unknown as { queues: Map<string, unknown> }).queues.has("dm_staff_1")).toBe(false);
	});

	it("sends plain DM and group messages using cached metadata", async () => {
		const { bot } = createBot();
		const privateApi = getPrivateApi(bot);
		(bot as unknown as { accessToken: string | null; tokenExpiry: number }).accessToken = "cached-token";
		(bot as unknown as { accessToken: string | null; tokenExpiry: number }).tokenExpiry = Date.now() / 1000 + 3600;
		axiosMock.post.mockResolvedValue({ data: {} });

		privateApi.setConversationMeta("dm_staff_1", {
			conversationId: "conv_1",
			conversationType: "1",
			senderId: "staff_1",
		});
		await expect(bot.sendPlain("dm_staff_1", "hello")).resolves.toBe(true);
		expect(axiosMock.post).toHaveBeenLastCalledWith(
			expect.stringContaining("/oToMessages/batchSend"),
			expect.objectContaining({
				msgKey: "sampleText",
				userIds: ["staff_1"],
			}),
			expect.any(Object),
		);

		privateApi.setConversationMeta("group_conv_2", {
			conversationId: "conv_2",
			conversationType: "2",
			senderId: "staff_2",
		});
		await expect(bot.sendPlain("group_conv_2", "# title")).resolves.toBe(true);
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
		(bot as unknown as { accessToken: string | null; tokenExpiry: number }).accessToken = "cached-token";
		(bot as unknown as { accessToken: string | null; tokenExpiry: number }).tokenExpiry = Date.now() / 1000 + 3600;
		axiosMock.post.mockResolvedValue({ data: {} });
		axiosMock.put.mockResolvedValue({ data: {} });

		privateApi.setConversationMeta("dm_staff_1", {
			conversationId: "conv_1",
			conversationType: "1",
			senderId: "staff_1",
		});

		await expect(bot.appendToCard("dm_staff_1", "hello")).resolves.toBe(true);
		expect(axiosMock.post).toHaveBeenCalledWith(
			expect.stringContaining("/card/instances/createAndDeliver"),
			expect.objectContaining({
				cardData: {
					cardParamMap: {
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

		await expect(bot.replaceCard("dm_staff_1", "hello world", true)).resolves.toBe(true);
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

	it("enforces queue limits and stops cleanly", async () => {
		let releaseCurrent: (() => void) | null = null;
		const { bot, handler } = createBot({
			handleEvent: vi.fn(
				() =>
					new Promise<void>((resolve) => {
						releaseCurrent = resolve;
					}),
			),
		});

		const event = (suffix: number): DingTalkEvent => ({
			type: "dm",
			channelId: "dm_queue",
			ts: `${suffix}`,
			user: "staff_1",
			userName: "Alice",
			text: `job ${suffix}`,
			conversationId: "conv_1",
			conversationType: "1",
		});

		const results = [1, 2, 3, 4, 5, 6, 7].map((index) => bot.enqueueEvent(event(index)));
		expect(results).toEqual([true, true, true, true, true, true, false]);
		expect(handler.handleEvent).toHaveBeenCalledTimes(1);

		const socket = createSocketMock(1);
		(bot as unknown as { client: { socket: typeof socket } }).client = { socket };

		await bot.stop();
		expect(socket.removeAllListeners).toHaveBeenCalledTimes(1);
		expect(socket.close).toHaveBeenCalledTimes(1);
		expect(bot.enqueueEvent(event(8))).toBe(false);

		expect(releaseCurrent).not.toBeNull();
		releaseCurrent!();
	});

	it("reserves a queued turn before entering its async handler", async () => {
		const order: string[] = [];
		const { bot } = createBot({
			reserveEvent: vi.fn(() => order.push("reserve")),
			handleEvent: vi.fn(async () => {
				order.push("handle");
			}),
		});
		bot.enqueueEvent({
			type: "dm",
			channelId: "dm_reserve",
			ts: "1",
			user: "staff_1",
			userName: "Alice",
			text: "work",
			conversationId: "conv_1",
			conversationType: "1",
		});
		await flushMicrotasks();
		expect(order).toEqual(["reserve", "handle"]);
	});

	it("acks downstream messages and deduplicates repeated deliveries", async () => {
		const { bot } = createBot();
		const client = { socketCallBackResponse: vi.fn() };
		(bot as unknown as { client: { socketCallBackResponse: (id: string, payload: unknown) => void } }).client =
			client;
		const privateApi = getPrivateApi(bot);
		const onStreamMessage = vi.spyOn(privateApi, "onStreamMessage").mockResolvedValue(undefined as never);

		expect(
			privateApi.handleRawMessage({
				headers: { messageId: "mid-1" },
				data: JSON.stringify({ msgId: "biz-1", text: { content: "hello" } }),
			}),
		).toEqual({ status: "SUCCESS", message: "OK" });
		expect(client.socketCallBackResponse).toHaveBeenCalledWith("mid-1", { status: "SUCCESS", message: "OK" });
		expect(onStreamMessage).toHaveBeenCalledTimes(1);

		privateApi.handleRawMessage({
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

		const reconnectPromise = (
			bot as unknown as { doReconnect: (immediate?: boolean) => Promise<boolean> }
		).doReconnect(true);
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

		const reconnecting = () => (bot as unknown as { isReconnecting: boolean }).isReconnecting;

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
