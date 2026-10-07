import { describe, expect, it } from "vitest";
import { extractJsonObject, LlmJsonParseError, parseJsonObject } from "../src/shared/llm-json.js";

describe("llm-json", () => {
	it("extracts the first balanced JSON object even when braces appear inside strings", () => {
		const raw = 'Preface {"message":"brace { inside } string","nested":{"ok":true}} trailing';

		expect(extractJsonObject(raw)).toBe('{"message":"brace { inside } string","nested":{"ok":true}}');
		expect(parseJsonObject(raw)).toEqual({
			message: "brace { inside } string",
			nested: { ok: true },
		});
	});

	it("throws a typed error when no JSON object is present", () => {
		expect(() => extractJsonObject("plain text only")).toThrow(LlmJsonParseError);
	});
});
