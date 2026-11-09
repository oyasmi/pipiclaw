import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const http = vi.hoisted(() => ({ post: vi.fn(), put: vi.fn(), defaults: {} }));
vi.mock("axios", () => ({ default: { ...http, create: () => http, isAxiosError: () => false } }));

import type { TurnEvent, TurnOutcome } from "../src/channel/channel-context.js";
import { deliveryScopeKey } from "../src/channel/delivery-scope.js";
import type { TurnInfo } from "../src/channel/transport.js";
import { DingTalkBot } from "../src/dingtalk/bot.js";
import { createDingTalkContext, type DeliveryPort } from "../src/dingtalk/delivery.js";
import { CARD_DOCUMENT_MAX_BYTES, CARD_REQUEST_MAX_BYTES } from "../src/dingtalk/progress.js";
import {
	type FinalDelivery,
	finalDeliveryOf,
	type ProgressStyle,
	progressStyleOf,
	type ResponseMode,
} from "../src/dingtalk/response-mode.js";
import { DingTalkScopeDelivery } from "../src/dingtalk/scope-delivery.js";
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
/** Advance the display throttle explicitly; no real sleeps in these scenarios. */
const FRAME_MS = 800;

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

/** The document implied by the recording port's writes. */
function renderedCard(calls: Array<{ method: string; args: unknown[] }>): string {
	let document = "";
	for (const call of calls) {
		const text = String(call.args[1] ?? "");
		if (call.method === "replaceCard") document = text;
		else if (call.method === "appendToCard") document += text;
	}
	return document;
}

function setup(
	mode: ResponseMode = "full_progress_then_plain_final",
	quiet = false,
	configure?: (port: RecordingPort) => void,
) {
	const port = new RecordingPort();
	port.responseMode = mode;
	configure?.(port);
	const archived: string[] = [];
	const archive = vi.fn(async (_channelId: string, text: string) => {
		archived.push(text);
	});
	const ctx = createDingTalkContext(turn, port, archive, quiet);
	return { port, archive, archived, ctx };
}

