import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyChannelMemoryOps, parseChannelMemoryEntries, readChannelMemory } from "../src/memory/files.js";
import { readMemoryMetadata, recordMemoryRecall } from "../src/memory/metadata.js";
import { setupChannelFiles, useTempDirs } from "./helpers/fixtures.js";

const makeChannel = useTempDirs("pipiclaw-memory-metadata-");

describe("memory entry metadata", () => {
	it("persists source, time, status, and recall statistics", async () => {
		const channelDir = makeChannel();
		setupChannelFiles(channelDir, { memory: "# Channel Memory\n" });
		await applyChannelMemoryOps(
			channelDir,
			[
				{
					op: "add",
					content: "User explicitly prefers concise release notes.",
					sourceEntryIds: ["session-entry-42"],
					metadata: {
						kind: "preference",
						sourceType: "user",
						sourceCorrelationId: "window-42",
					},
				},
			],
			"2026-07-01T00:00:00.000Z",
		);

		const [entry] = parseChannelMemoryEntries(await readChannelMemory(channelDir));
		expect(entry).toBeDefined();
		await recordMemoryRecall(
			channelDir,
			[entry.id],
			"What release-note style does the user prefer?",
			"2026-07-02T00:00:00.000Z",
		);
		await recordMemoryRecall(
			channelDir,
			[entry.id],
			"What release-note style does the user prefer?",
			"2026-07-03T00:00:00.000Z",
		);

		const metadata = (await readMemoryMetadata(channelDir)).entries[entry.id];
		expect(metadata).toMatchObject({
			id: entry.id,
			kind: "preference",
			sourceEntryIds: ["session-entry-42"],
			sourceCorrelationIds: ["window-42"],
			sourceType: "user",
			createdAt: "2026-07-01T00:00:00.000Z",
			status: "active",
			recallCount: 2,
			lastRecalledAt: "2026-07-03T00:00:00.000Z",
			recallByDay: { "2026-07-02": 1, "2026-07-03": 1 },
		});
		expect(metadata.queryFingerprints).toHaveLength(1);
		expect(readFileSync(join(channelDir, ".memory", "entries.json"), "utf-8")).not.toContain("release-note style");
	});

	it("tracks terminal status when an entry is invalidated", async () => {
		const channelDir = makeChannel();
		setupChannelFiles(channelDir, {
			memory: "# Channel Memory\n\n## Decisions\n\n- Use the legacy deploy. <!--id:m-deploy01-->\n",
		});

		await applyChannelMemoryOps(channelDir, [{ op: "invalidate", targetId: "m-deploy01" }]);

		expect((await readMemoryMetadata(channelDir)).entries["m-deploy01"]?.status).toBe("invalidated");
	});

	// spec 037, D7: probationUntil must survive the entries.json rebuild every applyChannelMemoryOps
	// call does (syncMemoryMetadata rebuilds each active entry's record from scratch on every write).
	it("carries probationUntil through a syncMemoryMetadata rebuild triggered by an unrelated write", async () => {
		const channelDir = makeChannel();
		setupChannelFiles(channelDir, { memory: "# Channel Memory\n" });
		await applyChannelMemoryOps(
			channelDir,
			[
				{
					op: "add",
					content: "Release channel defaults to Thursday cuts",
					metadata: { probationUntil: "2026-08-31T00:00:00.000Z" },
				},
			],
			"2026-08-01T00:00:00.000Z",
		);
		const [probationEntry] = parseChannelMemoryEntries(await readChannelMemory(channelDir));
		expect((await readMemoryMetadata(channelDir)).entries[probationEntry.id]?.probationUntil).toBe(
			"2026-08-31T00:00:00.000Z",
		);

		// An unrelated add triggers another full syncMemoryMetadata rebuild.
		await applyChannelMemoryOps(channelDir, [{ op: "add", content: "Unrelated durable fact" }]);

		expect((await readMemoryMetadata(channelDir)).entries[probationEntry.id]?.probationUntil).toBe(
			"2026-08-31T00:00:00.000Z",
		);
	});

	// spec 037, D7 path 1: recall is the primary promotion path, riding along on the write
	// recordMemoryRecall was already doing.
	it("clears probationUntil the first time a probationary entry is recalled", async () => {
		const channelDir = makeChannel();
		setupChannelFiles(channelDir, { memory: "# Channel Memory\n" });
		await applyChannelMemoryOps(channelDir, [
			{
				op: "add",
				content: "Release channel defaults to Thursday cuts",
				metadata: { probationUntil: "2026-08-31T00:00:00.000Z" },
			},
		]);
		const [entry] = parseChannelMemoryEntries(await readChannelMemory(channelDir));

		await recordMemoryRecall(channelDir, [entry.id], "when do we cut releases?");

		expect((await readMemoryMetadata(channelDir)).entries[entry.id]?.probationUntil).toBeUndefined();
	});

	// spec 037, D7 path 2: a durable restatement of an already-stored (possibly probationary)
	// fact promotes the existing entry in place instead of creating a duplicate.
	it("promotes an existing probationary entry when a durable duplicate add arrives", async () => {
		const channelDir = makeChannel();
		setupChannelFiles(channelDir, { memory: "# Channel Memory\n" });
		await applyChannelMemoryOps(channelDir, [
			{
				op: "add",
				content: "Release channel defaults to Thursday cuts",
				metadata: { probationUntil: "2026-08-31T00:00:00.000Z" },
			},
		]);
		const [entry] = parseChannelMemoryEntries(await readChannelMemory(channelDir));

		const result = await applyChannelMemoryOps(channelDir, [
			{ op: "add", content: "Release channel defaults to Thursday cuts", metadata: { probationUntil: null } },
		]);

		expect(result.skippedDuplicate).toBe(1);
		expect(result.promotedFromProbation).toBe(1);
		expect((await readMemoryMetadata(channelDir)).entries[entry.id]?.probationUntil).toBeUndefined();
	});

	// spec 037, D7 path 3: a durable supersede replacing a probationary entry in place (same id)
	// must not silently inherit the old deadline.
	it("promotes an existing probationary entry when a durable supersede replaces it in place", async () => {
		const channelDir = makeChannel();
		setupChannelFiles(channelDir, {
			memory: "# Channel Memory\n\n## Facts\n\n- Release channel defaults to Thursday cuts. <!--id:m-relchan01-->\n",
		});
		await applyChannelMemoryOps(channelDir, [
			{
				op: "supersede",
				targetId: "m-relchan01",
				content: "Release channel defaults to Thursday cuts (initial probation)",
				metadata: { probationUntil: "2026-08-31T00:00:00.000Z" },
			},
		]);
		expect((await readMemoryMetadata(channelDir)).entries["m-relchan01"]?.probationUntil).toBe(
			"2026-08-31T00:00:00.000Z",
		);

		await applyChannelMemoryOps(channelDir, [
			{
				op: "supersede",
				targetId: "m-relchan01",
				content: "Release channel defaults to Thursday cuts (confirmed)",
				metadata: { probationUntil: null },
			},
		]);

		expect((await readMemoryMetadata(channelDir)).entries["m-relchan01"]?.probationUntil).toBeUndefined();
	});
});
