import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CHANNELS_INDEX_FILENAME,
	createChannelIndex,
	discoverWorkspaceChannelIds,
	parseChannelIndex,
	renderChannelIndex,
} from "../src/runtime/channel-index.js";
import { getChannelDirName } from "../src/runtime/channel-paths.js";

/** A real DingTalk group id: base64, so it contains characters no id pattern would allow. */
const GROUP_ID = "group_cidYDhGqxhJOzS7VDv/eDInUw==";
const DM_ID = "dm_0123456789";

describe("channel index", () => {
	it("round-trips entries through render and parse", () => {
		const entries = [
			{ channelId: GROUP_ID, name: "投资理财", lastMessageAt: "2026-07-30T14:22:13+08:00", topic: "长期定投" },
			{ channelId: DM_ID, name: "张三", lastMessageAt: "", topic: "" },
		];
		expect(parseChannelIndex(renderChannelIndex(entries))).toEqual(entries);
	});

	it("recovers an id the directory scan alone cannot spell", async () => {
		const workspaceDir = await mkdtemp(join(tmpdir(), "pipiclaw-channel-discovery-"));
		try {
			// The directory is the escaped form, so only the index carries the real id back.
			await mkdir(join(workspaceDir, getChannelDirName(GROUP_ID)), { recursive: true });
			await writeFile(
				join(workspaceDir, CHANNELS_INDEX_FILENAME),
				renderChannelIndex([{ channelId: GROUP_ID, name: "投资理财", lastMessageAt: "", topic: "" }]),
				"utf-8",
			);

			await expect(discoverWorkspaceChannelIds(workspaceDir)).resolves.toEqual([GROUP_ID]);
		} finally {
			await rm(workspaceDir, { recursive: true, force: true });
		}
	});

	it("keeps scanning directories once the index exists but is still filling in", async () => {
		const workspaceDir = await mkdtemp(join(tmpdir(), "pipiclaw-channel-discovery-"));
		try {
			// The upgrade path: one channel has spoken, the rest have not. Treating a non-empty index
			// as authoritative would drop every channel that predates it.
			await mkdir(join(workspaceDir, getChannelDirName(GROUP_ID)), { recursive: true });
			await mkdir(join(workspaceDir, "dm_never_spoke"), { recursive: true });
			await writeFile(
				join(workspaceDir, CHANNELS_INDEX_FILENAME),
				renderChannelIndex([{ channelId: GROUP_ID, name: "投资理财", lastMessageAt: "", topic: "" }]),
				"utf-8",
			);

			await expect(discoverWorkspaceChannelIds(workspaceDir)).resolves.toEqual([GROUP_ID, "dm_never_spoke"].sort());
		} finally {
			await rm(workspaceDir, { recursive: true, force: true });
		}
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
		index = createChannelIndex({ workspaceDir, debounceMs: 10_000 });
	});

	afterEach(async () => {
		await index.close();
		await rm(workspaceDir, { recursive: true, force: true });
	});

	it("writes a first sighting immediately, without waiting for the debounce", async () => {
		index.note({ channelId: GROUP_ID, name: "投资理财", at: Date.parse("2026-07-30T06:22:13Z") });
		await index.flush();

		expect(await rows()).toMatchObject([{ channelId: GROUP_ID, name: "投资理财" }]);
	});
});
