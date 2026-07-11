import { describe, expect, it } from "vitest";
import { formatTokenCount, formatUptime, renderStatus, type StatusRenderState } from "../src/agent/status-render.js";
import type { RunnerStatusSnapshot } from "../src/agent/types.js";

function stateWith(
	snapshot: RunnerStatusSnapshot | (() => never),
	overrides: Partial<StatusRenderState> = {},
): StatusRenderState {
	return {
		running: false,
		runner: { getStatusSnapshot: typeof snapshot === "function" ? snapshot : () => snapshot },
		...overrides,
	};
}

describe("formatTokenCount", () => {
	it("renders raw counts under 1k", () => {
		expect(formatTokenCount(0)).toBe("0");
		expect(formatTokenCount(999)).toBe("999");
	});
	it("renders k for thousands and M for millions", () => {
		expect(formatTokenCount(1500)).toBe("2k");
		expect(formatTokenCount(12_000)).toBe("12k");
		expect(formatTokenCount(1_500_000)).toBe("1.5M");
	});
});

describe("formatUptime", () => {
	it("always shows minutes, adds hours/days as needed", () => {
		expect(formatUptime(0)).toBe("0m");
		expect(formatUptime(90_000)).toBe("1m");
		expect(formatUptime(3_600_000)).toBe("1h 0m");
		expect(formatUptime(90_000_000)).toBe("1d 1h 0m");
	});
});

describe("renderStatus", () => {
	it("shows idle + no-session when there is no state", () => {
		const out = renderStatus({ state: undefined, version: "1.2.3", uptimeMs: 0 });
		expect(out).toContain("- Run state: idle");
		expect(out).toContain("- Model: no session started for this channel yet");
		expect(out).toContain("- Version: 1.2.3");
	});

	it("renders running state with model, thinking and context", () => {
		const snapshot: RunnerStatusSnapshot = {
			model: "anthropic/claude-opus-4-8",
			contextTokens: 50_000,
			contextWindow: 200_000,
			thinkingLevel: "high",
		};
		const out = renderStatus({
			state: stateWith(snapshot, { running: true, currentTaskText: "do the thing" }),
			version: "1.0.0",
			uptimeMs: 0,
		});
		expect(out).toContain("- Run state: running: do the thing");
		expect(out).toContain("- Model: anthropic/claude-opus-4-8");
		expect(out).toContain("- Thinking: high");
		expect(out).toContain("- Context: 50k / 200k (25.0%)");
	});

	it("renders the fallback line when a backup model is active", () => {
		const snapshot: RunnerStatusSnapshot = {
			model: "backup/model",
			contextWindow: 0,
			thinkingLevel: "off",
			fallback: { primary: "primary/model", cooldownUntilMs: new Date(2026, 0, 1, 9, 5).getTime() },
		};
		const out = renderStatus({ state: stateWith(snapshot), version: "1", uptimeMs: 0 });
		expect(out).toContain("- Fallback: active（primary primary/model 冷却至 09:05）");
	});

	it("degrades gracefully when the snapshot throws", () => {
		const out = renderStatus({
			state: stateWith(() => {
				throw new Error("no session");
			}),
			version: "1",
			uptimeMs: 0,
		});
		expect(out).toContain("- Model: unavailable (no session)");
	});
});
