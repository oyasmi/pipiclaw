import { describe, expect, it } from "vitest";
import { classifyTurnError, renderTurnErrorReply } from "../src/agent/turn-error.js";

// Spec 053 D5.1: every turn failure used to read "_抱歉，出错了。_" plus the raw provider text, with
// no hint that `/compact`, `/model` or a server-side login would fix it. The class decides the next
// step, so the table pins classes against real provider wording — never the reply text.
describe("classifyTurnError", () => {
	it.each([
		['401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', "auth"],
		["403 Forbidden", "auth"],
		["Incorrect API key provided: sk-proj-****", "auth"],
		["OAuth token has expired", "auth"],
		[
			'429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded"}}',
			"rate_limit",
		],
		["You exceeded your current quota, please check your plan and billing details.", "rate_limit"],
		['529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', "rate_limit"],
		["400 prompt is too long: 215000 tokens > 200000 maximum", "context_overflow"],
		[
			"This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
			"context_overflow",
		],
		["context_length_exceeded", "context_overflow"],
		["connect ETIMEDOUT 104.18.0.1:443", "network"],
		["read ECONNRESET", "network"],
		["TypeError: fetch failed", "network"],
		["502 Bad Gateway", "network"],
		["Request timed out.", "network"],
		["Model returned an empty stream", "other"],
		// A bare number that merely contains a status code's digits is not a status code.
		["max_tokens must be at most 4010", "other"],
	])("%s → %s", (message, kind) => {
		expect(classifyTurnError(message)).toBe(kind);
	});
});

describe("renderTurnErrorReply", () => {
	it("leads with the next step and keeps the raw error on one quoted line", () => {
		const reply = renderTurnErrorReply({
			errorMessage: "429 rate_limit_error:\n`retry` later",
			fallbackRef: "openai/gpt-5",
		});
		const lines = reply.split("\n");
		// The raw text is last, flattened, with its backticks neutralised so it cannot break the quote.
		expect(lines.at(-1)).toMatch(/^原始错误：`[^`]*`$/);
		expect(reply).toContain("`/model`");
		expect(reply).toContain("openai/gpt-5");
		expect(reply.indexOf("/model")).toBeLessThan(reply.indexOf("429"));
	});
});
