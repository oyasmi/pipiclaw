import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getMemoryReviewLogPath } from "../src/memory/review-log.js";
import { applyMemoryOps, listMemoryEntries } from "../src/memory/store.js";
import { createMemoryForgetTool, createMemorySaveTool, createMemorySearchTool } from "../src/tools/memory-manage.js";
import { useTempDirs } from "./helpers/fixtures.js";

const createTempChannel = useTempDirs("pipiclaw-memory-manage-");

function makeOptions(channelDir: string, overrides: Record<string, unknown> = {}) {
	return { channelId: "dm_1", channelDir, workspaceDir: channelDir, ...overrides };
}
const makeSave = (dir: string, o: Record<string, unknown> = {}) => createMemorySaveTool(makeOptions(dir, o) as never);
const makeSearch = (dir: string, o: Record<string, unknown> = {}) => createMemorySearchTool(makeOptions(dir, o) as never);
const makeForget = (dir: string, o: Record<string, unknown> = {}) => createMemoryForgetTool(makeOptions(dir, o) as never);

async function run(
	tool: { execute: (id: string, args: never) => Promise<{ content: Array<{ type: string; text?: string }>; details: unknown }> },
	args: Record<string, unknown>,
) {
	const result = await tool.execute("call", args as never);
	return { text: result.content[0].text ?? "", details: result.details as Record<string, unknown> };
}

describe("memory tools", () => {
	it("saves a durable entry as a channel memory file", async () => {
		const channelDir = createTempChannel();
		const { details } = await run(makeSave(channelDir), {
			content: "User prefers responses in Chinese",
			name: "user-prefers-chinese",
			type: "user",
		});
		expect(details).toMatchObject({ saved: true, name: "user-prefers-chinese" });
		const entries = await listMemoryEntries(channelDir);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ description: "User prefers responses in Chinese", type: "user", source: "user" });
	});

	it("rejects a save with only whitespace content, an invalid name, or a secret", async () => {
		const channelDir = createTempChannel();
		await expect(makeSave(channelDir).execute("call", { content: "   " } as never)).rejects.toThrow(/non-empty content/);
		await expect(
			makeSave(channelDir).execute("call", { content: "fact", name: "Bad Name" } as never),
		).rejects.toThrow(/not a valid memory name/);
		const secret = await run(makeSave(channelDir), { content: "api_key = abcdef1234567890" });
		expect(secret.details).toMatchObject({ saved: false, blockedReason: "secret" });
	});

	it("rejects search without a query and forget without a name", async () => {
		const channelDir = createTempChannel();
		await expect(makeSearch(channelDir).execute("call", { query: "" } as never)).rejects.toThrow(/non-empty query/);
		await expect(makeForget(channelDir).execute("call", { name: " " } as never)).rejects.toThrow(/non-empty name/);
	});

	it("serializes writes through the provided channel memory queue", async () => {
		const channelDir = createTempChannel();
		const seen: string[] = [];
		const tool = makeSave(channelDir, {
			channelId: "dm_9",
			channelMemoryQueue: {
				run: <T>(channelId: string, job: () => Promise<T>) => {
					seen.push(channelId);
					return job();
				},
			},
		});
		await tool.execute("call", { content: "Durable fact" } as never);
		expect(seen).toEqual(["dm_9"]);
	});

	it("searches memory files and hints when nothing matched", async () => {
		const channelDir = createTempChannel();
		await applyMemoryOps(channelDir, [
			{ op: "add", description: "User prefers dark mode in the dashboard", source: "agent" },
		]);
		const hit = await run(makeSearch(channelDir), { query: "dark mode preference" });
		expect(hit.text).toContain("dark mode");
		expect(hit.details.resultCount).toBeGreaterThanOrEqual(1);

		const miss = await run(makeSearch(createTempChannel()), { query: "nonexistent topic xyz" });
		expect(miss.text).toContain("No stored memory matched");
	});

	it("forgets an entry by exact name through the serial queue and tombstones by hash only", async () => {
		const channelDir = createTempChannel();
		const seen: string[] = [];
		await applyMemoryOps(channelDir, [
			{ op: "add", name: "home-address", description: "User's home address is 5 Main St", source: "agent" },
		]);
		const tool = makeForget(channelDir, {
			channelMemoryQueue: {
				run: <T>(channelId: string, job: () => Promise<T>) => {
					seen.push(channelId);
					return job();
				},
			},
		});
		const { details } = await run(tool, { name: "home-address" });
		expect(details).toMatchObject({ forgotten: true, name: "home-address" });
		expect(seen).toEqual(["dm_1"]);
		expect(await listMemoryEntries(channelDir)).toHaveLength(0);

		const log = readFileSync(getMemoryReviewLogPath(channelDir), "utf-8").trim();
		const entry = JSON.parse(log.split("\n").at(-1) as string);
		expect(entry).toMatchObject({ channelId: "dm_1", reason: "memory-forget" });
		expect(JSON.stringify(entry.actions)).not.toContain("5 Main St");
		expect(JSON.stringify(entry.actions)).toContain("contentHash");
	});

	it("flags a near-duplicate save and accepts it once replaces is supplied", async () => {
		const channelDir = createTempChannel();
		await applyMemoryOps(channelDir, [
			{ op: "add", name: "pkg-manager", description: "The team default package manager for installs is npm", source: "agent" },
		]);
		await expect(
			makeSave(channelDir).execute("call", {
				content: "The team default package manager for installs is now pnpm",
			} as never),
		).rejects.toThrow(/pkg-manager/);
		expect(await listMemoryEntries(channelDir)).toHaveLength(1);

		const replaced = await run(makeSave(channelDir), {
			content: "The team default package manager for installs is now pnpm",
			replaces: "pkg-manager",
		});
		expect(replaced.details).toMatchObject({ saved: true, name: "pkg-manager" });
		const entries = await listMemoryEntries(channelDir);
		expect(entries).toHaveLength(1);
		expect(entries[0].description).toContain("pnpm");

		const waived = await run(makeSave(channelDir), {
			content: "The team default package manager for installs is now pnpm",
			replaces: "none",
		});
		expect(waived.details).toMatchObject({ saved: true });
		expect(await listMemoryEntries(channelDir)).toHaveLength(2);
	});

	it("reports when forget finds no match, and when replaces names a missing entry", async () => {
		const channelDir = createTempChannel();
		await applyMemoryOps(channelDir, [{ op: "add", description: "Something durable", source: "agent" }]);
		const forget = await run(makeForget(channelDir), { name: "does-not-exist" });
		expect(forget.details).toMatchObject({ forgotten: false });
		await expect(
			makeSave(channelDir).execute("call", { content: "new fact", replaces: "ghost" } as never),
		).rejects.toThrow(/No memory named "ghost"/);
	});
});

