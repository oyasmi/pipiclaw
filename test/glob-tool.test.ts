import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createExecutor } from "../src/executor.js";
import { createFileStore } from "../src/file-store.js";
import { createGlobTool } from "../src/tools/glob.js";
import { createReadTool } from "../src/tools/read.js";
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

describe("glob tool read-guard backstop (batch 1.4)", () => {
	it("does not leak the path of a file the read guard denies", async () => {
		// A sensitive-key filename is denied by the guard even though it is inside the search root.
		// Mutation check: remove the `partitionByReadGuard` filter in glob.ts and `id_rsa` shows up.
		const dir = makeWorkspace();
		mkdirSync(join(dir, "keys"), { recursive: true });
		writeFileSync(join(dir, "keep.txt"), "x");
		writeFileSync(join(dir, "keys", "id_rsa"), "x");

		const { DEFAULT_SECURITY_CONFIG } = await import("../src/security/config.js");
		const tool = createGlobTool(fileStore, {
			securityConfig: { ...DEFAULT_SECURITY_CONFIG, enabled: true },
			securityContext: { agentWorkspaceDir: dir, cwd: dir },
		});

		const result = await tool.execute("call", { pattern: "*", path: dir });
		expect(text(result)).toContain("keep.txt");
		expect(text(result)).not.toContain("id_rsa");
		expect(text(result)).toContain("read policy");
		expect(result.details).toMatchObject({ readDenyExcluded: 1 });
	});
});

describe("glob tool result addresses (batch 2.1)", () => {
	it("returns a path a subsequent read resolves to the same file, even with a name collision", async () => {
		// Two files share a basename at different depths. glob from `nested/` must return an address
		// that resolves back to `nested/same.ts`, not the top-level `same.ts`. Mutation check: drop
		// the toReadableAddress mapping and the returned bare `same.ts` resolves to the wrong file.
		const dir = makeWorkspace();
		mkdirSync(join(dir, "nested"), { recursive: true });
		writeFileSync(join(dir, "same.ts"), "TOP");
		writeFileSync(join(dir, "nested", "same.ts"), "NESTED");

		const options = {
			securityConfig: disabledSecurity,
			securityContext: { agentWorkspaceDir: dir, cwd: dir },
		};
		const result = await createGlobTool(fileStore, options).execute("glob", {
			pattern: "*.ts",
			path: join(dir, "nested"),
		});
		const address = text(result).trim();

		const read = await createReadTool(createExecutor(), fileStore, options).execute("read", { path: address });
		expect(text(read)).toBe("NESTED");
	});

	it("pages over the same mtime order using at most 32 concurrent stats", async () => {
		const dir = makeWorkspace();
		const store = createFileStore();
		const root = (await store.stat(dir))!;
		const names = Array.from({ length: 103 }, (_, index) => `file-${index}.ts`);
		vi.spyOn(store, "walkFiles").mockResolvedValue({ files: names, truncated: false });
		let active = 0;
		let peak = 0;
		vi.spyOn(store, "stat").mockImplementation(async (path) => {
			if (path === dir) return root;
			peak = Math.max(peak, ++active);
			await Promise.resolve();
			active--;
			return { ...root, isDirectory: false, isFile: true, mtimeMs: Number(/file-(\d+)/.exec(path)?.[1]) };
		});
		const tool = createGlobTool(store, {
			securityConfig: disabledSecurity,
			securityContext: { agentWorkspaceDir: dir, cwd: dir },
		});
		const first = await tool.execute("first", { pattern: "*.ts" });
		expect(text(first).split("\n").slice(0, 100)).toEqual(names.slice(3).reverse());
		expect(text(first)).toContain("skip=100");
		const second = await tool.execute("second", { pattern: "*.ts", skip: 100 });
		expect(text(second).split("\n")).toEqual(names.slice(0, 3).reverse());
		expect(second.details).toMatchObject({ matchCount: 103, shownCount: 3 });
		expect(peak).toBeGreaterThan(1);
		expect(peak).toBeLessThanOrEqual(32);
	});

	it("distinguishes a missing root, a file root, and an empty result", async () => {
		const dir = makeWorkspace();
		writeFileSync(join(dir, "a.txt"), "x");
		const tool = createGlobTool(fileStore, {
			securityConfig: { enabled: false } as never,
			securityContext: { agentWorkspaceDir: dir, cwd: dir },
		});

		await expect(tool.execute("call", { pattern: "*", path: join(dir, "nope") })).rejects.toThrow(/not found/i);
		await expect(tool.execute("call", { pattern: "*", path: join(dir, "a.txt") })).rejects.toThrow(
			/not a directory/i,
		);
		const empty = await tool.execute("call", { pattern: "*.zzz", path: dir });
		expect(text(empty)).toMatch(/No files matching/);
	});
});
