import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const http = vi.hoisted(() => ({ post: vi.fn(), put: vi.fn(), defaults: {} }));
vi.mock("axios", () => ({ default: { ...http, create: () => http, isAxiosError: () => false } }));

import type { TurnEvent, TurnOutcome } from "../src/channel/channel-context.js";
import type { TurnInfo } from "../src/channel/transport.js";
import { DingTalkBot } from "../src/dingtalk/bot.js";
import { createDingTalkContext, type DeliveryPort } from "../src/dingtalk/delivery.js";
import { CARD_COMPACT_MAX_BYTES, CARD_DOCUMENT_MAX_BYTES, CARD_REQUEST_MAX_BYTES } from "../src/dingtalk/progress.js";
import {
	type FinalDelivery,
	finalDeliveryOf,
	type ProgressStyle,
	progressStyleOf,
	type ResponseMode,
} from "../src/dingtalk/response-mode.js";
import * as log from "../src/log.js";
import { createEmptyUsageTotals } from "../src/usage/totals.js";
import { useTempDirs } from "./helpers/fixtures.js";

const CHANNEL = "dingtalk:dm:123";
const turn: TurnInfo = { channelId: CHANNEL, user: "u", userName: "U", text: "hello", ts: "1" };
const outcome = (kind: TurnOutcome["kind"], message?: string): TurnOutcome => ({
	kind,
	usage: createEmptyUsageTotals(),
	...(message ? { message } : {}),
});
const progress = (text: string): TurnEvent => ({ type: "commentary", text });
const answer = (text: string): TurnEvent => ({ type: "answer", text });
/** The card warm-up is the one timer the delivery starts on its own. */
const WARMUP_MS = 3500;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** A recording `DeliveryPort`: every card and send call, with per-method return values to force failures. */
class RecordingPort implements DeliveryPort {
	calls: Array<{ method: string; args: unknown[] }> = [];
	responseMode: ResponseMode = "full_progress_then_plain_final";
	private readonly returnValues = new Map<string, unknown>();

	get progressStyle(): ProgressStyle {
		return progressStyleOf(this.responseMode);
	}

	get finalDelivery(): FinalDelivery {
		return finalDeliveryOf(this.responseMode);
	}

	configure(method: string, returnValue: unknown): void {
		this.returnValues.set(method, returnValue);
	}

	private result<T>(method: string, fallback: T): T {
		return (this.returnValues.get(method) as T | undefined) ?? fallback;
	}

	getCardGeneration = () => Symbol("test-card-turn");
	isCardGenerationCurrent = () => true;

	async appendToCard(channelId: string, content: string): Promise<boolean> {
		this.calls.push({ method: "appendToCard", args: [channelId, content] });
		return this.result("appendToCard", true);
	}

	supportsStreamingAppend(): boolean {
		return this.result("supportsStreamingAppend", true);
	}

	async replaceCard(channelId: string, content: string, finalize = false): Promise<boolean> {
		this.calls.push({ method: "replaceCard", args: [channelId, content, finalize] });
		return this.result("replaceCard", true);
	}

	async finalizeCard(channelId: string, content: string): Promise<boolean> {
		this.calls.push({ method: "finalizeCard", args: [channelId, content] });
		return this.result("finalizeCard", true);
	}

	async finalizeExistingCard(channelId: string, content: string): Promise<boolean> {
		this.calls.push({ method: "finalizeExistingCard", args: [channelId, content] });
		return this.result("finalizeExistingCard", true);
	}

	discardCard(channelId: string): void {
		this.calls.push({ method: "discardCard", args: [channelId] });
	}

	async sendPlain(channelId: string, text: string): Promise<boolean> {
		this.calls.push({ method: "sendPlain", args: [channelId, text] });
		return this.result("sendPlain", true);
	}

	methods(): string[] {
		return this.calls.map((call) => call.method);
	}
}

/** The card body implied by replace and append calls, in order. */
function renderedCard(calls: Array<{ method: string; args: unknown[] }>): string {
	let document = "";
	for (const call of calls) {
		const text = String(call.args[1] ?? "");
		if (call.method === "replaceCard") document = text;
		else if (call.method === "appendToCard") document += text;
	}
	return document;
}

