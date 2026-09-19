import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const http = vi.hoisted(() => ({ post: vi.fn(), put: vi.fn(), defaults: {} }));
vi.mock("axios", () => ({ default: { ...http, create: () => http, isAxiosError: () => false } }));

import { createDingTalkContext } from "../src/runtime/delivery.js";
import { DingTalkBot, type DingTalkHandler } from "../src/runtime/dingtalk.js";
import { FakeChannelStore } from "./helpers/fake-store.js";
import { createFakeEvent, useTempDirs } from "./helpers/fixtures.js";

const temp = useTempDirs("pipiclaw-card-delivery-");
const cards = new Map<string, { content: string; finished: boolean }>();
interface CreateBody {
	outTrackId: string;
	cardData: { cardParamMap: Record<string, string> };
}
interface StreamBody {
	outTrackId: string;
	content: string;
	isFull: boolean;
	isFinalize: boolean;
}
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
let createGate: ReturnType<typeof deferred> | undefined;
let streamGate: ReturnType<typeof deferred> | undefined;
let failWrites: boolean;
let loseCreateResponse: boolean;
let loseAppendResponse: boolean;

beforeEach(() => {
	vi.useFakeTimers();
	cards.clear();
	createGate = streamGate = undefined;
	failWrites = loseCreateResponse = loseAppendResponse = false;
	http.post.mockReset().mockImplementation(async (url: string, body: CreateBody) => {
		if (url.endsWith("createAndDeliver")) {
			cards.set(body.outTrackId, { content: body.cardData.cardParamMap.content, finished: false });
			if (createGate) await createGate.promise;
			if (loseCreateResponse) throw new Error("lost create response");
		}
		return { data: {} };
	});
	http.put.mockReset().mockImplementation(async (_url: string, body: StreamBody) => {
		if (streamGate) await streamGate.promise;
		if (failWrites) throw new Error("stream unavailable");
		const card = cards.get(body.outTrackId);
		if (!card) throw new Error("unknown card");
		card.content = body.isFull ? body.content : card.content + body.content;
		card.finished = body.isFinalize;
		if (!body.isFull && loseAppendResponse) throw new Error("lost append response");
		return { data: {} };
	});
});
afterEach(() => vi.useRealTimers());

function setup(template = "template") {
	const handler: DingTalkHandler = {
		isRunning: () => false,
		handleEvent: async () => {},
		handleStop: async () => ({}),
		handleNewSession: async () => {},
		runRuntimeCommand: async () => "",
		handleBusyMessage: async () => ({ kind: "handled" }),
	};
	const bot = new DingTalkBot(handler, {
		clientId: "test",
		clientSecret: "test",
		cardTemplateId: template,
		stateDir: temp(),
	});
	const privateApi = bot as unknown as {
		accessToken: string;
		tokenExpiry: number;
		setConversationMeta(
			channel: string,
			meta: { conversationId: string; conversationType: string; senderId: string },
		): void;
	};
	privateApi.accessToken = "test-token";
	privateApi.tokenExpiry = Date.now() / 1000 + 3600;
	privateApi.setConversationMeta("dm_123", { conversationId: "test", conversationType: "1", senderId: "123" });
	const store = new FakeChannelStore();
	const context = () => createDingTalkContext(createFakeEvent(), bot, store as never);
	return { bot, context, ctx: context() };
}
const plainCalls = () => http.post.mock.calls.filter(([url]) => String(url).endsWith("batchSend"));
const onlyCard = () => {
	expect(cards.size).toBe(1);
	return [...cards.values()][0];
};

