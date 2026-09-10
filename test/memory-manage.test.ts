import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JOURNAL_SEARCH_DAY_BYTES } from "../src/memory/journal.js";
import { getMemoryReviewLogPath } from "../src/memory/review-log.js";
import { applyMemoryOps, listMemoryEntries } from "../src/memory/store.js";
import { createMemoryForgetTool, createMemorySaveTool, createMemorySearchTool } from "../src/tools/memory-manage.js";
import { useTempDirs } from "./helpers/fixtures.js";

const createTempChannel = useTempDirs("pipiclaw-memory-manage-");

function makeOptions(channelDir: string, overrides: Record<string, unknown> = {}) {
	return { channelId: "dm_1", channelDir, workspaceDir: channelDir, ...overrides };
}
const makeSave = (dir: string, o: Record<string, unknown> = {}) => createMemorySaveTool(makeOptions(dir, o) as never);
const makeSearch = (dir: string, o: Record<string, unknown> = {}) =>
	createMemorySearchTool(makeOptions(dir, o) as never);
const makeForget = (dir: string, o: Record<string, unknown> = {}) =>
	createMemoryForgetTool(makeOptions(dir, o) as never);

async function run(
	tool: {
		execute: (
			id: string,
			args: never,
		) => Promise<{ content: Array<{ type: string; text?: string }>; details: unknown }>;
	},
	args: Record<string, unknown>,
) {
	const result = await tool.execute("call", args as never);
	return { text: result.content[0].text ?? "", details: result.details as Record<string, unknown> };
}

describe("memory tools", () => {
	it("bounds a long journal hit and points to the full source", async () => {
		const channelDir = createTempChannel();
		mkdirSync(join(channelDir, "journal"), { recursive: true });
		writeFileSync(join(channelDir, "journal", "2020-01-02.md"), `- archiveprobe ${"details ".repeat(2000)}\n`);
		const { text } = await run(makeSearch(channelDir), { query: "archiveprobe" });
		expect(text).toContain("journal/2020-01-02.md");
		expect(text.length).toBeLessThan(1000);
		expect(text).toMatch(/read.*file/i);
	});

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
		expect(entries[0]).toMatchObject({
			description: "User prefers responses in Chinese",
			type: "user",
			source: "user",
		});
	});

	it("re-saving a forgotten fact reports honest success, not `undefined` (batch 1.7)", async () => {
		// Regression: after save → forget → save, the store skipped the tombstoned add, `result.added`
		// was empty, and the tool rendered "Saved ... as `undefined`." with details.saved=false — a
		// success message for a write that never happened. Mutation check: revert the content builder
		// to `savedName = replaces ?? result.added[0]` and details.name is undefined here.
		const channelDir = createTempChannel();
		await run(makeSave(channelDir), { content: "The staging deploy key rotated on Tuesday", name: "deploy-key" });
		await run(makeForget(channelDir), { name: "deploy-key" });

		const again = await run(makeSave(channelDir), {
			content: "The staging deploy key rotated on Tuesday",
			name: "deploy-key",
		});
		expect(again.details.saved).toBe(true);
		expect(typeof again.details.name).toBe("string");
		expect(again.text).not.toContain("undefined");
		const entries = await listMemoryEntries(channelDir);
		expect(entries.map((e) => e.description)).toContain("The staging deploy key rotated on Tuesday");
	});

	it("rejects a save with only whitespace content, an invalid name, or a secret", async () => {
		const channelDir = createTempChannel();
		await expect(makeSave(channelDir).execute("call", { content: "   " } as never)).rejects.toThrow(
			/non-empty content/,
		);
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
		const source = hit.text.match(/\[(memory\/[^\]]+)\]/)?.[1];
		expect(source).toBeDefined();
		expect(readFileSync(join(channelDir, source!), "utf8")).toContain("dark mode");

		const miss = await run(makeSearch(createTempChannel()), { query: "nonexistent topic xyz" });
		expect(miss.text).toContain("No stored memory matched");
	});

	it("retrieves journal-only evidence with its source and discloses omitted history on hits and misses", async () => {
		const dir = createTempChannel();
		mkdirSync(join(dir, "journal"));
		writeFileSync(
			join(dir, "journal", "2026-09-09.md"),
			`- omittedcanaryvalue\n${"x".repeat(JOURNAL_SEARCH_DAY_BYTES)}\n- journal-only-marker was confirmed\n`,
		);
		const hit = await run(makeSearch(dir), { query: "journal-only-marker" });
		expect(hit.details.resultCount).toBe(1);
		expect(hit.text).toContain("journal/2026-09-09.md");
		expect(hit.text).toContain("journal-only-marker");
		const miss = await run(makeSearch(dir), { query: "omittedcanaryvalue" });
		expect(miss.details.resultCount).toBe(0);
		for (const result of [hit, miss]) {
			expect(result.text).toContain(join(dir, "journal"));
			expect(result.text).toMatch(/grep|read/);
		}
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
			{
				op: "add",
				name: "pkg-manager",
				description: "The team default package manager for installs is npm",
				source: "agent",
			},
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
