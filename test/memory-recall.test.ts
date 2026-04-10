import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMemoryCandidates, createMemoryCandidateStore } from "../src/memory/candidates.js";
import { recallRelevantMemory, tokenizeRecallText } from "../src/memory/recall.js";

const tempDirs: string[] = [];

function createTempWorkspace(): { workspaceDir: string; channelDir: string } {
	const workspaceDir = mkdtempSync(join(tmpdir(), "pipiclaw-recall-"));
	const channelDir = join(workspaceDir, "dm_123");
	mkdirSync(channelDir, { recursive: true });
	tempDirs.push(workspaceDir);
	return { workspaceDir, channelDir };
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

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

	it("prioritizes current session state for current-work queries", async () => {
		const { workspaceDir, channelDir } = createTempWorkspace();
		writeFileSync(
			join(workspaceDir, "MEMORY.md"),
			"# Workspace Memory\n\n## Shared Context\n\n- Default package manager is pnpm.\n",
			"utf-8",
		);
		writeFileSync(
			join(channelDir, "SESSION.md"),
			[
				"# Session Title",
				"",
				"Fix login regression",
				"",
				"# Current State",
				"",
				"- Investigating oauth callback failure in src/auth.ts.",
				"",
				"# Next Steps",
				"",
				"- Reproduce the bug and inspect callback state handling.",
			].join("\n"),
			"utf-8",
		);
		writeFileSync(
			join(channelDir, "MEMORY.md"),
			"# Channel Memory\n\n## Constraints\n\n- Avoid changing token storage format.\n",
			"utf-8",
		);
		writeFileSync(
			join(channelDir, "HISTORY.md"),
			"# Channel History\n\n## 2026-03-01T00:00:00.000Z\n\nOld deployment note.\n",
			"utf-8",
		);

		const result = await recallRelevantMemory({
			query: "What are we doing now on the login bug and what should I do next?",
			workspaceDir,
			channelDir,
			maxCandidates: 8,
			maxInjected: 2,
			maxChars: 2000,
			rerankWithModel: false,
			model: { provider: "test", id: "noop" } as never,
			resolveApiKey: async () => "",
		});

		expect(result.items).toHaveLength(2);
		expect(result.items[0]?.source).toBe("channel-session");
		expect(result.renderedText).toContain("<runtime_context>");
		expect(result.renderedText).toContain("Current State");
		expect(result.renderedText).toContain("Next Steps");
	});

	it("keeps high-priority session context available for Chinese queries", async () => {
		const { workspaceDir, channelDir } = createTempWorkspace();
		writeFileSync(
			join(workspaceDir, "MEMORY.md"),
			"# Workspace Memory\n\n## Shared Context\n\n- 使用 pnpm。\n",
			"utf-8",
		);
		writeFileSync(
			join(channelDir, "SESSION.md"),
			[
				"# Session Title",
				"",
				"修复登录异常",
				"",
				"# Current State",
				"",
				"- 正在排查认证回调异常。",
				"",
				"# Next Steps",
				"",
				"- 先复现问题，再检查回调状态。",
			].join("\n"),
			"utf-8",
		);
		writeFileSync(
			join(channelDir, "MEMORY.md"),
			"# Channel Memory\n\n## Constraints\n\n- 不要变更 token 存储。\n",
			"utf-8",
		);
		writeFileSync(
			join(channelDir, "HISTORY.md"),
			"# Channel History\n\n## 2026-03-01T00:00:00.000Z\n\n旧发布记录。\n",
			"utf-8",
		);

		const result = await recallRelevantMemory({
			query: "现在登录失败了，下一步该查什么？",
			workspaceDir,
			channelDir,
			maxCandidates: 8,
			maxInjected: 2,
			maxChars: 2000,
			rerankWithModel: false,
			autoRerank: false,
			model: { provider: "test", id: "noop" } as never,
			resolveApiKey: async () => "",
		});

		expect(result.items).toHaveLength(2);
		expect(result.items.every((item) => item.source === "channel-session" || item.source === "channel-memory")).toBe(
			true,
		);
		expect(result.renderedText).toContain("认证回调异常");
		expect(result.renderedText).toContain("先复现问题");
	});
});
