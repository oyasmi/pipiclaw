import { writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { buildMemoryCandidates, createMemoryCandidateStore } from "../src/memory/candidates.js";
import { parseChannelMemoryEntries } from "../src/memory/files.js";
import {
	getMemoryMetadataPath,
	readMemoryMetadata,
	recordMemoryRecall,
	syncMemoryMetadata,
} from "../src/memory/metadata.js";
import { findPreviousUserText, recallRelevantMemory, tokenizeRecallText } from "../src/memory/recall.js";
import { countPromptUnits } from "../src/shared/prompt-units.js";
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

	it("builds one traceable candidate per channel memory entry", async () => {
		const { workspaceDir, channelDir } = createTempWorkspace();
		writeFileSync(
			join(channelDir, "MEMORY.md"),
			[
				"# Channel Memory",
				"",
				"## Preferences",
				"",
				"- Prefer compact diffs. <!--id:m-compact01-->",
				"- Use Chinese for handoff notes. <!--id:m-chinese01-->",
			].join("\n"),
			"utf-8",
		);

		const candidates = (await buildMemoryCandidates({ workspaceDir, channelDir })).filter(
			(candidate) => candidate.source === "channel-memory",
		);

		expect(candidates).toHaveLength(2);
		expect(candidates.map((candidate) => candidate.id)).toEqual(["m-compact01", "m-chinese01"]);
		expect(candidates.map((candidate) => candidate.content)).toEqual([
			"Prefer compact diffs.",
			"Use Chinese for handoff notes.",
		]);
		expect(candidates.every((candidate) => candidate.entryId === candidate.id)).toBe(true);
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

describe("memory recall: contextQuery fallback for weak queries", () => {
	const seedThursdayGate = (channelDir: string) =>
		writeFileSync(
			join(channelDir, "MEMORY.md"),
			[
				"# Channel Memory",
				"",
				"## Decisions",
				"",
				"- 发布窗口固定在每周四晚上 22:00，代号叫 THURSDAY-GATE。 <!--id:m-thursday-->",
			].join("\n"),
			"utf-8",
		);

	it("borrows the previous user turn only when the current query cannot clear the evidence bar alone", async () => {
		const { workspaceDir, channelDir } = createTempWorkspace();
		seedThursdayGate(channelDir);

		const withoutContext = await recallRelevantMemory({
			query: "代号是什么来着？",
			workspaceDir,
			channelDir,
			maxCandidates: 8,
			maxInjected: 3,
			maxChars: 2_000,
			rerankWithModel: false,
			model: { provider: "test", id: "noop" } as never,
			resolveApiKey: async () => "",
		});
		expect(withoutContext.items.map((item) => item.id)).not.toContain("m-thursday");

		const withContext = await recallRelevantMemory({
			query: "代号是什么来着？",
			contextQuery: "我们发布现在固定在周四晚上，代号叫 THURSDAY-GATE。",
			workspaceDir,
			channelDir,
			maxCandidates: 8,
			maxInjected: 3,
			maxChars: 2_000,
			rerankWithModel: false,
			model: { provider: "test", id: "noop" } as never,
			resolveApiKey: async () => "",
		});
		expect(withContext.items.map((item) => item.id)).toContain("m-thursday");
	});

	it("has no effect when the current query already clears the evidence bar on its own", async () => {
		const { workspaceDir, channelDir } = createTempWorkspace();
		seedThursdayGate(channelDir);

		const request = {
			query: "发布窗口代号是什么？只回答代号本身。",
			workspaceDir,
			channelDir,
			maxCandidates: 8,
			maxInjected: 3,
			maxChars: 2_000,
			rerankWithModel: false as const,
			model: { provider: "test", id: "noop" } as never,
			resolveApiKey: async () => "",
		};
		const withoutContext = await recallRelevantMemory(request);
		const withContext = await recallRelevantMemory({ ...request, contextQuery: "完全不相关的上一轮消息内容。" });
		expect(withContext.items.map((item) => item.id)).toEqual(withoutContext.items.map((item) => item.id));
		expect(withContext.renderedText).toEqual(withoutContext.renderedText);
	});

	it("findPreviousUserText strips injected runtime-context wrappers so they can't leak into contextQuery", () => {
		// The wrapped runtime_context block names THURSDAY-GATE; if it survived unstripped, a
		// caller feeding this straight into recall's contextQuery would trivially "recall" the
		// injected block's own echo of the answer rather than anything from genuine expansion.
		const messages = [
			{
				role: "user",
				content:
					"<runtime_context>发布窗口 THURSDAY-GATE 已注入</runtime_context>\n<user_message>\n随便问问\n</user_message>",
			},
		] as never[];
		expect(findPreviousUserText(messages)).toBe("随便问问");
	});
});

describe("memory recall", () => {
	it("injects only the matching bullet from a large section and records its recall", async () => {
		const { workspaceDir, channelDir } = createTempWorkspace();
		const entries = Array.from({ length: 100 }, (_, index) =>
			index === 73
				? "- Release codename is moonstone. <!--id:m-moonstone-->"
				: `- Unrelated durable item number ${index}. <!--id:m-item${index}-->`,
		);
		const memoryText = ["# Channel Memory", "", "## Facts", "", ...entries].join("\n");
		writeFileSync(join(channelDir, "MEMORY.md"), memoryText);
		// Recall no longer reconciles metadata itself (that's a write-path responsibility); seed it
		// the way a real write path would so `recordMemoryRecall` has an active record to update.
		await syncMemoryMetadata(channelDir, parseChannelMemoryEntries(memoryText));

		const result = await recallRelevantMemory({
			query: "release codename moonstone",
			channelId: "dm_123",
			workspaceDir,
			channelDir,
			maxCandidates: 8,
			maxInjected: 3,
			maxChars: 2_000,
			rerankWithModel: false,
			model: { provider: "test", id: "noop" } as never,
			resolveApiKey: async () => "",
		});

		expect(result.items).toHaveLength(1);
		expect(result.items[0]).toMatchObject({ id: "m-moonstone", entryId: "m-moonstone" });
		expect(result.renderedText).toContain("Release codename is moonstone.");
		expect(result.renderedText).not.toContain("Unrelated durable item");
		expect((await readMemoryMetadata(channelDir)).entries["m-moonstone"]?.recallCount).toBe(1);
	});

	it("ranks a frequently-recalled entry above an equally-matched one that has never been recalled", async () => {
		const { workspaceDir, channelDir } = createTempWorkspace();
		const memoryText = [
			"# Channel Memory",
			"",
			"## Facts",
			"",
			"- Deploy pipeline notes alpha entry. <!--id:m-popular-->",
			"- Deploy pipeline notes beta entry. <!--id:m-quiet-->",
		].join("\n");
		writeFileSync(join(channelDir, "MEMORY.md"), memoryText);
		const entries = parseChannelMemoryEntries(memoryText);
		await syncMemoryMetadata(channelDir, entries);
		// Simulate ten distinct past recalls for m-popular; m-quiet stays untouched.
		for (let index = 0; index < 10; index++) {
			await recordMemoryRecall(channelDir, ["m-popular"], `distinct query phrasing number ${index}`);
		}

		const result = await recallRelevantMemory({
			query: "deploy pipeline notes",
			workspaceDir,
			channelDir,
			maxCandidates: 8,
			maxInjected: 2,
			maxChars: 2_000,
			rerankWithModel: false,
			model: { provider: "test", id: "noop" } as never,
			resolveApiKey: async () => "",
		});

		expect(result.items.map((item) => item.id)).toEqual(["m-popular", "m-quiet"]);
	});

	it("does not penalize a stale user-saved entry the way it penalizes a stale agent-learned one", async () => {
		const { workspaceDir, channelDir } = createTempWorkspace();
		const memoryText = [
			"# Channel Memory",
			"",
			"## Facts",
			"",
			"- Onboarding checklist alpha entry. <!--id:m-userstale-->",
			"- Onboarding checklist beta entry. <!--id:m-agentstale-->",
		].join("\n");
		writeFileSync(join(channelDir, "MEMORY.md"), memoryText);
		const entries = parseChannelMemoryEntries(memoryText);
		await syncMemoryMetadata(
			channelDir,
			entries,
			entries.map((entry) => ({
				id: entry.id,
				metadata: { sourceType: entry.id === "m-userstale" ? "user" : "agent" },
			})),
		);
		const staleTimestamp = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
		const metadata = await readMemoryMetadata(channelDir);
		for (const id of ["m-userstale", "m-agentstale"]) {
			metadata.entries[id] = { ...metadata.entries[id], lastRecalledAt: staleTimestamp, createdAt: staleTimestamp };
		}
		await writeFile(getMemoryMetadataPath(channelDir), `${JSON.stringify(metadata, null, 2)}\n`);

		const result = await recallRelevantMemory({
			query: "onboarding checklist",
			workspaceDir,
			channelDir,
			maxCandidates: 8,
			maxInjected: 2,
			maxChars: 2_000,
			rerankWithModel: false,
			model: { provider: "test", id: "noop" } as never,
			resolveApiKey: async () => "",
		});

		// Equal lexical evidence; only the user-saved one should avoid the staleness penalty, so it
		// ranks first (or ties, never behind the agent-sourced one).
		expect(result.items[0]?.id).toBe("m-userstale");
	});

	it("clips recalled memory to the unit budget and points at the search tools", async () => {
		const { workspaceDir, channelDir } = createTempWorkspace();
		const entries = Array.from(
			{ length: 8 },
			(_, index) => `- Deploy runbook step ${index} for the moonstone release. <!--id:m-run${index}-->`,
		);
		writeFileSync(join(channelDir, "MEMORY.md"), ["# Channel Memory", "", "## Runbook", "", ...entries].join("\n"));

		const base = {
			query: "moonstone release runbook",
			channelId: "dm_u",
			workspaceDir,
			channelDir,
			maxCandidates: 12,
			maxInjected: 8,
			maxChars: 100_000,
			rerankWithModel: false as const,
			model: { provider: "test", id: "noop" } as never,
			resolveApiKey: async () => "",
		};

		const generous = await recallRelevantMemory({ ...base, maxUnits: 100_000 });
		const tight = await recallRelevantMemory({ ...base, maxUnits: 60 });

		const bodyCount = (text: string): number => (text.match(/Deploy runbook step/g) ?? []).length;
		expect(bodyCount(generous.renderedText)).toBeGreaterThan(1);
		expect(bodyCount(tight.renderedText)).toBeLessThan(bodyCount(generous.renderedText));
		expect(tight.renderedText).toContain("memory_manage search");
		// The tight render is a small fraction of the generous one, in units.
		expect(countPromptUnits(tight.renderedText)).toBeLessThan(countPromptUnits(generous.renderedText));
	});

	it("recalls a durable entry from a long detailed message as readily as a terse one", async () => {
		const { workspaceDir, channelDir } = createTempWorkspace();
		writeFileSync(
			join(channelDir, "MEMORY.md"),
			[
				"# Channel Memory",
				"",
				"## Preferences",
				"",
				"- 用户偏好使用 pnpm 作为包管理器，不要用 npm <!--id:m-pnpm01-->",
				"- 回复不要自动添加 emoji <!--id:m-emoji01-->",
			].join("\n"),
			"utf-8",
		);

		const recall = async (query: string) =>
			recallRelevantMemory({
				query,
				workspaceDir,
				channelDir,
				maxCandidates: 8,
				maxInjected: 3,
				maxChars: 2_000,
				rerankWithModel: false,
				model: { provider: "test", id: "noop" } as never,
				resolveApiKey: async () => "",
			});

		const terse = await recall("包管理器");
		// Scoring must not normalize by query length: this message names the same subject but
		// buries it in 100+ tokens of context, which used to drive coverage under the gate and
		// silently recall nothing at all.
		const verbose = await recall(
			"我现在想把项目的依赖重新安装一遍，因为 lockfile 有冲突，你先确认一下我们这边用的是哪个包管理器再动手，别装错了",
		);

		expect(terse.items.map((item) => item.id)).toContain("m-pnpm01");
		expect(verbose.items.map((item) => item.id)).toContain("m-pnpm01");
		// The unrelated preference stays out of both: wider recall must not mean recall-everything.
		expect(verbose.items.map((item) => item.id)).not.toContain("m-emoji01");
	});

	it("matches Chinese compounds that dictionary segmentation splits apart", async () => {
		const { workspaceDir, channelDir } = createTempWorkspace();
		writeFileSync(
			join(channelDir, "MEMORY.md"),
			[
				"# Channel Memory",
				"",
				"## Constraints",
				"",
				"- 灰度发布必须先过预发环境 <!--id:m-gray01-->",
				"- 数据库迁移脚本需要评审 <!--id:m-db01-->",
			].join("\n"),
			"utf-8",
		);

		const result = await recallRelevantMemory({
			query: "这次改动想直接上线，灰度发布的流程还需要走吗？",
			workspaceDir,
			channelDir,
			maxCandidates: 8,
			maxInjected: 2,
			maxChars: 2_000,
			rerankWithModel: false,
			model: { provider: "test", id: "noop" } as never,
			resolveApiKey: async () => "",
		});

		expect(result.items.map((item) => item.id)).toEqual(["m-gray01"]);
	});

	it.each([
		{
			label: "emits Chinese trigrams so compounds survive greedy dictionary segmentation",
			input: "包管理器",
			expected: ["包管理", "管理器"],
			notExpected: [],
		},
		{
			label: "captures overlapping Chinese dictionary terms without keeping covered bigram noise",
			input: "当前状态管理优化方案",
			expected: ["当前状态", "状态管理", "管理", "优化方案"],
			notExpected: ["前状", "态管", "理优", "化方"],
		},
		{
			label: "keeps meaningful uncovered single Chinese characters while filtering stop chars",
			input: "库表锁了",
			expected: ["库表", "表锁", "库", "表", "锁"],
			notExpected: ["了"],
		},
	])("$label", ({ input, expected, notExpected }) => {
		const tokens = tokenizeRecallText(input);

		expect(tokens).toEqual(expect.arrayContaining(expected));
		for (const token of notExpected) {
			expect(tokens).not.toContain(token);
		}
	});
});
