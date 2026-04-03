import { readFileSync, rmSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/memory/sidecar-worker.js", () => ({
	runSidecarTask: vi.fn(),
	SidecarParseError: class SidecarParseError extends Error {
		readonly taskName: string;
		readonly rawText: string;

		constructor(taskName: string, rawText: string, cause: unknown) {
			super(`Sidecar task "${taskName}" returned invalid output`);
			this.name = "SidecarParseError";
			this.taskName = taskName;
			this.rawText = rawText;
			this.cause = cause;
		}
	},
}));

import { runBackgroundMaintenance, runInlineConsolidation } from "../../src/memory/consolidation.js";
import { runSidecarTask } from "../../src/memory/sidecar-worker.js";
import { createTempWorkspace, setupChannelFiles } from "../helpers/fixtures.js";

const tempDirs: string[] = [];

const TEST_MODEL = { provider: "test", id: "noop" } as never;

function createChannelDir(): string {
	const workspaceDir = createTempWorkspace("pipiclaw-memory-consolidation-");
	const channelDir = join(workspaceDir, "dm_123");
	tempDirs.push(workspaceDir);
	return channelDir;
}

function createUserMessage(content: string) {
	return { role: "user", content } as never;
}

function createAssistantMessage(text: string) {
	return { role: "assistant", content: [{ type: "text", text }] } as never;
}

afterEach(() => {
	vi.clearAllMocks();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("memory-consolidation integration", () => {
	it("skips inline consolidation when there are not enough meaningful messages", async () => {
		const channelDir = createChannelDir();
		setupChannelFiles(channelDir);

		const result = await runInlineConsolidation({
			channelDir,
			model: TEST_MODEL,
			resolveApiKey: async () => "",
			messages: [createUserMessage("ping")],
		});

		expect(result).toEqual({
			skipped: true,
			appendedMemoryEntries: 0,
			appendedHistoryBlock: false,
		});
		expect(runSidecarTask).not.toHaveBeenCalled();
	});

	it("appends durable memory entries and a history block to the real channel files", async () => {
		const channelDir = createChannelDir();
		setupChannelFiles(channelDir, {
			memory: "# Channel Memory\n\n## Constraints\n\n- Keep the schema stable.\n",
			session: "# Session Title\n\nFix login regression\n",
			history: "# Channel History\n",
		});
		vi.mocked(runSidecarTask).mockResolvedValue({
			rawText:
				'{"memoryEntries":["OAuth callback fails in prod"],"historyBlock":"- Investigated callback state handling."}',
			output:
				'{"memoryEntries":["OAuth callback fails in prod"],"historyBlock":"- Investigated callback state handling."}',
		});

		const result = await runInlineConsolidation({
			channelDir,
			model: TEST_MODEL,
			resolveApiKey: async () => "",
			messages: [
				createUserMessage("Please fix the login callback regression."),
				createAssistantMessage("I am tracing the callback state flow in src/auth.ts."),
			],
		});

		expect(result.skipped).toBe(false);
		expect(result.appendedMemoryEntries).toBe(1);
		expect(result.appendedHistoryBlock).toBe(true);

		const memory = readFileSync(join(channelDir, "MEMORY.md"), "utf-8");
		const history = readFileSync(join(channelDir, "HISTORY.md"), "utf-8");
		expect(memory).toContain("## Update ");
		expect(memory).toContain("OAuth callback fails in prod");
		expect(history).toContain("## ");
		expect(history).toContain("Investigated callback state handling.");
	});

	it("uses the latest compaction boundary when session entries are provided", async () => {
		const channelDir = createChannelDir();
		setupChannelFiles(channelDir);

		vi.mocked(runSidecarTask).mockImplementation(async (task) => {
			if (task.name === "memory-inline-consolidation") {
				expect(task.prompt).toContain("after boundary");
				expect(task.prompt).not.toContain("before boundary");
				return {
					rawText: '{"memoryEntries":["Recovered after compaction"],"historyBlock":""}',
					output: '{"memoryEntries":["Recovered after compaction"],"historyBlock":""}',
				};
			}
			throw new Error(`Unexpected sidecar task ${task.name}`);
		});

		await runInlineConsolidation({
			channelDir,
			model: TEST_MODEL,
			resolveApiKey: async () => "",
			messages: [],
			sessionEntries: [
				{
					type: "message",
					id: "msg-1",
					timestamp: "2026-04-01T00:00:00.000Z",
					message: createUserMessage("before boundary"),
				},
				{
					type: "compaction",
					id: "cmp-1",
					timestamp: "2026-04-01T00:05:00.000Z",
					parentId: "msg-1",
					summary: "trimmed",
					firstKeptEntryId: "msg-2",
					tokensBefore: 1234,
				},
				{
					type: "message",
					id: "msg-2",
					timestamp: "2026-04-01T00:06:00.000Z",
					message: createUserMessage("after boundary"),
				},
				{
					type: "message",
					id: "msg-3",
					timestamp: "2026-04-01T00:07:00.000Z",
					message: createAssistantMessage("Investigating the kept branch."),
				},
			] as never,
		});

		expect(runSidecarTask).toHaveBeenCalledTimes(1);
	});

	it("rewrites oversized memory and folds older history blocks during background maintenance", async () => {
		const channelDir = createChannelDir();
		const memory = [
			"# Channel Memory",
			"",
			...Array.from({ length: 6 }, (_, index) =>
				[`## Update 2026-04-0${index + 1}`, `- Fact ${index + 1}`, ""].join("\n"),
			),
		].join("\n");
		const history = [
			"# Channel History",
			"",
			...Array.from({ length: 9 }, (_, index) =>
				[
					`## 2026-04-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
					"",
					`History block ${index + 1}`,
					"",
				].join("\n"),
			),
		].join("\n");
		setupChannelFiles(channelDir, { memory, history, session: "# Session Title\n\nTask\n" });

		vi.mocked(runSidecarTask)
			.mockResolvedValueOnce({
				rawText: "## Decisions\n\n- Keep the callback contract stable.\n",
				output: "## Decisions\n\n- Keep the callback contract stable.\n",
			})
			.mockResolvedValueOnce({
				rawText: "- Folded blocks 1 through 5.",
				output: "- Folded blocks 1 through 5.",
			});

		const result = await runBackgroundMaintenance({
			channelDir,
			model: TEST_MODEL,
			resolveApiKey: async () => "",
			messages: [],
		});

		expect(result).toEqual({ cleanedMemory: true, foldedHistory: true });
		expect(readFileSync(join(channelDir, "MEMORY.md"), "utf-8")).toContain("Keep the callback contract stable.");

		const nextHistory = readFileSync(join(channelDir, "HISTORY.md"), "utf-8");
		expect(nextHistory).toContain("## Folded History Through 2026-04-06T00:00:00.000Z");
		expect(nextHistory).toContain("Folded blocks 1 through 5.");
		expect(nextHistory).toContain("History block 9");
		expect(nextHistory).not.toContain("History block 1");
	});
});
