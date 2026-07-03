import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
	appendChannelHistoryArchive,
	applyChannelMemoryOps,
	getChannelHistoryArchivePath,
	parseChannelMemoryEntries,
	readChannelMemory,
	rewriteChannelMemory,
} from "../src/memory/files.js";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pipiclaw-write-ops-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("channel memory write ops", () => {
	it("add ops append entries with generated ids", async () => {
		const channelDir = createTempDir();
		const result = await applyChannelMemoryOps(channelDir, [
			{ op: "add", content: "User prefers dark mode" },
			{ op: "add", content: "Default deploy is blue-green" },
		]);

		expect(result.added).toBe(2);
		const entries = parseChannelMemoryEntries(await readChannelMemory(channelDir));
		expect(entries).toHaveLength(2);
		expect(entries.every((entry) => entry.hasExplicitId)).toBe(true);
		expect(new Set(entries.map((entry) => entry.id)).size).toBe(2);
	});

	it("supersede replaces an existing entry in place, keeping its id", async () => {
		const channelDir = createTempDir();
		await applyChannelMemoryOps(channelDir, [{ op: "add", content: "Old preference: light mode" }]);
		const [entry] = parseChannelMemoryEntries(await readChannelMemory(channelDir));

		const result = await applyChannelMemoryOps(channelDir, [
			{ op: "supersede", targetId: entry.id, content: "User now prefers dark mode" },
		]);

		expect(result.superseded).toBe(1);
		const memory = await readChannelMemory(channelDir);
		expect(memory).toContain("User now prefers dark mode");
		expect(memory).not.toContain("light mode");
		const entries = parseChannelMemoryEntries(memory);
		expect(entries).toHaveLength(1);
		expect(entries[0].id).toBe(entry.id);
	});

	it("invalidate removes the target entry", async () => {
		const channelDir = createTempDir();
		await applyChannelMemoryOps(channelDir, [
			{ op: "add", content: "Temporary open loop: migrate config" },
			{ op: "add", content: "Durable: keep prod online" },
		]);
		const entries = parseChannelMemoryEntries(await readChannelMemory(channelDir));
		const target = entries.find((entry) => entry.content.includes("migrate config"));
		expect(target).toBeDefined();

		const result = await applyChannelMemoryOps(channelDir, [
			{ op: "invalidate", targetId: target?.id ?? "", reason: "done" },
		]);
		expect(result.invalidated).toBe(1);
		const memory = await readChannelMemory(channelDir);
		expect(memory).not.toContain("migrate config");
		expect(memory).toContain("keep prod online");
	});

	it("downgrades supersede with an unknown target to an add", async () => {
		const channelDir = createTempDir();
		const result = await applyChannelMemoryOps(channelDir, [
			{ op: "supersede", targetId: "m-doesnotexist", content: "New durable fact" },
		]);
		expect(result.downgradedToAdd).toBe(1);
		expect(result.missingTarget).toBe(1);
		expect(await readChannelMemory(channelDir)).toContain("New durable fact");
	});

	it("matches legacy entries without id comments by synthesized id", async () => {
		const channelDir = createTempDir();
		await rewriteChannelMemory(channelDir, "## Preferences\n\n- Legacy fact without id");
		const [legacy] = parseChannelMemoryEntries(await readChannelMemory(channelDir));
		expect(legacy.hasExplicitId).toBe(false);

		const result = await applyChannelMemoryOps(channelDir, [
			{ op: "supersede", targetId: legacy.id, content: "Migrated fact with id" },
		]);
		expect(result.superseded).toBe(1);
		const memory = await readChannelMemory(channelDir);
		expect(memory).toContain("Migrated fact with id");
		expect(memory).not.toContain("Legacy fact without id");
		expect(parseChannelMemoryEntries(memory)[0].hasExplicitId).toBe(true);
	});

	it("backs up the file before a mutating op and keeps at most five backups", async () => {
		const channelDir = createTempDir();
		await applyChannelMemoryOps(channelDir, [{ op: "add", content: "Base fact" }]);

		for (let i = 0; i < 7; i++) {
			const [entry] = parseChannelMemoryEntries(await readChannelMemory(channelDir));
			await applyChannelMemoryOps(channelDir, [{ op: "supersede", targetId: entry.id, content: `Fact v${i}` }]);
		}

		const backupDir = join(channelDir, ".memory-backups");
		expect(existsSync(backupDir)).toBe(true);
		const backups = readdirSync(backupDir).filter((f) => f.startsWith("MEMORY-"));
		expect(backups.length).toBeLessThanOrEqual(5);
	});

	it("does not back up on pure add ops", async () => {
		const channelDir = createTempDir();
		await applyChannelMemoryOps(channelDir, [{ op: "add", content: "First" }]);
		await applyChannelMemoryOps(channelDir, [{ op: "add", content: "Second" }]);
		expect(existsSync(join(channelDir, ".memory-backups"))).toBe(false);
	});

	it("archives raw history blocks", async () => {
		const channelDir = createTempDir();
		await appendChannelHistoryArchive(channelDir, {
			timestamp: "2026-07-01T00:00:00.000Z",
			content: "## 2026-06-01\n\nOriginal detailed block",
		});
		const archive = readFileSync(getChannelHistoryArchivePath(channelDir), "utf-8");
		expect(archive).toContain("Original detailed block");
		expect(archive).toContain("Archived 2026-07-01T00:00:00.000Z");
	});
});
