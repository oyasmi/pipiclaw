import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryCandidateStore } from "../src/memory/candidates.js";
import { parseChannelMemoryEntries, readChannelMemory } from "../src/memory/files.js";
import { createMemorySaveTool } from "../src/tools/memory-save.js";

const tempDirs: string[] = [];

function createTempChannel(): string {
	const dir = mkdtempSync(join(tmpdir(), "pipiclaw-memory-save-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("memory_save tool", () => {
	it("writes a durable entry with an id and invalidates the candidate cache", async () => {
		const channelDir = createTempChannel();
		const store = createMemoryCandidateStore();
		const invalidateSpy = vi.spyOn(store, "invalidate");
		const tool = createMemorySaveTool({
			channelId: "dm_1",
			channelDir,
			memoryCandidateStore: store,
		});

		const result = await tool.execute("call-1", {
			label: "remember preference",
			content: "User prefers responses in Chinese",
			kind: "preference",
		});

		expect(result.details).toMatchObject({ kind: "memory_save", saved: true });
		expect(invalidateSpy).toHaveBeenCalledWith(join(channelDir, "MEMORY.md"));
		const entries = parseChannelMemoryEntries(await readChannelMemory(channelDir));
		expect(entries).toHaveLength(1);
		expect(entries[0].content).toBe("User prefers responses in Chinese");
		expect(entries[0].hasExplicitId).toBe(true);
	});

	it("no-ops on empty content", async () => {
		const channelDir = createTempChannel();
		const tool = createMemorySaveTool({
			channelId: "dm_1",
			channelDir,
			memoryCandidateStore: createMemoryCandidateStore(),
		});

		const result = await tool.execute("call-2", { label: "x", content: "   " });
		expect(result.details).toMatchObject({ saved: false });
	});

	it("serializes writes through the provided channel memory queue", async () => {
		const channelDir = createTempChannel();
		const seenChannelIds: string[] = [];
		const tool = createMemorySaveTool({
			channelId: "dm_9",
			channelDir,
			memoryCandidateStore: createMemoryCandidateStore(),
			channelMemoryQueue: {
				run: <T>(channelId: string, job: () => Promise<T>) => {
					seenChannelIds.push(channelId);
					return job();
				},
			},
		});

		await tool.execute("call-3", { label: "x", content: "Durable fact" });
		expect(seenChannelIds).toEqual(["dm_9"]);
	});
});
