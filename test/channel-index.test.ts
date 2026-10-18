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
const GROUP_ID = "group_cidYDhGqxhJOzS7VDv/eDInUw==";
const DM_ID = "dm_0123456789";

describe("channel index", () => {
	it("round-trips entries through render and parse, and reads a pre-058 four-column row", () => {
		const entries = [
			{
				channelId: GROUP_ID,
				name: "投资理财",
				dot: "invest",
				lastMessageAt: "2026-07-30T14:22:13+08:00",
				topic: "长期定投",
			},
			{ channelId: DM_ID, name: "张三", dot: "", lastMessageAt: "", topic: "" },
		];
		expect(parseChannelIndex(renderChannelIndex(entries))).toEqual(entries);
		// Spec 058, D17: an index written before the `dot` column existed must keep its topic and
		// timestamp in place instead of shifting them one column left.
		const legacy =
			"| 频道 ID | 名称 | 最近消息 | 主题 |\n| --- | --- | --- | --- |\n| `dm_1` | 李四 | 2026-07-30T14:22:13+08:00 | 周报 |\n";
		expect(parseChannelIndex(legacy)).toEqual([
			{ channelId: "dm_1", name: "李四", dot: "", lastMessageAt: "2026-07-30T14:22:13+08:00", topic: "周报" },
		]);
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
		index = createChannelIndex({ workspaceDir, debounceMs: 10_000, getBoundDot: () => "invest" });
	});

	afterEach(async () => {
		await index.close();
		await rm(workspaceDir, { recursive: true, force: true });
	});

	it("writes a first sighting immediately, without waiting for the debounce", async () => {
		index.note({ channelId: GROUP_ID, name: "投资理财", at: Date.parse("2026-07-30T06:22:13Z") });
		await index.flush();

		expect(await rows()).toMatchObject([{ channelId: GROUP_ID, name: "投资理财", dot: "invest" }]);
	});
});
