import { describe, expect, it } from "vitest";
import { WebApiError } from "../src/webapi/errors.js";
import { parseInput } from "../src/webapi/input.js";
import { validateCreateRequest } from "../src/webapi/request-policy.js";

const problem = (run: () => unknown): { code: string | null; param: string | null } => {
	try {
		run();
	} catch (error) {
		if (error instanceof WebApiError) return { code: error.code, param: error.param };
		throw error;
	}
	throw new Error("expected a WebApiError");
};

describe("create request policy", () => {
	it("names the first field that would change behaviour, and ignores pure hints", () => {
		const rejected: Array<[Record<string, unknown>, string, string]> = [
			[{ input: "x", tools: [] }, "unsupported_parameter", "tools"],
			[{ input: "x", temperature: 0.2 }, "unsupported_parameter", "temperature"],
			[{ input: "x", instructions: {} }, "invalid_value", "instructions"],
			[{ input: "x", store: "false" }, "invalid_value", "store"],
			[{ input: "x", store: false, background: true }, "invalid_value", "store"],
			[{ input: "x", model: "gpt-5" }, "unsupported_value", "model"],
			[{ input: "x", surprise: 1 }, "unknown_parameter", "surprise"],
			[{ input: "x", stream_options: { include_obfuscation: true } }, "invalid_value", "stream_options"],
			[
				{ input: "x", conversation: "conv_1", previous_response_id: "resp_1" },
				"invalid_value",
				"previous_response_id",
			],
			[{}, "missing_required_parameter", "input"],
		];
		for (const [body, code, param] of rejected) {
			expect(
				problem(() => validateCreateRequest(body, "http")),
				JSON.stringify(body),
			).toEqual({ code, param });
		}
		for (const transport of ["http", "websocket"] as const) {
			for (const store of [true, false])
				expect(validateCreateRequest({ input: "x", store, instructions: "be brief" }, transport)).toMatchObject({
					store,
					instructions: "be brief",
				});
		}
		// null means "not set" to SDKs; hints are accepted and dropped.
		expect(
			validateCreateRequest(
				{ input: "x", tools: null, user: "u", prompt_cache_key: "k", model: "pipiclaw" },
				"http",
			),
		).toMatchObject({ input: "x", stream: false, background: false });
		expect(validateCreateRequest({ input: "x", conversation: { id: "conv_1" } }, "http").conversation).toBe("conv_1");
	});

	it("over WebSocket refuses stream and background, which the connection decides", () => {
		for (const field of ["stream", "background", "stream_options"]) {
			expect(problem(() => validateCreateRequest({ input: "x", [field]: false }, "websocket")).param).toBe(field);
		}
	});
});

describe("input", () => {
	const png = `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`;

	it("puts markers where attachments sit, in order, and records input items without the bytes", () => {
		const parsed = parseInput([
			{
				role: "user",
				content: [
					{ type: "input_text", text: "看 " },
					{ type: "input_image", image_url: png },
				],
			},
			{
				role: "user",
				content: [{ type: "input_file", filename: "a.txt", file_data: Buffer.from("hi").toString("base64") }],
			},
		]);
		expect(parsed.text).toBe("看 [图片1]\n[文件1]");
		expect(parsed.attachments.map((a) => [a.kind, a.index])).toEqual([
			["image", 1],
			["file", 1],
		]);
		const replay = parseInput([
			{ role: "system", content: "system rule" },
			{ role: "developer", content: "developer rule" },
			{ role: "user", content: "first" },
			{
				role: "assistant",
				phase: "final_answer",
				content: [{ type: "output_text", text: "answer", annotations: [] }],
			},
			{
				type: "mcp_call",
				server_label: "pipiclaw",
				name: "bash",
				arguments: '{"command":"false"}',
				output: "historic result",
				error: null,
			},
			{ type: "reasoning", summary: [{ type: "summary_text", text: "historic reasoning" }] },
			{ role: "user", content: "next" },
		]);
		expect(replay.context.map((m) => m.role)).toEqual([
			"system",
			"developer",
			"user",
			"assistant",
			"assistant",
			"assistant",
			"user",
		]);
		expect(replay.context[3]).toMatchObject({ phase: "final_answer", content: [{ type: "text", text: "answer" }] });
		expect(JSON.stringify(parsed.items)).not.toContain(Buffer.from("png-bytes").toString("base64"));
	});

	it("refuses what would make the server fetch or trust something it should not", () => {
		const rejected: Array<[unknown, string]> = [
			[[{ type: "reasoning", summary: [], encrypted_content: "opaque" }], "unsupported_parameter"],
			[
				[{ role: "user", content: [{ type: "input_image", image_url: "https://example.com/a.png" }] }],
				"unsupported_value",
			],
			[[{ role: "user", content: [{ type: "input_image", file_id: "file_1" }] }], "unsupported_parameter"],
			[[{ role: "user", content: [{ type: "input_file", file_url: "https://x/y" }] }], "unsupported_parameter"],
			[
				[{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,@@@@" }] }],
				"invalid_value",
			],
			[[{ role: "admin", content: "x" }], "unsupported_value"],
			[[{ type: "function_call_output", output: "x" }], "unsupported_value"],
			[[], "invalid_value"],
			["   ", "invalid_value"],
		];
		for (const [input, code] of rejected) {
			expect(problem(() => parseInput(input)).code, JSON.stringify(input)).toBe(code);
		}
	});

	it("measures a base64 payload before decoding it", () => {
		// 6 MB of base64 'A's would decode to 4.5 MB of zeros; the limit applies to what it would become.
		const big = `data:image/png;base64,${"A".repeat(40 * 1024 * 1024)}`;
		expect(
			problem(() => parseInput([{ role: "user", content: [{ type: "input_image", image_url: big }] }])).code,
		).toBe("input_too_large");
	});
});
