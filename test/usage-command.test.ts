import { describe, expect, it } from "vitest";
import { parseBuiltInCommand } from "../src/agent/commands.js";
import type { UsageLedger, UsageSummary, UsageSummaryQuery } from "../src/usage/ledger.js";
import { parseUsageMode, renderUsageReport, usageWindows } from "../src/usage/render.js";

const NOW = new Date("2026-07-04T12:00:00Z");

/** In-memory ledger stub that returns fixed per-query summaries. */
function stubLedger(fn: (q: UsageSummaryQuery) => Partial<UsageSummary>): UsageLedger {
	return {
		record: () => {},
		summarize: (q) => ({
			totalCost: 0,
			entryCount: 0,
			byKind: {},
			byModel: {},
			byChannel: {},
			...fn(q),
		}),
	};
}

describe("/usage command parsing", () => {
	it("is recognized as a built-in command with args", () => {
		expect(parseBuiltInCommand("/usage")).toMatchObject({ name: "usage", args: "" });
		expect(parseBuiltInCommand("/usage 7d")).toMatchObject({ name: "usage", args: "7d" });
	});

	it("maps args to a query mode", () => {
		expect(parseUsageMode("")).toBe("default");
		expect(parseUsageMode("7d")).toBe("7d");
		expect(parseUsageMode("month")).toBe("month");
		expect(parseUsageMode("garbage")).toBe("default");
	});
});

describe("usage windows", () => {
	it("default shows today + this month", () => {
		const windows = usageWindows("default", NOW);
		expect(windows.map((w) => w.title)).toEqual(["Today (UTC)", "This month (2026-07)"]);
		expect(windows[0].since.toISOString()).toBe("2026-07-04T00:00:00.000Z");
		expect(windows[1].since.toISOString()).toBe("2026-07-01T00:00:00.000Z");
	});

	it("7d spans the last week", () => {
		const [window] = usageWindows("7d", NOW);
		expect(window.title).toBe("Last 7 days");
		expect(window.since.toISOString()).toBe("2026-06-27T12:00:00.000Z");
	});
});

describe("renderUsageReport", () => {
	it("renders channel + global cost with kind and model breakdowns", () => {
		const ledger = stubLedger((q) =>
			q.channelId
				? { totalCost: 0.3, entryCount: 2, byKind: { turn: 0.2, sidecar: 0.1 } }
				: {
						totalCost: 1.5,
						entryCount: 5,
						byModel: { "anthropic/opus": 1.0, "anthropic/haiku": 0.5 },
						byChannel: { c1: 0.3, c2: 1.2 },
					},
		);

		const report = renderUsageReport(ledger, "c1", "month", NOW);
		expect(report).toContain("This month (2026-07)");
		expect(report).toContain("This channel: $0.3000");
		expect(report).toContain("turn $0.2000 · sidecar $0.1000");
		expect(report).toContain("Global: $1.5000 across 2 channels");
		expect(report).toContain("Top models: anthropic/opus $1.0000, anthropic/haiku $0.5000");
	});

	it("reports empty windows plainly", () => {
		const ledger = stubLedger(() => ({}));
		const report = renderUsageReport(ledger, "c1", "default", NOW);
		expect(report).toContain("No recorded usage.");
	});
});
