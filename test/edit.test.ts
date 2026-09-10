import { chmodSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileStore } from "../src/file-store.js";
import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";
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
				path: tempFile("a.txt", "alpha\nbeta\n"),
				oldText: "omega",
				newText: "delta",
			}),
		).rejects.toThrow("Could not find the exact text");

		await expect(
			tool.execute("call", {
				path: tempFile("b.txt", "beta\nbeta\n"),
				oldText: "beta",
				newText: "delta",
			}),
		).rejects.toThrow("Found 2 occurrences");

		await expect(
			tool.execute("call", {
				path: tempFile("c.txt", "beta\n"),
				oldText: "beta",
				newText: "beta",
			}),
		).rejects.toThrow("No changes made");
	});

	it("escalates a repeated byte-identical no-op to a hard stop, then resets after a real edit", async () => {
		const tool = makeTool();
		const path = tempFile("notes.txt", "beta\n");
		const noop = { path, oldText: "beta", newText: "beta" };

		await expect(tool.execute("c1", noop)).rejects.toThrow(/No changes made/);
		await expect(tool.execute("c2", noop)).rejects.toThrow(/No changes made/);
		await expect(tool.execute("c3", noop)).rejects.toThrow(/STOP\./);

		// A successful edit clears the streak so a later no-op starts soft again.
		const path2 = tempFile("notes2.txt", "beta\n");
		const noop2 = { path: path2, oldText: "beta", newText: "beta" };
		await expect(tool.execute("c1", noop2)).rejects.toThrow(/No changes made/);
		await expect(tool.execute("c2", noop2)).rejects.toThrow(/No changes made/);
		await tool.execute("c3", { path: path2, oldText: "beta", newText: "omega" });
		expect(readFileSync(path2, "utf-8")).toBe("omega\n");
		// Streak was cleared by the successful edit: this is soft again, not the hard stop.
		await expect(tool.execute("c4", { path: path2, oldText: "omega", newText: "omega" })).rejects.toThrow(
			/No changes made/,
		);
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
			walkFiles: (...args) => fileStore.walkFiles(...args),
		};
		const tool = createEditTool(flakyFileStore, { securityConfig: disabledSecurity });

		await expect(tool.execute("call", { path, oldText: "beta", newText: "delta" })).rejects.toThrow(
			/changed during this edit/,
		);
		// No write was attempted.
		expect(readFileSync(path, "utf-8")).toBe("alpha\nbeta\ngamma\n");
	});

	it("preserves executable permission bits across a write", async () => {
		const path = tempFile("script.sh", "#!/bin/sh\necho hi\n");
		chmodSync(path, 0o755);
		const tool = makeTool();

		await tool.execute("call", { path, oldText: "echo hi", newText: "echo bye" });

		expect(statSync(path).mode & 0o777).toBe(0o755);
		expect(readFileSync(path, "utf-8")).toBe("#!/bin/sh\necho bye\n");
	});

	it("rejects binary files with a bash suggestion", async () => {
		const path = tempFile("bin.dat", Buffer.from([0, 1, 2, 3, 0, 5]));
		const tool = makeTool();

		await expect(tool.execute("call", { path, oldText: String.fromCharCode(1), newText: "x" })).rejects.toThrow(
			/looks like a binary file/,
		);
	});

	it("rejects an empty oldText", async () => {
		const path = tempFile("notes.txt", "content\n");
		const tool = makeTool();
		await expect(tool.execute("call", { path, oldText: "", newText: "x" })).rejects.toThrow(/must not be empty/);
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
			await tool.execute("call", { path, oldText: "MARKER_LINE_HERE", newText: "REPLACED_LINE" });

			const content = readFileSync(path, "utf-8");
			expect(content).toContain("REPLACED_LINE");
			expect(content.includes("�")).toBe(false);
		});

		it("does not double-count a self-overlapping needle straddling a stream chunk boundary (batch 1.2)", async () => {
			// Regression: scanOccurrences restarted every window's search at from=0 while the carry
			// still held the previous window's tail, so a match ending inside the carry was re-found
			// at an overlapping offset and spliceBuffer produced a corrupt file (e.g. "QQa" for what
			// should be "Qaa"). Mutation check: revert `let from = Math.max(0, nextAllowed -
			// windowBaseOffset)` to `let from = 0` in scanOccurrences and this assertion fails.
			const dir = mkdtempSync(join(tmpdir(), "pipiclaw-edit-test-"));
			dirs.push(dir);
			const path = join(dir, "overlap.txt");
			// "aaaaa" with its bytes at 65533..65537 so it straddles the 65536-byte stream read
			// boundary; a second cluster after 9MB of filler keeps the file on the streaming path.
			const original = `${"b".repeat(65533)}aaaaa${"c".repeat(9 * 1024 * 1024)}aaaaa-end`;
			writeFileSync(path, original);

			const tool = makeTool();
			await tool.execute("call", { path, oldText: "aaa", newText: "Q", replaceAll: true });

			// Reference: non-overlapping left-to-right replace (String.replaceAll string semantics).
			expect(readFileSync(path, "utf-8")).toBe(original.replaceAll("aaa", "Q"));
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

	describe("write guard (batch 1.1)", () => {
		function guardedTool(overrides: Partial<typeof DEFAULT_SECURITY_CONFIG.pathGuard>) {
			const cfg = {
				...DEFAULT_SECURITY_CONFIG,
				pathGuard: { ...DEFAULT_SECURITY_CONFIG.pathGuard, ...overrides },
			} as never;
			return createEditTool(fileStore, { securityConfig: cfg });
		}

		it("refuses an edit that the write guard denies, leaving the file byte-identical", async () => {
			// Regression: edit only ran the *read* guard, so `writeDeny` (and every protection
			// wired through it — sub-agent memory, role dirs) was silently bypassed. Mutation
			// check: drop the added `checkPathGuard(path, "write", ...)` call and this passes.
			const path = tempFile("denied.txt", "before\n");
			const tool = guardedTool({ writeDeny: [path] });
			await expect(tool.execute("call", { path, oldText: "before", newText: "after" })).rejects.toThrow(/denied/i);
			expect(readFileSync(path, "utf-8")).toBe("before\n");
		});

		it("will not rewrite a file through a symlink (a write-guard-only rule)", async () => {
			const dir = mkdtempSync(join(tmpdir(), "pipiclaw-edit-test-"));
			dirs.push(dir);
			const realPath = join(dir, "real.txt");
			writeFileSync(realPath, "real-before\n");
			const linkPath = join(dir, "link.txt");
			symlinkSync(realPath, linkPath);

			const tool = guardedTool({});
			await expect(
				tool.execute("call", { path: linkPath, oldText: "real-before", newText: "real-after" }),
			).rejects.toThrow(/symbolic link/i);
			expect(readFileSync(realPath, "utf-8")).toBe("real-before\n");
		});

		it("still rejects at the read stage when readDeny matches", async () => {
			const path = tempFile("no-read.txt", "data\n");
			const tool = guardedTool({ readDeny: [path] });
			await expect(tool.execute("call", { path, oldText: "data", newText: "x" })).rejects.toThrow(/denied/i);
			expect(readFileSync(path, "utf-8")).toBe("data\n");
		});
	});

	it("bounds the echoed diff by bytes on a long single line, but keeps the full diff in details (batch 2.4)", async () => {
		const longLine = `{"data":"${"z".repeat(200_000)}"}`;
		const path = tempFile("min.json", longLine);
		const tool = makeTool();

		const result = await tool.execute("call", { path, oldText: '"data"', newText: '"payload"' });
		const text = result.content[0].type === "text" ? result.content[0].text : "";

		expect(Buffer.byteLength(text, "utf-8")).toBeLessThan(20_000);
		expect(text).toContain("diff truncated");
		// The complete diff is still available to the runtime.
		expect((result.details as { diff: string }).diff.length).toBeGreaterThan(100_000);
	});
});
