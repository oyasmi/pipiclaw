import { describe, expect, it, vi } from "vitest";
import type { ChannelStore } from "../src/runtime/store.js";
import type { TranscriptRenderer } from "../src/tui/renderer.js";
import { createTerminalContext, type DeliveryTraits, type TurnInput } from "../src/tui/terminal-context.js";

function fakeRenderer() {
	const calls: Array<{ method: string; arg?: unknown }> = [];
	const renderer: TranscriptRenderer = {
		appendProgress: (text) => calls.push({ method: "appendProgress", arg: text }),
		showFinal: (text) => calls.push({ method: "showFinal", arg: text }),
		showNotice: (text) => calls.push({ method: "showNotice", arg: text }),
		clearProgress: () => calls.push({ method: "clearProgress" }),
		setWorking: (on) => calls.push({ method: "setWorking", arg: on }),
	};
	return { renderer, calls };
}

function fakeStore() {
	const logBotResponse = vi.fn().mockResolvedValue(undefined);
	return { logBotResponse } as unknown as ChannelStore & { logBotResponse: ReturnType<typeof vi.fn> };
}

const INPUT: TurnInput = { text: "hi", user: "tui", userName: "me", channel: "tui_local", ts: "1" };
const FULL: DeliveryTraits = { progressStyle: "full", finalDelivery: "plain" };

describe("terminal context", () => {
	it("exposes message + traits", () => {
		const { renderer } = fakeRenderer();
		const ctx = createTerminalContext(INPUT, renderer, fakeStore(), FULL);
		expect(ctx.message).toMatchObject({ text: "hi", rawText: "hi", user: "tui", channel: "tui_local" });
		expect(ctx.channelName).toBe("tui_local");
		expect(ctx.progressStyle).toBe("full");
		expect(ctx.finalDelivery).toBe("plain");
	});

	it("respond streams progress and archives only when shouldLog", async () => {
		const { renderer, calls } = fakeRenderer();
		const store = fakeStore();
		const ctx = createTerminalContext(INPUT, renderer, store, FULL);
		await ctx.respond("Running: bash", false);
		await ctx.respond("logged one", true);
		expect(calls.filter((c) => c.method === "appendProgress").map((c) => c.arg)).toEqual([
			"Running: bash",
			"logged one",
		]);
		expect(store.logBotResponse).toHaveBeenCalledTimes(1);
		expect(store.logBotResponse).toHaveBeenCalledWith("tui_local", "logged one", expect.any(String));
	});

	it("respondPlain renders final, archives by default, returns true", async () => {
		const { renderer, calls } = fakeRenderer();
		const store = fakeStore();
		const ctx = createTerminalContext(INPUT, renderer, store, FULL);
		const ok = await ctx.respondPlain("the answer");
		expect(ok).toBe(true);
		expect(calls).toContainEqual({ method: "showFinal", arg: "the answer" });
		expect(store.logBotResponse).toHaveBeenCalledWith("tui_local", "the answer", expect.any(String));
	});

	it("ignores progress after the final answer", async () => {
		const { renderer, calls } = fakeRenderer();
		const ctx = createTerminalContext(INPUT, renderer, fakeStore(), FULL);
		await ctx.respondPlain("done");
		await ctx.respond("late progress", false);
		expect(calls.some((c) => c.method === "appendProgress")).toBe(false);
	});

	it("respondPlain returns false for empty text so caller can fall back", async () => {
		const { renderer } = fakeRenderer();
		const ctx = createTerminalContext(INPUT, renderer, fakeStore(), FULL);
		expect(await ctx.respondPlain("   ")).toBe(false);
	});

	it("replaceMessage clears progress then shows final, without archiving", async () => {
		const { renderer, calls } = fakeRenderer();
		const store = fakeStore();
		const ctx = createTerminalContext(INPUT, renderer, store, FULL);
		await ctx.replaceMessage("replaced");
		expect(calls.map((c) => c.method)).toEqual(["clearProgress", "showFinal"]);
		expect(store.logBotResponse).not.toHaveBeenCalled();
	});

	it("deleteMessage collapses progress silently", async () => {
		const { renderer, calls } = fakeRenderer();
		const ctx = createTerminalContext(INPUT, renderer, fakeStore(), FULL);
		await ctx.deleteMessage();
		expect(calls).toEqual([{ method: "clearProgress" }]);
	});

	it("respondInThread renders a notice; blank is ignored", async () => {
		const { renderer, calls } = fakeRenderer();
		const ctx = createTerminalContext(INPUT, renderer, fakeStore(), FULL);
		await ctx.respondInThread("heads up");
		await ctx.respondInThread("   ");
		expect(calls).toEqual([{ method: "showNotice", arg: "heads up" }]);
	});

	it("drops progress entirely when progressStyle is none", async () => {
		const { renderer, calls } = fakeRenderer();
		const ctx = createTerminalContext(INPUT, renderer, fakeStore(), { progressStyle: "none", finalDelivery: "card" });
		await ctx.respond("nope", false);
		expect(calls).toEqual([]);
	});

	it("setWorking forwards to the renderer", async () => {
		const { renderer, calls } = fakeRenderer();
		const ctx = createTerminalContext(INPUT, renderer, fakeStore(), FULL);
		await ctx.setWorking(true);
		expect(calls).toEqual([{ method: "setWorking", arg: true }]);
	});
});
