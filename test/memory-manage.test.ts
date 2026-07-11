import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";
import { createMemoryCandidateStore } from "../src/memory/candidates.js";
import { applyChannelMemoryOps, parseChannelMemoryEntries, readChannelMemory } from "../src/memory/files.js";
import { getMemoryReviewLogPath } from "../src/memory/review-log.js";
import { createMemoryManageTool } from "../src/tools/memory-manage.js";
import { useTempDirs } from "./helpers/fixtures.js";

const createTempChannel = useTempDirs("pipiclaw-memory-manage-");

function makeTool(channelDir: string, overrides: Record<string, unknown> = {}) {
	return createMemoryManageTool({
		channelId: "dm_1",
		channelDir,
		workspaceDir: channelDir,
		memoryCandidateStore: createMemoryCandidateStore(),
		getCurrentModel: () => ({}) as never,
		resolveApiKey: async () => "key",
		...overrides,
	});
}

async function runText(
	tool: ReturnType<typeof createMemoryManageTool>,
	args: Record<string, unknown>,
): Promise<string> {
	const result = await tool.execute("call", { label: "memory", ...args } as never);
	return result.content[0].type === "text" ? result.content[0].text : "";
}

describe("memory_manage tool", () => {
	it("saves a durable entry and invalidates the candidate cache", async () => {
		const channelDir = createTempChannel();
		const store = createMemoryCandidateStore();
		const invalidateSpy = vi.spyOn(store, "invalidate");
		const tool = makeTool(channelDir, { memoryCandidateStore: store });

		const result = await tool.execute("call", {
			label: "remember",
			op: "save",
			content: "User prefers responses in Chinese",
			kind: "preference",
		});

		expect(result.details).toMatchObject({ kind: "memory_manage", op: "save", saved: true });
		expect(invalidateSpy).toHaveBeenCalledWith(join(channelDir, "MEMORY.md"));
		const entries = parseChannelMemoryEntries(await readChannelMemory(channelDir));
		expect(entries).toHaveLength(1);
		expect(entries[0].content).toBe("User prefers responses in Chinese");
	});

	it("no-ops save on empty content", async () => {
		const channelDir = createTempChannel();
		const result = await makeTool(channelDir).execute("call", { label: "x", op: "save", content: "   " });
		expect(result.details).toMatchObject({ op: "save", saved: false });
	});

	it("serializes writes through the provided channel memory queue", async () => {
		const channelDir = createTempChannel();
		const seenChannelIds: string[] = [];
		const tool = makeTool(channelDir, {
			channelId: "dm_9",
			channelMemoryQueue: {
				run: <T>(channelId: string, job: () => Promise<T>) => {
					seenChannelIds.push(channelId);
					return job();
				},
			},
		});

		await tool.execute("call", { label: "x", op: "save", content: "Durable fact" });
		expect(seenChannelIds).toEqual(["dm_9"]);
	});

	it("searches stored memory and returns matching entries", async () => {
		const channelDir = createTempChannel();
		await applyChannelMemoryOps(channelDir, [{ op: "add", content: "User prefers dark mode in the dashboard" }]);
		const result = await makeTool(channelDir).execute("call", {
			label: "search",
			op: "search",
			query: "dark mode preference",
		});
		const text = result.content[0].type === "text" ? result.content[0].text : "";
		expect(text).toContain("dark mode");
		expect(result.details).toMatchObject({ op: "search" });
		expect((result.details as { resultCount: number }).resultCount).toBeGreaterThanOrEqual(1);
	});

	it("reports an empty search with a widening hint", async () => {
		const channelDir = createTempChannel();
		const text = await runText(makeTool(channelDir), { op: "search", query: "nonexistent topic xyz" });
		expect(text).toContain("No stored memory matched");
	});

	it("forgets a uniquely matched entry through the serial queue", async () => {
		const channelDir = createTempChannel();
		const seenChannelIds: string[] = [];
		await applyChannelMemoryOps(channelDir, [{ op: "add", content: "User's home address is 5 Main St" }]);
		const tool = makeTool(channelDir, {
			channelMemoryQueue: {
				run: <T>(channelId: string, job: () => Promise<T>) => {
					seenChannelIds.push(channelId);
					return job();
				},
			},
		});

		const result = await tool.execute("call", { label: "forget", op: "forget", target: "home address" });
		expect(result.details).toMatchObject({ op: "forget", forgotten: true });
		expect(seenChannelIds).toEqual(["dm_1"]);
		const entries = parseChannelMemoryEntries(await readChannelMemory(channelDir));
		expect(entries).toHaveLength(0);

		// forget must leave an auditable trail in the maintenance log.
		const log = readFileSync(getMemoryReviewLogPath(channelDir), "utf-8").trim();
		const entry = JSON.parse(log.split("\n").at(-1) as string);
		expect(entry).toMatchObject({ channelId: "dm_1", reason: "user-forget" });
		expect(JSON.stringify(entry.actions)).toContain("5 Main St");
	});

	it("refuses to forget when the target is ambiguous", async () => {
		const channelDir = createTempChannel();
		await applyChannelMemoryOps(channelDir, [
			{ op: "add", content: "User likes tea in the morning" },
			{ op: "add", content: "User likes tea after lunch" },
		]);
		const tool = makeTool(channelDir);
		await expect(tool.execute("call", { label: "forget", op: "forget", target: "likes tea" })).rejects.toThrow(
			/matched 2 entries/,
		);
	});

	it("reports when forget finds no match", async () => {
		const channelDir = createTempChannel();
		await applyChannelMemoryOps(channelDir, [{ op: "add", content: "Something durable" }]);
		const result = await makeTool(channelDir).execute("call", {
			label: "forget",
			op: "forget",
			target: "does not exist",
		});
		expect(result.details).toMatchObject({ op: "forget", forgotten: false });
	});
});
