import { afterEach, describe, expect, it } from "vitest";
import { shellEscape, shellEscapePath } from "../src/shared/shell-escape.js";

const originalPlatform = process.platform;

afterEach(() => {
	Object.defineProperty(process, "platform", { value: originalPlatform });
});

describe("shellEscape", () => {
	it("wraps strings in single quotes and escapes internal quotes", () => {
		expect(shellEscape("plain")).toBe("'plain'");
		expect(shellEscape("it's dangerous")).toBe("'it'\\''s dangerous'");
		expect(shellEscape("a'b'c")).toBe("'a'\\''b'\\''c'");
	});

	it("normalizes Windows-style paths before escaping", () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		expect(shellEscapePath("C:\\Users\\alice\\project\\file.txt")).toBe("'C:/Users/alice/project/file.txt'");
	});
});
