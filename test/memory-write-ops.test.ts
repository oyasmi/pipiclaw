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
	it("generates explicit ids for adds and targets legacy id-less entries by synthesized id", async () => {
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

		// A legacy entry written without an id comment is still addressable by its synthesized
		// id, and superseding it upgrades the entry to an explicit one.
		const legacyDir = createTempDir();
		await rewriteChannelMemory(legacyDir, "## Preferences\n\n- Legacy fact without id");
		const [legacy] = parseChannelMemoryEntries(await readChannelMemory(legacyDir));
		expect(legacy.hasExplicitId).toBe(false);

		const migrated = await applyChannelMemoryOps(legacyDir, [
			{ op: "supersede", targetId: legacy.id, content: "Migrated fact with id" },
		]);
		expect(migrated.superseded).toBe(1);
		const legacyMemory = await readChannelMemory(legacyDir);
		expect(legacyMemory).toContain("Migrated fact with id");
		expect(legacyMemory).not.toContain("Legacy fact without id");
		expect(parseChannelMemoryEntries(legacyMemory)[0].hasExplicitId).toBe(true);
	});

	it("treats normalized duplicate adds as idempotent across batches and within one batch", async () => {
		const channelDir = createTempDir();
		await applyChannelMemoryOps(channelDir, [{ op: "add", content: "User prefers dark mode" }]);

		const replayed = await applyChannelMemoryOps(channelDir, [
			{ op: "add", content: "  user   PREFERS dark mode  " },
			{ op: "add", content: "USER PREFERS DARK MODE" },
		]);
		expect(replayed.added).toBe(0);
		expect(replayed.skippedDuplicate).toBe(2);
		expect(parseChannelMemoryEntries(await readChannelMemory(channelDir))).toHaveLength(1);

		const batched = await applyChannelMemoryOps(channelDir, [
			{ op: "add", content: "Default deploy is blue-green" },
			{ op: "add", content: "default deploy is blue-green" },
		]);
		expect(batched.added).toBe(1);
		expect(batched.skippedDuplicate).toBe(1);
		expect(parseChannelMemoryEntries(await readChannelMemory(channelDir))).toHaveLength(2);
	});

	it("treats a repeated consolidation window as idempotent even when wording changes", async () => {
		const channelDir = createTempDir();
		const metadata = { sourceCorrelationId: "window-42" };
		await applyChannelMemoryOps(channelDir, [
			{ op: "add", content: "User prefers dark mode", metadata },
			{ op: "add", content: "Production deploys use blue-green", metadata },
		]);

		const replayed = await applyChannelMemoryOps(channelDir, [
			{ op: "add", content: "Dark mode is the user's preference", metadata },
			{ op: "add", content: "Use a blue-green strategy in production", metadata },
		]);

		expect(replayed.added).toBe(0);
		expect(replayed.skippedDuplicate).toBe(2);
		const entries = parseChannelMemoryEntries(await readChannelMemory(channelDir));
		expect(entries.map((entry) => entry.content)).toEqual([
			"User prefers dark mode",
			"Production deploys use blue-green",
		]);
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

	it("backs up only on a mutating op, before it applies, and keeps at most ten backups", async () => {
		const channelDir = createTempDir();
		await applyChannelMemoryOps(channelDir, [{ op: "add", content: "Base fact" }]);
		await applyChannelMemoryOps(channelDir, [{ op: "add", content: "Second" }]);
		expect(existsSync(join(channelDir, ".memory-backups"))).toBe(false);

		for (let i = 0; i < 13; i++) {
			const [entry] = parseChannelMemoryEntries(await readChannelMemory(channelDir));
			await applyChannelMemoryOps(channelDir, [{ op: "supersede", targetId: entry.id, content: `Fact v${i}` }]);
		}

		const backupDir = join(channelDir, ".memory-backups");
		expect(existsSync(backupDir)).toBe(true);
		const backups = readdirSync(backupDir).filter((f) => f.startsWith("MEMORY-"));
		expect(backups.length).toBeLessThanOrEqual(10);
	});

	it("archives history blocks, keeps successive ones, and rotates into a .1 generation past the size threshold", async () => {
		const channelDir = createTempDir();
		await appendChannelHistoryArchive(channelDir, {
			timestamp: "2026-07-01T00:00:00.000Z",
			content: "## 2026-06-01\n\nOriginal detailed block",
		});
		let archive = readFileSync(getChannelHistoryArchivePath(channelDir), "utf-8");
		expect(archive).toContain("Original detailed block");
		expect(archive).toContain("Archived 2026-07-01T00:00:00.000Z");

		await appendChannelHistoryArchive(channelDir, { timestamp: "2026-07-02T00:00:00.000Z", content: "Second block" });
		await appendChannelHistoryArchive(channelDir, { timestamp: "2026-07-03T00:00:00.000Z", content: "Third block" });
		archive = readFileSync(getChannelHistoryArchivePath(channelDir), "utf-8");
		expect(archive).toContain("Second block");
		expect(archive).toContain("Third block");
		expect(archive.startsWith("# Channel History Archive")).toBe(true);

		const bigBlock = "x".repeat(4 * 1024 * 1024);
		await appendChannelHistoryArchive(channelDir, { timestamp: "2026-07-04T00:00:00.000Z", content: bigBlock });
		await appendChannelHistoryArchive(channelDir, {
			timestamp: "2026-07-05T00:00:00.000Z",
			content: "Block after rotation",
		});

		const archivePath = getChannelHistoryArchivePath(channelDir);
		const rotatedPath = `${archivePath}.1`;
		expect(existsSync(rotatedPath)).toBe(true);
		expect(readFileSync(rotatedPath, "utf-8")).toContain(bigBlock);

		const current = readFileSync(archivePath, "utf-8");
		expect(current).toContain("Block after rotation");
		expect(current).not.toContain(bigBlock);
	});

	it("records a forget tombstone blocking both exact resurrection and paraphrased replays from the same source window", async () => {
		const channelDir = createTempDir();
		await applyChannelMemoryOps(channelDir, [{ op: "add", content: "User prefers cobalt blue" }]);
		const [entry] = parseChannelMemoryEntries(await readChannelMemory(channelDir));
		const forgotten = await applyChannelMemoryOps(channelDir, [
			{ op: "forget", targetId: entry.id, reason: "user request" },
		]);
		expect(forgotten.forgotten).toBe(1);

		const resurrected = await applyChannelMemoryOps(channelDir, [{ op: "add", content: "User prefers cobalt blue" }]);
		expect(resurrected.blockedByTombstone).toBe(1);
		expect(parseChannelMemoryEntries(await readChannelMemory(channelDir))).toHaveLength(0);

		// A paraphrase replaying from the forgotten entry's source window is blocked too.
		const sourcedDir = createTempDir();
		await applyChannelMemoryOps(sourcedDir, [
			{
				op: "add",
				content: "User prefers cobalt blue",
				sourceEntryIds: ["session-entry-42"],
			},
		]);
		const [sourced] = parseChannelMemoryEntries(await readChannelMemory(sourcedDir));
		await applyChannelMemoryOps(sourcedDir, [{ op: "forget", targetId: sourced.id }]);

		const replayed = await applyChannelMemoryOps(sourcedDir, [
			{
				op: "add",
				content: "Cobalt blue is the user's preferred color",
				sourceEntryIds: ["session-entry-42"],
			},
		]);
		expect(replayed.blockedByTombstone).toBe(1);
		expect(parseChannelMemoryEntries(await readChannelMemory(sourcedDir))).toHaveLength(0);
	});
});
