import { describe, expect, it, vi } from "vitest";

const { rmMock } = vi.hoisted(() => ({ rmMock: vi.fn() }));

vi.mock("node:fs/promises", async () => {
	const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	return { ...actual, rm: rmMock };
});

import { applyMemoryOps, isDescriptionTombstoned } from "../src/memory/store.js";
import { useTempDirs } from "./helpers/fixtures.js";

const createTempDir = useTempDirs("pipiclaw-memory-delete-order-");

// R8: the tombstone is what stops the background reflect pass from silently re-learning a fact
// the user just deleted. It must be recorded *before* the fact file is removed — the old order
// (delete file, then append tombstone) meant a failure between the two steps left the fact gone
// with no tombstone recorded, and by the time a caller retried, the source file no longer existed
// to recompute the hash from, so the deleted fact could quietly come back.
describe("memory store — delete ordering", () => {
	it("records the tombstone before removing the file, so a delete that fails after recording it still protects against re-learning", async () => {
		const channelDir = createTempDir();
		await applyMemoryOps(channelDir, [{ op: "add", name: "gone", description: "obsolete fact", source: "agent" }]);

		rmMock.mockRejectedValueOnce(new Error("simulated ENOSPC"));
		await expect(
			applyMemoryOps(channelDir, [{ op: "delete", name: "gone", reason: "user said so" }]),
		).rejects.toThrow("simulated ENOSPC");

		// The tombstone landed even though the delete itself failed — the worst case left behind is
		// "file still present, already protected", which is recoverable (the caller can just retry
		// the delete), unlike the old order's "file gone, no record it was ever deleted".
		expect(await isDescriptionTombstoned(channelDir, "obsolete fact")).toBe(true);
	});
});
