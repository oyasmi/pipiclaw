import { describe, expect, it } from "vitest";
import { formatSize, truncateHead, truncateTail } from "../src/tools/truncate.js";

describe("truncate utilities", () => {
	it("formats sizes in bytes, kilobytes, and megabytes", () => {
		expect(formatSize(999)).toBe("999B");
		expect(formatSize(1536)).toBe("1.5KB");
		expect(formatSize(2 * 1024 * 1024)).toBe("2.0MB");
	});

	it("truncates from the head by line count and byte limit", () => {
		const byLines = truncateHead("a\nb\nc", { maxLines: 2, maxBytes: 100 });
		expect(byLines).toMatchObject({
			content: "a\nb",
			truncated: true,
			truncatedBy: "lines",
			outputLines: 2,
		});

		const byBytes = truncateHead("12345\n67890", { maxLines: 10, maxBytes: 8 });
		expect(byBytes).toMatchObject({
			content: "12345",
			truncated: true,
			truncatedBy: "bytes",
			firstLineExceedsLimit: false,
		});
	});

	it("reports when the first line exceeds the byte limit", () => {
		const result = truncateHead("abcdefghij", { maxBytes: 5 });
		expect(result).toMatchObject({
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			firstLineExceedsLimit: true,
		});
	});

	it("truncates from the tail and can keep a partial last line", () => {
		const byLines = truncateTail("a\nb\nc", { maxLines: 2, maxBytes: 100 });
		expect(byLines).toMatchObject({
			content: "b\nc",
			truncated: true,
			truncatedBy: "lines",
			outputLines: 2,
		});

		const partial = truncateTail("abcdefghij", { maxBytes: 4 });
		expect(partial.truncated).toBe(true);
		expect(partial.truncatedBy).toBe("bytes");
		expect(partial.lastLinePartial).toBe(true);
		expect(partial.content).toBe("ghij");
	});
});
