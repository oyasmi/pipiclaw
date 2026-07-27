import { beforeEach, describe, expect, it } from "vitest";
import {
	channelEffectCount,
	isEffectfulTool,
	noteChannelEffect,
	noteTaskEffects,
	resetChannelEffects,
	taskEffectCount,
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

	// The governor asks "did *this task's* wake accomplish anything?". A channel total answers a
	// different question — it also counts the user's small talk and every other task's work.
	it("keeps per-task credit separate from the channel total", () => {
		noteChannelEffect("dm_1");
		noteTaskEffects("dm_1", "alpha", 1);
		noteTaskEffects("dm_1", "beta", 2);
		expect(taskEffectCount("dm_1", "alpha")).toBe(1);
		expect(taskEffectCount("dm_1", "beta")).toBe(2);
		expect(taskEffectCount("dm_2", "alpha")).toBe(0);
		expect(taskEffectCount("dm_1", "never-run")).toBe(0);
	});

	it("ignores an empty or negative turn delta", () => {
		noteTaskEffects("dm_1", "alpha", 0);
		noteTaskEffects("dm_1", "alpha", -3);
		expect(taskEffectCount("dm_1", "alpha")).toBe(0);
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

	it("counts a background launch, and a synchronous command that ran clean and returned output", () => {
		expect(isEffectfulTool("bash", { kind: "bash", async: { state: "running", jobId: "abc" } })).toBe(true);
		// The shape this matters for: a turn that drives an external coding agent synchronously
		// touches no file the runtime can see, and used to score zero.
		expect(isEffectfulTool("bash", { kind: "bash", exitCode: 0, producedOutput: true })).toBe(true);
	});

	it("does not count a synchronous command that failed or returned nothing", () => {
		expect(isEffectfulTool("bash", { kind: "bash", exitCode: 1, producedOutput: true })).toBe(false);
		expect(isEffectfulTool("bash", { kind: "bash", exitCode: 0, producedOutput: false })).toBe(false);
		// A result carrying no outcome at all (older shape, or a rejection) claims nothing.
		expect(isEffectfulTool("bash", { kind: "bash" })).toBe(false);
		expect(isEffectfulTool("bash", undefined)).toBe(false);
	});
});
