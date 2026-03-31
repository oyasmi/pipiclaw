import { afterEach, describe, expect, it, vi } from "vitest";
import {
	logAgentError,
	logInfo,
	logResponse,
	logToolStart,
	logToolSuccess,
	logUsageSummary,
	logUserMessage,
	logWarning,
} from "../src/log.js";

function stripAnsi(text: string): string {
	return text.replace(/\u001B\[[0-9;]*m/g, "");
}

describe("log helpers", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("formats DM user messages and tool starts with file ranges", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-01T08:09:10.000Z"));
		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		logUserMessage({ channelId: "dm_123", userName: "alice" }, "hello");
		logToolStart({ channelId: "team-1", channelName: "ops", userName: "alice" }, "read", "inspect file", {
			label: "ignored",
			path: "src/app.ts",
			offset: 10,
			limit: 5,
			extra: { mode: "full" },
		});

		const calls = consoleSpy.mock.calls.map(([value]) => stripAnsi(String(value)));
		expect(calls[0]).toMatch(/^\[\d{2}:\d{2}:\d{2}\] \[DM:alice\] hello$/);
		expect(calls[1]).toMatch(/^\[\d{2}:\d{2}:\d{2}\] \[ops:alice\] ↳ read: inspect file$/);
		expect(calls[2]).toContain("src/app.ts:10-15");
		expect(calls[2]).toContain('{"mode":"full"}');
	});

	it("truncates long result bodies and prints warning details", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-01T08:09:10.000Z"));
		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const longText = "x".repeat(1_100);

		logToolSuccess({ channelId: "dm_123", userName: "alice" }, "bash", 1500, longText);
		logResponse({ channelId: "dm_123", userName: "alice" }, "response body");
		logWarning("Disk nearly full", "line 1\nline 2");
		logInfo("Boot complete");
		logAgentError("system", "fatal\ntrace");

		const calls = consoleSpy.mock.calls.map(([value]) => stripAnsi(String(value)));
		expect(calls[0]).toContain("✓ bash (1.5s)");
		expect(calls[1]).toContain("(truncated at 1000 chars)");
		expect(calls[2]).toContain("💬 Response");
		expect(calls[3]).toContain("response body");
		expect(calls[4]).toContain("⚠ Disk nearly full");
		expect(calls[5]).toContain("line 1");
		expect(calls[5]).toContain("line 2");
		expect(calls[6]).toContain("[system] Boot complete");
		expect(calls[7]).toContain("[system] ✗ Agent error");
		expect(calls[8]).toContain("fatal");
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
