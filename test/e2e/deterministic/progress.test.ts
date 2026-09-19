import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";

const hasContent = (method: string) =>
	method === "sendPlain" || method === "finalizeCard" || method === "finalizeExistingCard";

describe("E2E deterministic: progress & silent turns", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		harness.assertNoUnmatchedRequests();
		await harness.shutdown();
	});

	it("awaited completion wakes create no progress cards while waiting, whether they answer or stay silent", async () => {
		// Regression: awaited job/subagent wakes used to prime a card, then clear it on [SILENT].
		// Mutation check: restoring the awaited exception in bootstrap's backgroundOnly makes
		// the held wake create a card at 1500ms and this test fail (verified 2026-09-19).
		harness = await createDeterministicHarness();
		for (const [marker, answer] of [
			["SILENT_WAKE", "[SILENT]"],
			["RESULT_WAKE", "result"],
		]) {
			harness.model.script.route({
				name: marker,
				when: (r) => r.isMainTurn && r.lastUserText.includes(marker),
				respond: [reply.text(answer)],
			});
			let arrived!: () => void;
			const requestArrived = new Promise<void>((resolve) => {
				arrived = resolve;
			});
			const gate = harness.model.script.hold({
				when: (r) => {
					if (!r.isMainTurn || !r.lastUserText.includes(marker)) return false;
					arrived();
					return true;
				},
			});
			const before = harness.deliveries.length;
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
			const wake = harness.sendWake(marker, { presentation: "awaited" });
			try {
				await requestArrived;
				await vi.advanceTimersByTimeAsync(1500);
				expect(harness.deliveries.slice(before).filter((d) => d.method !== "discardCard")).toHaveLength(0);
			} finally {
				vi.useRealTimers();
				gate.release();
				await wake;
			}
			const visible = harness.deliveries.slice(before).filter((d) => d.method !== "discardCard");
			expect(visible.map((d) => d.method)).toEqual(answer === "[SILENT]" ? [] : ["sendPlain"]);
		}
	});

	it("A8: a normal turn finalizes; a [SILENT] turn delivers nothing; a background wake opens no card", async () => {
		harness = await createDeterministicHarness();
		harness.model.script.route({
			name: "answer",
			when: (r) => r.isMainTurn && r.lastUserText.includes("ANSWER_ME"),
			respond: [reply.text("这是给用户的正式答复。")],
			repeat: true,
		});
		harness.model.script.route({
			name: "silent-msg",
			when: (r) => r.isMainTurn && r.lastUserText.includes("随便说点什么"),
			respond: [reply.text("[SILENT]")],
			repeat: true,
		});
		harness.model.script.route({
			name: "silent-wake",
			when: (r) => r.isMainTurn && r.lastUserText.includes("JOB:x"),
			respond: [reply.text("[SILENT]")],
			repeat: true,
		});

		// Normal turn → a content delivery lands.
		let before = harness.deliveries.length;
		await harness.sendUserMessage("ANSWER_ME 请回复");
		expect(
			harness.deliveries.slice(before).some((d) => hasContent(d.method) && (d.text ?? "").includes("正式答复")),
		).toBe(true);

		// [SILENT] turn from a normal message → no content delivery.
		before = harness.deliveries.length;
		await harness.sendUserMessage("随便说点什么");
		expect(harness.deliveries.slice(before).some((d) => hasContent(d.method))).toBe(false);

		// Background wake that ends [SILENT] → no card was ever opened for it.
		before = harness.deliveries.length;
		await harness.sendWake("[JOB:x] 后台检查完成。", { presentation: "background" as never });
		const wakeDeliveries = harness.deliveries.slice(before);
		expect(wakeDeliveries.some((d) => hasContent(d.method))).toBe(false);
		expect(wakeDeliveries.some((d) => d.method === "ensureCard")).toBe(false);
	});
});
