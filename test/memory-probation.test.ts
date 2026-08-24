import { describe, expect, it } from "vitest";
import { applyChannelMemoryOps, parseChannelMemoryEntries, readChannelMemory } from "../src/memory/files.js";
import { readMemoryMetadata } from "../src/memory/metadata.js";
import { collectExpiredEntryIds, expireMemoryEntries } from "../src/memory/probation.js";
import { readMemoryTombstones } from "../src/memory/tombstones.js";
import { setupChannelFiles, useTempDirs } from "./helpers/fixtures.js";

const makeChannel = useTempDirs("pipiclaw-memory-probation-");

describe("memory probation expiry (spec 037, D8)", () => {
	interface ExpiryScenario {
		content: string;
		probationUntil?: string;
		now: string;
		expectEviction: boolean;
	}

	const expiryScenarios: ExpiryScenario[] = [
		{
			content: "Release channel defaults to Thursday cuts",
			probationUntil: "2026-01-01T00:00:00.000Z",
			now: "2026-02-01T00:00:00.000Z",
			expectEviction: true,
		},
		{
			content: "Future probation entry",
			probationUntil: "2026-06-01T00:00:00.000Z",
			now: "2026-02-01T00:00:00.000Z",
			expectEviction: false,
		},
		// A durable entry (no probationUntil) is untouched regardless of age.
		{ content: "Durable fact with no expiry", now: "2030-01-01T00:00:00.000Z", expectEviction: false },
	];

	it("expires only entries whose probation lapsed, via invalidate — not forget", async () => {
		for (const scenario of expiryScenarios) {
			const channelDir = makeChannel();
			setupChannelFiles(channelDir, { memory: "# Channel Memory\n" });
			await applyChannelMemoryOps(channelDir, [
				{
					op: "add",
					content: scenario.content,
					metadata: scenario.probationUntil ? { probationUntil: scenario.probationUntil } : undefined,
				},
			]);
			const [entry] = parseChannelMemoryEntries(await readChannelMemory(channelDir));

			const evicted = await expireMemoryEntries(channelDir, new Date(scenario.now));

			if (scenario.expectEviction) {
				expect(evicted).toBe(1);
				expect(await readChannelMemory(channelDir)).not.toContain(scenario.content);
				expect((await readMemoryMetadata(channelDir)).entries[entry.id]?.status).toBe("invalidated");
				// Not a tombstone: the same fact must be re-learnable later.
				expect(await readMemoryTombstones(channelDir)).toHaveLength(0);
			} else {
				expect(evicted).toBe(0);
				expect(await readChannelMemory(channelDir)).toContain(scenario.content);
			}
		}
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
