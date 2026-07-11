import { afterEach, describe, expect, it, vi } from "vitest";
import { logUsageSummary } from "../src/log.js";

function stripAnsi(text: string): string {
	return text.replace(/\u001B\[[0-9;]*m/g, "");
}

describe("log helpers", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("returns usage summaries with cache and context information", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-01T08:09:10.000Z"));
		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const summary = logUsageSummary(
			{ channelId: "team-1", channelName: "ops", userName: "alice" },
			{
				input: 12_345,
				output: 678,
				cacheRead: 100,
				cacheWrite: 50,
				cost: {
					input: 0.1234,
					output: 0.0567,
					cacheRead: 0.001,
					cacheWrite: 0.002,
					total: 0.1831,
				},
			},
			45_000,
			200_000,
		);

		expect(summary).toContain("**Usage Summary**");
		expect(summary).toContain("Tokens: 12,345 in, 678 out");
		expect(summary).toContain("Cache: 100 read, 50 write");
		expect(summary).toContain("Context: 45k / 200k (22.5%)");
		expect(summary).toContain("**Total: $0.1831**");

		const calls = consoleSpy.mock.calls.map(([value]) => stripAnsi(String(value)));
		expect(calls[0]).toContain("[ops:alice] 💰 Usage");
		expect(calls[1]).toContain("12,345 in + 678 out");
		expect(calls[1]).toContain("= $0.1831");
	});
});
