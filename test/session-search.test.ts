import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSearchIndexes } from "../src/memory/search-index-db.js";
import { searchDeskSessions } from "../src/memory/session-search.js";
import { createSessionSearchTool } from "../src/tools/session-search.js";
import { useTempDirs } from "./helpers/fixtures.js";
import { testModelRequests } from "./helpers/model-requests.js";

const { runSidecarTaskMock } = vi.hoisted(() => ({
	runSidecarTaskMock: vi.fn(),
}));

vi.mock("../src/memory/sidecar-worker.js", () => ({
	runSidecarTask: runSidecarTaskMock,
}));

const makeWorkspace = useTempDirs("pipiclaw-session-search-");
const TEST_MODEL = { provider: "test", id: "noop" } as never;

function createWorkspace(): string {
	const workspaceDir = makeWorkspace();
	return workspaceDir;
}

/** A conversation directory inside a desk (spec 058, D2), created on first use. */
function conv(deskDir: string, name = "dm-1"): string {
	const dir = join(deskDir, "conversations", name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeJsonl(path: string, entries: unknown[]): void {
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf-8");
}

afterEach(closeSearchIndexes);

function searchRequest(appHomeDir: string, deskDir: string, query: string) {
	return {
		appHomeDir,
		deskDir,
		query,
		limit: 5,
		maxCharsPerChunk: 800,
		summarizeWithModel: false,
		timeoutMs: 1000,
		model: TEST_MODEL,
		modelRequests: testModelRequests(),
	};
}

beforeEach(() => {
	runSidecarTaskMock.mockReset();
});

describe("session search", () => {
	it("builds a desk corpus from every conversation's context, session jsonl, log, and rotated log", async () => {
		const workspaceDir = createWorkspace();
		const deskDir = join(workspaceDir, "desk-main");
		const siblingDir = join(workspaceDir, "desk-other");
		mkdirSync(deskDir, { recursive: true });
		mkdirSync(siblingDir, { recursive: true });

		writeJsonl(join(conv(deskDir), "context.jsonl"), [
			{
				type: "message",
				timestamp: "2026-04-19T00:00:00.000Z",
				message: { role: "user", content: "context mentions sqlite migration" },
			},
		]);
		writeFileSync(join(conv(deskDir), "session-1.jsonl"), "{bad json}\n", "utf-8");
		writeFileSync(
			join(conv(deskDir), "session-2.jsonl"),
			`${JSON.stringify({
				type: "message",
				timestamp: "2026-04-19T00:01:00.000Z",
				message: { role: "assistant", content: [{ type: "text", text: "session mentions OAuth callback" }] },
			})}\n`,
			"utf-8",
		);
		// A second channel's conversation in the same desk is part of the corpus (spec 058, D12).
		writeJsonl(join(conv(deskDir, "group-1"), "log.jsonl"), [
			{ date: "2026-04-19T00:02:00.000Z", userName: "Alice", text: "current log mentions rollout", isBot: false },
		]);
		writeJsonl(join(conv(deskDir, "group-1"), "log.jsonl.1"), [
			{ date: "2026-04-18T00:02:00.000Z", text: "rotated log mentions archive", isBot: true },
		]);
		writeJsonl(join(conv(siblingDir), "log.jsonl"), [
			{ date: "2026-04-19T00:02:00.000Z", text: "sibling secret should not appear", isBot: false },
		]);

		for (let i = 0; i < 15; i++) {
			const path = join(conv(deskDir), `history-${i}.jsonl`);
			writeJsonl(path, [{ role: "user", text: i === 0 ? "OLDEST-HISTORY-7" : `distraction ${i}` }]);
			utimesSync(path, i + 1, i + 1);
		}
		writeJsonl(join(conv(deskDir, "group-1"), "log.jsonl.2"), [{ text: "SECOND-ROTATION-7" }]);
		for (const [query, source] of [
			["sqlite migration", "context"],
			["OAuth callback", "session"],
			["rollout", "log"],
			["archive", "log"],
			["SECOND-ROTATION-7", "log"],
			["OLDEST-HISTORY-7", "session"],
			["sibling secret", undefined],
		] as const) {
			const result = await searchDeskSessions(searchRequest(workspaceDir, deskDir, query));
			expect(result.results[0]?.source).toBe(source);
		}
	});

	it("searches Chinese and English terms with role filtering", async () => {
		const workspaceDir = createWorkspace();
		const deskDir = join(workspaceDir, "desk-main");
		mkdirSync(deskDir, { recursive: true });
		writeJsonl(join(conv(deskDir), "log.jsonl"), [
			{ date: "2026-04-19T00:00:00.000Z", userName: "Alice", text: "需要优化记忆管理", isBot: false },
			{ date: "2026-04-19T00:01:00.000Z", text: 'Assistant discussed "session_search" design', isBot: true },
		]);

		writeJsonl(join(conv(deskDir), "session.jsonl"), [
			{
				type: "message",
				message: {
					role: "toolResult",
					content: [
						{
							type: "text",
							text: `TOOL-HEAD-55 password=abcd1234secret ${"x ".repeat(2400)} OMIT-TOOL-MIDDLE ${"y ".repeat(1000)} TOOL-TAIL-55`,
						},
					],
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "THINKING-ONLY-77" },
						{ type: "text", text: "visible" },
						{ type: "toolCall", name: "read", arguments: { path: "HIDDEN-ARG-77" } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "user",
					content:
						"<memory_bootstrap>INJECTED-MEMORY-77</memory_bootstrap>\n<runtime_turn_context>INJECTED-RUNTIME-77</runtime_turn_context>\n<user_message>VISIBLE-USER-77</user_message>",
				},
			},
		]);
		const request = searchRequest(workspaceDir, deskDir, "");
		const clippedTool = await searchDeskSessions({ ...request, query: "TOOL-TAIL-55", roleFilter: ["tool"] });
		expect(clippedTool.results[0]).toMatchObject({ role: "tool", path: "conversations/dm-1/session.jsonl#L1" });
		expect(clippedTool.partialDocuments).toBe(0);
		const head = await searchDeskSessions({ ...request, query: "TOOL-HEAD-55", roleFilter: ["tool"] });
		expect(head.results[0]?.summary).toContain("[REDACTED_SECRET]");
		for (const query of [
			"abcd1234secret",
			"OMIT-TOOL-MIDDLE",
			"THINKING-ONLY-77",
			"INJECTED-MEMORY-77",
			"INJECTED-RUNTIME-77",
			"HIDDEN-ARG-77",
		]) {
			expect((await searchDeskSessions({ ...request, query })).results).toEqual([]);
		}

		const chinese = await searchDeskSessions({
			appHomeDir: workspaceDir,
			deskDir,
			query: "记忆管理",
			roleFilter: ["user"],
			limit: 3,

			maxCharsPerChunk: 800,
			summarizeWithModel: false,
			timeoutMs: 1000,
			model: TEST_MODEL,
			modelRequests: testModelRequests(),
		});
		const english = await searchDeskSessions({
			appHomeDir: workspaceDir,
			deskDir,
			query: "session_search",
			limit: 3,

			maxCharsPerChunk: 800,
			summarizeWithModel: false,
			timeoutMs: 1000,
			model: TEST_MODEL,
			modelRequests: testModelRequests(),
		});

		expect(chinese.results).toHaveLength(1);
		expect(chinese.results[0]?.role).toBe("user");
		expect(english.results[0]?.summary).toContain("session_search");
		const tool = createSessionSearchTool({
			desk: "main",
			appHomeDir: workspaceDir,
			deskDir,
			channelId: "dingtalk:dm:123",
			describeConversation: () => "Release chat",
			getCurrentModel: () => TEST_MODEL,
			modelRequests: testModelRequests(),
			getSessionSearchSettings: () => ({
				maxCharsPerChunk: 800,
				summarizeWithModel: false,
				timeoutMs: 1000,
			}),
		});
		const hit = await tool.execute("call", { query: "session_search" });
		expect(hit.details).toMatchObject({ resultCount: 1, searchedDocuments: 5, index: { filesIndexed: 0 } });
		expect(hit.content[0]).toMatchObject({
			text: expect.stringContaining(
				'[Release chat · conversations/dm-1/log.jsonl#L2 · assistant · 2026-04-19T00:01:00.000Z] Assistant discussed "session_search" design',
			),
		});
	});

	it("returns recent entries when query is empty", async () => {
		const workspaceDir = createWorkspace();
		const deskDir = join(workspaceDir, "desk-main");
		mkdirSync(deskDir, { recursive: true });
		writeJsonl(join(conv(deskDir), "log.jsonl"), [
			{ date: "2026-04-19T07:59:00+08:00", text: "older", isBot: false },
			{ date: "2026-04-19T00:00:00.000Z", text: "newer", isBot: false },
		]);

		const result = await searchDeskSessions({
			appHomeDir: workspaceDir,
			deskDir,
			query: "",
			limit: 1,

			maxCharsPerChunk: 800,
			summarizeWithModel: false,
			timeoutMs: 1000,
			model: TEST_MODEL,
			modelRequests: testModelRequests(),
		});

		expect(result.results).toHaveLength(1);
		expect(result.results[0]?.summary).toContain("newer");
	});

	it("falls back to raw preview when model summarization fails", async () => {
		const workspaceDir = createWorkspace();
		const deskDir = join(workspaceDir, "desk-main");
		mkdirSync(deskDir, { recursive: true });
		const longText = `session_search fallback ${"detail ".repeat(220)}`;
		writeJsonl(join(conv(deskDir), "log.jsonl"), [
			{ date: "2026-04-19T00:00:00.000Z", text: longText, isBot: false },
		]);
		runSidecarTaskMock.mockRejectedValueOnce(new Error("model unavailable"));

		const result = await searchDeskSessions({
			appHomeDir: workspaceDir,
			deskDir,
			query: "session_search fallback",
			limit: 1,

			maxCharsPerChunk: 1400,
			summarizeWithModel: true,
			timeoutMs: 1000,
			model: TEST_MODEL,
			modelRequests: testModelRequests(),
		});

		expect(runSidecarTaskMock).toHaveBeenCalledTimes(1);
		expect(result.results[0]?.summary).toContain("session_search fallback");
	});

	it("deduplicates mirrored text, keeping the earliest attributed reference, and recalls archived tasks", async () => {
		const workspaceDir = createWorkspace();
		const deskDir = join(workspaceDir, "desk-main");
		mkdirSync(join(deskDir, "tasks", "archive"), { recursive: true });
		const duplicate = {
			type: "message",
			timestamp: "2026-04-19T00:00:00.000Z",
			message: { role: "user", content: "[2026-04-19T00:00:00.000Z] [Alice]: duplicate  oauth note" },
		};
		writeJsonl(join(conv(deskDir), "context.jsonl"), [duplicate]);
		writeJsonl(join(conv(deskDir), "session-1.jsonl"), [duplicate]);
		writeJsonl(join(conv(deskDir), "log.jsonl"), [
			{ date: "2026-04-19T00:01:00.000Z", text: "duplicate oauth note", isBot: false },
		]);
		writeFileSync(
			join(deskDir, "tasks", "archive", "oauth-migration.md"),
			"---\nstate: closed\n---\n# OAuth Migration\n\n## Goal\nMigrate legacy PKCE callback.\n",
		);
		writeJsonl(join(deskDir, "tasks", "archive", "oauth-migration.jsonl"), [
			{
				id: "r0",
				kind: "ask",
				ts: "2026-04-18T11:00:00.000Z",
				seq: 1,
				question: "Use S256 challenge?",
				delivered: true,
			},
			{
				id: "r1",
				kind: "close",
				ts: "2026-04-18T12:00:00.000Z",
				outcome: "completed",
				by: "leader",
				note: "PKCE live",
			},
		]);

		const result = await searchDeskSessions(searchRequest(workspaceDir, deskDir, "oauth pkce"));
		expect(result.searchedDocuments).toBe(2);
		expect(result.results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ source: "context", speaker: "Alice", when: "2026-04-19T00:00:00.000Z" }),
				expect.objectContaining({
					source: "task",
					path: "tasks/archive/oauth-migration.md",
					summary: expect.stringContaining("PKCE live"),
				}),
			]),
		);
		expect(result.results.find((entry) => entry.source === "task")?.summary).toContain("Use S256 challenge?");
	});

	// batch 2.5: a keyword deep inside a long message must stay findable — the old code clipped each
	// message to the small display window at ingest, so widening the query could never recover it.
	it("finds a keyword in the middle of a long message and centers the preview on it", async () => {
		const workspaceDir = createWorkspace();
		const deskDir = join(workspaceDir, "desk-mid");
		mkdirSync(deskDir, { recursive: true });
		const longMessage = `THE_BURIED_TOKEN ${"lorem ipsum ".repeat(2400)} THE_BURIED_TOKEN decided to use pgbouncer ${"dolor sit ".repeat(400)}`;
		writeJsonl(join(conv(deskDir), "log.jsonl"), [
			{ date: "2026-09-01T00:00:00.000Z", userName: "Alice", text: longMessage, isBot: false },
		]);

		const result = await searchDeskSessions({
			appHomeDir: workspaceDir,
			deskDir,
			query: "THE_BURIED_TOKEN pgbouncer",
			limit: 3,

			maxCharsPerChunk: 400,
			summarizeWithModel: false,
			timeoutMs: 1000,
			model: TEST_MODEL,
			modelRequests: testModelRequests(),
		});

		expect(result.results).toHaveLength(1);
		expect(result.results[0]?.summary).toContain("THE_BURIED_TOKEN");
		expect(result.results[0]?.summary).toContain("pgbouncer");
	});

	it("does not return an unrelated recent message just because it is recent (batch 2.5)", async () => {
		const workspaceDir = createWorkspace();
		const deskDir = join(workspaceDir, "desk-recent");
		mkdirSync(deskDir, { recursive: true });
		writeJsonl(join(conv(deskDir), "log.jsonl"), [
			{
				date: new Date().toISOString(),
				userName: "Alice",
				text: "what's for lunch today with kubernetes",
				isBot: false,
			},
		]);

		const result = await searchDeskSessions({
			appHomeDir: workspaceDir,
			deskDir,
			query: "kubernetes ingress controller service health",
			limit: 3,

			maxCharsPerChunk: 400,
			summarizeWithModel: false,
			timeoutMs: 1000,
			model: TEST_MODEL,
			modelRequests: testModelRequests(),
		});

		expect(result.results).toEqual([]);
	});
});
