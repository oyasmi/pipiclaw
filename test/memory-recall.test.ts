import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMemoryCandidates } from "../src/memory-candidates.js";
import { recallRelevantMemory } from "../src/memory-recall.js";

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
		writeFileSync(join(channelDir, "MEMORY.md"), "# Channel Memory\n\n## Constraints\n\n- Production must stay online.\n", "utf-8");
		writeFileSync(join(channelDir, "HISTORY.md"), "# Channel History\n\n## 2026-04-01T00:00:00.000Z\n\nShipped initial auth flow.\n", "utf-8");

		const candidates = await buildMemoryCandidates({ workspaceDir, channelDir });
		expect(candidates.map((candidate) => candidate.source)).toEqual(
			expect.arrayContaining(["workspace-memory", "channel-session", "channel-memory", "channel-history"]),
		);
		expect(candidates.some((candidate) => candidate.title === "Current State")).toBe(true);
	});
});

describe("memory recall", () => {
	it("prioritizes current session state for current-work queries", async () => {
		const { workspaceDir, channelDir } = createTempWorkspace();
		writeFileSync(join(workspaceDir, "MEMORY.md"), "# Workspace Memory\n\n## Shared Context\n\n- Default package manager is pnpm.\n", "utf-8");
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
		writeFileSync(join(channelDir, "MEMORY.md"), "# Channel Memory\n\n## Constraints\n\n- Avoid changing token storage format.\n", "utf-8");
		writeFileSync(join(channelDir, "HISTORY.md"), "# Channel History\n\n## 2026-03-01T00:00:00.000Z\n\nOld deployment note.\n", "utf-8");

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
});
