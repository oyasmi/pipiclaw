import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";
import { createMemoryCandidateStore } from "../src/memory/candidates.js";
import { applyChannelMemoryOps, parseChannelMemoryEntries, readChannelMemory } from "../src/memory/files.js";
import { getMemoryReviewLogPath } from "../src/memory/review-log.js";
import { createMemoryForgetTool, createMemorySaveTool, createMemorySearchTool } from "../src/tools/memory-manage.js";
import { useTempDirs } from "./helpers/fixtures.js";

const createTempChannel = useTempDirs("pipiclaw-memory-manage-");

function makeOptions(channelDir: string, overrides: Record<string, unknown> = {}) {
	return {
		channelId: "dm_1",
		channelDir,
		workspaceDir: channelDir,
		memoryCandidateStore: createMemoryCandidateStore(),
		getCurrentModel: () => ({}) as never,
		resolveApiKey: async () => "key",
		...overrides,
	};
}

function makeSave(channelDir: string, overrides: Record<string, unknown> = {}) {
	return createMemorySaveTool(makeOptions(channelDir, overrides) as never);
}
function makeSearch(channelDir: string, overrides: Record<string, unknown> = {}) {
	return createMemorySearchTool(makeOptions(channelDir, overrides) as never);
}
function makeForget(channelDir: string, overrides: Record<string, unknown> = {}) {
	return createMemoryForgetTool(makeOptions(channelDir, overrides) as never);
}

async function runText(
	tool: { execute: (id: string, args: never) => Promise<{ content: Array<{ type: string; text?: string }> }> },
	args: Record<string, unknown>,
): Promise<string> {
	const result = await tool.execute("call", { ...args } as never);
	return result.content[0].type === "text" ? (result.content[0].text ?? "") : "";
}

