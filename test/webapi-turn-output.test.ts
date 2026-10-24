import { describe, expect, it } from "vitest";
import { MAX_TOOL_OUTPUT_CHARS } from "../src/webapi/limits.js";
import type { ResponseRecord } from "../src/webapi/response-record.js";
import { LiveResponse, type LoggedEvent } from "../src/webapi/response-state.js";

const blank = (): ResponseRecord => ({
	id: "resp_1",
	conversation_id: "conv_1",
	owner: "ci",
	status: "in_progress",
	created_at: 1,
	completed_at: null,
	previous_response_id: null,
	background: false,
	metadata: null,
	input_items: [],
	output: [],
	usage: null,
	error: null,
	incomplete_details: null,
});
const usage = {
	input_tokens: 1,
	input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
	output_tokens: 1,
	output_tokens_details: { reasoning_tokens: 0 },
	total_tokens: 2,
};

function live() {
	const saved: ResponseRecord[] = [];
	const response = new LiveResponse(blank(), { persist: async (record) => void saved.push(record) }, true);
	const events: LoggedEvent[] = [];
	response.subscribe(0, { onEvent: (event) => events.push(event), onEnd: () => undefined });
	return { response, events, saved };
}

describe("LiveResponse event log", () => {
	it("orders what happened before announce after response.created, numbers every event, and replays from any point", () => {
		const { response, events } = live();
		response.addMessage("commentary", "先看一下");
		response.announce("in_progress");
		response.complete(usage);

		expect(events[0]?.type).toBe("response.created");
		expect(events.at(-1)?.type).toBe("response.completed");
		expect(events.map((e) => e.sequence_number)).toEqual(events.map((_, index) => index));
		const types = events.map((e) => e.type);
		expect(types.indexOf("response.output_item.added")).toBeGreaterThan(types.indexOf("response.in_progress"));

		const replayed: LoggedEvent[] = [];
		response.subscribe(5, { onEvent: (event) => replayed.push(event), onEnd: () => undefined });
		expect(replayed.map((e) => e.sequence_number)).toEqual(events.slice(5).map((e) => e.sequence_number));
	});

	it("shows a failed tool as a failed mcp_call, cuts long output, closes a call left open, and ignores events after the end", () => {
		const { response, events, saved } = live();
		response.announce("in_progress");
		response.beginToolCall("a", "bash", { command: "false" });
		response.endToolCall("a", false, "x".repeat(MAX_TOOL_OUTPUT_CHARS + 500));
		response.beginToolCall("b", "bash", { command: "sleep 99" });
		response.addMessage("final_answer", "完成");
		response.complete(usage);
		response.addMessage("final_answer", "too late");

		const [failed, open] = response.record.output as Array<{ status: string; output: string | null; error: unknown }>;
		expect(failed.status).toBe("failed");
		expect(failed.output?.length).toBe(MAX_TOOL_OUTPUT_CHARS + 1);
		expect(failed.error).toMatchObject({ type: "mcp_tool_execution_error" });
		// A call still open when the turn ends is never left "in_progress" in what a client reads later.
		expect(open.status).not.toBe("in_progress");
		expect(response.snapshot().output_text).toBe("完成");
		expect(events.filter((e) => e.type === "response.completed")).toHaveLength(1);
		expect(saved.at(-1)?.status).toBe("completed");
	});
});
