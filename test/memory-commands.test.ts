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

	it("shows active metadata and pending review suggestions", async () => {
		const channelDir = makeChannel();
		setupChannelFiles(channelDir, {
			memory: "# Channel Memory\n\n## Facts\n\n- Production is in CN. <!--id:m-region01-->\n",
		});
		await appendMemoryReviewLog(channelDir, {
			timestamp: "2026-07-01T00:00:00.000Z",
			channelId: "dm_123",
			reason: "memory-checkpoint-job",
			suggestions: [{ target: "channel-memory", content: "Maybe prefer weekly summaries." }],
		});

		const show = await handleMemoryCommand({ channelDir, args: "show m-region01" });
		const pending = await handleMemoryCommand({ channelDir, args: "pending" });

		expect(show).toContain("Production is in CN.");
		expect(show).toContain('"status": "active"');
		expect(pending).toContain("Maybe prefer weekly summaries.");
		expect(pending).toMatch(/`p-[a-f0-9]{8}`/);
	});

	it("returns actionable guidance for invalid input", async () => {
		const channelDir = makeChannel();
		setupChannelFiles(channelDir, { memory: "# Channel Memory\n" });

		expect(await handleMemoryCommand({ channelDir, args: "show" })).toContain("/memory list");
		expect(await handleMemoryCommand({ channelDir, args: "unknown" })).toContain("/memory status");
	});
});
