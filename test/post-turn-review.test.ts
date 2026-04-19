import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPostTurnReviewResult, parsePostTurnReviewResult } from "../src/memory/post-turn-review.js";
import { createTempWorkspace, setupChannelFiles } from "./helpers/fixtures.js";

const tempDirs: string[] = [];
const TEST_MODEL = { provider: "test", id: "noop" } as never;

function createWorkspace(): { workspaceDir: string; channelDir: string } {
	const workspaceDir = createTempWorkspace("pipiclaw-post-turn-review-");
	const channelDir = join(workspaceDir, "dm_123");
	tempDirs.push(workspaceDir);
	setupChannelFiles(channelDir, {
		memory: "# Channel Memory\n",
		session: "# Session Title\n\nActive task\n",
		history: "# Channel History\n",
	});
	return { workspaceDir, channelDir };
}

function baseOptions(workspaceDir: string, channelDir: string) {
	return {
		channelId: "dm_123",
		channelDir,
		workspaceDir,
		workspacePath: "/workspace",
		messages: [],
		model: TEST_MODEL,
		resolveApiKey: async () => "",
		timeoutMs: 1000,
		autoWriteChannelMemory: true,
		autoWriteWorkspaceSkills: true,
		minMemoryAutoWriteConfidence: 0.85,
		minSkillAutoWriteConfidence: 0.9,
		loadedSkills: [],
	};
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("post-turn review", () => {
	it("normalizes parsed review JSON", () => {
		const review = parsePostTurnReviewResult({
			memoryCandidates: [
				{
					target: "channel-memory",
					content: "User prefers specs before implementation",
					confidence: 2,
					necessity: "high",
				},
				{ target: "bad", content: "ignore", confidence: 1 },
			],
			skillCandidates: [{ action: "create", name: "spec-workflow", confidence: 0.95, necessity: "high" }],
			discarded: [{ content: "temporary log", reason: "not durable" }],
		});

		expect(review.memoryCandidates).toHaveLength(1);
		expect(review.memoryCandidates[0]?.confidence).toBe(1);
		expect(review.skillCandidates).toHaveLength(1);
		expect(review.discarded).toHaveLength(1);
	});

	it("auto-appends high-confidence channel memory and logs the action", async () => {
		const { workspaceDir, channelDir } = createWorkspace();

		const result = await applyPostTurnReviewResult(baseOptions(workspaceDir, channelDir), {
			memoryCandidates: [
				{
					target: "channel-memory",
					content: "User prefers specs before implementation",
					confidence: 0.9,
					necessity: "high",
					reason: "stable preference",
				},
			],
			skillCandidates: [],
			discarded: [],
		});

		expect(result.actions).toHaveLength(1);
		expect(readFileSync(join(channelDir, "MEMORY.md"), "utf-8")).toContain(
			"User prefers specs before implementation",
		);
		expect(readFileSync(join(channelDir, "memory-review.jsonl"), "utf-8")).toContain("MEMORY.md");
	});

	it("keeps low-confidence memory as a suggestion", async () => {
		const { workspaceDir, channelDir } = createWorkspace();

		const result = await applyPostTurnReviewResult(baseOptions(workspaceDir, channelDir), {
			memoryCandidates: [
				{
					target: "channel-memory",
					content: "Maybe user likes verbose output",
					confidence: 0.4,
					necessity: "medium",
					reason: "uncertain",
				},
			],
			skillCandidates: [],
			discarded: [],
		});

		expect(result.actions).toHaveLength(0);
		expect(result.suggestions).toHaveLength(1);
		expect(readFileSync(join(channelDir, "MEMORY.md"), "utf-8")).not.toContain("verbose output");
		expect(readFileSync(join(channelDir, "memory-review.jsonl"), "utf-8")).toContain("suggestions");
	});

	it("creates high-confidence workspace skills and downgrades blocked skill writes to suggestions", async () => {
		const { workspaceDir, channelDir } = createWorkspace();
		const notices: string[] = [];

		const result = await applyPostTurnReviewResult(
			{
				...baseOptions(workspaceDir, channelDir),
				emitNotice: async (notice) => {
					notices.push(notice);
				},
			},
			{
				memoryCandidates: [],
				skillCandidates: [
					{
						action: "create",
						name: "spec-workflow",
						content: `---
name: spec-workflow
description: Draft implementation specs
---

# Spec Workflow

Review design decisions before coding.
`,
						confidence: 0.95,
						necessity: "high",
						reason: "reusable workflow",
					},
					{
						action: "create",
						name: "bad-skill",
						content: "missing frontmatter",
						confidence: 0.99,
						necessity: "high",
						reason: "blocked",
					},
				],
				discarded: [],
			},
		);

		expect(result.actions).toHaveLength(1);
		expect(result.suggestions).toHaveLength(1);
		expect(notices[0]).toContain("spec-workflow");
		expect(readFileSync(join(workspaceDir, "skills", "spec-workflow", "SKILL.md"), "utf-8")).toContain(
			"Review design decisions",
		);
		expect(readFileSync(join(channelDir, "memory-review.jsonl"), "utf-8")).toContain("bad-skill");
	});
});
