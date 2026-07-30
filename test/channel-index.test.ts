import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CHANNELS_INDEX_FILENAME,
	type ChannelIndex,
	createChannelIndex,
	discoverWorkspaceChannelIds,
	parseChannelIndex,
	renderChannelIndex,
} from "../src/runtime/channel-index.js";
import { getChannelDirName } from "../src/runtime/channel-paths.js";

/** A real DingTalk group id: base64, so it contains characters no id pattern would allow. */
const GROUP_ID = "group_cidYDhGqxhJOzS7VDv/eDInUw==";
const DM_ID = "dm_0123456789";

describe("channel index rendering", () => {
	it("round-trips entries through render and parse", () => {
		const entries = [
			{ channelId: GROUP_ID, name: "投资理财", lastMessageAt: "2026-07-30T14:22:13+08:00", topic: "长期定投" },
			{ channelId: DM_ID, name: "张三", lastMessageAt: "", topic: "" },
		];
		expect(parseChannelIndex(renderChannelIndex(entries))).toEqual(entries);
	});

	it("survives pipes and newlines in a name or topic", () => {
		const entries = [{ channelId: GROUP_ID, name: "A | B", lastMessageAt: "", topic: "line one\nline two | tail" }];
		const parsed = parseChannelIndex(renderChannelIndex(entries));
		expect(parsed).toEqual([
			{ channelId: GROUP_ID, name: "A | B", lastMessageAt: "", topic: "line one line two | tail" },
		]);
	});

	it("ignores the header, the separator, and prose around the table", () => {
		expect(parseChannelIndex(renderChannelIndex([]))).toEqual([]);
		expect(parseChannelIndex("# Channels\n\nsome prose\n")).toEqual([]);
	});
});

describe("workspace channel discovery", () => {
	let workspaceDir: string;

	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), "pipiclaw-channel-discovery-"));
	});

	afterEach(async () => {
		await rm(workspaceDir, { recursive: true, force: true });
	});

	it("returns nothing for a workspace that does not exist", async () => {
		await expect(discoverWorkspaceChannelIds(join(workspaceDir, "missing"))).resolves.toEqual([]);
	});

	it("falls back to scanning directories when there is no index yet", async () => {
		await mkdir(join(workspaceDir, "dm_quiet"), { recursive: true });
		await mkdir(join(workspaceDir, "skills"), { recursive: true });

		await expect(discoverWorkspaceChannelIds(workspaceDir)).resolves.toEqual(["dm_quiet"]);
	});

	it("recovers an id the directory scan alone cannot spell", async () => {
		// The directory is the escaped form, so only the index carries the real id back.
		await mkdir(join(workspaceDir, getChannelDirName(GROUP_ID)), { recursive: true });
		await writeFile(
			join(workspaceDir, CHANNELS_INDEX_FILENAME),
			renderChannelIndex([{ channelId: GROUP_ID, name: "投资理财", lastMessageAt: "", topic: "" }]),
			"utf-8",
		);

		await expect(discoverWorkspaceChannelIds(workspaceDir)).resolves.toEqual([GROUP_ID]);
	});

	it("keeps scanning directories once the index exists but is still filling in", async () => {
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
	});

	it("ignores an index row that is not a usable channel id", async () => {
		await writeFile(
			join(workspaceDir, CHANNELS_INDEX_FILENAME),
			renderChannelIndex([
				{ channelId: "group_../../escape", name: "bad", lastMessageAt: "", topic: "" },
				{ channelId: "notachannel", name: "bad", lastMessageAt: "", topic: "" },
			]),
			"utf-8",
		);

		await expect(discoverWorkspaceChannelIds(workspaceDir)).resolves.toEqual([]);
	});
});

describe("channel index maintenance", () => {
	let workspaceDir: string;
	let indexPath: string;
	let index: ChannelIndex;

	const readIndex = async (): Promise<string> => readFile(indexPath, "utf-8");
	const rows = async () => parseChannelIndex(await readIndex());

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

	it("writes a rename immediately but holds a timestamp-only change for the debounce", async () => {
		index.note({ channelId: GROUP_ID, name: "投资理财", at: 1_000 });
		await index.flush();
		const afterFirst = await readIndex();

		// Same name, later message: nothing structural changed, so the file must not move yet.
		index.note({ channelId: GROUP_ID, name: "投资理财", at: 2_000 });
		expect(await readIndex()).toBe(afterFirst);

		index.note({ channelId: GROUP_ID, name: "投资理财群", at: 3_000 });
		await index.flush();
		expect(await rows()).toMatchObject([{ name: "投资理财群" }]);
	});

	it("preserves a hand-written topic and rows it never observed", async () => {
		await writeFile(
			indexPath,
			renderChannelIndex([
				{
					channelId: GROUP_ID,
					name: "投资理财",
					lastMessageAt: "2026-07-01T09:00:00+08:00",
					topic: "长期定投与仓位",
				},
				{
					channelId: "group_retired",
					name: "已解散的群",
					lastMessageAt: "2026-06-01T09:00:00+08:00",
					topic: "旧项目",
				},
			]),
			"utf-8",
		);

		index.note({ channelId: GROUP_ID, name: "投资理财", at: Date.now() });
		await index.flush();

		const parsed = await rows();
		expect(parsed.find((row) => row.channelId === GROUP_ID)?.topic).toBe("长期定投与仓位");
		expect(parsed.find((row) => row.channelId === "group_retired")).toMatchObject({
			name: "已解散的群",
			topic: "旧项目",
		});
	});

	it("never moves the recorded time backwards", async () => {
		index.note({ channelId: GROUP_ID, name: "投资理财", at: Date.parse("2026-07-30T06:00:00Z") });
		await index.flush();
		const latest = (await rows())[0].lastMessageAt;

		index.note({ channelId: GROUP_ID, name: "投资理财", at: Date.parse("2026-07-01T06:00:00Z") });
		await index.flush();
		expect((await rows())[0].lastMessageAt).toBe(latest);
	});

	it("keeps an existing name when a later observation carries none", async () => {
		index.note({ channelId: DM_ID, name: "张三", at: 1_000 });
		await index.flush();

		index.note({ channelId: DM_ID, at: 2_000 });
		await index.flush();
		expect(await rows()).toMatchObject([{ channelId: DM_ID, name: "张三" }]);
	});

	it("sorts the most recently active channel first", async () => {
		index.note({ channelId: DM_ID, name: "张三", at: Date.parse("2026-07-01T06:00:00Z") });
		index.note({ channelId: GROUP_ID, name: "投资理财", at: Date.parse("2026-07-30T06:00:00Z") });
		await index.flush();

		expect((await rows()).map((row) => row.channelId)).toEqual([GROUP_ID, DM_ID]);
	});

	it("flushes pending timestamp changes on close", async () => {
		index.note({ channelId: GROUP_ID, name: "投资理财", at: 1_000 });
		await index.flush();

		index.note({ channelId: GROUP_ID, name: "投资理财", at: Date.parse("2026-07-30T06:00:00Z") });
		await index.close();

		expect((await rows())[0].lastMessageAt).not.toBe("");
		expect(parseChannelIndex(await readIndex())[0].lastMessageAt).toContain("2026-07-30");
	});

	it("is a no-op when nothing changed", async () => {
		index.note({ channelId: GROUP_ID, name: "投资理财", at: 1_000 });
		await index.flush();
		// The atomic write renames a temp file into place, so a rewrite always changes the inode
		// — a stronger signal than comparing content, which would look identical either way.
		const before = (await stat(indexPath)).ino;

		await index.flush();
		expect((await stat(indexPath)).ino).toBe(before);
	});
});
