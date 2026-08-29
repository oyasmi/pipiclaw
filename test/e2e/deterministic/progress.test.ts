import { afterEach, describe, expect, it } from "vitest";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";

const hasContent = (method: string) =>
	method === "sendPlain" || method === "finalizeCard" || method === "finalizeExistingCard";

describe("E2E deterministic: progress & silent turns", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		harness.assertNoUnmatchedRequests();
		await harness.shutdown();
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
