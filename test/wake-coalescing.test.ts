import { describe, expect, it } from "vitest";
import type { ChannelEvent } from "../src/channel/channel-event.js";
import { isCoalescableWake, mergeCompletionWakes } from "../src/runtime/wake-coalescing.js";

function event(overrides: Partial<ChannelEvent>): ChannelEvent {
	return {
		type: "dm",
		channelId: "dm_1",
		user: "SUBAGENT",
		userName: "SUBAGENT",
		text: "[SUBAGENT:run_a] finished",
		ts: "1",
		conversationType: "1",
		...overrides,
	};
}

describe("completion-wake coalescing", () => {
	it("merges only chat-level run/job completion wakes", () => {
		expect(isCoalescableWake(event({ dispatchId: "subagent:dm_1:run_a:done" }))).toBe(true);
		expect(isCoalescableWake(event({ dispatchId: "job:dm_1:job_1:done" }))).toBe(true);
		// A task-bound wake must go through its own verified claim, never be folded into a chat turn.
		expect(
			isCoalescableWake(
				event({
					dispatchId: "subagent:dm_1:run_a:done",
					internalWake: {
						kind: "subagent",
						resourceId: "run_a",
						taskId: "t1",
						dispatchId: "subagent:dm_1:run_a:done",
					},
				}),
			),
		).toBe(false);
		// Task steps, events and user messages are not completion wakes.
		expect(isCoalescableWake(event({ dispatchId: "task:dm_1:t1:step" }))).toBe(false);
		expect(isCoalescableWake(event({ dispatchId: "event:dm_1:x" }))).toBe(false);
		expect(isCoalescableWake(event({}))).toBe(false);
	});

	it("keeps the primary wake's own text first so its tag and dispatch id stay authoritative", () => {
		const primary = event({ dispatchId: "subagent:dm_1:run_a:done", text: "[SUBAGENT:run_a] A" });
		const merged = mergeCompletionWakes(primary, [event({ text: "[SUBAGENT:run_b] B" })]);
		expect(merged.text.startsWith("[SUBAGENT:run_a] A")).toBe(true);
		expect(merged.text).toContain("[SUBAGENT:run_b] B");
		expect(merged.dispatchId).toBe(primary.dispatchId);
		expect(mergeCompletionWakes(primary, [])).toBe(primary);
	});
});