describe("DingTalk turn delivery: events onto cards and messages", () => {
	it("opens a waiting card synchronously and closes it even when no progress follows", async () => {
		const { port, ctx } = setup();
		expect(port.methods()).toEqual(["replaceCard"]);
		expect(String(port.calls[0].args[1]).trim()).not.toBe("");
		await ctx.finish(outcome("silent"));
		await vi.runAllTimersAsync();
		expect(port.methods()).toEqual(["replaceCard", "finalizeExistingCard", "discardCard"]);
	});

	it.each(["full_progress_then_plain_final", "rolling_progress_then_plain_final"] as const)(
		"collapses a card that showed progress to one status line on silent completion in %s",
		async (mode) => {
			const { port, ctx } = setup(mode);
			await vi.advanceTimersByTimeAsync(0);
			expect(port.calls[0].method).toBe("replaceCard");
			expect(String(port.calls[0].args[1]).trim()).not.toBe("");
			ctx.emit(progress("visible progress"));
			await vi.advanceTimersByTimeAsync(FRAME_MS);
			await ctx.finish(outcome("silent"));
			const finalized = port.calls.filter((call) => call.method === "finalizeExistingCard");
			expect(finalized.at(-1)?.args[1]).toBe("已处理，无需答复。");
			expect(port.methods()).not.toContain("sendPlain");
		},
	);

	it("puts the answer into a waiting-only card instead of sending a second message", async () => {
		const { port, archived, ctx } = setup();
		ctx.emit(answer("answer"));
		await ctx.finish(outcome("completed"));
		expect(port.methods()).toEqual(["replaceCard", "finalizeCard", "discardCard"]);
		expect(port.calls[1].args[1]).toBe("answer");
		expect(archived).toEqual(["answer"]);
	});

	it("coalesces bursts without postponing a frame, and paces events received during HTTP", async () => {
		// A debounce starves busy streams; draining revisions immediately hides folds on slow HTTP.
		// Mutation (2026-11-05): zero the interval -> an extra frame appears before the deadline.
		const { port, archive, ctx } = setup();
		ctx.emit(progress(" "));
		ctx.emit(progress("A"));
		ctx.emit(progress("B"));
		expect(port.methods()).toEqual(["replaceCard"]);
		await vi.advanceTimersByTimeAsync(FRAME_MS);
		expect(renderedCard(port.calls)).toContain("\n- A\n- B");
		ctx.emit(progress("C"));
		await vi.advanceTimersByTimeAsync(FRAME_MS - 1);
		expect(port.calls).toHaveLength(2);
		let release!: (ok: boolean) => void;
		port.configure(
			"appendToCard",
			new Promise<boolean>((resolve) => {
				release = resolve;
			}),
		);
		ctx.emit(progress("D"));
		await vi.advanceTimersByTimeAsync(1);
		expect(port.calls).toHaveLength(3);
		expect(renderedCard(port.calls)).toContain("- D");
		ctx.emit(progress("E"));
		ctx.emit(progress("F"));
		await vi.advanceTimersByTimeAsync(FRAME_MS * 2);
		expect(port.calls).toHaveLength(3);
		port.configure("appendToCard", true);
		release(true);
		await vi.advanceTimersByTimeAsync(FRAME_MS - 1);
		expect(port.calls).toHaveLength(3);
		await vi.advanceTimersByTimeAsync(1);
		expect(port.calls).toHaveLength(4);
		expect(renderedCard(port.calls)).toContain("- F");
		ctx.emit(progress("F"));
		await vi.advanceTimersByTimeAsync(FRAME_MS);
		expect(port.calls).toHaveLength(4);
		// Templates that reject append use bounded snapshots; they never receive a >1KB replay.
		port.configure("supportsStreamingAppend", false);
		ctx.emit(progress("fallback"));
		await vi.advanceTimersByTimeAsync(FRAME_MS);
		expect(port.calls.at(-1)?.method).toBe("replaceCard");
		expect(renderedCard(port.calls)).toContain("fallback");
		port.configure("supportsStreamingAppend", true);
		port.configure(
			"appendToCard",
			new Promise<boolean>((resolve) => {
				release = resolve;
			}),
		);
		ctx.emit(progress("held"));
		await vi.advanceTimersByTimeAsync(FRAME_MS);
		const beforeFold = port.calls.length;
		// A fold while an old append is in flight must survive its late acknowledgement.
		for (let index = 0; index < 25; index++) ctx.emit(progress(`burst-${index} ${"甲".repeat(100)}`));
		await vi.advanceTimersByTimeAsync(0);
		port.configure("appendToCard", true);
		release(true);
		await vi.advanceTimersByTimeAsync(FRAME_MS - 1);
		expect(port.calls).toHaveLength(beforeFold);
		await vi.advanceTimersByTimeAsync(1);
		expect(port.calls.at(-1)?.method).toBe("replaceCard");
		await vi.runAllTimersAsync();
		const burst = port.calls.slice(beforeFold);
		expect(burst.length).toBeGreaterThan(1); // A current cycle larger than 1KB is paced in parts.
		for (const call of burst)
			expect(Buffer.byteLength(String(call.args[1]))).toBeLessThanOrEqual(CARD_REQUEST_MAX_BYTES);
		expect(renderedCard(port.calls)).toContain("burst-24");
		expect(renderedCard(port.calls).split("\n")).not.toContain("- A");
		expect(archive).not.toHaveBeenCalled();
	});

	it("accumulates full progress while rolling keeps only recent events, and finalizes without waiting", async () => {
		// Mutation (2026-11-05): force both modes to rolling -> the first tool event disappears.
		for (const mode of ["full_progress_then_plain_final", "rolling_progress_then_plain_final"] as const) {
			const { port, ctx } = setup(mode);
			for (let index = 0; index < 16; index++) {
				ctx.emit({ type: "tool.start", callId: String(index), tool: "bash", args: { command: `cmd-${index}` } });
				await vi.advanceTimersByTimeAsync(FRAME_MS);
			}
			const card = renderedCard(port.calls);
			expect(card).toContain("cmd-15");
			if (mode === "full_progress_then_plain_final") {
				expect(card).toContain("cmd-0");
				expect(card.split("\n")).toHaveLength(17); // No arbitrary row limit in full mode.
			} else {
				expect(card).not.toContain("cmd-0");
				expect(card.split("\n")).toHaveLength(6); // header + five recent events
			}
			ctx.emit({ type: "reasoning", text: "new thought" });
			await vi.advanceTimersByTimeAsync(FRAME_MS);
			const withThinking = renderedCard(port.calls);
			expect(withThinking).toContain("new thought");
			expect(withThinking.split("\n")).toHaveLength(mode === "rolling_progress_then_plain_final" ? 6 : 18);
			// Five maximum-sized entries must fit with the header, without silently folding rolling.
			for (let index = 0; index < 5; index++) {
				ctx.emit(progress(`${index}${"甲".repeat(400)}`));
				await vi.advanceTimersByTimeAsync(FRAME_MS);
			}
			if (mode === "rolling_progress_then_plain_final") {
				const recent = renderedCard(port.calls);
				expect(recent.split("\n")).toHaveLength(6);
				expect(Buffer.byteLength(recent)).toBeLessThanOrEqual(CARD_REQUEST_MAX_BYTES);
			}
			ctx.emit(progress("pending"));
			ctx.emit(answer("answer"));
			await ctx.finish(outcome("completed"));
			expect(port.calls.filter((call) => call.method === "sendPlain")).toHaveLength(1);
			const finalized = port.calls.filter((call) => call.method === "finalizeExistingCard");
			expect(String(finalized.at(-1)?.args[1])).toContain("工具调用 16 次");
		}
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
		let release!: (ok: boolean) => void;
		const { port, ctx } = setup("full_progress_then_plain_final", false, (port) => {
			port.configure(
				"replaceCard",
				new Promise<boolean>((resolve) => {
					release = resolve;
				}),
			);
		});
		await vi.advanceTimersByTimeAsync(0);
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

	it("keeps markdown complete and stops after two failed writes without losing the final answer", async () => {
		const { port, ctx } = setup();
		ctx.emit({ type: "reasoning", text: `\`\`\`\n**未闭合 ${"甲".repeat(3000)}尾` });
		ctx.emit({ type: "tool.start", callId: "1", tool: "bash", args: { command: "ls src/a_b.ts *.md" } });
		ctx.emit(progress("可见"));
		await vi.advanceTimersByTimeAsync(FRAME_MS);
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
		const sent = port.calls.length;
		port.configure("replaceCard", false);
		port.configure("appendToCard", false);
		for (const text of ["更多", "再来", "停"]) {
			ctx.emit(progress(text));
			await vi.advanceTimersByTimeAsync(FRAME_MS);
		}
		expect(port.calls).toHaveLength(sent + 2);
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
		ctx.emit(progress("observed work"));
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
		await vi.advanceTimersByTimeAsync(FRAME_MS);
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
		let release!: (ok: boolean) => void;
		const { port, ctx } = setup("full_progress_then_plain_final", false, (port) => {
			port.configure(
				"replaceCard",
				new Promise<boolean>((resolve) => {
					release = resolve;
				}),
			);
		});
		await vi.advanceTimersByTimeAsync(0);
		const finishing = ctx.finish(outcome("cancelled"));
		// The write is still pending, yet the card is already discarded and later events draw nothing.
		expect(port.methods()).toEqual(["replaceCard", "discardCard"]);
		ctx.emit(progress("stale"));
		release(true);
		await finishing;
		expect(port.calls.filter((call) => call.method === "replaceCard")).toHaveLength(1);
		expect(port.methods()).not.toContain("sendPlain");
		// The new throttle must not delay /stop when a future frame is queued.
		const next = setup();
		next.ctx.emit(progress("first"));
		await vi.advanceTimersByTimeAsync(0);
		next.ctx.emit(progress("pending"));
		await vi.advanceTimersByTimeAsync(0);
		let ended = false;
		const stopped = next.ctx.finish(outcome("cancelled")).then(() => {
			ended = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(ended).toBe(true);
		await stopped;
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

	beforeEach(() => {
		cards.clear();
		createGate = streamGate = undefined;
		failWrites = loseCreateResponse = false;
		http.post.mockReset().mockImplementation(async (url: string, body: CreateBody) => {
			if (url.endsWith("createAndDeliver")) {
				cards.set(body.outTrackId, { content: body.cardData.cardParamMap.content, finished: false });
				if (createGate) await createGate.promise;
				if (loseCreateResponse) throw new Error("lost create response");
			}
			return {
				data: url.endsWith("createAndDeliver")
					? { success: true, result: { outTrackId: body.outTrackId, deliverResults: [{ success: true }] } }
					: { processQueryKey: "fixture-receipt" },
			};
		});
		http.put.mockReset().mockImplementation(async (_url: string, body: StreamBody) => {
			if (streamGate) await streamGate.promise;
			if (failWrites) throw new Error("stream unavailable");
			const card = cards.get(body.outTrackId);
			if (!card) throw new Error("unknown card");
			card.content = body.isFull ? body.content : card.content + body.content;
			card.finished = body.isFinalize;
			return { data: { success: true, result: true } };
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
		await vi.advanceTimersByTimeAsync(0);
		ctx.emit(progress("observed work"));
		await vi.advanceTimersByTimeAsync(FRAME_MS);
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
			await vi.advanceTimersByTimeAsync(FRAME_MS);
		}
		expect(http.put).toHaveBeenCalledTimes(2);
		expect(onlyCard().content.trim()).not.toBe("");
		failWrites = false;
		ctx.emit(answer("answer"));
		await ctx.finish(outcome("completed"));
		expect(onlyCard().finished).toBe(true);
		expect(plainCalls()).toHaveLength(1);
	});

	it("does not create another instance when creation is unconfirmed", async () => {
		const post = http.post.getMockImplementation()!;
		for (const mode of ["lost", "empty", "rejected", "wrong-owner"]) {
			cards.clear();
			http.post.mockClear().mockImplementation(async (url: string, body: CreateBody) => {
				const response = await post(url, body);
				if (!url.endsWith("createAndDeliver") || mode === "lost") return response;
				return {
					data:
						mode === "empty"
							? {}
							: {
									success: mode !== "rejected",
									result: { outTrackId: "another-owner", deliverResults: [{ success: true }] },
								},
				};
			});
			const { ctx } = remote("template", "final_card_only");
			loseCreateResponse = mode === "lost";
			ctx.emit(answer("answer"));
			await ctx.finish(outcome("completed"));
			expect(onlyCard().content.trim()).not.toBe("");
			expect(http.post.mock.calls.filter(([url]) => String(url).endsWith("createAndDeliver"))).toHaveLength(1);
			expect(plainCalls()).toHaveLength(1);
		}
	});

	it("repeatedly folds and regrows a bounded window without replaying removed content", async () => {
		// Regression: 6ca4630 mixed replacement with remote append and drained queued lines after
		// folding. Epoch changes must reset the acknowledged prefix; normal growth sends deltas.
		// Mutations (2026-11-06): force full snapshots / retain the old baseline after replace;
		// both lose the newest event once the request-sized prefix is exhausted, and turn this case red.
		const { ctx } = remote();
		ctx.emit({ type: "reasoning", text: "latest thought" });
		await vi.advanceTimersByTimeAsync(FRAME_MS);
		let previous: string[] = [];
		let folds = 0;
		let regrows = 0;
		let folded = false;
		const removed = new Set<string>();
		let wireBytes = 0;
		let snapshotBytes = 0;
		for (let index = 0; index < 160; index++) {
			const line = `activity-${index} extra words ${"甲".repeat(12)}`;
			ctx.emit(progress(line));
			await vi.advanceTimersByTimeAsync(FRAME_MS);
			const frame = http.put.mock.calls.at(-1)?.[1] as StreamBody;
			expect(Buffer.byteLength(frame.content)).toBeLessThanOrEqual(CARD_REQUEST_MAX_BYTES);
			if (!frame.isFull) expect(frame.content).toBe(`\n- ${line}`);
			wireBytes += Buffer.byteLength(frame.content);
			snapshotBytes += Buffer.byteLength(onlyCard().content);
			expect(Buffer.byteLength(onlyCard().content)).toBeLessThanOrEqual(CARD_DOCUMENT_MAX_BYTES);
			const rows = onlyCard().content.split("\n");
			expect(rows.every((row) => row.startsWith("- "))).toBe(true);
			expect(onlyCard().content).toContain("latest thought");
			expect(rows.at(-1)).toBe(`- ${line}`);
			if (rows.length < previous.length) {
				folds++;
				folded = true;
				expect(rows.length).toBe(4); // header, pinned thought, two retained activities
				for (const row of previous.slice(2)) if (!rows.includes(row)) removed.add(row);
			} else if (folded) {
				expect(rows.length).toBe(previous.length + 1);
				regrows++;
				folded = false;
			}
			for (const row of removed) expect(rows).not.toContain(row);
			previous = rows;
		}
		expect(folds).toBeGreaterThanOrEqual(3);
		expect(regrows).toBeGreaterThanOrEqual(3);
		expect(wireBytes).toBeLessThan(snapshotBytes / 2);
		// Long Chinese lines must respect the UTF-8 budget, including multibyte truncation.
		for (let index = 0; index < 8; index++) {
			ctx.emit(progress(`${index}${"丙".repeat(400)}`));
			await vi.advanceTimersByTimeAsync(FRAME_MS);
			expect(Buffer.byteLength(onlyCard().content)).toBeLessThanOrEqual(CARD_DOCUMENT_MAX_BYTES);
		}
		// The server applied this write, but its response was lost. A retry must replace it,
		// rather than duplicate it or restore an earlier window.
		http.put.mockImplementationOnce(async (_url: string, body: StreamBody) => {
			const card = cards.get(body.outTrackId);
			if (card) card.content = body.isFull ? body.content : card.content + body.content;
			throw new Error("lost append response");
		});
		ctx.emit(progress("ambiguous"));
		await vi.advanceTimersByTimeAsync(FRAME_MS);
		await vi.advanceTimersByTimeAsync(FRAME_MS);
		expect((http.put.mock.calls.at(-1)?.[1] as StreamBody).isFull).toBe(true);
		ctx.emit(progress("recovered"));
		await vi.advanceTimersByTimeAsync(FRAME_MS);
		expect(onlyCard().content.match(/ambiguous/g)).toHaveLength(1);
		expect(onlyCard().content).toContain("recovered");
		await ctx.finish(outcome("silent"));
	});

	it.each(["template", ""])(
		"keeps one card for a fast final, or sends plainly without a template (%s)",
		async (template) => {
			const { ctx } = remote(template);
			ctx.emit(answer("answer"));
			ctx.emit(progress("late progress"));
			await ctx.finish(outcome("completed"));
			// Cross two display intervals without draining the bot's recurring idle sweep.
			await vi.advanceTimersByTimeAsync(FRAME_MS * 2);
			expect(cards.size).toBe(template ? 1 : 0);
			if (template) expect(onlyCard()).toEqual({ content: "answer", finished: true });
			expect(plainCalls()).toHaveLength(template ? 0 : 1);
		},
	);

	it("waits for in-flight creation and then answers in that same card", async () => {
		createGate = deferred();
		const { ctx } = remote();
		await vi.advanceTimersByTimeAsync(0);
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
		const gate = deferred();
		createGate = gate;
		const { ctx, context } = remote();
		await vi.advanceTimersByTimeAsync(0);
		const oldId = [...cards.keys()][0];
		const stopping = ctx.finish(outcome("cancelled"));
		createGate = undefined;
		const next = context();
		next.emit(progress("next turn"));
		await vi.advanceTimersByTimeAsync(FRAME_MS);
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
		streamGate = deferred();
		const { ctx, context } = remote();
		await vi.advanceTimersByTimeAsync(0);
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

	it("keeps concurrent scopes on separate remote cards and rejects unconfirmed update/final responses", async () => {
		// New risk: a channel-keyed publisher overwrites another scope; 2xx alone opens delivery gates.
		// Mutation 2026-11-09: key by channelId only -> one remote card instead of two (confirmed red).
		const { bot, ctx } = remote();
		await ctx.finish(outcome("silent"));
		cards.clear();
		http.post.mockClear();
		http.put.mockClear();
		const scopes = new DingTalkScopeDelivery(bot, async () => undefined, true);
		const owner = { desk: "default", channelId: CHANNEL, scopeId: "request:first" as const };
		createGate = deferred();
		const first = scopes.open(owner, false);
		first.emit(progress("first scope"));
		await vi.advanceTimersByTimeAsync(0);
		const firstId = [...cards.keys()][0]!;
		const gate = createGate;
		createGate = undefined;
		const second = scopes.open({ ...owner, scopeId: "task:second" }, false);
		second.emit(progress("second scope"));
		await vi.advanceTimersByTimeAsync(FRAME_MS);
		expect(cards.size).toBe(2);
		const secondId = [...cards.keys()].find((id) => id !== firstId)!;
		expect(cards.get(secondId)?.content).toContain("second scope");
		gate.resolve();
		await vi.advanceTimersByTimeAsync(FRAME_MS);
		expect(cards.size).toBe(2);
		expect(cards.get(firstId)?.content).toContain("first scope");
		expect(cards.get(firstId)?.content).not.toContain("second scope");
		expect(bot.cardChannel(`scope:${deliveryScopeKey(owner)}`)).toBe(CHANNEL);
		const put = http.put.getMockImplementation()!;
		let rejectReport = true;
		http.put.mockImplementation((url: string, body: StreamBody) =>
			body.outTrackId === secondId && rejectReport
				? Promise.resolve({ data: { success: false, result: false } })
				: put(url, body),
		);
		const report = second.report({ id: "report", text: "new report" });
		await vi.advanceTimersByTimeAsync(FRAME_MS);
		expect(await report).toEqual({ status: "unknown" });
		rejectReport = false;
		const retry = second.report({ id: "report", text: "new report" });
		await vi.advanceTimersByTimeAsync(FRAME_MS);
		expect(await retry).toEqual({ status: "confirmed" });
		// Missing send receipt is unknown; retry is the same business final, never a new card.
		http.post.mockResolvedValueOnce({ data: {} });
		const intent = { id: "final", text: "final answer" };
		expect(await first.finalize(intent)).toEqual({ status: "unknown" });
		expect(await first.finalize(intent)).toEqual({ status: "confirmed" });
		expect(await first.finalize(intent)).toEqual({ status: "confirmed" });
		first.emit(progress("late first writer"));
		await scopes.stop();
		expect(cards.size).toBe(2);
		expect(plainCalls()).toHaveLength(2);
		expect(cards.get(secondId)?.content).not.toContain("late first writer");
	});

	it("revokes queued scope writes before HTTP when its binding changes", async () => {
		// Review R4: a paced frame or queued stream must not execute under another desk's binding.
		// Mutation 2026-11-09: remove streamCardRequest guard -> queued write succeeds (red, restored).
		const { bot, ctx } = remote();
		await ctx.finish(outcome("silent"));
		cards.clear();
		http.post.mockClear();
		http.put.mockClear();
		const scopes = new DingTalkScopeDelivery(bot, async () => undefined, true);
		let bound = true;
		const scope = scopes.open({ desk: "default", channelId: CHANNEL, scopeId: "task:bound" }, false, () => bound);
		await vi.advanceTimersByTimeAsync(0);
		const before = http.put.mock.calls.length;
		scope.emit(progress("queued old desk"));
		bound = false;
		await vi.advanceTimersByTimeAsync(FRAME_MS);
		expect(http.put).toHaveBeenCalledTimes(before);
		expect(await scope.report({ id: "report", text: "old report" })).toEqual({ status: "blocked" });
		expect(await scope.finalize({ id: "final", text: "old answer" })).toEqual({ status: "blocked" });
		expect(plainCalls()).toHaveLength(0);
		bound = true;
		expect(await scope.finalize({ id: "final", text: "late old answer" })).toEqual({ status: "blocked" });
		expect(http.put).toHaveBeenCalledTimes(before);
		// A second write can already be inside CardController's per-card queue when rebinding.
		let queuedBound = true;
		const queuedOwner = { desk: "default", channelId: CHANNEL, scopeId: "task:queued-http" as const };
		scopes.open(queuedOwner, false, () => queuedBound);
		await vi.advanceTimersByTimeAsync(0);
		const key = `scope:${deliveryScopeKey(queuedOwner)}`;
		const generation = bot.getCardGeneration(key);
		streamGate = deferred();
		const puts = http.put.mock.calls.length;
		const inFlight = bot.replaceCard(key, "already submitted", false, false, generation);
		await vi.advanceTimersByTimeAsync(0);
		const queued = bot.replaceCard(key, "not submitted", false, false, generation);
		queuedBound = false;
		streamGate.resolve();
		await inFlight;
		expect(await queued).toBe(false);
		expect(http.put).toHaveBeenCalledTimes(puts + 1);
		streamGate = undefined;
		// A binding can change while CREATE or SEND waits for a token, after the adapter entry check.
		const tokens = (bot as unknown as { tokens: { get(): Promise<string | null> } }).tokens;
		for (const kind of ["create", "send"]) {
			let allowed = true;
			const entered = deferred();
			const release = deferred();
			vi.spyOn(tokens, "get").mockImplementation(async () => {
				entered.resolve();
				await release.promise;
				return "test-token";
			});
			const posts = http.post.mock.calls.length;
			const writer = scopes.open(
				{ desk: "default", channelId: CHANNEL, scopeId: `task:token-${kind}` },
				kind === "send",
				() => allowed,
			);
			const sending = kind === "send" ? writer.finalize({ id: "final", text: "old owner" }) : undefined;
			await entered.promise;
			allowed = false;
			release.resolve();
			await vi.advanceTimersByTimeAsync(0);
			if (sending) expect(await sending).toEqual({ status: "blocked" });
			expect(http.post).toHaveBeenCalledTimes(posts);
		}
		await scopes.stop();
	});

	it("recovers a report after an ambiguous CREATE by a confirmed plain retry without creating another card", async () => {
		// Review R5: CREATE may have reached the platform; retry must unblock the report without a second card.
		// Mutation 2026-11-09: disable fallback -> retry stays unknown (confirmed red, restored).
		const { bot, ctx } = remote();
		await ctx.finish(outcome("silent"));
		cards.clear();
		http.post.mockClear();
		http.put.mockClear();
		loseCreateResponse = true;
		const scopes = new DingTalkScopeDelivery(bot, async () => undefined, true);
		const scope = scopes.open({ desk: "default", channelId: CHANNEL, scopeId: "task:create-failed" }, false);
		const first = scope.report({ id: "report", text: "retained result" });
		await vi.advanceTimersByTimeAsync(FRAME_MS);
		expect(await first).toEqual({ status: "unknown" });
		loseCreateResponse = false;
		const retried = scope.report({ id: "report", text: "retained result" });
		await vi.advanceTimersByTimeAsync(FRAME_MS);
		expect(await retried).toEqual({ status: "confirmed" });
		const intent = { id: "close", text: "completed" };
		expect(await scope.finalize(intent)).toEqual({ status: "confirmed" });
		expect(await scope.finalize(intent)).toEqual({ status: "confirmed" });
		expect(cards.size).toBe(1);
		expect(http.post.mock.calls.filter(([url]) => String(url).endsWith("createAndDeliver"))).toHaveLength(1);
		expect(plainCalls()).toHaveLength(2);
		await scopes.stop();
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
