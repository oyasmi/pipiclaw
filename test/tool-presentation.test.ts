import { describe, expect, it } from "vitest";
import { describeToolCall } from "../src/tools/presentation.js";
import { TOOL_NAMES } from "../src/tools/registry.js";

describe("describeToolCall", () => {
	it("has a describer for every registered tool name", () => {
		for (const name of TOOL_NAMES) {
			expect(() => describeToolCall(name, {})).not.toThrow();
			expect(describeToolCall(name, {})).toBeTruthy();
		}
	});

	it("never throws on missing, empty, or malformed args", () => {
		for (const name of TOOL_NAMES) {
			expect(() => describeToolCall(name, undefined)).not.toThrow();
			expect(() => describeToolCall(name, null)).not.toThrow();
			expect(() => describeToolCall(name, "not an object")).not.toThrow();
			expect(() => describeToolCall(name, { unrelated: 1 })).not.toThrow();
		}
	});

	it("falls back to the raw tool name for an unrecognized tool", () => {
		expect(describeToolCall("some_future_tool", { path: "x" })).toBe("some_future_tool");
	});

	it("summarizes read with an offset", () => {
		expect(describeToolCall("read", { path: "src/foo.ts", offset: 120 })).toBe("读取 src/foo.ts:120");
		expect(describeToolCall("read", { path: "src/foo.ts" })).toBe("读取 src/foo.ts");
	});

	it("summarizes glob and grep", () => {
		expect(describeToolCall("glob", { pattern: "**/*.ts" })).toBe("查找 **/*.ts");
		expect(describeToolCall("grep", { pattern: "handleEvent", path: "src/" })).toBe('搜索 "handleEvent" · src/');
	});

	it("summarizes bash, marking async runs", () => {
		expect(describeToolCall("bash", { command: "npm test" })).toBe("执行 npm test");
		expect(describeToolCall("bash", { command: "npm test", async: true })).toBe("后台执行 npm test");
	});

	it("summarizes web_fetch to host+path only", () => {
		expect(describeToolCall("web_fetch", { url: "https://example.com/a/b?x=1" })).toBe("抓取 example.com/a/b");
	});

	it("summarizes skill list vs read", () => {
		expect(describeToolCall("skill", { action: "list" })).toBe("列出 skills");
		expect(describeToolCall("skill", { action: "read", name: "dws" })).toBe("加载 skill dws");
	});

	it("summarizes subagent with the first line of the task", () => {
		expect(describeToolCall("subagent", { agent: "reviewer", task: "Review the diff\nmore detail" })).toBe(
			"委派 reviewer：Review the diff",
		);
	});
});
