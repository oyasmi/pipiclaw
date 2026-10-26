import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ResponseRecord } from "../src/webapi/response-record.js";
import { WebApiStore } from "../src/webapi/store.js";
import { useTempDirs } from "./helpers/fixtures.js";

const record = (id: string, conversation: string, status: ResponseRecord["status"]): ResponseRecord => ({
	id,
	conversation_id: conversation,
	owner: "ci",
	status,
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

describe("webapi store", () => {
	const tempDir = useTempDirs();

	it("keeps the last snapshot per response, fails unfinished ones once after a restart, and survives a torn line", async () => {
		const dir = tempDir();
		const conv = `conv_${"a".repeat(32)}`;
		const first = await WebApiStore.open(dir);
		await first.createConversation("ci", null, conv);
		await first.saveResponse(record("resp_1", conv, "in_progress"));
		// A snapshot holding a few attached images is well past the appender's default 8 MiB bound.
		const large = "x".repeat(12 * 1024 * 1024);
		await first.saveResponse({ ...record("resp_1", conv, "completed"), instructions: large });
		await first.saveResponse(record("resp_2", conv, "in_progress"));
		const standalone = {
			...record("resp_standalone", `conv_${"b".repeat(32)}`, "in_progress"),
			request_scoped: true,
			store: true,
		};
		await first.saveResponse(standalone);
		await first.saveResponse({ ...standalone, id: "resp_private", store: false });
		expect(first.getResponse("resp_private")).toBeUndefined();
		await first.close();
		// A crash mid-write leaves a partial last line.
		appendFileSync(join(dir, "conversations", conv, "responses.jsonl"), '{"id":"resp_3","conv');

		const second = await WebApiStore.open(dir);
		expect(second.listResponses(conv).map((r) => [r.id, r.status])).toEqual([
			["resp_1", "completed"],
			["resp_2", "failed"],
		]);
		expect(second.getResponse("resp_2")?.error?.message).toMatch(/重启/);
		expect(second.getResponse("resp_1")?.instructions).toHaveLength(large.length);
		expect(second.latestResponseId(conv)).toBe("resp_2");
		expect(second.getResponse("resp_standalone")?.status).toBe("failed");
		expect(second.getConversation(standalone.conversation_id)).toBeUndefined();
		expect(second.getResponse("resp_private")).toBeUndefined();
		await second.close();

		// The failure was persisted: a third start neither changes nor re-appends it.
		const third = await WebApiStore.open(dir);
		expect(third.getResponse("resp_2")?.status).toBe("failed");
		expect(third.getResponse("resp_2")?.error?.message).toMatch(/重启/);
		await third.close();
		const lines = readFileSync(join(dir, "conversations", conv, "responses.jsonl"), "utf-8").split("\n");
		expect(lines.filter((line) => line.includes('"resp_2"') && line.includes('"failed"'))).toHaveLength(1);
	});
});
