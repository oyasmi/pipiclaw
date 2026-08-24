import { describe, expect, it } from "vitest";
import { renderStatus, type StatusRenderRunner } from "../src/agent/status-render.js";
import type { RunnerStatusSnapshot, TurnStatus } from "../src/agent/types.js";

function runnerWith(snapshot: RunnerStatusSnapshot | (() => never)): StatusRenderRunner {
	return {
		getStatusSnapshot: typeof snapshot === "function" ? snapshot : () => snapshot,
		isBusy: () => false,
		getTurnStatus: () => ({ phase: "idle", stopRequested: false }),
	};
}

describe("renderStatus", () => {
	it("shows idle + no-session when there is no runner", () => {
		const out = renderStatus({ runner: undefined, version: "1.2.3", uptimeMs: 0 });
		expect(out).toContain("**状态** · 空闲");
		expect(out).toContain("- 模型：本频道尚未开始过会话");
		expect(out).toContain("版本 `1.2.3`");
	});

	it("renders running state with model, thinking and context", () => {
		const snapshot: RunnerStatusSnapshot = {
			model: "anthropic/claude-opus-4-8",
			contextTokens: 50_000,
			contextWindow: 200_000,
			thinkingLevel: "high",
		};
		const turn: Partial<TurnStatus> = { phase: "streaming", taskText: "do the thing" };
		const runner: StatusRenderRunner = {
			...runnerWith(snapshot),
			isBusy: () => true,
			getTurnStatus: () => ({ phase: "idle", stopRequested: false, ...turn }),
		};
		const out = renderStatus({ runner, version: "1.0.0", uptimeMs: 0 });
		expect(out).toContain("**状态** · 运行中：do the thing");
		expect(out).toContain("- 模型：`anthropic/claude-opus-4-8`（thinking `high`）");
		expect(out).toContain("- 上下文：50k / 200k（25.0%）");
	});
});
