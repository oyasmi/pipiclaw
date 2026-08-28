import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileStore } from "../src/file-store.js";
import { createGlobTool } from "../src/tools/glob.js";
import { useTempDirs } from "./helpers/fixtures.js";

const fileStore = createFileStore();
const disabledSecurity = { enabled: false } as never;
const makeWorkspace = useTempDirs("pipiclaw-glob-test-");

function makeTool() {
	return createGlobTool(fileStore, { securityConfig: disabledSecurity });
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	const block = result.content[0];
	return block?.type === "text" ? (block.text ?? "") : "";
}

describe("glob tool", () => {
	it("excludes VCS/build directories from the walk", async () => {
		const dir = makeWorkspace();
		mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
		writeFileSync(join(dir, "node_modules", "pkg", "index.ts"), "x");
		writeFileSync(join(dir, "kept.ts"), "x");

		const result = await makeTool().execute("call", { pattern: "*.ts", path: dir });
		expect(text(result)).toContain("kept.ts");
		expect(text(result)).not.toContain("node_modules");
	});

	it("does not follow symlinked files or directories", async () => {
		const dir = makeWorkspace();
		writeFileSync(join(dir, "real.ts"), "x");
		symlinkSync(join(dir, "real.ts"), join(dir, "link.ts"));

		const result = await makeTool().execute("call", { pattern: "*.ts", path: dir });
		expect(text(result)).toContain("real.ts");
		expect(text(result)).not.toContain("link.ts");
	});

	it("rejects an empty pattern", async () => {
		const dir = makeWorkspace();
		await expect(makeTool().execute("call", { pattern: "  ", path: dir })).rejects.toThrow(/non-empty|empty/i);
	});
});
