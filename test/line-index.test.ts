import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileStore } from "../src/file-store.js";
import { clearLineIndexCacheForTests, resolveLineOffset } from "../src/tools/line-index.js";

const fileStore = createFileStore();

afterEach(() => {
	clearLineIndexCacheForTests();
});

function tempFile(content: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pipiclaw-line-index-test-"));
	const path = join(dir, "file.txt");
	writeFileSync(path, content);
	return path;
}

describe("resolveLineOffset", () => {
	it("resolves line offsets for a small file, including EOF-exact totals", async () => {
		const path = tempFile("aa\nbb\ncc\n");
		const stat = (await fileStore.stat(path))!;

		// Line 1 is known immediately (offset 0 always starts the index) without scanning ahead --
		// the index is lazy, so `eof`/`knownLines` reflect only what has been scanned so far.
		const line1 = await resolveLineOffset(fileStore, path, stat, 1);
		expect(line1).toEqual({ offset: 0, eof: false, knownLines: 1 });

		const line3 = await resolveLineOffset(fileStore, path, stat, 3);
		expect(line3.offset).toBe(6);
		expect(line3.eof).toBe(true);
		expect(line3.knownLines).toBe(3);

		const line4 = await resolveLineOffset(fileStore, path, stat, 4);
		expect(line4.offset).toBeUndefined();
		expect(line4.eof).toBe(true);
		expect(line4.knownLines).toBe(3);
	});

	it("does not count a phantom line for content ending exactly on a newline", async () => {
		const withTrailingNewline = tempFile("a\nb\n");
		const stat1 = (await fileStore.stat(withTrailingNewline))!;
		const result1 = await resolveLineOffset(fileStore, withTrailingNewline, stat1, 100);
		expect(result1.knownLines).toBe(2);

		const withoutTrailingNewline = tempFile("a\nb");
		const stat2 = (await fileStore.stat(withoutTrailingNewline))!;
		const result2 = await resolveLineOffset(fileStore, withoutTrailingNewline, stat2, 100);
		expect(result2.knownLines).toBe(2);
	});

	it("does not rescan bytes already indexed on a later, further request", async () => {
		// Long enough (padded lines well past the 256KB scan chunk) that reaching a line deep into
		// the file takes multiple `readBytes` calls, so "resume instead of rescan" is observable.
		const padding = "z".repeat(200);
		const lineCount = 20_000;
		const lines = Array.from({ length: lineCount }, (_, i) => `line-${i + 1}-${padding}`);
		const path = tempFile(`${lines.join("\n")}\n`);
		const stat = (await fileStore.stat(path))!;

		const readBytesSpy = vi.spyOn(fileStore, "readBytes");
		const targetLine = Math.floor(lineCount / 2);
		await resolveLineOffset(fileStore, path, stat, targetLine);
		const callsForFirstScan = readBytesSpy.mock.calls.length;
		expect(callsForFirstScan).toBeGreaterThan(1);

		// Asking for an earlier line than what's already indexed must not re-scan from the start.
		readBytesSpy.mockClear();
		const earlier = await resolveLineOffset(fileStore, path, stat, Math.floor(targetLine / 2));
		expect(earlier.offset).toBeDefined();
		expect(readBytesSpy).not.toHaveBeenCalled();

		// Continuing forward from where the index left off scans only the new bytes -- far fewer
		// calls than the first scan would have needed to cover the same total distance from zero.
		readBytesSpy.mockClear();
		await resolveLineOffset(fileStore, path, stat, lineCount - 100);
		expect(readBytesSpy.mock.calls.length).toBeGreaterThan(0);
		expect(readBytesSpy.mock.calls.length).toBeLessThan(callsForFirstScan);

		readBytesSpy.mockRestore();
	});

	it("invalidates the index when the file's size or mtime changes (different cache key)", async () => {
		const path = tempFile("a\nb\nc\n");
		const stat1 = (await fileStore.stat(path))!;
		await resolveLineOffset(fileStore, path, stat1, 3);

		writeFileSync(path, "a\nb\nc\nd\ne\n");
		const stat2 = (await fileStore.stat(path))!;
		expect(stat2.size).not.toBe(stat1.size);

		const result = await resolveLineOffset(fileStore, path, stat2, 5);
		expect(result.offset).toBeDefined();
		expect(result.knownLines).toBe(5);
	});

	it("reports zero known lines for an empty file, with no resolvable line 1", async () => {
		// `read.ts` special-cases size === 0 itself and never calls this for an empty file; this
		// just pins the index's own behavior so it never invents a line out of nothing.
		const path = tempFile("");
		const stat = (await fileStore.stat(path))!;

		const line1 = await resolveLineOffset(fileStore, path, stat, 1);
		expect(line1).toEqual({ offset: undefined, eof: true, knownLines: 0 });
	});
});
