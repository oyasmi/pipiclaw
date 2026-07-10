import { describe, expect, it } from "vitest";
import { scanPromotionSignals } from "../src/memory/promotion-signals.js";

// A regex list gating whether a turn even gets considered for memory/skill
// promotion. Silent typos or overly broad patterns here would either miss
// real promotion-worthy turns or fire on nearly everything; had no test.
describe("scanPromotionSignals", () => {
	it("flags Chinese durable-preference language", () => {
		expect(scanPromotionSignals("以后请默认用简体中文回复").hasSignal).toBe(true);
		expect(scanPromotionSignals("记住我的偏好：晚上不要发消息").hasSignal).toBe(true);
	});

	it("flags Chinese process/SOP language", () => {
		expect(scanPromotionSignals("这个流程以后每次都要走这几个步骤").hasSignal).toBe(true);
	});

	it("flags English durable-preference language case-insensitively", () => {
		expect(scanPromotionSignals("I prefer concise replies").hasSignal).toBe(true);
		expect(scanPromotionSignals("PLEASE REMEMBER this default").hasSignal).toBe(true);
	});

	it("flags English workflow/follow-up language", () => {
		expect(scanPromotionSignals("Let's adopt this workflow going forward").hasSignal).toBe(true);
		expect(scanPromotionSignals("next steps: follow up next week").hasSignal).toBe(true);
	});

	it("does not flag plain factual or task-only text", () => {
		const result = scanPromotionSignals("The build passed and all 90 tests are green.");
		expect(result.hasSignal).toBe(false);
		expect(result.matchedSignals).toEqual([]);
	});

	it("reports every distinct pattern that matched, not just the first", () => {
		const result = scanPromotionSignals("以后默认记住这个偏好");
		expect(result.matchedSignals.length).toBeGreaterThan(1);
	});
});
