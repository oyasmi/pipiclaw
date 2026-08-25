import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecOptions, ExecResult, Executor } from "../src/executor.js";
import { createFileStore } from "../src/file-store.js";
import { createReadTool } from "../src/tools/read.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../src/tools/truncate.js";

const fileStore = createFileStore();
const disabledSecurity = { enabled: false } as never;

class ScriptedExecutor implements Executor {
	public readonly calls: Array<{ command: string; options?: ExecOptions }> = [];
	constructor(private readonly results: Array<ExecResult>) {}
	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		this.calls.push({ command, options });
		const result = this.results.shift();
		if (!result) throw new Error(`Unexpected command: ${command}`);
		return result;
	}
}
const cleanExecutor: Executor = {
	async exec() {
		return { stdout: "", stderr: "", code: 0 };
	},
};

const dirs: string[] = [];
afterEach(() => {
	dirs.length = 0;
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pipiclaw-read-test-"));
	dirs.push(dir);
	return dir;
}

function tempFile(content: string | Buffer, name = "notes.txt"): string {
	const dir = tempDir();
	const path = join(dir, name);
	writeFileSync(path, content);
	return path;
}

function makeTool(executor: Executor = cleanExecutor) {
	return createReadTool(executor, fileStore, { securityConfig: disabledSecurity });
}

describe("read tool", () => {
	it("returns image payloads for supported image files", async () => {
		const path = tempFile(Buffer.from("abcd"), "photo.png");
		const tool = makeTool();

		const result = await tool.execute("call", { label: "read image", path });

		expect(result.details).toBeUndefined();
		expect(result.content).toEqual([
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "image", data: Buffer.from("abcd").toString("base64"), mimeType: "image/png" },
		]);
	});

	it("rejects an image over the inline size limit before reading it", async () => {
		const path = tempFile(Buffer.alloc(6 * 1024 * 1024), "huge.png");
		const tool = makeTool();

		await expect(tool.execute("call", { label: "read image", path })).rejects.toThrow(/over the .* inline limit/);
	});

	it("reads text with offset and limit, reports remaining lines, and rejects an offset past EOF", async () => {
		const path = tempFile("line1\nline2\nline3\nline4\nline5\n");
		const tool = makeTool();

		const result = await tool.execute("call", { label: "read text", path, offset: 2, limit: 2 });

		expect(result.details).toBeUndefined();
		expect(result.content).toEqual([
			{ type: "text", text: "line2\nline3\n\n[2 more lines in file. Use offset=4 to continue]" },
		]);

		const shortPath = tempFile("only\ntwo\n");
		await expect(makeTool().execute("call", { label: "read text", path: shortPath, offset: 5 })).rejects.toThrow(
			"Offset 5 is beyond end of file (2 lines total)",
		);
	});

	it("reads empty files without inventing a line", async () => {
		const path = tempFile("", "empty.txt");
		const tool = makeTool();

		const result = await tool.execute("call", { label: "read empty", path });

		expect(result.details).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "" }]);
	});

	it("truncates oversized reads and reports how to continue (byte-limited line, next offset)", async () => {
		const firstLine = "x".repeat(DEFAULT_MAX_BYTES + 256);
		const hugePath = tempFile(`${firstLine}\n`, "huge.txt");
		const hugeResult = await makeTool().execute("call", { label: "read text", path: hugePath });

		expect(hugeResult.details?.truncation?.firstLineExceedsLimit).toBe(true);
		expect(hugeResult.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining(`Use bash: sed -n '1p' ${hugePath} | head -c`),
		});

		const longContent = Array.from({ length: DEFAULT_MAX_LINES + 10 }, (_, index) => `line ${index + 1}`).join("\n");
		const longPath = tempFile(longContent, "long.txt");
		const longResult = await makeTool().execute("call", { label: "read text", path: longPath });

		expect(longResult.details?.truncation?.truncated).toBe(true);
		expect(longResult.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining(`Use offset=${DEFAULT_MAX_LINES + 1} to continue`),
		});
	});

	it("propagates a missing file as a recoverable error", async () => {
		const dir = tempDir();
		const tool = makeTool();

		await expect(tool.execute("call", { label: "read text", path: join(dir, "does-not-exist.txt") })).rejects.toThrow(
			"Failed to read file",
		);
	});

	it("renders a directory as a shallow tree", async () => {
		const dir = tempDir();
		mkdirSync(join(dir, "util"));
		writeFileSync(join(dir, "README.md"), "readme");
		writeFileSync(join(dir, "a.ts"), "a");
		writeFileSync(join(dir, "util", "b.ts"), "b");
		const tool = makeTool();

		const result = await tool.execute("call", { label: "list", path: dir });
		expect(result.details).toBeUndefined();
		const text = result.content[0].type === "text" ? result.content[0].text : "";
		expect(text).toContain(`Directory: ${dir}`);
		expect(text).toContain("README.md");
		expect(text).toContain("a.ts");
		expect(text).toContain("util/");
		// A depth-1 file is indented under its parent directory.
		expect(text).toContain("  b.ts");
	});

	it("reports an empty directory", async () => {
		const dir = tempDir();
		const emptyDir = join(dir, "empty");
		mkdirSync(emptyDir);
		const tool = makeTool();
		const result = await tool.execute("call", { label: "list", path: emptyDir });
		const text = result.content[0].type === "text" ? result.content[0].text : "";
		expect(text).toContain("(empty directory)");
	});

	it("converts a PDF to text and applies offset/limit, surfacing pdftotext failures as hints", async () => {
		const dir = tempDir();
		const path = join(dir, "doc.pdf");
		writeFileSync(path, "fake pdf bytes");
		const executor = new ScriptedExecutor([{ code: 0, stdout: "page one\npage two\npage three\n", stderr: "" }]);
		const tool = makeTool(executor);

		const result = await tool.execute("call", { label: "read pdf", path, limit: 2 });
		expect(executor.calls).toHaveLength(1);
		expect(executor.calls[0].command).toContain(`pdftotext -layout '${path}'`);
		const text = result.content[0].type === "text" ? result.content[0].text : "";
		expect(text).toContain("page one");
		expect(text).toContain("page two");
		expect(text).toContain("Use offset=3 to continue");

		const missing = makeTool(new ScriptedExecutor([{ code: 127, stdout: "", stderr: "" }]));
		await expect(missing.execute("call", { label: "read pdf", path })).rejects.toThrow(/pdftotext is not installed/);

		const scanned = makeTool(new ScriptedExecutor([{ code: 0, stdout: "   \n", stderr: "" }]));
		await expect(scanned.execute("call", { label: "read pdf", path })).rejects.toThrow(/scanned\/image-based/);
	});

	describe("large files (line-index sequential paging)", () => {
		it("pages sequentially through a large file, each page reusing the prior scan", async () => {
			const lineCount = 5000;
			const lines = Array.from({ length: lineCount }, (_, i) => `line-${i + 1}`);
			const path = tempFile(`${lines.join("\n")}\n`, "big.txt");
			const tool = makeTool();

			const page1 = await tool.execute("call", { label: "read", path, offset: 1, limit: 500 });
			const text1 = page1.content[0].type === "text" ? page1.content[0].text : "";
			expect(text1).toContain("line-1\n");
			expect(text1).toContain("line-500");
			expect(text1).toContain("Use offset=501 to continue");

			const page2 = await tool.execute("call", { label: "read", path, offset: 501, limit: 500 });
			const text2 = page2.content[0].type === "text" ? page2.content[0].text : "";
			expect(text2).toContain("line-501");
			expect(text2).toContain("line-1000");
			expect(text2).not.toContain("line-500\n");
		});

		it("reports an honest lower bound (of >= N) when it has not scanned to EOF", async () => {
			// Bigger than the byte-cap read window, so the tool's own read stops before EOF.
			const line = "y".repeat(200);
			const manyLines = Array.from({ length: 5000 }, () => line).join("\n");
			const path = tempFile(manyLines, "notexact.txt");
			const tool = makeTool();

			const result = await tool.execute("call", { label: "read", path, offset: 1 });
			const text = result.content[0].type === "text" ? result.content[0].text : "";
			expect(text).toMatch(/of >=\d+/);
		});
	});
});
