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
	const result = await tool.execute("call", { ...args } as never);
	return result.content[0].type === "text" ? result.content[0].text : "";
}

describe("memory_manage tool", () => {
	it("saves a durable entry and invalidates the candidate cache", async () => {
		const channelDir = createTempChannel();
		const store = createMemoryCandidateStore();
		const invalidateSpy = vi.spyOn(store, "invalidate");
		const tool = makeTool(channelDir, { memoryCandidateStore: store });

		const result = await tool.execute("call", {
			op: "save",
			content: "User prefers responses in Chinese",
			kind: "preference",
		});

		expect(result.details).toMatchObject({ op: "save", saved: true });
		expect(invalidateSpy).toHaveBeenCalledWith(join(channelDir, "MEMORY.md"));
		const entries = parseChannelMemoryEntries(await readChannelMemory(channelDir));
		expect(entries).toHaveLength(1);
		expect(entries[0].content).toBe("User prefers responses in Chinese");
	});

	it("rejects saves without usable content, naming the arguments that did arrive when content is missing entirely", async () => {
		const channelDir = createTempChannel();
		await expect(makeTool(channelDir).execute("call", { op: "save", content: "   " })).rejects.toThrow(
			/requires a non-empty "content"/,
		);
		expect(await readChannelMemory(channelDir)).not.toContain("x");

		// The signature of an argument dropped in transit: everything but the payload arrives.
		// The rejection must name the keys that did arrive, otherwise the model reads its own
		// content-less call back from history and replays it forever.
		await expect(makeTool(channelDir).execute("call", { op: "save", kind: "fact" })).rejects.toThrow(/op, kind/);
	});

	it("rejects search without a query and forget without a target", async () => {
		const channelDir = createTempChannel();
		await expect(makeTool(channelDir).execute("call", { op: "search" })).rejects.toThrow(
			/requires a non-empty "query"/,
		);
		await expect(makeTool(channelDir).execute("call", { op: "forget" })).rejects.toThrow(
			/requires a non-empty "target"/,
		);
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

		await tool.execute("call", { op: "save", content: "Durable fact" });
		expect(seenChannelIds).toEqual(["dm_9"]);
	});

	it("searches stored memory, returns matching entries, and hints when nothing matched", async () => {
		const channelDir = createTempChannel();
		await applyChannelMemoryOps(channelDir, [{ op: "add", content: "User prefers dark mode in the dashboard" }]);
		const result = await makeTool(channelDir).execute("call", {
			op: "search",
			query: "dark mode preference",
		});
		const text = result.content[0].type === "text" ? result.content[0].text : "";
		expect(text).toContain("dark mode");
		expect(result.details).toMatchObject({ op: "search" });
		expect((result.details as { resultCount: number }).resultCount).toBeGreaterThanOrEqual(1);

		const emptyText = await runText(makeTool(createTempChannel()), { op: "search", query: "nonexistent topic xyz" });
		expect(emptyText).toContain("No stored memory matched");
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

		const result = await tool.execute("call", { op: "forget", target: "home address" });
		expect(result.details).toMatchObject({ op: "forget", forgotten: true });
		expect(seenChannelIds).toEqual(["dm_1"]);
		const entries = parseChannelMemoryEntries(await readChannelMemory(channelDir));
		expect(entries).toHaveLength(0);

		// forget must leave an auditable trail in the maintenance log.
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
		const tool = makeTool(channelDir);
		await expect(tool.execute("call", { op: "forget", target: "likes tea" })).rejects.toThrow(/matched 2 entries/);
	});

	it("guards similar-entry conflicts: flags them by default, allows them with supersedes none, replaces in place when given the id", async () => {
		const channelDir = createTempChannel();
		await applyChannelMemoryOps(channelDir, [
			{ op: "add", content: "The team default package manager for installs is npm" },
		]);
		const [existing] = parseChannelMemoryEntries(await readChannelMemory(channelDir));

		// The default save flags a similar entry instead of writing a second,
		// possibly-contradictory fact.
		await expect(
			makeTool(channelDir).execute("call", {
				op: "save",
				content: "The team default package manager for installs is now pnpm",
			}),
		).rejects.toThrow(new RegExp(`supersedes.*${existing.id}|${existing.id}`));
		expect(parseChannelMemoryEntries(await readChannelMemory(channelDir))).toHaveLength(1);

		// Naming the flagged id replaces that entry in place.
		const replaced = await makeTool(channelDir).execute("call", {
			op: "save",
			content: "The team default package manager for installs is now pnpm",
			supersedes: existing.id,
		});
		expect(replaced.details).toMatchObject({ op: "save", saved: true });
		const entries = parseChannelMemoryEntries(await readChannelMemory(channelDir));
		expect(entries).toHaveLength(1);
		expect(entries[0].content).toContain("pnpm");

		// Waiving the conflict stores both entries side by side.
		const waivedDir = createTempChannel();
		await applyChannelMemoryOps(waivedDir, [
			{ op: "add", content: "The team default package manager for installs is npm" },
		]);
		const waived = await makeTool(waivedDir).execute("call", {
			op: "save",
			content: "The team default package manager for installs is now pnpm",
			supersedes: "none",
		});
		expect(waived.details).toMatchObject({ op: "save", saved: true });
		expect(parseChannelMemoryEntries(await readChannelMemory(waivedDir))).toHaveLength(2);
	});

	it("reports when forget finds no match", async () => {
		const channelDir = createTempChannel();
		await applyChannelMemoryOps(channelDir, [{ op: "add", content: "Something durable" }]);
		const result = await makeTool(channelDir).execute("call", {
			op: "forget",
			target: "does not exist",
		});
		expect(result.details).toMatchObject({ op: "forget", forgotten: false });
	});
});
