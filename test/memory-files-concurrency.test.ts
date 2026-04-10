import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
	existsSync: vi.fn(() => true),
	mkdirSync: vi.fn(),
	writeFileSync: vi.fn(),
	mkdir: vi.fn<(path: string, options?: unknown) => Promise<void>>(async () => undefined),
	readFile: vi.fn<(path: string, encoding: string) => Promise<string>>(async () => "# Channel Memory\n"),
	writeFile: vi.fn<(path: string, content: string, encoding: string) => Promise<void>>(async () => undefined),
	rename: vi.fn<(from: string, to: string) => Promise<void>>(async () => undefined),
}));

vi.mock("fs", () => ({
	existsSync: fsMocks.existsSync,
	mkdirSync: fsMocks.mkdirSync,
	writeFileSync: fsMocks.writeFileSync,
}));

vi.mock("fs/promises", () => ({
	mkdir: fsMocks.mkdir,
	readFile: fsMocks.readFile,
	writeFile: fsMocks.writeFile,
	rename: fsMocks.rename,
}));

describe("memory-files concurrency", () => {
	beforeEach(() => {
		vi.resetModules();
		fsMocks.existsSync.mockReturnValue(true);
		fsMocks.mkdirSync.mockClear();
		fsMocks.writeFileSync.mockClear();
		fsMocks.mkdir.mockClear();
		fsMocks.readFile.mockClear();
		fsMocks.writeFile.mockClear();
		fsMocks.rename.mockClear();
	});

	it("uses unique temp file names for concurrent rewrites of the same file", async () => {
		const { rewriteChannelMemory } = await import("../src/memory/files.js");

		await Promise.all([
			rewriteChannelMemory("/tmp/channel", "# first"),
			rewriteChannelMemory("/tmp/channel", "# second"),
		]);

		expect(fsMocks.writeFile).toHaveBeenCalledTimes(2);
		const tempPaths = fsMocks.writeFile.mock.calls.map((call) => call[0]);
		expect(new Set(tempPaths).size).toBe(2);
		for (const tempPath of tempPaths) {
			expect(tempPath).toMatch(/^\/tmp\/channel\/MEMORY\.md\.\d+\..+\.tmp$/);
		}

		expect(fsMocks.rename.mock.calls.map((call) => call[0])).toEqual(tempPaths);
	});
});
