import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyChannelMemoryOps, parseChannelMemoryEntries, readChannelMemory } from "../src/memory/files.js";
import { readMemoryMetadata, recordMemoryRecall } from "../src/memory/metadata.js";
import { setupChannelFiles, useTempDirs } from "./helpers/fixtures.js";

const makeChannel = useTempDirs("pipiclaw-memory-metadata-");

describe("memory entry metadata", () => {
	it("persists source, trust, time, status, sensitivity, and recall statistics", async () => {
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
						subjectId: "user-7",
						sourceType: "user",
						trust: "explicit",
						sensitivity: "personal",
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
			scope: "channel",
			subjectId: "user-7",
			sourceEntryIds: ["session-entry-42"],
			sourceCorrelationIds: ["window-42"],
			sourceType: "user",
			trust: "explicit",
			createdAt: "2026-07-01T00:00:00.000Z",
			status: "active",
			sensitivity: "personal",
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
});
