import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";

describe("E2E deterministic: progress & silent turns", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		await harness.shutdown();
	});

	it("awaited completion wakes create no progress cards while waiting, whether they answer or stay silent", async () => {
		// Regression: awaited job/subagent wakes used to prime a card, then clear it on [SILENT].
		// Mutation check (2026-11-06): opening background turns with quiet: false creates a
		// waiting card before provider arrival and makes this case fail.
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
			const gate = harness.model.script.hold({
				when: (r) => r.isMainTurn && r.lastUserText.includes(marker),
			});
			const before = harness.deliveries.length;
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
			const wake = harness.sendWake(marker, { presentation: "awaited" });
			try {
				await gate.arrived;
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

	it("A8: human turns open cards before model output; silent turns close them; background wakes open none", async () => {
		// Regression: delayed waiting cards leave human turns without feedback until model output.
		// Mutation check (2026-11-06): delaying the initial revision by 3500ms makes the
		// pre-release delivery assertion fail. Silent human turns must now close their card.
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

		// Freeze timers and hold the model: feedback must precede its answer, with no time advance.
		const gate = harness.model.script.hold({
			when: (r) => r.isMainTurn && r.lastUserText.includes("ANSWER_ME"),
		});
		let before = harness.deliveries.length;
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const sending = harness.sendUserMessageNoWait("ANSWER_ME 请回复");
		try {
			await gate.arrived;
			expect(harness.deliveries.slice(before).map((d) => d.method)).toEqual(["replaceCard"]);
		} finally {
			vi.useRealTimers();
			gate.release();
			await sending;
			await harness.waitForIdle();
		}
		expect(harness.deliveries.slice(before).map((d) => d.method)).toEqual([
			"replaceCard",
			"finalizeCard",
			"discardCard",
		]);

		// A silent human turn still closes the immediately opened waiting card.
		before = harness.deliveries.length;
		await harness.sendUserMessage("随便说点什么");
		expect(harness.deliveries.slice(before).map((d) => d.method)).toEqual([
			"replaceCard",
			"finalizeExistingCard",
			"discardCard",
		]);

		// Background wake that ends [SILENT] → no card was ever opened for it.
		before = harness.deliveries.length;
		await harness.sendWake("[JOB:x] 后台检查完成。", { presentation: "background" as never });
		expect(harness.deliveries.slice(before).filter((d) => d.method !== "discardCard")).toEqual([]);
	});
});
