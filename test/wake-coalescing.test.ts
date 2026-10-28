import { describe, expect, it } from "vitest";
import type { WakeEvent } from "../src/channel/channel-event.js";
import { canAbsorbWake, isCoalescableWake, mergeCompletionWakes } from "../src/runtime/wake-coalescing.js";

function event(overrides: Partial<WakeEvent>): WakeEvent {
	return {
		source: "wake",
		channelId: "dingtalk:dm:1",
		producer: "SUBAGENT",
		text: "[SUBAGENT:run_a] finished",
		ts: "1",
		desk: "lab",
		...overrides,
	};
}

describe("completion-wake coalescing", () => {
	it("merges only chat-level run/job completion wakes", () => {
		expect(isCoalescableWake(event({ dispatchId: "subagent:dingtalk:dm:1:run_a:done" }))).toBe(true);
		expect(isCoalescableWake(event({ dispatchId: "job:dingtalk:dm:1:job_1:done" }))).toBe(true);
		// Events and user messages are not completion wakes.
		expect(isCoalescableWake(event({ dispatchId: "event:dingtalk:dm:1:x" }))).toBe(false);
		expect(isCoalescableWake(event({}))).toBe(false);
		// Spec 058, D7: only a wake produced for the primary's desk rides along — never one from the
		// desk this channel was bound to before.
		const primary = event({ dispatchId: "subagent:lab:run_a:done" });
		expect(canAbsorbWake(primary, event({ dispatchId: "job:lab:job_1:done", desk: "lab" }))).toBe(true);
		expect(canAbsorbWake(primary, event({ dispatchId: "job:e2e:job_1:done", desk: "e2e" }))).toBe(false);
	});

	it("keeps the primary wake's own text first so its tag and dispatch id stay authoritative", () => {
		const primary = event({ dispatchId: "subagent:dingtalk:dm:1:run_a:done", text: "[SUBAGENT:run_a] A" });
		const merged = mergeCompletionWakes(primary, [event({ text: "[SUBAGENT:run_b] B" })]);
		expect(merged.text.startsWith("[SUBAGENT:run_a] A")).toBe(true);
		expect(merged.text).toContain("[SUBAGENT:run_b] B");
		expect(merged.dispatchId).toBe(primary.dispatchId);
		expect(mergeCompletionWakes(primary, [])).toBe(primary);
	});
});
