import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSessionCorpus } from "../src/memory/session-corpus.js";
import { searchChannelSessions } from "../src/memory/session-search.js";
import { createTempWorkspace } from "./helpers/fixtures.js";

const { runSidecarTaskMock } = vi.hoisted(() => ({
	runSidecarTaskMock: vi.fn(),
}));

vi.mock("../src/memory/sidecar-worker.js", () => ({
	runSidecarTask: runSidecarTaskMock,
}));

const tempDirs: string[] = [];
const TEST_MODEL = { provider: "test", id: "noop" } as never;

function createWorkspace(): string {
	const workspaceDir = createTempWorkspace("pipiclaw-session-search-");
	tempDirs.push(workspaceDir);
	return workspaceDir;
}

function writeJsonl(path: string, entries: unknown[]): void {
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf-8");
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

beforeEach(() => {
	runSidecarTaskMock.mockReset();
});

describe("session search", () => {
	it("builds a current-channel corpus from context, session jsonl, log, and rotated log", async () => {
		const workspaceDir = createWorkspace();
		const channelDir = join(workspaceDir, "dm_123");
		const siblingDir = join(workspaceDir, "dm_other");
		mkdirSync(channelDir, { recursive: true });
		mkdirSync(siblingDir, { recursive: true });

		writeJsonl(join(channelDir, "context.jsonl"), [
			{
				type: "message",
				timestamp: "2026-04-19T00:00:00.000Z",
				message: { role: "user", content: "context mentions sqlite migration" },
			},
		]);
		writeFileSync(join(channelDir, "session-1.jsonl"), "{bad json}\n", "utf-8");
		writeFileSync(
			join(channelDir, "session-2.jsonl"),
			`${JSON.stringify({
				type: "message",
				timestamp: "2026-04-19T00:01:00.000Z",
				message: { role: "assistant", content: [{ type: "text", text: "session mentions OAuth callback" }] },
			})}\n`,
			"utf-8",
		);
		writeJsonl(join(channelDir, "log.jsonl"), [
			{ date: "2026-04-19T00:02:00.000Z", userName: "Alice", text: "current log mentions rollout", isBot: false },
		]);
		writeJsonl(join(channelDir, "log.jsonl.1"), [
			{ date: "2026-04-18T00:02:00.000Z", text: "rotated log mentions archive", isBot: true },
		]);
		writeJsonl(join(siblingDir, "log.jsonl"), [
			{ date: "2026-04-19T00:02:00.000Z", text: "sibling secret should not appear", isBot: false },
		]);

		const docs = await buildSessionCorpus({ channelDir, maxFiles: 8 });

		expect(docs.map((doc) => doc.text).join("\n")).toContain("sqlite migration");
		expect(docs.map((doc) => doc.text).join("\n")).toContain("OAuth callback");
		expect(docs.map((doc) => doc.text).join("\n")).toContain("rollout");
		expect(docs.map((doc) => doc.text).join("\n")).toContain("archive");
		expect(docs.map((doc) => doc.text).join("\n")).not.toContain("sibling secret");
		expect(docs.filter((doc) => doc.path.endsWith("context.jsonl"))).toHaveLength(1);
	});

	it("searches Chinese and English terms with role filtering", async () => {
		const workspaceDir = createWorkspace();
		const channelDir = join(workspaceDir, "dm_123");
		mkdirSync(channelDir, { recursive: true });
		writeJsonl(join(channelDir, "log.jsonl"), [
			{ date: "2026-04-19T00:00:00.000Z", userName: "Alice", text: "需要优化记忆管理", isBot: false },
			{ date: "2026-04-19T00:01:00.000Z", text: "Assistant discussed session_search design", isBot: true },
		]);

		const chinese = await searchChannelSessions({
			channelDir,
			query: "记忆管理",
			roleFilter: ["user"],
			limit: 3,
			maxFiles: 6,
			maxChunks: 20,
			maxCharsPerChunk: 800,
			summarizeWithModel: false,
			timeoutMs: 1000,
			model: TEST_MODEL,
			resolveApiKey: async () => "",
		});
		const english = await searchChannelSessions({
			channelDir,
			query: "session_search",
			limit: 3,
			maxFiles: 6,
			maxChunks: 20,
			maxCharsPerChunk: 800,
			summarizeWithModel: false,
			timeoutMs: 1000,
			model: TEST_MODEL,
			resolveApiKey: async () => "",
		});

		expect(chinese.results).toHaveLength(1);
		expect(chinese.results[0]?.role).toBe("user");
		expect(english.results[0]?.summary).toContain("session_search");
	});

	it("returns recent entries when query is empty", async () => {
		const workspaceDir = createWorkspace();
		const channelDir = join(workspaceDir, "dm_123");
		mkdirSync(channelDir, { recursive: true });
		writeJsonl(join(channelDir, "log.jsonl"), [
			{ date: "2026-04-18T00:00:00.000Z", text: "older", isBot: false },
			{ date: "2026-04-19T00:00:00.000Z", text: "newer", isBot: false },
		]);

		const result = await searchChannelSessions({
			channelDir,
			query: "",
			limit: 1,
			maxFiles: 6,
			maxChunks: 20,
			maxCharsPerChunk: 800,
			summarizeWithModel: false,
			timeoutMs: 1000,
			model: TEST_MODEL,
			resolveApiKey: async () => "",
		});

		expect(result.results).toHaveLength(1);
		expect(result.results[0]?.summary).toContain("newer");
	});

	it("falls back to raw preview when model summarization fails", async () => {
		const workspaceDir = createWorkspace();
		const channelDir = join(workspaceDir, "dm_123");
		mkdirSync(channelDir, { recursive: true });
		const longText = `session_search fallback ${"detail ".repeat(220)}`;
		writeJsonl(join(channelDir, "log.jsonl"), [{ date: "2026-04-19T00:00:00.000Z", text: longText, isBot: false }]);
		runSidecarTaskMock.mockRejectedValueOnce(new Error("model unavailable"));

		const result = await searchChannelSessions({
			channelDir,
			query: "session_search fallback",
			limit: 1,
			maxFiles: 6,
			maxChunks: 20,
			maxCharsPerChunk: 1400,
			summarizeWithModel: true,
			timeoutMs: 1000,
			model: TEST_MODEL,
			resolveApiKey: async () => "",
		});

		expect(runSidecarTaskMock).toHaveBeenCalledTimes(1);
		expect(result.results[0]?.summary).toContain("session_search fallback");
	});
});
