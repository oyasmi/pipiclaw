import { describe, expect, it } from "vitest";
import { formatWilson, wilsonInterval } from "../../evals/harness/statistics.js";

describe("eval confidence intervals", () => {
	it("shows the uncertainty of small samples instead of implying 3/3 is stable", () => {
		const interval = wilsonInterval(3, 3)!;
		expect(interval[0]).toBeCloseTo(0.4385, 3);
		expect(interval[1]).toBe(1);
		expect(formatWilson(3, 3)).toBe("44–100%");
	});

	it("rejects invalid or empty denominators", () => {
		expect(wilsonInterval(0, 0)).toBeUndefined();
		expect(wilsonInterval(2, 1)).toBeUndefined();
		expect(formatWilson(0, 0)).toBe("N/A");
	});
});
