import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileStore } from "../src/file-store.js";

const fileStore = createFileStore();

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pipiclaw-filestore-test-"));
}

describe("FileStore", () => {
	it("stat resolves ENOENT to undefined instead of throwing", async () => {
		const dir = tempDir();
		await expect(fileStore.stat(join(dir, "nope.txt"))).resolves.toBeUndefined();
	});

	it("stat reports size, mtime, and file/directory kind", async () => {
		const dir = tempDir();
		const path = join(dir, "a.txt");
		writeFileSync(path, "hello");

		const stat = await fileStore.stat(path);
		expect(stat?.size).toBe(5);
		expect(stat?.isFile).toBe(true);
		expect(stat?.isDirectory).toBe(false);

		const dirStat = await fileStore.stat(dir);
		expect(dirStat?.isDirectory).toBe(true);
	});

	it("readBytes honors start/maxBytes windows and reports eof", async () => {
		const dir = tempDir();
		const path = join(dir, "a.txt");
		writeFileSync(path, "0123456789");

		const full = await fileStore.readBytes(path);
		expect(full.data.toString()).toBe("0123456789");
		expect(full.eof).toBe(true);

		const windowed = await fileStore.readBytes(path, { start: 2, maxBytes: 3 });
		expect(windowed.data.toString()).toBe("234");
		expect(windowed.eof).toBe(false);

		const tail = await fileStore.readBytes(path, { start: 8, maxBytes: 100 });
		expect(tail.data.toString()).toBe("89");
		expect(tail.eof).toBe(true);

		const beyond = await fileStore.readBytes(path, { start: 100 });
		expect(beyond.data.length).toBe(0);
		expect(beyond.eof).toBe(true);
	});

	it("openRead streams the requested byte range", async () => {
		const dir = tempDir();
		const path = join(dir, "a.txt");
		writeFileSync(path, "abcdefghij");

		const chunks: Buffer[] = [];
		for await (const chunk of fileStore.openRead(path, { start: 2, end: 5 })) {
			chunks.push(chunk as Buffer);
		}
		expect(Buffer.concat(chunks).toString()).toBe("cdef");
	});

	it("writeAtomic creates parent directories on request and writes the full content", async () => {
		const dir = tempDir();
		const path = join(dir, "nested", "deep", "out.txt");

		await fileStore.writeAtomic(path, "hello world", { createParentDir: true });

		expect(readFileSync(path, "utf-8")).toBe("hello world");
	});

	it("writeAtomic preserveMode keeps the existing file's permission bits", async () => {
		const dir = tempDir();
		const path = join(dir, "script.sh");
		writeFileSync(path, "#!/bin/sh\necho old\n");
		chmodSync(path, 0o755);

		await fileStore.writeAtomic(path, "#!/bin/sh\necho new\n", { preserveMode: true });

		expect(statSync(path).mode & 0o777).toBe(0o755);
	});

	it("writeAtomic without preserveMode does not force a specific mode", async () => {
		const dir = tempDir();
		const path = join(dir, "fresh.txt");

		await fileStore.writeAtomic(path, "content");

		expect(readFileSync(path, "utf-8")).toBe("content");
	});

	it("replaceViaTemp renames the produced content over the target atomically", async () => {
		const dir = tempDir();
		const path = join(dir, "target.txt");
		writeFileSync(path, "old content");

		await fileStore.replaceViaTemp(path, async (out) => {
			out.write("new ");
			out.write("content");
		});

		expect(readFileSync(path, "utf-8")).toBe("new content");
	});

	it("replaceViaTemp preserves the existing file's permission bits", async () => {
		const dir = tempDir();
		const path = join(dir, "script.sh");
		writeFileSync(path, "old");
		chmodSync(path, 0o750);

		await fileStore.replaceViaTemp(
			path,
			async (out) => {
				out.write("new");
			},
			{ preserveMode: true },
		);

		expect(statSync(path).mode & 0o777).toBe(0o750);
		expect(readFileSync(path, "utf-8")).toBe("new");
	});

	it("replaceViaTemp cleans up the temp file and leaves the target untouched when `produce` throws", async () => {
		const dir = tempDir();
		const path = join(dir, "target.txt");
		writeFileSync(path, "original");

		await expect(
			fileStore.replaceViaTemp(path, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		expect(readFileSync(path, "utf-8")).toBe("original");
		const { readdirSync } = await import("node:fs");
		const leftovers = readdirSync(dir).filter((name) => name !== "target.txt");
		expect(leftovers).toEqual([]);
	});

	it("listDirectory respects maxDepth and reports directory vs file entries", async () => {
		const dir = tempDir();
		const { mkdirSync } = await import("node:fs");
		mkdirSync(join(dir, "sub"));
		mkdirSync(join(dir, "sub", "deeper"));
		writeFileSync(join(dir, "top.txt"), "x");
		writeFileSync(join(dir, "sub", "mid.txt"), "x");
		writeFileSync(join(dir, "sub", "deeper", "bottom.txt"), "x");

		const entries = await fileStore.listDirectory(dir, { maxDepth: 2 });
		const paths = entries.map((e) => e.relativePath).sort();
		expect(paths).toEqual(["sub", "sub/deeper", "sub/mid.txt", "top.txt"]);
		expect(entries.find((e) => e.relativePath === "sub")?.isDirectory).toBe(true);
		expect(entries.find((e) => e.relativePath === "top.txt")?.isDirectory).toBe(false);
		// "sub/deeper/bottom.txt" is depth 3 -- beyond maxDepth 2 -- so it must not appear.
		expect(paths).not.toContain("sub/deeper/bottom.txt");
	});
});
