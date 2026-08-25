import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileStore } from "../src/file-store.js";
import { createEditTool } from "../src/tools/edit.js";

const fileStore = createFileStore();
const disabledSecurity = { enabled: false } as never;

const dirs: string[] = [];
afterEach(() => {
	dirs.length = 0;
});

function tempFile(name: string, content: string | Buffer): string {
	const dir = mkdtempSync(join(tmpdir(), "pipiclaw-edit-test-"));
	dirs.push(dir);
	const path = join(dir, name);
	writeFileSync(path, content);
	return path;
}

function makeTool() {
	return createEditTool(fileStore, { securityConfig: disabledSecurity });
}

describe("edit tool", () => {
	it("replaces unique text and returns a diff", async () => {
		const path = tempFile("notes.txt", "alpha\nbeta\ngamma\n");
		const tool = makeTool();

		const result = await tool.execute("call", {
			label: "edit file",
			path,
			oldText: "beta",
			newText: "delta",
		});

		expect(readFileSync(path, "utf-8")).toBe("alpha\ndelta\ngamma\n");
		expect(result.content[0].type).toBe("text");
		const text = result.content[0].type === "text" ? result.content[0].text : "";
		expect(text).toContain(`Successfully replaced text in ${path}. Changed 4 characters to 5 characters.`);
		expect(text).toContain("-2 beta");
		expect(text).toContain("+2 delta");
		expect(result.details).toMatchObject({ diff: expect.stringContaining("-2 beta") });
		expect(result.details).toMatchObject({ diff: expect.stringContaining("+2 delta") });
	});

	it("replaces every occurrence when replaceAll is set", async () => {
		const path = tempFile("notes.txt", "a\nfoo\nfoo\nb\n");
		const tool = makeTool();

		const result = await tool.execute("call", {
			label: "edit file",
			path,
			oldText: "foo",
			newText: "bar",
			replaceAll: true,
		});

		expect(readFileSync(path, "utf-8")).toBe("a\nbar\nbar\nb\n");
		const text = result.content[0].type === "text" ? result.content[0].text : "";
		expect(text).toContain("Replaced 2 occurrences in");
	});

	it("fails when the file does not exist", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipiclaw-edit-test-"));
		dirs.push(dir);
		const tool = makeTool();

		await expect(
			tool.execute("call", {
				label: "edit file",
				path: join(dir, "missing.txt"),
				oldText: "beta",
				newText: "delta",
			}),
		).rejects.toThrow("File not found");
	});

	it("fails when the old text does not exist, is duplicated, or makes no change", async () => {
		const tool = makeTool();

		await expect(
			tool.execute("call", {
				label: "edit file",
				path: tempFile("a.txt", "alpha\nbeta\n"),
				oldText: "omega",
				newText: "delta",
			}),
		).rejects.toThrow("Could not find the exact text");

		await expect(
			tool.execute("call", {
				label: "edit file",
				path: tempFile("b.txt", "beta\nbeta\n"),
				oldText: "beta",
				newText: "delta",
			}),
		).rejects.toThrow("Found 2 occurrences");

		await expect(
			tool.execute("call", {
				label: "edit file",
				path: tempFile("c.txt", "beta\n"),
				oldText: "beta",
				newText: "beta",
			}),
		).rejects.toThrow("No changes made");
	});

	it("escalates a repeated byte-identical no-op to a hard stop, then resets after a real edit", async () => {
		const tool = makeTool();
		const path = tempFile("notes.txt", "beta\n");
		const noop = { label: "edit", path, oldText: "beta", newText: "beta" };

		await expect(tool.execute("c1", noop)).rejects.toThrow(/No changes made/);
		await expect(tool.execute("c2", noop)).rejects.toThrow(/No changes made/);
		await expect(tool.execute("c3", noop)).rejects.toThrow(/STOP\./);

		// A successful edit clears the streak so a later no-op starts soft again.
		const path2 = tempFile("notes2.txt", "beta\n");
		const noop2 = { label: "edit", path: path2, oldText: "beta", newText: "beta" };
		await expect(tool.execute("c1", noop2)).rejects.toThrow(/No changes made/);
		await expect(tool.execute("c2", noop2)).rejects.toThrow(/No changes made/);
		await tool.execute("c3", { label: "edit", path: path2, oldText: "beta", newText: "omega" });
		expect(readFileSync(path2, "utf-8")).toBe("omega\n");
		// Streak was cleared by the successful edit: this is soft again, not the hard stop.
		await expect(
			tool.execute("c4", { label: "edit", path: path2, oldText: "omega", newText: "omega" }),
		).rejects.toThrow(/No changes made/);
	});

	it("rejects the write when the file changed between the read and the pre-write recheck", async () => {
		const path = tempFile("notes.txt", "alpha\nbeta\ngamma\n");
		let statCalls = 0;
		const flakyFileStore: typeof fileStore = {
			stat: async (p: string) => {
				const real = await fileStore.stat(p);
				statCalls++;
				// First stat (the initial read) is real; the pre-write recheck sees a changed file,
				// simulating a concurrent writer racing the edit.
				return statCalls > 1 && real ? { ...real, size: real.size + 1, mtimeMs: real.mtimeMs + 1000 } : real;
			},
			readBytes: (...args) => fileStore.readBytes(...args),
			openRead: (...args) => fileStore.openRead(...args),
			writeAtomic: (...args) => fileStore.writeAtomic(...args),
			replaceViaTemp: (...args) => fileStore.replaceViaTemp(...args),
			listDirectory: (...args) => fileStore.listDirectory(...args),
		};
		const tool = createEditTool(flakyFileStore, { securityConfig: disabledSecurity });

		await expect(
			tool.execute("call", { label: "edit file", path, oldText: "beta", newText: "delta" }),
		).rejects.toThrow(/changed during this edit/);
		// No write was attempted.
		expect(readFileSync(path, "utf-8")).toBe("alpha\nbeta\ngamma\n");
	});

	it("preserves executable permission bits across a write", async () => {
		const path = tempFile("script.sh", "#!/bin/sh\necho hi\n");
		chmodSync(path, 0o755);
		const tool = makeTool();

		await tool.execute("call", { label: "edit", path, oldText: "echo hi", newText: "echo bye" });

		expect(statSync(path).mode & 0o777).toBe(0o755);
		expect(readFileSync(path, "utf-8")).toBe("#!/bin/sh\necho bye\n");
	});

	it("rejects binary files with a bash suggestion", async () => {
		const path = tempFile("bin.dat", Buffer.from([0, 1, 2, 3, 0, 5]));
		const tool = makeTool();

		await expect(
			tool.execute("call", { label: "edit", path, oldText: String.fromCharCode(1), newText: "x" }),
		).rejects.toThrow(/looks like a binary file/);
	});

	it("rejects an empty oldText", async () => {
		const path = tempFile("notes.txt", "content\n");
		const tool = makeTool();
		await expect(tool.execute("call", { label: "edit", path, oldText: "", newText: "x" })).rejects.toThrow(
			/must not be empty/,
		);
	});

	describe("streaming path (files over the inline threshold)", () => {
		it("edits a >8MB file correctly, preserving the tail and file size delta", async () => {
			const dir = mkdtempSync(join(tmpdir(), "pipiclaw-edit-test-"));
			dirs.push(dir);
			const path = join(dir, "big.txt");
			const marker = "UNIQUE_MARKER_AT_START";
			const tail = "TAIL_MARKER_PRESENT";
			const filler = "x".repeat(1024 * 1024); // 1MB per chunk
			const chunks = [marker, "\n"];
			for (let i = 0; i < 9; i++) chunks.push(filler);
			chunks.push("\n", tail, "\n");
			writeFileSync(path, chunks.join(""));
			const before = statSync(path).size;
			expect(before).toBeGreaterThan(8 * 1024 * 1024);

			const tool = makeTool();
			const result = await tool.execute("call", {
				label: "edit",
				path,
				oldText: marker,
				newText: "REPLACED_MARKER_AT_START",
			});

			const after = statSync(path).size;
			expect(after - before).toBe("REPLACED_MARKER_AT_START".length - marker.length);
			const content = readFileSync(path, "utf-8");
			expect(content.startsWith("REPLACED_MARKER_AT_START\n")).toBe(true);
			expect(content).toContain(tail);
			const text = result.content[0].type === "text" ? result.content[0].text : "";
			expect(text).toContain("Successfully replaced text in");
		});

		it("does not corrupt multi-byte UTF-8 characters that straddle a chunk boundary", async () => {
			const dir = mkdtempSync(join(tmpdir(), "pipiclaw-edit-test-"));
			dirs.push(dir);
			const path = join(dir, "big-cjk.txt");
			// A run of 3-byte CJK characters long enough to guarantee some straddle a 64KB stream
			// highWaterMark boundary, padded well past the 8MB inline threshold.
			const cjkLine = "汉字测试内容一二三四五六七八九十".repeat(50); // ~2.4KB per line
			const lines: string[] = [];
			let total = 0;
			while (total < 8.5 * 1024 * 1024) {
				lines.push(cjkLine);
				total += Buffer.byteLength(cjkLine, "utf-8") + 1;
			}
			lines.push("MARKER_LINE_HERE");
			writeFileSync(path, lines.join("\n"), "utf-8");

			const tool = makeTool();
			await tool.execute("call", { label: "edit", path, oldText: "MARKER_LINE_HERE", newText: "REPLACED_LINE" });

			const content = readFileSync(path, "utf-8");
			expect(content).toContain("REPLACED_LINE");
			expect(content.includes("�")).toBe(false);
		});

		it("replaces all occurrences on the streaming path", async () => {
			const dir = mkdtempSync(join(tmpdir(), "pipiclaw-edit-test-"));
			dirs.push(dir);
			const path = join(dir, "big-repeat.txt");
			const filler = "y".repeat(1024 * 1024);
			const parts = [filler, "NEEDLE\n", filler, "NEEDLE\n", filler];
			writeFileSync(path, parts.join(""));

			const tool = makeTool();
			const result = await tool.execute("call", {
				label: "edit",
				path,
				oldText: "NEEDLE",
				newText: "FOUND",
				replaceAll: true,
			});

			const content = readFileSync(path, "utf-8");
			expect(content.match(/NEEDLE/g)).toBeNull();
			expect(content.match(/FOUND/g)?.length).toBe(2);
			const text = result.content[0].type === "text" ? result.content[0].text : "";
			expect(text).toContain("Replaced 2 occurrences in");
		});
	});
});
