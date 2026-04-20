import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DingTalkEvent, DingTalkHandler } from "../src/runtime/dingtalk.js";

const { axiosMock, fakeClientState } = vi.hoisted(() => {
	const post = vi.fn();
	const put = vi.fn();
	const defaults = { proxy: true };
	return {
		axiosMock: {
			post,
			put,
			defaults,
			isAxiosError: (error: unknown) => Boolean((error as { isAxiosError?: boolean })?.isAxiosError),
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

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pipiclaw-dingtalk-"));
	tempDirs.push(dir);
	return dir;
}

function createHandler(overrides: Partial<DingTalkHandler> = {}): DingTalkHandler {
	return {
		isRunning: vi.fn(() => false),
		handleEvent: vi.fn(async () => {}),
		handleStop: vi.fn(async () => {}),
		handleBusyMessage: vi.fn(async () => {}),
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
	extractContent(data: Record<string, unknown>): string;
	onStreamMessage(data: Record<string, unknown>): Promise<void>;
	getAccessToken(): Promise<string | null>;
	setConversationMeta(
		channelId: string,
		meta: { conversationId: string; conversationType: string; senderId: string },
	): void;
	getConversationMeta(
		channelId: string,
	): { conversationId: string; conversationType: string; senderId: string } | null;
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
	axiosMock.defaults.proxy = true;
	fakeClientState.connectImpl = null;
	fakeClientState.disconnectImpl = null;
	fakeClientState.instances.length = 0;
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("dingtalk", () => {
	it("extracts plain text and richText content", () => {
		const { bot } = createBot();
		const privateApi = getPrivateApi(bot);

		expect(privateApi.extractContent({ text: { content: " hello " } })).toBe("hello");
		expect(
			privateApi.extractContent({
				content: {
					richText: [{ text: "Hello" }, { text: " " }, { text: "World" }],
				},
			}),
		).toBe("Hello World");
		expect(privateApi.extractContent({ msgtype: "empty" })).toBe("");
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

	it("ignores unauthorized senders", async () => {
		const { bot, handler } = createBot({}, { allowFrom: ["staff_ok"] });
		const privateApi = getPrivateApi(bot);

		await privateApi.onStreamMessage({
			text: { content: "blocked" },
			senderStaffId: "staff_nope",
			senderNick: "Mallory",
			conversationId: "conv_1",
			conversationType: "1",
		});
		await flushMicrotasks();

		expect(handler.handleEvent).not.toHaveBeenCalled();
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
		expect(bot.sendPlain).toHaveBeenCalledWith("dm_staff_1", "Stopping the current task.");

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
	});

	it("routes plain busy messages through the configured follow-up default", async () => {
		for (const busyMessageDefault of ["followUp", "followup"] as const) {
			const { bot, handler } = createBot(
				{
					isRunning: vi.fn(() => true),
				},
				{ busyMessageDefault },
			);
			bot.sendPlain = vi.fn(async () => true);
			const privateApi = getPrivateApi(bot);

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
				"followUp",
				"plain busy text",
			);

			await privateApi.onStreamMessage({
				text: { content: "/steer keep current focus" },
				senderStaffId: "staff_1",
				senderNick: "Alice",
				conversationId: "conv_1",
				conversationType: "1",
			});
			expect(handler.handleBusyMessage).toHaveBeenCalledWith(
				expect.objectContaining({ text: "/steer keep current focus" }),
				bot,
				"steer",
				"keep current focus",
			);
		}
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

	it("persists and reloads conversation metadata from disk", () => {
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
});
