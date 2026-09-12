import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileStore } from "../src/file-store.js";
import { writeContent } from "../src/tools/write-content.js";
import { useTempDirs } from "./helpers/fixtures.js";

const fileStore = createFileStore();
const disabledSecurity = { enabled: false } as never;

const tempDir = useTempDirs("pipiclaw-write-test-");

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

	it("preserves the existing file's permission bits across an overwrite", async () => {
		const dir = tempDir();
		const target = join(dir, "script.sh");
		writeFileSync(target, "#!/bin/sh\necho hi\n");
		chmodSync(target, 0o755);

		await writeContent(fileStore, target, "#!/bin/sh\necho bye\n", undefined, { securityConfig: disabledSecurity });

		expect(statSync(target).mode & 0o777).toBe(0o755);
		expect(readFileSync(target, "utf-8")).toBe("#!/bin/sh\necho bye\n");
	});
});
