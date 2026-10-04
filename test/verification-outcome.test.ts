import { describe, expect, it } from "vitest";
import { parseVerificationVerdict, resolveVerificationVerdict } from "../src/subagents/verification-outcome.js";

describe("verification verdict (spec 052, D6)", () => {
	it("takes the checker's declared verdict from the final line only", () => {
		expect(parseVerificationVerdict("looked fine\nVERDICT: PASS")).toBe("pass");
		expect(parseVerificationVerdict("VERDICT: FAIL")).toBe("fail");
		// A verdict that is not the last line is part of the discussion, not the verdict.
		expect(parseVerificationVerdict("VERDICT: PASS\nbut then I noticed a problem")).toBeUndefined();
	});

	it("never believes a PASS from a run that did not finish cleanly", () => {
		expect(resolveVerificationVerdict({ finalText: "VERDICT: PASS", runFailed: false })).toBe("pass");
		expect(resolveVerificationVerdict({ finalText: "VERDICT: PASS", runFailed: true })).toBe("fail");
	});

	it("treats a missing verdict line as a failure", () => {
		expect(resolveVerificationVerdict({ finalText: "all good, ship it", runFailed: false })).toBe("fail");
	});
});
