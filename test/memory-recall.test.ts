import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { buildMemoryCandidates, createMemoryCandidateStore } from "../src/memory/candidates.js";
import { tokenizeRecallText } from "../src/memory/recall.js";
import { useTempDirs } from "./helpers/fixtures.js";

const makeWorkspace = useTempDirs("pipiclaw-recall-");

function createTempWorkspace(): { workspaceDir: string; channelDir: string } {
	const workspaceDir = makeWorkspace();
	const channelDir = join(workspaceDir, "dm_123");
	mkdirSync(channelDir, { recursive: true });
	return { workspaceDir, channelDir };
}

describe("memory candidates", () => {
	it("builds candidates from workspace, session, memory, and history files", async () => {
		const { workspaceDir, channelDir } = createTempWorkspace();
		writeFileSync(
			join(workspaceDir, "MEMORY.md"),
			"# Workspace Memory\n\n## Shared Context\n\n- Use pnpm for installs.\n",
			"utf-8",
		);
		writeFileSync(
			join(channelDir, "SESSION.md"),
			"# Session Title\n\nFix login regression\n\n# Current State\n\n- Investigating oauth callback failure.\n",
			{ encoding: "utf-8", flag: "w" },
		);
		writeFileSync(
			join(channelDir, "MEMORY.md"),
			"# Channel Memory\n\n## Constraints\n\n- Production must stay online.\n",
			"utf-8",
		);
		writeFileSync(
			join(channelDir, "HISTORY.md"),
			"# Channel History\n\n## 2026-04-01T00:00:00.000Z\n\nShipped initial auth flow.\n",
			"utf-8",
		);

		const candidates = await buildMemoryCandidates({ workspaceDir, channelDir });
		expect(candidates.map((candidate) => candidate.source)).toEqual(
			expect.arrayContaining(["workspace-memory", "channel-session", "channel-memory", "channel-history"]),
		);
		expect(candidates.some((candidate) => candidate.title === "Current State")).toBe(true);
	});

	it("reuses unchanged candidates and refreshes files whose fingerprints change", async () => {
		const { workspaceDir, channelDir } = createTempWorkspace();
		const store = createMemoryCandidateStore();
		writeFileSync(
			join(workspaceDir, "MEMORY.md"),
			"# Workspace Memory\n\n## Shared Context\n\n- First value.\n",
			"utf-8",
		);

		const initial = await buildMemoryCandidates({ workspaceDir, channelDir }, store);
		const repeated = await buildMemoryCandidates({ workspaceDir, channelDir }, store);
		writeFileSync(
			join(workspaceDir, "MEMORY.md"),
			"# Workspace Memory\n\n## Shared Context\n\n- Second value.\n",
			"utf-8",
		);
		const refreshed = await buildMemoryCandidates({ workspaceDir, channelDir }, store);

		expect(repeated).toEqual(initial);
		expect(refreshed.some((candidate) => candidate.content.includes("Second value."))).toBe(true);
		expect(refreshed.some((candidate) => candidate.content.includes("First value."))).toBe(false);
	});

	it("parses the timestamp from channel-memory Update blocks", async () => {
		const { workspaceDir, channelDir } = createTempWorkspace();
		writeFileSync(
			join(channelDir, "MEMORY.md"),
			[
				"# Channel Memory",
				"",
				"## Update 2026-07-01T00:00:00.000Z",
				"- Older durable note.",
				"",
				"## Update 2026-07-03T00:00:00.000Z",
				"- Newer durable note.",
			].join("\n"),
			"utf-8",
		);

		const candidates = await buildMemoryCandidates({ workspaceDir, channelDir });
		const updates = candidates.filter((candidate) => candidate.source === "channel-memory");
		expect(updates).toHaveLength(2);
		expect(updates.map((candidate) => candidate.timestamp)).toEqual(
			expect.arrayContaining(["2026-07-01T00:00:00.000Z", "2026-07-03T00:00:00.000Z"]),
		);
		expect(new Set(updates.map((candidate) => candidate.id)).size).toBe(2);
	});

	it("refreshes only the files whose fingerprints changed", async () => {
		const { workspaceDir, channelDir } = createTempWorkspace();
		const store = createMemoryCandidateStore();
		writeFileSync(
			join(workspaceDir, "MEMORY.md"),
			"# Workspace Memory\n\n## Shared Context\n\n- Shared install policy.\n",
			"utf-8",
		);
		writeFileSync(
			join(channelDir, "SESSION.md"),
			"# Session Title\n\nCurrent task\n\n# Current State\n\n- First state.\n",
			"utf-8",
		);

		const initial = await buildMemoryCandidates({ workspaceDir, channelDir }, store);
		writeFileSync(
			join(channelDir, "SESSION.md"),
			"# Session Title\n\nCurrent task\n\n# Current State\n\n- Updated state.\n",
			"utf-8",
		);

		const updated = await buildMemoryCandidates({ workspaceDir, channelDir }, store);
		expect(updated.some((candidate) => candidate.content.includes("Updated state."))).toBe(true);
		expect(updated.some((candidate) => candidate.content.includes("Shared install policy."))).toBe(true);
		expect(initial.some((candidate) => candidate.content.includes("First state."))).toBe(true);
	});

	it("limits large history files to folded blocks plus recent entries", async () => {
		const { workspaceDir, channelDir } = createTempWorkspace();
		const history = [
			"# Channel History",
			"",
			"## Folded History Through 2026-04-05T00:00:00.000Z",
			"",
			"- Older auth milestones.",
			"",
			...Array.from({ length: 12 }, (_, index) =>
				[
					`## 2026-04-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
					"",
					`History block ${index + 1}`,
					"",
				].join("\n"),
			),
		].join("\n");
		writeFileSync(join(channelDir, "HISTORY.md"), history, "utf-8");

		const candidates = await buildMemoryCandidates({ workspaceDir, channelDir }, createMemoryCandidateStore());
		const historyCandidates = candidates.filter((candidate) => candidate.source === "channel-history");

		expect(historyCandidates.some((candidate) => candidate.title.startsWith("Folded History Through"))).toBe(true);
		expect(historyCandidates.some((candidate) => candidate.content.includes("History block 12"))).toBe(true);
		expect(historyCandidates.some((candidate) => candidate.content === "History block 1")).toBe(false);
		expect(historyCandidates.length).toBeLessThanOrEqual(9);
	});
});

describe("memory recall", () => {
	it("captures overlapping Chinese dictionary terms without keeping covered bigram noise", () => {
		const tokens = tokenizeRecallText("当前状态管理优化方案");

		expect(tokens).toEqual(expect.arrayContaining(["当前状态", "状态管理", "管理", "优化方案"]));
		expect(tokens).not.toEqual(expect.arrayContaining(["前状", "态管", "理优", "化方"]));
	});

	it("keeps meaningful uncovered single Chinese characters while filtering stop chars", () => {
		const tokens = tokenizeRecallText("库表锁了");

		expect(tokens).toEqual(expect.arrayContaining(["库表", "表锁", "库", "表", "锁"]));
		expect(tokens).not.toContain("了");
	});
});
