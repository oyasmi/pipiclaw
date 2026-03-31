import { describe, expect, it, vi } from "vitest";
import { createAttachTool } from "../src/tools/attach.js";

describe("attach tool", () => {
	it("throws an actionable error when uploads are unavailable", async () => {
		const tool = createAttachTool();

		await expect(tool.execute("call", { label: "attach", path: "report.txt" })).rejects.toThrow(
			"File upload is not supported in DingTalk mode",
		);
	});

	it("rejects aborted operations before uploading", async () => {
		const uploadFn = vi.fn();
		const tool = createAttachTool(uploadFn);
		const controller = new AbortController();
		controller.abort();

		await expect(tool.execute("call", { label: "attach", path: "report.txt" }, controller.signal)).rejects.toThrow(
			"Operation aborted",
		);
		expect(uploadFn).not.toHaveBeenCalled();
	});

	it("resolves absolute paths and defaults titles to the file name", async () => {
		const uploadFn = vi.fn(async () => {});
		const tool = createAttachTool(uploadFn);

		const result = await tool.execute("call", { label: "attach", path: "./reports/output.txt" });
		expect(uploadFn).toHaveBeenCalledWith(expect.stringMatching(/reports\/output\.txt$/), "output.txt");
		expect(result).toEqual({
			content: [{ type: "text", text: "Attached file: output.txt" }],
			details: undefined,
		});

		await tool.execute("call", { label: "attach", path: "./reports/output.txt", title: "Summary" });
		expect(uploadFn).toHaveBeenLastCalledWith(expect.stringMatching(/reports\/output\.txt$/), "Summary");
	});
});
