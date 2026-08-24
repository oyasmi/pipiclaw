import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleMemoryCommand } from "../src/memory/commands.js";
import { appendMemoryReviewLog } from "../src/memory/review-log.js";
import { setupChannelFiles, useTempDirs } from "./helpers/fixtures.js";

const makeChannel = useTempDirs("pipiclaw-memory-commands-");

describe("memory commands", () => {
	it("reports status and lists entry-level ids", async () => {
		const channelDir = makeChannel();
		setupChannelFiles(channelDir, {
			memory: "# Channel Memory\n\n## Preferences\n\n- Prefer concise updates. <!--id:m-concise01-->\n",
		});

		const status = await handleMemoryCommand({ channelDir, args: "status" });
		const list = await handleMemoryCommand({ channelDir, args: "list" });

		expect(status).toContain("Active entries: `1`");
		expect(status).toContain(join(channelDir, "MEMORY.md"));
		expect(list).toContain("`m-concise01` [preference] Prefer concise updates.");
	});

	it("shows active metadata and recent memory activity", async () => {
		const channelDir = makeChannel();
		setupChannelFiles(channelDir, {
			memory: "# Channel Memory\n\n## Facts\n\n- Production is in CN. <!--id:m-region01-->\n",
		});
		const now = new Date().toISOString();
		await appendMemoryReviewLog(channelDir, {
			timestamp: now,
			channelId: "dm_123",
			reason: "memory-checkpoint-job",
			actions: [
				{ target: "MEMORY.md", action: "append", entries: 2, durableCandidates: 2, probationaryCandidates: 0 },
			],
		});
		await appendMemoryReviewLog(channelDir, {
			timestamp: now,
			channelId: "dm_123",
			reason: "structural-maintenance-job",
			actions: [{ target: "MEMORY.md", action: "rewrite", droppedEntryIds: ["m-old01", "m-old02"] }],
		});
		await appendMemoryReviewLog(channelDir, {
			timestamp: now,
			channelId: "dm_123",
			reason: "structural-maintenance-job",
			actions: [{ target: "MEMORY.md", action: "expire", entries: 1 }],
		});

		const show = await handleMemoryCommand({ channelDir, args: "show m-region01" });
		const recent = await handleMemoryCommand({ channelDir, args: "recent" });
		const status = await handleMemoryCommand({ channelDir, args: "status" });

		expect(show).toContain("Production is in CN.");
		expect(show).toContain('"status": "active"');
		expect(recent).toContain("append 2 entries");
		expect(recent).toContain("rewrite (dropped m-old01, m-old02)");
		expect(recent).toContain("expire 1 entry");
		expect(status).toContain("Last 7d: +2 written / -2 dropped / -1 expired");
	});

	it("returns actionable guidance for invalid input", async () => {
		const channelDir = makeChannel();
		setupChannelFiles(channelDir, { memory: "# Channel Memory\n" });

		expect(await handleMemoryCommand({ channelDir, args: "show" })).toContain("/memory list");
		expect(await handleMemoryCommand({ channelDir, args: "unknown" })).toContain("/memory status");
	});
});
