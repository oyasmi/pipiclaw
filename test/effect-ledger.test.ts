import { beforeEach, describe, expect, it } from "vitest";
import {
	channelEffectCount,
	isEffectfulTool,
	noteChannelEffect,
	resetChannelEffects,
} from "../src/agent/effect-ledger.js";

describe("effect ledger (spec 031, D7)", () => {
	beforeEach(() => {
		resetChannelEffects();
	});

	it("counts per channel and starts at zero", () => {
		expect(channelEffectCount("dm_1")).toBe(0);
		noteChannelEffect("dm_1");
		noteChannelEffect("dm_1");
		noteChannelEffect("dm_2");
		expect(channelEffectCount("dm_1")).toBe(2);
		expect(channelEffectCount("dm_2")).toBe(1);
	});

	it("treats world-changing tools as effects", () => {
		for (const tool of ["write", "edit", "send_media", "subagent"]) {
			expect(isEffectfulTool(tool, undefined)).toBe(true);
		}
	});

	it("does not treat read-only or self-reporting tools as effects", () => {
		// task_manage and memory_manage are the model's own account of its work; counting them
		// would restore exactly the bypass D7 exists to close.
		for (const tool of [
			"read",
			"grep",
			"web_search",
			"web_fetch",
			"session_search",
			"task_manage",
			"memory_manage",
		]) {
			expect(isEffectfulTool(tool, undefined)).toBe(false);
		}
	});

	it("counts bash only when it launched a background job", () => {
		// The runtime cannot tell `ls` from `rm -rf`, so a synchronous bash call claims nothing.
		expect(isEffectfulTool("bash", { kind: "bash" })).toBe(false);
		expect(isEffectfulTool("bash", { kind: "bash", async: { state: "running", jobId: "abc" } })).toBe(true);
	});
});
