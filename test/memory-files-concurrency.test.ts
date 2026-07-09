import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
	existsSync: vi.fn(() => true),
	mkdirSync: vi.fn(),
	writeFileSync: vi.fn(),
	mkdir: vi.fn<(path: string, options?: unknown) => Promise<void>>(async () => undefined),
	readFile: vi.fn<(path: string, encoding: string) => Promise<string>>(async () => "# Channel Memory\n"),
	handleWriteFile: vi.fn<(content: string, encoding: string) => Promise<void>>(async () => undefined),
	open: vi.fn(async (path: string) => ({
		writeFile: (content: string, encoding: string) => fsMocks.handleWriteFile(content, encoding),
		sync: async () => undefined,
		close: async () => undefined,
		__path: path,
	})),
	unlink: vi.fn<(path: string) => Promise<void>>(async () => undefined),
	rename: vi.fn<(from: string, to: string) => Promise<void>>(async () => undefined),
	copyFile: vi.fn<(from: string, to: string) => Promise<void>>(async () => undefined),
	readdir: vi.fn<(path: string) => Promise<string[]>>(async () => []),
	rm: vi.fn<(path: string, options?: unknown) => Promise<void>>(async () => undefined),
}));

vi.mock("fs", () => ({
	existsSync: fsMocks.existsSync,
	mkdirSync: fsMocks.mkdirSync,
	writeFileSync: fsMocks.writeFileSync,
}));

vi.mock("fs/promises", () => ({
	mkdir: fsMocks.mkdir,
	readFile: fsMocks.readFile,
	open: fsMocks.open,
	unlink: fsMocks.unlink,
	rename: fsMocks.rename,
	copyFile: fsMocks.copyFile,
	readdir: fsMocks.readdir,
	rm: fsMocks.rm,
}));

describe("memory-files concurrency", () => {
	beforeEach(() => {
		vi.resetModules();
		fsMocks.existsSync.mockReturnValue(true);
		fsMocks.mkdirSync.mockClear();
		fsMocks.writeFileSync.mockClear();
		fsMocks.mkdir.mockClear();
		fsMocks.readFile.mockClear();
		fsMocks.handleWriteFile.mockClear();
		fsMocks.open.mockClear();
		fsMocks.unlink.mockClear();
		fsMocks.rename.mockClear();
	});

	it("uses unique temp file names for concurrent rewrites of the same file", async () => {
		const { rewriteChannelMemory } = await import("../src/memory/files.js");

		await Promise.all([
			rewriteChannelMemory("/tmp/channel", "# first"),
			rewriteChannelMemory("/tmp/channel", "# second"),
		]);

		const tempPaths = fsMocks.open.mock.calls
			.map((call) => call[0] as string)
			.filter((path) => path.endsWith(".tmp"));
		expect(tempPaths).toHaveLength(2);
		expect(new Set(tempPaths).size).toBe(2);
		for (const tempPath of tempPaths) {
			expect(tempPath).toMatch(/^\/tmp\/channel\/MEMORY\.md\.\d+\..+\.tmp$/);
		}

		expect(fsMocks.rename.mock.calls.map((call) => call[0])).toEqual(tempPaths);
	});
});
