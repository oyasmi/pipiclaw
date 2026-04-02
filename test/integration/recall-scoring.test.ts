import { rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/sidecar-worker.js", () => ({
	runSidecarTask: vi.fn(),
}));

import { recallRelevantMemory } from "../../src/memory/recall.js";
import { runSidecarTask } from "../../src/sidecar-worker.js";
import { createTempWorkspace, setupChannelFiles } from "../helpers/fixtures.js";

const tempDirs: string[] = [];
const TEST_MODEL = { provider: "test", id: "noop" } as never;

function createWorkspace() {
	const workspaceDir = createTempWorkspace("pipiclaw-recall-scoring-");
	const channelDir = join(workspaceDir, "dm_123");
	tempDirs.push(workspaceDir);
	return { workspaceDir, channelDir };
}

afterEach(() => {
	vi.clearAllMocks();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("recall scoring integration", () => {
	it("prioritizes session state over durable memory when the same query matches both", async () => {
		const { workspaceDir, channelDir } = createWorkspace();
		writeFileSync(
			join(workspaceDir, "MEMORY.md"),
			"# Workspace Memory\n\n## Shared Context\n\n- Use pnpm.\n",
			"utf-8",
		);
		setupChannelFiles(channelDir, {
			session: [
				"# Session Title",
				"",
				"Fix login regression",
				"",
				"# Current State",
				"",
				"- Investigating oauth callback validation in src/auth.ts.",
				"",
				"# Next Steps",
				"",
				"- Patch callback verification after reproducing the bug.",
			].join("\n"),
			memory:
				"# Channel Memory\n\n## Constraints\n\n- OAuth callback verification must remain backwards-compatible.\n",
			history: "# Channel History\n\n## 2026-04-01T00:00:00.000Z\n\nShipped the earlier auth flow.\n",
		});

		const result = await recallRelevantMemory({
			query: "What is the current oauth callback work?",
			workspaceDir,
			channelDir,
			maxCandidates: 8,
			maxInjected: 2,
			maxChars: 2000,
			rerankWithModel: false,
			model: TEST_MODEL,
			resolveApiKey: async () => "",
		});

		expect(result.items).toHaveLength(2);
		expect(result.items[0]?.source).toBe("channel-session");
		expect(result.renderedText).toContain("Current State");
	});

	it("respects maxInjected when multiple candidates match the query", async () => {
		const { workspaceDir, channelDir } = createWorkspace();
		setupChannelFiles(channelDir, {
			session: [
				"# Session Title",
				"",
				"Fix login regression",
				"",
				"# Current State",
				"",
				"- Investigating oauth callback validation.",
				"",
				"# Next Steps",
				"",
				"- Patch callback verification.",
				"",
				"# Errors & Corrections",
				"",
				"- Retry loop masked the real callback error.",
			].join("\n"),
			memory: "# Channel Memory\n\n## Constraints\n\n- Keep callback verification backwards-compatible.\n",
		});

		const result = await recallRelevantMemory({
			query: "callback verification error",
			workspaceDir,
			channelDir,
			maxCandidates: 8,
			maxInjected: 1,
			maxChars: 2000,
			rerankWithModel: false,
			model: TEST_MODEL,
			resolveApiKey: async () => "",
		});

		expect(result.items).toHaveLength(1);
		expect(result.renderedText.match(/\[.*?\/.*?\]/g)?.length ?? 0).toBe(1);
	});

	it("uses model rerank when enabled and honors the selected candidate ids", async () => {
		const { workspaceDir, channelDir } = createWorkspace();
		setupChannelFiles(channelDir, {
			session: [
				"# Session Title",
				"",
				"Fix login regression",
				"",
				"# Current State",
				"",
				"- Investigating oauth callback validation.",
				"",
				"# Next Steps",
				"",
				"- Patch callback verification.",
			].join("\n"),
			memory: "# Channel Memory\n\n## Constraints\n\n- Callback verification must stay backwards-compatible.\n",
		});
		vi.mocked(runSidecarTask).mockResolvedValue({
			rawText: '{"selectedIds":["channel-memory:constraints:"]}',
			output: ["channel-memory:constraints:"],
		});

		const result = await recallRelevantMemory({
			query: "callback verification",
			workspaceDir,
			channelDir,
			maxCandidates: 8,
			maxInjected: 1,
			maxChars: 2000,
			rerankWithModel: true,
			model: TEST_MODEL,
			resolveApiKey: async () => "",
		});

		expect(runSidecarTask).toHaveBeenCalledTimes(1);
		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.source).toBe("channel-memory");
		expect(result.items[0]?.title).toBe("Constraints");
	});

	it("falls back to lexical scoring when rerank fails", async () => {
		const { workspaceDir, channelDir } = createWorkspace();
		setupChannelFiles(channelDir, {
			session: [
				"# Session Title",
				"",
				"Fix login regression",
				"",
				"# Current State",
				"",
				"- Investigating oauth callback validation.",
				"",
				"# Next Steps",
				"",
				"- Patch callback verification.",
			].join("\n"),
			memory: "# Channel Memory\n\n## Constraints\n\n- Callback verification must stay backwards-compatible.\n",
		});
		vi.mocked(runSidecarTask).mockRejectedValue(new Error("rerank timeout"));

		const result = await recallRelevantMemory({
			query: "callback verification",
			workspaceDir,
			channelDir,
			maxCandidates: 8,
			maxInjected: 1,
			maxChars: 2000,
			rerankWithModel: true,
			model: TEST_MODEL,
			resolveApiKey: async () => "",
		});

		expect(runSidecarTask).toHaveBeenCalledTimes(1);
		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.source).toBe("channel-session");
	});

	it("prefers highly relevant history over unrelated session state", async () => {
		const { workspaceDir, channelDir } = createWorkspace();
		setupChannelFiles(channelDir, {
			session: [
				"# Session Title",
				"",
				"Triage metrics dashboard",
				"",
				"# Current State",
				"",
				"- Reviewing dashboard rendering latency.",
				"",
				"# Next Steps",
				"",
				"- Compare the latest latency snapshots.",
			].join("\n"),
			memory: "# Channel Memory\n\n## Constraints\n\n- Keep dashboard charts stable.\n",
			history: [
				"# Channel History",
				"",
				"## 2026-04-01T00:00:00.000Z",
				"",
				"- Fixed the oauth callback regression by tightening callback verification.",
			].join("\n"),
		});

		const result = await recallRelevantMemory({
			query: "What happened in the earlier oauth callback regression fix?",
			workspaceDir,
			channelDir,
			maxCandidates: 8,
			maxInjected: 1,
			maxChars: 2000,
			rerankWithModel: false,
			model: TEST_MODEL,
			resolveApiKey: async () => "",
		});

		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.source).toBe("channel-history");
		expect(result.items[0]?.content).toContain("oauth callback regression");
	});

	it("uses section intent plus session title context for Chinese next-step queries", async () => {
		const { workspaceDir, channelDir } = createWorkspace();
		setupChannelFiles(channelDir, {
			session: [
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
			memory: "# Channel Memory\n\n## Constraints\n\n- 不要变更 token 存储。\n",
			history: "# Channel History\n",
		});

		const result = await recallRelevantMemory({
			query: "登录失败了，下一步该查什么？",
			workspaceDir,
			channelDir,
			maxCandidates: 8,
			maxInjected: 2,
			maxChars: 2000,
			rerankWithModel: false,
			autoRerank: false,
			model: TEST_MODEL,
			resolveApiKey: async () => "",
		});

		expect(result.items.some((item) => item.title === "Next Steps")).toBe(true);
		expect(result.renderedText).toContain("先复现问题");
	});

	it("does not seed history candidates from intent alone when there is zero lexical overlap", async () => {
		const { workspaceDir, channelDir } = createWorkspace();
		setupChannelFiles(channelDir, {
			session: [
				"# Session Title",
				"",
				"Fix login regression",
				"",
				"# Current State",
				"",
				"- Investigating oauth callback validation.",
			].join("\n"),
			memory: "# Channel Memory\n\n## Constraints\n\n- Keep callback verification backwards-compatible.\n",
			history: [
				"# Channel History",
				"",
				"## 2026-04-01T00:00:00.000Z",
				"",
				"- Patched background job retries in an unrelated worker.",
			].join("\n"),
		});

		const result = await recallRelevantMemory({
			query: "what happened earlier?",
			workspaceDir,
			channelDir,
			maxCandidates: 8,
			maxInjected: 2,
			maxChars: 2000,
			rerankWithModel: false,
			model: TEST_MODEL,
			resolveApiKey: async () => "",
		});

		expect(result.items.some((item) => item.source === "channel-history")).toBe(false);
	});
});
