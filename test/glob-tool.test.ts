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
	it("finds files matching a basename pattern at any depth", async () => {
		const dir = makeWorkspace();
		mkdirSync(join(dir, "src", "deep"), { recursive: true });
		writeFileSync(join(dir, "a.ts"), "a");
		writeFileSync(join(dir, "src", "b.ts"), "b");
		writeFileSync(join(dir, "src", "deep", "c.ts"), "c");
		writeFileSync(join(dir, "readme.md"), "not ts");

		const result = await makeTool().execute("call", { pattern: "*.ts", path: dir });
		const lines = text(result).split("\n\n")[0]?.split("\n") ?? [];
		expect(lines.sort()).toEqual(["a.ts", "src/b.ts", "src/deep/c.ts"].sort());
	});

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

	it("reports no matches without claiming the tree is empty when scoped by a subdir", async () => {
		const dir = makeWorkspace();
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src", "a.ts"), "x");

		const result = await makeTool().execute("call", { pattern: "*.py", path: dir });
		expect(text(result)).toContain("No files matching");
	});

	it("rejects an empty pattern", async () => {
		const dir = makeWorkspace();
		await expect(makeTool().execute("call", { pattern: "  ", path: dir })).rejects.toThrow(/non-empty|empty/i);
	});

	it("scopes results to a given subdirectory", async () => {
		const dir = makeWorkspace();
		mkdirSync(join(dir, "src"));
		mkdirSync(join(dir, "other"));
		writeFileSync(join(dir, "src", "a.ts"), "x");
		writeFileSync(join(dir, "other", "b.ts"), "x");

		const result = await makeTool().execute("call", { pattern: "*.ts", path: join(dir, "src") });
		expect(text(result)).toContain("a.ts");
		expect(text(result)).not.toContain("b.ts");
	});
});
