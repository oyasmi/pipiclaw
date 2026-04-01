import { describe, expect, it } from "vitest";
import { extractJsonObject, LlmJsonParseError, parseJsonObject } from "../src/llm-json.js";

describe("llm-json", () => {
	it("extracts the first balanced JSON object even when braces appear inside strings", () => {
		const raw = 'Preface {"message":"brace { inside } string","nested":{"ok":true}} trailing';

		expect(extractJsonObject(raw)).toBe('{"message":"brace { inside } string","nested":{"ok":true}}');
		expect(parseJsonObject(raw)).toEqual({
			message: "brace { inside } string",
			nested: { ok: true },
		});
	});

	it("extracts JSON objects from fenced blocks", () => {
		const raw = ["Here you go:", "```json", '{"selectedIds":["a","b"]}', "```"].join("\n");
		expect(parseJsonObject(raw)).toEqual({ selectedIds: ["a", "b"] });
	});

	it("throws a typed error when no JSON object is present", () => {
		expect(() => extractJsonObject("plain text only")).toThrow(LlmJsonParseError);
	});
});