describe("memory tools", () => {
	it("saves a durable entry and invalidates the candidate cache", async () => {
		const channelDir = createTempChannel();
		const store = createMemoryCandidateStore();
		const invalidateSpy = vi.spyOn(store, "invalidate");
		const tool = makeSave(channelDir, { memoryCandidateStore: store });

		const result = await tool.execute("call", { content: "User prefers responses in Chinese" } as never);

		expect(result.details).toMatchObject({ op: "save", saved: true });
		expect(invalidateSpy).toHaveBeenCalledWith(join(channelDir, "MEMORY.md"));
		const entries = parseChannelMemoryEntries(await readChannelMemory(channelDir));
		expect(entries).toHaveLength(1);
		expect(entries[0].content).toBe("User prefers responses in Chinese");
	});

	it("rejects a save with only whitespace content", async () => {
		const channelDir = createTempChannel();
		await expect(makeSave(channelDir).execute("call", { content: "   " } as never)).rejects.toThrow(
			/non-empty content/,
		);
		expect(await readChannelMemory(channelDir)).not.toContain("x");
	});

	it("rejects search without a query and forget without a target", async () => {
		const channelDir = createTempChannel();
		await expect(makeSearch(channelDir).execute("call", { query: "" } as never)).rejects.toThrow(/non-empty query/);
		await expect(makeForget(channelDir).execute("call", { target: " " } as never)).rejects.toThrow(
			/non-empty target/,
		);
	});

	it("serializes writes through the provided channel memory queue", async () => {
		const channelDir = createTempChannel();
		const seenChannelIds: string[] = [];
		const tool = makeSave(channelDir, {
			channelId: "dm_9",
			channelMemoryQueue: {
				run: <T>(channelId: string, job: () => Promise<T>) => {
					seenChannelIds.push(channelId);
					return job();
				},
			},
		});

		await tool.execute("call", { content: "Durable fact" } as never);
		expect(seenChannelIds).toEqual(["dm_9"]);
	});

	it("searches stored memory, returns matching entries, and hints when nothing matched", async () => {
		const channelDir = createTempChannel();
		await applyChannelMemoryOps(channelDir, [{ op: "add", content: "User prefers dark mode in the dashboard" }]);
		const result = await makeSearch(channelDir).execute("call", { query: "dark mode preference" } as never);
		const text = result.content[0].type === "text" ? result.content[0].text : "";
		expect(text).toContain("dark mode");
		expect(result.details).toMatchObject({ op: "search" });
		expect((result.details as { resultCount: number }).resultCount).toBeGreaterThanOrEqual(1);

		const emptyText = await runText(makeSearch(createTempChannel()), { query: "nonexistent topic xyz" });
		expect(emptyText).toContain("No stored memory matched");
	});

	it("forgets a uniquely matched entry through the serial queue", async () => {
		const channelDir = createTempChannel();
		const seenChannelIds: string[] = [];
		await applyChannelMemoryOps(channelDir, [{ op: "add", content: "User's home address is 5 Main St" }]);
		const tool = makeForget(channelDir, {
			channelMemoryQueue: {
				run: <T>(channelId: string, job: () => Promise<T>) => {
					seenChannelIds.push(channelId);
					return job();
				},
			},
		});

		const result = await tool.execute("call", { target: "home address" } as never);
		expect(result.details).toMatchObject({ op: "forget", forgotten: true });
		expect(seenChannelIds).toEqual(["dm_1"]);
		const entries = parseChannelMemoryEntries(await readChannelMemory(channelDir));
		expect(entries).toHaveLength(0);

		const log = readFileSync(getMemoryReviewLogPath(channelDir), "utf-8").trim();
		const entry = JSON.parse(log.split("\n").at(-1) as string);
		expect(entry).toMatchObject({ channelId: "dm_1", reason: "user-forget" });
		expect(JSON.stringify(entry.actions)).not.toContain("5 Main St");
		expect(JSON.stringify(entry.actions)).toContain("contentHash");
	});

	it("refuses to forget when the target is ambiguous", async () => {
		const channelDir = createTempChannel();
		await applyChannelMemoryOps(channelDir, [
			{ op: "add", content: "User likes tea in the morning" },
			{ op: "add", content: "User likes tea after lunch" },
		]);
		await expect(makeForget(channelDir).execute("call", { target: "likes tea" } as never)).rejects.toThrow(
			/matched 2 entries/,
		);
	});

	it("guards similar-entry conflicts: flags them by default, allows them with supersedes none, replaces in place when given the id", async () => {
		const channelDir = createTempChannel();
		await applyChannelMemoryOps(channelDir, [
			{ op: "add", content: "The team default package manager for installs is npm" },
		]);
		const [existing] = parseChannelMemoryEntries(await readChannelMemory(channelDir));

		await expect(
			makeSave(channelDir).execute("call", {
				content: "The team default package manager for installs is now pnpm",
			} as never),
		).rejects.toThrow(new RegExp(`supersedes.*${existing.id}|${existing.id}`));
		expect(parseChannelMemoryEntries(await readChannelMemory(channelDir))).toHaveLength(1);

		const replaced = await makeSave(channelDir).execute("call", {
			content: "The team default package manager for installs is now pnpm",
			supersedes: existing.id,
		} as never);
		expect(replaced.details).toMatchObject({ op: "save", saved: true });
		const entries = parseChannelMemoryEntries(await readChannelMemory(channelDir));
		expect(entries).toHaveLength(1);
		expect(entries[0].content).toContain("pnpm");

		const waivedDir = createTempChannel();
		await applyChannelMemoryOps(waivedDir, [
			{ op: "add", content: "The team default package manager for installs is npm" },
		]);
		const waived = await makeSave(waivedDir).execute("call", {
			content: "The team default package manager for installs is now pnpm",
			supersedes: "none",
		} as never);
		expect(waived.details).toMatchObject({ op: "save", saved: true });
		expect(parseChannelMemoryEntries(await readChannelMemory(waivedDir))).toHaveLength(2);
	});

	it("reports when forget finds no match", async () => {
		const channelDir = createTempChannel();
		await applyChannelMemoryOps(channelDir, [{ op: "add", content: "Something durable" }]);
		const result = await makeForget(channelDir).execute("call", { target: "does not exist" } as never);
		expect(result.details).toMatchObject({ op: "forget", forgotten: false });
	});
});
