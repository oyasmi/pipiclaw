import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileStore } from "../src/file-store.js";
import { createWriteTool } from "../src/tools/write.js";
import { writeContent } from "../src/tools/write-content.js";

const fileStore = createFileStore();
const disabledSecurity = { enabled: false } as never;

const dirs: string[] = [];
afterEach(() => {
	dirs.length = 0;
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pipiclaw-write-test-"));
	dirs.push(dir);
	return dir;
}

describe("write-content", () => {
	it("writes content and can create parent directories", async () => {
		const dir = tempDir();
		const target = join(dir, "nested", "file.txt");

		await writeContent(fileStore, target, "hello", undefined, {
			createParentDir: true,
			securityConfig: disabledSecurity,
		});

		expect(readFileSync(target, "utf-8")).toBe("hello");
	});

	it("writes content containing shell metacharacters byte-for-byte", async () => {
		const dir = tempDir();
		const target = join(dir, "special.txt");
		const content = "line 1\nit's `dangerous` $(rm -rf /)\nbackslash\\done";

		await writeContent(fileStore, target, content, undefined, { securityConfig: disabledSecurity });

		expect(readFileSync(target, "utf-8")).toBe(content);
	});

	it("preserves the existing file's permission bits across an overwrite", async () => {
		const dir = tempDir();
		const target = join(dir, "script.sh");
		writeFileSync(target, "#!/bin/sh\necho hi\n");
		chmodSync(target, 0o755);

		await writeContent(fileStore, target, "#!/bin/sh\necho bye\n", undefined, { securityConfig: disabledSecurity });

		expect(statSync(target).mode & 0o777).toBe(0o755);
		expect(readFileSync(target, "utf-8")).toBe("#!/bin/sh\necho bye\n");
	});

	it("preserves multi-byte UTF-8 content exactly", async () => {
		const dir = tempDir();
		const target = join(dir, "unicode.txt");
		const content = "你好，世界！🎉 emoji and 汉字混合内容";

		await writeContent(fileStore, target, content, undefined, { securityConfig: disabledSecurity });

		expect(readFileSync(target, "utf-8")).toBe(content);
	});

	it("write tool reports bytes written and creates parent directories", async () => {
		const dir = tempDir();
		const target = join(dir, "sub", "out.txt");
		const tool = createWriteTool(fileStore, { securityConfig: disabledSecurity });

		const result = await tool.execute("call", { path: target, content: "hello界" });

		expect(readFileSync(target, "utf-8")).toBe("hello界");
		expect(result).toEqual({
			content: [{ type: "text", text: `Successfully wrote 8 bytes to ${target}` }],
			details: { path: target },
		});
	});
});
