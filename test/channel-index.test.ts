import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CHANNELS_INDEX_FILENAME,
	createChannelIndex,
	parseChannelIndex,
	renderChannelIndex,
} from "../src/channel/channel-index.js";

/** A real DingTalk group id: base64, so it contains characters no id pattern would allow. */
const GROUP_ID = "dingtalk:group:cidYDhGqxhJOzS7VDv/eDInUw==";
const DM_ID = "dingtalk:dm:0123456789";

describe("channel index", () => {
	it("round-trips the current channel index", () => {
		const entries = [
			{
				channelId: GROUP_ID,
				name: "投资理财",
				desk: "invest",
				lastMessageAt: "2026-07-30T14:22:13+08:00",
				topic: "长期定投",
			},
			{ channelId: DM_ID, name: "张三", desk: "", lastMessageAt: "", topic: "" },
		];
		expect(parseChannelIndex(renderChannelIndex(entries))).toEqual(entries);
	});
});

describe("channel index maintenance", () => {
	let workspaceDir: string;
	let indexPath: string;
	let index: ReturnType<typeof createChannelIndex>;

	const rows = async () => parseChannelIndex(await readFile(indexPath, "utf-8"));

	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), "pipiclaw-channel-index-"));
		indexPath = join(workspaceDir, CHANNELS_INDEX_FILENAME);
		index = createChannelIndex({ workspaceDir, debounceMs: 10_000, getBoundDesk: () => "invest" });
	});

	afterEach(async () => {
		await index.close();
		await rm(workspaceDir, { recursive: true, force: true });
	});

	it("writes a first sighting immediately, without waiting for the debounce", async () => {
		index.note({ channelId: GROUP_ID, name: "投资理财", at: Date.parse("2026-07-30T06:22:13Z") });
		await index.flush();

		expect(await rows()).toMatchObject([{ channelId: GROUP_ID, name: "投资理财", desk: "invest" }]);
	});
});