function setup(mode: ResponseMode = "full_progress_then_plain_final", quiet = false) {
	const port = new RecordingPort();
	port.responseMode = mode;
	const archived: string[] = [];
	const archive = vi.fn(async (_channelId: string, text: string) => {
		archived.push(text);
	});
	const ctx = createDingTalkContext(turn, port, archive, quiet);
	return { port, archive, archived, ctx };
}

describe("DingTalk turn delivery: events onto cards and messages", () => {
	it("delays the waiting notice and cancels it when the answer arrives first", async () => {
		const { port, ctx } = setup();
		await vi.advanceTimersByTimeAsync(WARMUP_MS - 1);
		expect(port.calls).toEqual([]);
		ctx.emit(answer("answer"));
		await ctx.finish(outcome("completed"));
		await vi.runAllTimersAsync();
		expect(port.methods()).toEqual(["sendPlain", "discardCard"]);
	});

	it.each(["full_progress_then_plain_final", "rolling_progress_then_plain_final"] as const)(
		"collapses a card that showed progress to one status line on silent completion in %s",
		async (mode) => {
			const { port, ctx } = setup(mode);
			await vi.advanceTimersByTimeAsync(WARMUP_MS);
			expect(port.calls[0].method).toBe("replaceCard");
			expect(String(port.calls[0].args[1]).trim()).not.toBe("");
			ctx.emit(progress("visible progress"));
			await vi.advanceTimersByTimeAsync(0);
			await ctx.finish(outcome("silent"));
			const finalized = port.calls.filter((call) => call.method === "finalizeExistingCard");
			expect(finalized.at(-1)?.args[1]).toBe("已处理，无需答复。");
			expect(port.methods()).not.toContain("sendPlain");
		},
	);

	it("puts the answer into a waiting-only card instead of sending a second message", async () => {
		const { port, archived, ctx } = setup();
		await vi.advanceTimersByTimeAsync(WARMUP_MS);
		ctx.emit(answer("answer"));
		await ctx.finish(outcome("completed"));
		expect(port.methods()).toEqual(["replaceCard", "finalizeCard", "discardCard"]);
		expect(port.calls[1].args[1]).toBe("answer");
		expect(archived).toEqual(["answer"]);
	});

	it("coalesces queued progress into one frame, then appends only a new line", async () => {
		const { port, archive, ctx } = setup();
		ctx.emit(progress(" "));
		ctx.emit(progress("A"));
		ctx.emit(progress("B"));
		expect(port.calls).toEqual([]);
		await vi.advanceTimersByTimeAsync(0);
		const first = String(port.calls[0]?.args[1]);
		expect(port.calls[0]?.method).toBe("replaceCard");
		expect(first).toContain("\n- A\n- B");
		expect(first.split("\n").every((line) => line.startsWith("- "))).toBe(true);
		expect(Buffer.byteLength(first)).toBeLessThanOrEqual(CARD_REQUEST_MAX_BYTES);
		ctx.emit(progress("C"));
		await vi.advanceTimersByTimeAsync(0);
		const appended = String(port.calls.at(-1)?.args[1]);
		expect(port.calls.at(-1)?.method).toBe("appendToCard");
		expect(appended).toBe("\n- C");
		expect(appended).not.toContain("A");
		const after = port.calls.length;
		ctx.emit(progress("C"));
		await vi.advanceTimersByTimeAsync(0);
		expect(port.calls).toHaveLength(after);
		port.configure("supportsStreamingAppend", false);
		ctx.emit(progress("D"));
		await vi.advanceTimersByTimeAsync(0);
		const fallback = port.calls.at(-1);
		expect(fallback?.method).toBe("replaceCard");
		const snapshot = String(fallback?.args[1]);
		expect(Buffer.byteLength(snapshot)).toBeLessThanOrEqual(CARD_REQUEST_MAX_BYTES);
		expect(snapshot.split("\n").some((line) => line === "- A")).toBe(false);
		expect(snapshot).toContain("D");
		expect(archive).not.toHaveBeenCalled();
	});

	it("appends each new tool line and folds the card without sending the transcript again", async () => {
		const { port, ctx } = setup("rolling_progress_then_plain_final");
		for (const text of ["A", "B", "C", "D", "E"]) {
			ctx.emit({ type: "tool.start", callId: text, tool: "bash", args: { command: text } });
			await vi.advanceTimersByTimeAsync(0);
		}
		expect(port.calls[0]?.method).toBe("replaceCard");
		expect(port.calls.slice(1).every((call) => call.method === "appendToCard")).toBe(true);
		for (const call of port.calls) {
			expect(Buffer.byteLength(String(call.args[1]))).toBeLessThanOrEqual(CARD_REQUEST_MAX_BYTES);
		}
		const card = renderedCard(port.calls);
		expect(card).toContain("执行 A");
		expect(card).toContain("执行 E");
		ctx.emit(answer("answer"));
		await ctx.finish(outcome("completed"));
		expect(port.calls.filter((call) => call.method === "sendPlain")).toHaveLength(1);
		const finalized = port.calls.filter((call) => call.method === "finalizeExistingCard");
		expect(String(finalized.at(-1)?.args[1])).toContain("完成 · 工具调用 5 次");
	});

	it("draws no progress and primes no card for a final-only channel or a quiet turn", async () => {
		for (const { port, ctx } of [setup("final_card_only"), setup("full_progress_then_plain_final", true)]) {
			ctx.emit(progress("progress"));
			ctx.emit({ type: "tool.start", callId: "1", tool: "bash", args: { command: "ls" } });
			await vi.runAllTimersAsync();
			expect(port.calls).toEqual([]);
		}
	});

	it("a quiet turn still delivers its answer, with no card ever drawn", async () => {
		const { port, ctx } = setup("full_progress_then_plain_final", true);
		ctx.emit(progress("progress"));
		await vi.runAllTimersAsync();
		ctx.emit(answer("answer"));
		await ctx.finish(outcome("completed"));
		expect(port.calls.filter((call) => call.method !== "discardCard")).toEqual([
			{ method: "sendPlain", args: [CHANNEL, "answer"] },
		]);
	});

	it("successful final replacement blocks progress, silence, and a duplicate answer", async () => {
		const { port, ctx } = setup("final_card_only");
		ctx.emit(answer("answer"));
		ctx.emit(progress("late progress"));
		ctx.emit(answer("duplicate"));
		await ctx.finish(outcome("silent"));
		await vi.runAllTimersAsync();
		expect(port.calls.filter((call) => call.method !== "discardCard")).toEqual([
			{ method: "finalizeCard", args: [CHANNEL, "answer"] },
		]);
	});

	it("waits for the actual final delivery, retries a failed card once, and reports the failure", async () => {
		const warn = vi.spyOn(log, "logWarn").mockImplementation(() => undefined);
		const { port, ctx } = setup("final_card_only");
		let release!: (ok: boolean) => void;
		port.configure(
			"finalizeCard",
			new Promise<boolean>((resolve) => {
				release = resolve;
			}),
		);
		ctx.emit(answer("answer"));
		let settled = false;
		const finishing = ctx.finish(outcome("completed")).finally(() => {
			settled = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(settled).toBe(false);
		release(false);
		await finishing;
		// One attempt while the answer streamed, one fallback attempt at the end; neither reached the user.
		expect(port.methods().filter((method) => method === "finalizeCard")).toHaveLength(2);
		expect(warn).toHaveBeenCalledWith("delivery.final_reply.failed", expect.any(String), expect.anything());
	});

	it("waits for in-flight progress before closing and ignores everything after the end", async () => {
		const { port, ctx } = setup();
		let release!: (ok: boolean) => void;
		port.configure(
			"replaceCard",
			new Promise<boolean>((resolve) => {
				release = resolve;
			}),
		);
		await vi.advanceTimersByTimeAsync(WARMUP_MS);
		let closed = false;
		const closing = ctx.finish(outcome("completed")).then(() => {
			closed = true;
		});
		await Promise.resolve();
		expect(closed).toBe(false);
		release(true);
		await closing;
		expect(port.methods()).toEqual(["replaceCard", "finalizeExistingCard", "discardCard"]);
		ctx.emit(progress("ignored"));
		ctx.emit(answer("ignored"));
		await vi.runAllTimersAsync();
		expect(port.calls).toHaveLength(3);
	});

	it("keeps appended markdown complete, stops after two failed updates, and folds the card", async () => {
		const { port, ctx } = setup();
		ctx.emit({ type: "reasoning", text: `\`\`\`\n**未闭合 ${"甲".repeat(3000)}尾` });
		ctx.emit({ type: "tool.start", callId: "1", tool: "bash", args: { command: "ls src/a_b.ts *.md" } });
		ctx.emit(progress("可见"));
		await vi.advanceTimersByTimeAsync(0);
		const frame = renderedCard(port.calls);
		for (const call of port.calls) {
			expect(Buffer.byteLength(String(call.args[1]))).toBeLessThanOrEqual(CARD_REQUEST_MAX_BYTES);
		}
		expect(frame.includes("```") || frame.includes("`") || /[*_~]{2}/.test(frame)).toBe(false);
		expect(frame).toContain("尾");
		expect(frame).toContain("可见");
		expect(frame).toContain("a_b.ts");
		expect(frame).toContain("*.md");
		expect(frame.split("\n").every((line) => line.startsWith("- "))).toBe(true);
		const sent = {
			replace: port.calls.filter((call) => call.method === "replaceCard").length,
			append: port.calls.filter((call) => call.method === "appendToCard").length,
		};
		port.configure("appendToCard", false);
		port.configure("replaceCard", false);
		ctx.emit(progress("更多"));
		await vi.advanceTimersByTimeAsync(0);
		ctx.emit(progress("再来"));
		await vi.advanceTimersByTimeAsync(0);
		ctx.emit(progress("停"));
		await vi.advanceTimersByTimeAsync(0);
		expect(port.calls.filter((call) => call.method === "replaceCard")).toHaveLength(sent.replace + 2);
		expect(port.calls.filter((call) => call.method === "appendToCard")).toHaveLength(sent.append + 2);
		ctx.emit(answer("结论"));
		await ctx.finish(outcome("completed"));
		const summary = String(port.calls.filter((call) => call.method === "finalizeExistingCard").at(-1)?.args[1]);
		expect(summary.startsWith("完成 · 工具调用 1 次 · ")).toBe(true);
		expect(summary).not.toContain("可见");
		expect(port.calls.filter((call) => call.method === "sendPlain")).toEqual([
			{ method: "sendPlain", args: [CHANNEL, "结论"] },
		]);
	});

	it("archives only an answer that reached the user, and a failing archive does not break delivery", async () => {
		const { port, archive, ctx } = setup();
		port.configure("sendPlain", false);
		ctx.emit(answer("undelivered"));
		await ctx.finish(outcome("completed"));
		// The plain send failed; the end-of-turn fallback put it in a card instead. Nothing was archived.
		expect(port.methods()).toContain("finalizeCard");
		expect(archive).not.toHaveBeenCalled();

		const next = setup();
		next.archive.mockRejectedValue(new Error("disk full"));
		next.ctx.emit(answer("answer"));
		await expect(next.ctx.finish(outcome("completed"))).resolves.toBeUndefined();
		expect(next.archive).toHaveBeenCalledWith(CHANNEL, "answer");
	});

	it("shows runtime commentary by its level: errors as progress, notices always, warnings either way", async () => {
		const full = setup();
		full.ctx.emit({ type: "commentary", level: "error", text: "tool exploded" });
		full.ctx.emit({ type: "commentary", level: "warning", text: "switched model" });
		full.ctx.emit({ type: "commentary", level: "notice", text: "skill updated" });
		await vi.advanceTimersByTimeAsync(0);
		const card = renderedCard(full.port.calls);
		expect(card).toContain("✕ tool exploded");
		expect(card).toContain("✕ switched model");
		// A notice is a side message, never a progress line.
		expect(card).not.toContain("skill updated");
		expect(full.port.calls.filter((call) => call.method === "sendPlain")).toEqual([
			{ method: "sendPlain", args: [CHANNEL, "skill updated"] },
		]);

		const none = setup("final_card_only");
		none.ctx.emit({ type: "commentary", level: "error", text: "tool exploded" });
		none.ctx.emit({ type: "commentary", level: "warning", text: "switched model" });
		await vi.advanceTimersByTimeAsync(0);
		// With no progress to put it in, an error stays out of the chat but a warning is still said.
		expect(none.port.calls).toEqual([{ method: "sendPlain", args: [CHANNEL, "⚠️ switched model"] }]);
	});

	it("a stopped turn closes its card at once instead of waiting behind an in-flight write", async () => {
		const { port, ctx } = setup();
		let release!: (ok: boolean) => void;
		port.configure(
			"replaceCard",
			new Promise<boolean>((resolve) => {
				release = resolve;
			}),
		);
		await vi.advanceTimersByTimeAsync(WARMUP_MS);
		const finishing = ctx.finish(outcome("cancelled"));
		// The write is still pending, yet the card is already discarded and later events draw nothing.
		expect(port.methods()).toEqual(["replaceCard", "discardCard"]);
		ctx.emit(progress("stale"));
		release(true);
		await finishing;
		expect(port.calls.filter((call) => call.method === "appendToCard")).toHaveLength(0);
		expect(port.methods()).not.toContain("sendPlain");
	});
});

describe("DingTalk turn delivery against a stateful card API", () => {
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

	function remote(template = "template", mode: ResponseMode = "full_progress_then_plain_final") {
		const bot = new DingTalkBot(
			{ receive: async () => ({ kind: "started" }) },
			{ clientId: "test", clientSecret: "test", cardTemplateId: template, responseMode: mode, stateDir: temp() },
		);
		const privateApi = bot as unknown as {
			tokens: { accessToken: string; tokenExpiry: number };
			conversations: {
				set(channel: string, meta: { conversationId: string; conversationType: string; senderId: string }): void;
			};
		};
		privateApi.tokens.accessToken = "test-token";
		privateApi.tokens.tokenExpiry = Date.now() / 1000 + 3600;
		privateApi.conversations.set(CHANNEL, { conversationId: "test", conversationType: "1", senderId: "123" });
		const context = () => createDingTalkContext(turn, bot, async () => undefined, false);
		return { bot, context, ctx: context() };
	}
	const plainCalls = () => http.post.mock.calls.filter(([url]) => String(url).endsWith("batchSend"));
	const onlyCard = () => {
		expect(cards.size).toBe(1);
		return [...cards.values()][0];
	};

	it("folds a card that showed progress to one status line when the turn is silent", async () => {
		const { ctx } = remote();
		await vi.advanceTimersByTimeAsync(WARMUP_MS);
		ctx.emit(progress("observed work"));
		await vi.advanceTimersByTimeAsync(0);
		await ctx.finish(outcome("silent"));
		expect(onlyCard().content).toBe("已处理，无需答复。");
		expect(onlyCard().finished).toBe(true);
		expect(plainCalls()).toHaveLength(0);
	});

	it("creates at most one nonempty card when all progress updates fail", async () => {
		const { ctx } = remote();
		failWrites = true;
		for (const text of ["one", "two", "three", "four"]) {
			ctx.emit(progress(text));
			await vi.advanceTimersByTimeAsync(0);
		}
		expect(http.put).toHaveBeenCalledTimes(2);
		expect(onlyCard().content.trim()).not.toBe("");
		failWrites = false;
		ctx.emit(answer("answer"));
		await ctx.finish(outcome("completed"));
		expect(onlyCard().finished).toBe(true);
		expect(plainCalls()).toHaveLength(1);
	});

	it("does not create another instance when the create response is lost", async () => {
		const { ctx } = remote("template", "final_card_only");
		loseCreateResponse = true;
		ctx.emit(answer("answer"));
		await ctx.finish(outcome("completed"));
		expect(onlyCard().content.trim()).not.toBe("");
		expect(plainCalls()).toHaveLength(1);
	});

	it("appends whole lines until the card nears 2.9KB, then sends one short snapshot", async () => {
		const { ctx } = remote();
		ctx.emit(progress("A"));
		await vi.advanceTimersByTimeAsync(0);
		ctx.emit(progress("B"));
		await vi.advanceTimersByTimeAsync(0);
		ctx.emit(progress("C"));
		await vi.advanceTimersByTimeAsync(0);
		for (let index = 0; index < 6; index++) {
			ctx.emit(progress(`${index}${"丙".repeat(400)}`));
			await vi.advanceTimersByTimeAsync(0);
		}
		const frames = http.put.mock.calls.map((call) => call[1] as StreamBody);
		expect(frames[0]?.isFull).toBe(true);
		expect(frames[0]?.content.split("\n").every((line) => line.startsWith("- "))).toBe(true);
		let document = "";
		let compressed = false;
		for (const frame of frames) {
			expect(Buffer.byteLength(frame.content)).toBeLessThanOrEqual(CARD_REQUEST_MAX_BYTES);
			if (frame.isFull) {
				if (Buffer.byteLength(document) > CARD_COMPACT_MAX_BYTES) {
					expect(Buffer.byteLength(frame.content)).toBeLessThanOrEqual(CARD_COMPACT_MAX_BYTES);
					compressed = true;
				}
				document = frame.content;
			} else {
				expect(frame.content.startsWith("\n- ")).toBe(true);
				expect(Buffer.byteLength(document) + Buffer.byteLength(frame.content)).toBeLessThanOrEqual(
					CARD_DOCUMENT_MAX_BYTES,
				);
				document += frame.content;
			}
		}
		expect(compressed).toBe(true);
		expect(frames.some((frame) => frame.content.includes("- A"))).toBe(true);
		expect(onlyCard().content).toContain("丙");
		expect(Buffer.byteLength(onlyCard().content)).toBeLessThanOrEqual(CARD_DOCUMENT_MAX_BYTES);
	});

	it.each(["template", ""])(
		"does not create a progress card or fallback message after a fast final (%s)",
		async (template) => {
			const { ctx } = remote(template);
			ctx.emit(progress("buffered progress"));
			ctx.emit(answer("answer"));
			await ctx.finish(outcome("completed"));
			await vi.advanceTimersByTimeAsync(2000);
			expect(cards.size).toBe(0);
			expect(plainCalls()).toHaveLength(1);
		},
	);

	it("waits for in-flight creation and then answers in that same card", async () => {
		const { ctx } = remote();
		createGate = deferred();
		await vi.advanceTimersByTimeAsync(WARMUP_MS);
		ctx.emit(answer("answer"));
		let answered = false;
		const finishing = ctx.finish(outcome("completed")).then(() => {
			answered = true;
		});
		await Promise.resolve();
		expect(answered).toBe(false);
		createGate.resolve();
		await finishing;
		expect(onlyCard()).toEqual({ content: "answer", finished: true });
		expect(plainCalls()).toHaveLength(0);
	});

	it("a late create after stop cannot replace the next turn's card", async () => {
		const { ctx, context } = remote();
		const gate = deferred();
		createGate = gate;
		await vi.advanceTimersByTimeAsync(WARMUP_MS);
		const oldId = [...cards.keys()][0];
		const stopping = ctx.finish(outcome("cancelled"));
		createGate = undefined;
		const next = context();
		next.emit(progress("next turn"));
		await vi.advanceTimersByTimeAsync(0);
		const nextId = [...cards.keys()].find((id) => id !== oldId);
		expect(cards.get(nextId ?? "")?.content).toContain("next turn");
		gate.resolve();
		await stopping;
		next.emit(answer("answer"));
		await next.finish(outcome("completed"));
		expect(cards.size).toBe(2);
		expect(cards.get(oldId)?.finished).toBe(true);
		expect(cards.get(oldId)?.content).not.toContain("next turn");
		// The answer folds the new card in place. The late create must not have replaced it.
		expect(cards.get(nextId ?? "")?.content).toMatch(/^完成 · 工具调用 0 次 · /);
		expect(cards.get(nextId ?? "")?.finished).toBe(true);
	});

	it("stop is serialized after the old write and stale progress cannot create another card", async () => {
		const { ctx, context } = remote();
		streamGate = deferred();
		await vi.advanceTimersByTimeAsync(WARMUP_MS);
		const stopping = ctx.finish(outcome("cancelled"));
		ctx.emit(progress("stale progress"));
		streamGate.resolve();
		await stopping;
		await vi.advanceTimersByTimeAsync(0);
		expect(onlyCard().finished).toBe(true);
		expect(onlyCard().content).not.toContain("stale progress");
		const next = remote("template", "final_card_only");
		next.ctx.emit(answer("next answer"));
		await next.ctx.finish(outcome("completed"));
		void context;
		expect(cards.size).toBe(2);
		expect([...cards.values()].every((c) => c.finished && c.content.trim())).toBe(true);
	});

	it("a failed final card falls back to one plain message; when that fails too, delivery is reported failed", async () => {
		const warn = vi.spyOn(log, "logWarn").mockImplementation(() => undefined);
		const { ctx } = remote("template", "final_card_only");
		failWrites = true;
		ctx.emit(answer("answer"));
		await ctx.finish(outcome("completed"));
		expect(plainCalls()).toHaveLength(1);
		const next = remote("", "final_card_only");
		http.post.mockRejectedValue(new Error("plain unavailable"));
		next.ctx.emit(answer("undelivered"));
		await next.ctx.finish(outcome("completed"));
		expect(plainCalls()).toHaveLength(3);
		expect(warn).toHaveBeenCalledWith("delivery.final_reply.failed", expect.any(String), expect.anything());
	});
});