describe("card delivery with stateful remote HTTP", () => {
	it("preserves visible progress when a warmed turn becomes silent", async () => {
		const { ctx } = setup();
		ctx.primeCard(1);
		await vi.advanceTimersByTimeAsync(1);
		await ctx.respond("observed work");
		await vi.advanceTimersByTimeAsync(800);
		await ctx.deleteMessage();
		await ctx.close();
		expect(onlyCard().content).toContain("observed work");
		expect(onlyCard().finished).toBe(true);
		expect(plainCalls()).toHaveLength(0);
	});

	it("creates at most one nonempty card when all progress updates fail", async () => {
		const { ctx } = setup();
		failWrites = true;
		for (const progress of ["one", "two", "three", "four"]) {
			await ctx.respond(progress);
			await vi.advanceTimersByTimeAsync(800);
			await ctx.flush();
		}
		expect(http.put).toHaveBeenCalledTimes(2);
		expect(onlyCard().content.trim()).not.toBe("");
		failWrites = false;
		await ctx.respondPlain("answer");
		await ctx.close();
		expect(onlyCard().finished).toBe(true);
		expect(plainCalls()).toHaveLength(1);
	});

	it("does not create another instance when the create response is lost", async () => {
		const { ctx } = setup();
		loseCreateResponse = true;
		for (const progress of ["one", "two", "three"]) {
			await ctx.respond(progress);
			await vi.advanceTimersByTimeAsync(800);
		}
		await ctx.replaceMessage("answer");
		await ctx.close();
		expect(onlyCard().content.trim()).not.toBe("");
		expect(plainCalls()).toHaveLength(1);
	});

	it("recovers an accepted but unacknowledged append with a full snapshot on the same instance", async () => {
		const { ctx } = setup();
		await ctx.respond("A");
		await vi.advanceTimersByTimeAsync(800);
		loseAppendResponse = true;
		await ctx.respond("B");
		await vi.advanceTimersByTimeAsync(800);
		await ctx.respond("C");
		await vi.advanceTimersByTimeAsync(800);
		expect(onlyCard().content).toBe("- A\n- B\n- C");
	});

	it.each(["template", ""])(
		"does not create a progress card or fallback message after a fast final (%s)",
		async (template) => {
			const { ctx } = setup(template);
			await ctx.respond("buffered progress");
			await ctx.respondPlain("answer");
			await ctx.close();
			await vi.advanceTimersByTimeAsync(2000);
			expect(cards.size).toBe(0);
			expect(plainCalls()).toHaveLength(1);
		},
	);

	it("waits for in-flight creation and then finishes the same card on close", async () => {
		const { ctx } = setup();
		createGate = deferred();
		ctx.primeCard(1);
		await vi.advanceTimersByTimeAsync(1);
		await ctx.respondPlain("answer");
		let closed = false;
		const closing = ctx.close().then(() => {
			closed = true;
		});
		await Promise.resolve();
		expect(closed).toBe(false);
		createGate.resolve();
		await closing;
		expect(onlyCard().finished).toBe(true);
		expect(onlyCard().content.trim()).not.toBe("");
	});

	it("a late create after stop cannot replace the next turn's card", async () => {
		const { bot, ctx, context } = setup();
		const gate = deferred();
		createGate = gate;
		ctx.primeCard(1);
		await vi.advanceTimersByTimeAsync(1);
		const oldId = [...cards.keys()][0];
		bot.discardCard("dm_123");
		createGate = undefined;
		const next = context();
		await next.respond("next turn");
		await vi.advanceTimersByTimeAsync(800);
		gate.resolve();
		await ctx.close();
		await next.respondPlain("answer");
		await next.close();
		expect(cards.size).toBe(2);
		expect(cards.get(oldId)?.finished).toBe(true);
		const nextCard = [...cards.entries()].find(([id]) => id !== oldId)?.[1];
		expect(nextCard?.content).toContain("next turn");
		expect(nextCard?.finished).toBe(true);
	});

	it("stop is serialized after the old write and stale progress cannot create another card", async () => {
		const { bot, ctx, context } = setup();
		streamGate = deferred();
		ctx.primeCard(1);
		await vi.advanceTimersByTimeAsync(1);
		bot.discardCard("dm_123");
		await ctx.respond("stale progress");
		streamGate.resolve();
		await ctx.close();
		await vi.advanceTimersByTimeAsync(0);
		expect(onlyCard().finished).toBe(true);
		expect(onlyCard().content).not.toContain("stale progress");
		const next = context();
		await next.replaceMessage("next answer");
		await next.close();
		expect(cards.size).toBe(2);
		expect([...cards.values()].every((c) => c.finished && c.content.trim())).toBe(true);
	});

	it("final card failure falls back once and both failures reject delivery", async () => {
		const { ctx } = setup();
		failWrites = true;
		await ctx.replaceMessage("answer");
		expect(plainCalls()).toHaveLength(1);
		await ctx.close();
		const next = setup("");
		http.post.mockRejectedValue(new Error("plain unavailable"));
		await expect(next.ctx.replaceMessage("undelivered")).rejects.toThrow();
		expect(plainCalls()).toHaveLength(2);
	});
});
