import { describe, expect, it } from "vitest";
import { shellEscape } from "../src/shell-escape.js";

describe("shellEscape", () => {
	it("wraps strings in single quotes and escapes internal quotes", () => {
		expect(shellEscape("plain")).toBe("'plain'");
		expect(shellEscape("it's dangerous")).toBe("'it'\\''s dangerous'");
		expect(shellEscape("a'b'c")).toBe("'a'\\''b'\\''c'");
	});
});
