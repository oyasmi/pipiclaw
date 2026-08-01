import { describe, expect, it } from "vitest";
import { applyChannelMemoryOps, parseChannelMemoryEntries, readChannelMemory } from "../src/memory/files.js";
import { readMemoryMetadata } from "../src/memory/metadata.js";
import { collectExpiredEntryIds, expireMemoryEntries, probationDeadline } from "../src/memory/probation.js";
import { readMemoryTombstones } from "../src/memory/tombstones.js";
import { setupChannelFiles, useTempDirs } from "./helpers/fixtures.js";

const makeChannel = useTempDirs("pipiclaw-memory-probation-");

describe("memory probation expiry (spec 037, D8)", () => {
	it("evicts an entry whose probation lapsed, via invalidate — not forget", async () => {
		const channelDir = makeChannel();
		setupChannelFiles(channelDir, { memory: "# Channel Memory\n" });
		await applyChannelMemoryOps(channelDir, [
			{
				op: "add",
				content: "Release channel defaults to Thursday cuts",
				metadata: { probationUntil: "2026-01-01T00:00:00.000Z" },
			},
		]);
		const [entry] = parseChannelMemoryEntries(await readChannelMemory(channelDir));

		const evicted = await expireMemoryEntries(channelDir, new Date("2026-02-01T00:00:00.000Z"));

		expect(evicted).toBe(1);
		expect(await readChannelMemory(channelDir)).not.toContain("Release channel defaults to Thursday cuts");
		expect((await readMemoryMetadata(channelDir)).entries[entry.id]?.status).toBe("invalidated");
		// Not a tombstone: the same fact must be re-learnable later.
		expect(await readMemoryTombstones(channelDir)).toHaveLength(0);
	});

	it("leaves an entry whose probation has not yet lapsed untouched", async () => {
		const channelDir = makeChannel();
		setupChannelFiles(channelDir, { memory: "# Channel Memory\n" });
		await applyChannelMemoryOps(channelDir, [
			{
				op: "add",
				content: "Release channel defaults to Thursday cuts",
				metadata: { probationUntil: "2026-06-01T00:00:00.000Z" },
			},
		]);

		const evicted = await expireMemoryEntries(channelDir, new Date("2026-02-01T00:00:00.000Z"));

		expect(evicted).toBe(0);
		expect(await readChannelMemory(channelDir)).toContain("Release channel defaults to Thursday cuts");
	});

	it("leaves a durable entry (no probationUntil) untouched regardless of age", async () => {
		const channelDir = makeChannel();
		setupChannelFiles(channelDir, { memory: "# Channel Memory\n" });
		await applyChannelMemoryOps(channelDir, [{ op: "add", content: "Durable fact with no expiry" }]);

		const evicted = await expireMemoryEntries(channelDir, new Date("2030-01-01T00:00:00.000Z"));

		expect(evicted).toBe(0);
		expect(await readChannelMemory(channelDir)).toContain("Durable fact with no expiry");
	});

	it("also evicts an entry whose expiresAt was reached, even without probationUntil", async () => {
		const channelDir = makeChannel();
		setupChannelFiles(channelDir, { memory: "# Channel Memory\n" });
		await applyChannelMemoryOps(channelDir, [
			{ op: "add", content: "Temporary access grant", metadata: { expiresAt: "2026-01-01T00:00:00.000Z" } },
		]);

		const evicted = await expireMemoryEntries(channelDir, new Date("2026-02-01T00:00:00.000Z"));

		expect(evicted).toBe(1);
		expect(await readChannelMemory(channelDir)).not.toContain("Temporary access grant");
	});

	it("probationDeadline is MEMORY_PROBATION_DAYS in the future", () => {
		const now = new Date("2026-01-01T00:00:00.000Z");
		const deadline = new Date(probationDeadline(now));
		expect(Math.round((deadline.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))).toBe(30);
	});

	it("collectExpiredEntryIds ignores non-active entries", async () => {
		const channelDir = makeChannel();
		setupChannelFiles(channelDir, { memory: "# Channel Memory\n" });
		await applyChannelMemoryOps(channelDir, [
			{
				op: "add",
				content: "Fact to invalidate before it would expire",
				metadata: { probationUntil: "2026-01-01T00:00:00.000Z" },
			},
		]);
		const [entry] = parseChannelMemoryEntries(await readChannelMemory(channelDir));
		await applyChannelMemoryOps(channelDir, [{ op: "invalidate", targetId: entry.id }]);

		const metadata = await readMemoryMetadata(channelDir);
		expect(collectExpiredEntryIds(metadata, new Date("2026-02-01T00:00:00.000Z"))).toEqual([]);
	});
});
