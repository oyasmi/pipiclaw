import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildSessionCorpus } from "../src/memory/session-corpus.js";
import { searchDotSessions } from "../src/memory/session-search.js";
import { useTempDirs } from "./helpers/fixtures.js";

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

/** A conversation directory inside a dot (spec 058, D2), created on first use. */
function conv(dotDir: string, name = "dm-1"): string {
	const dir = join(dotDir, "conversations", name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeJsonl(path: string, entries: unknown[]): void {
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf-8");
}

beforeEach(() => {
	runSidecarTaskMock.mockReset();
});

describe("session search", () => {
	it("builds a dot corpus from every conversation's context, session jsonl, log, and rotated log", async () => {
		const workspaceDir = createWorkspace();
		const dotDir = join(workspaceDir, "dm_123");
		const siblingDir = join(workspaceDir, "dm_other");
		mkdirSync(dotDir, { recursive: true });
		mkdirSync(siblingDir, { recursive: true });

		writeJsonl(join(conv(dotDir), "context.jsonl"), [
			{
				type: "message",
				timestamp: "2026-04-19T00:00:00.000Z",
				message: { role: "user", content: "context mentions sqlite migration" },
			},
		]);
		writeFileSync(join(conv(dotDir), "session-1.jsonl"), "{bad json}\n", "utf-8");
		writeFileSync(
			join(conv(dotDir), "session-2.jsonl"),
			`${JSON.stringify({
				type: "message",
				timestamp: "2026-04-19T00:01:00.000Z",
				message: { role: "assistant", content: [{ type: "text", text: "session mentions OAuth callback" }] },
			})}\n`,
			"utf-8",
		);
		// A second channel's conversation in the same dot is part of the corpus (spec 058, D12).
		writeJsonl(join(conv(dotDir, "group-1"), "log.jsonl"), [
			{ date: "2026-04-19T00:02:00.000Z", userName: "Alice", text: "current log mentions rollout", isBot: false },
		]);
		writeJsonl(join(conv(dotDir, "group-1"), "log.jsonl.1"), [
			{ date: "2026-04-18T00:02:00.000Z", text: "rotated log mentions archive", isBot: true },
		]);
		writeJsonl(join(conv(siblingDir), "log.jsonl"), [
			{ date: "2026-04-19T00:02:00.000Z", text: "sibling secret should not appear", isBot: false },
		]);

		const docs = await buildSessionCorpus({ dotDir, maxFiles: 8 });

		expect(docs.map((doc) => doc.text).join("\n")).toContain("sqlite migration");
		expect(docs.map((doc) => doc.text).join("\n")).toContain("OAuth callback");
		expect(docs.map((doc) => doc.text).join("\n")).toContain("rollout");
		expect(docs.map((doc) => doc.text).join("\n")).toContain("archive");
		expect(docs.map((doc) => doc.text).join("\n")).not.toContain("sibling secret");
		expect(docs.filter((doc) => doc.path.endsWith("context.jsonl"))).toHaveLength(1);
		expect(docs.find((doc) => doc.text.includes("rollout"))?.conversation).toBe("group-1");
	});

	it("searches Chinese and English terms with role filtering", async () => {
		const workspaceDir = createWorkspace();
		const dotDir = join(workspaceDir, "dm_123");
		mkdirSync(dotDir, { recursive: true });
		writeJsonl(join(conv(dotDir), "log.jsonl"), [
			{ date: "2026-04-19T00:00:00.000Z", userName: "Alice", text: "需要优化记忆管理", isBot: false },
			{ date: "2026-04-19T00:01:00.000Z", text: "Assistant discussed session_search design", isBot: true },
		]);

		const chinese = await searchDotSessions({
			dotDir,
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
		const english = await searchDotSessions({
			dotDir,
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
		const dotDir = join(workspaceDir, "dm_123");
		mkdirSync(dotDir, { recursive: true });
		writeJsonl(join(conv(dotDir), "log.jsonl"), [
			{ date: "2026-04-18T00:00:00.000Z", text: "older", isBot: false },
			{ date: "2026-04-19T00:00:00.000Z", text: "newer", isBot: false },
		]);

		const result = await searchDotSessions({
			dotDir,
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

	it("keeps short-lived corpus caches for more than one channel", async () => {
		const workspaceDir = createWorkspace();
		const firstDir = join(workspaceDir, "dm_first");
		const secondDir = join(workspaceDir, "dm_second");
		mkdirSync(firstDir, { recursive: true });
		mkdirSync(secondDir, { recursive: true });
		writeJsonl(join(conv(firstDir), "log.jsonl"), [
			{ date: "2026-04-19T00:00:00.000Z", text: "first cached value", isBot: false },
		]);
		writeJsonl(join(conv(secondDir), "log.jsonl"), [
			{ date: "2026-04-19T00:00:00.000Z", text: "second cached value", isBot: false },
		]);
		const request = {
			query: "",
			limit: 1,
			maxFiles: 6,
			maxChunks: 20,
			maxCharsPerChunk: 800,
			summarizeWithModel: false,
			timeoutMs: 1000,
			model: TEST_MODEL,
			resolveApiKey: async () => "",
		};

		await searchDotSessions({ ...request, dotDir: firstDir });
		await searchDotSessions({ ...request, dotDir: secondDir });
		writeJsonl(join(conv(firstDir), "log.jsonl"), [
			{ date: "2026-04-19T00:01:00.000Z", text: "replacement value", isBot: false },
		]);

		const cached = await searchDotSessions({ ...request, dotDir: firstDir });
		expect(cached.results[0]?.summary).toContain("first cached value");
		expect(cached.results[0]?.summary).not.toContain("replacement value");
	});

	it("falls back to raw preview when model summarization fails", async () => {
		const workspaceDir = createWorkspace();
		const dotDir = join(workspaceDir, "dm_123");
		mkdirSync(dotDir, { recursive: true });
		const longText = `session_search fallback ${"detail ".repeat(220)}`;
		writeJsonl(join(conv(dotDir), "log.jsonl"), [{ date: "2026-04-19T00:00:00.000Z", text: longText, isBot: false }]);
		runSidecarTaskMock.mockRejectedValueOnce(new Error("model unavailable"));

		const result = await searchDotSessions({
			dotDir,
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

	it("deduplicates mirrored transcript documents and limits the scored corpus", async () => {
		const workspaceDir = createWorkspace();
		const dotDir = join(workspaceDir, "dm_123");
		mkdirSync(dotDir, { recursive: true });
		const duplicate = {
			type: "message",
			timestamp: "2026-04-19T00:00:00.000Z",
			message: { role: "user", content: "duplicate oauth note" },
		};
		writeJsonl(join(conv(dotDir), "context.jsonl"), [duplicate]);
		writeJsonl(join(conv(dotDir), "session-1.jsonl"), [duplicate]);
		writeJsonl(join(conv(dotDir), "log.jsonl"), [
			{ date: "2026-04-19T00:01:00.000Z", text: "newest unrelated note", isBot: false },
		]);

		const docs = await buildSessionCorpus({ dotDir, maxFiles: 6 });
		expect(docs.filter((doc) => doc.text === "duplicate oauth note")).toHaveLength(1);

		const result = await searchDotSessions({
			dotDir,
			query: "oauth",
			limit: 5,
			maxFiles: 6,
			maxChunks: 1,
			maxCharsPerChunk: 800,
			summarizeWithModel: false,
			timeoutMs: 1000,
			model: TEST_MODEL,
			resolveApiKey: async () => "",
		});
		expect(result.searchedDocuments).toBe(1);
		expect(result.results).toEqual([]);
	});

	it("caps documents at maxDocumentsTotal and keeps newest", async () => {
		const workspaceDir = createWorkspace();
		const dotDir = join(workspaceDir, "dm_123");
		mkdirSync(dotDir, { recursive: true });
		const entries = Array.from({ length: 200 }, (_, i) => ({
			date: new Date(Date.now() - (200 - i) * 60_000).toISOString(),
			userName: "Alice",
			text: `message number ${i}`,
			isBot: false,
		}));
		writeJsonl(join(conv(dotDir), "log.jsonl"), entries);

		const docs = await buildSessionCorpus({ dotDir, maxFiles: 6, maxDocumentsTotal: 50 });

		expect(docs.length).toBeLessThanOrEqual(50);
		// Should keep newest (tail) entries
		const lastDoc = docs[docs.length - 1];
		expect(lastDoc?.text).toContain("message number 199");
	});

	// batch 2.5: a keyword deep inside a long message must stay findable — the old code clipped each
	// message to the small display window at ingest, so widening the query could never recover it.
	it("finds a keyword in the middle of a long message and centers the preview on it", async () => {
		const workspaceDir = createWorkspace();
		const dotDir = join(workspaceDir, "dm_mid");
		mkdirSync(dotDir, { recursive: true });
		const longMessage = `${"lorem ipsum ".repeat(400)} THE_BURIED_TOKEN decided to use pgbouncer ${"dolor sit ".repeat(400)}`;
		writeJsonl(join(conv(dotDir), "log.jsonl"), [
			{ date: "2026-09-01T00:00:00.000Z", userName: "Alice", text: longMessage, isBot: false },
		]);

		const result = await searchDotSessions({
			dotDir,
			query: "THE_BURIED_TOKEN",
			limit: 3,
			maxFiles: 6,
			maxChunks: 20,
			maxCharsPerChunk: 400,
			summarizeWithModel: false,
			timeoutMs: 1000,
			model: TEST_MODEL,
			resolveApiKey: async () => "",
		});

		expect(result.results).toHaveLength(1);
		expect(result.results[0]?.summary).toContain("THE_BURIED_TOKEN");
		expect(result.results[0]?.summary).toContain("pgbouncer");
	});

	it("does not return an unrelated recent message just because it is recent (batch 2.5)", async () => {
		const workspaceDir = createWorkspace();
		const dotDir = join(workspaceDir, "dm_recent");
		mkdirSync(dotDir, { recursive: true });
		writeJsonl(join(conv(dotDir), "log.jsonl"), [
			{ date: new Date().toISOString(), userName: "Alice", text: "what's for lunch today", isBot: false },
		]);

		const result = await searchDotSessions({
			dotDir,
			query: "kubernetes ingress controller",
			limit: 3,
			maxFiles: 6,
			maxChunks: 20,
			maxCharsPerChunk: 400,
			summarizeWithModel: false,
			timeoutMs: 1000,
			model: TEST_MODEL,
			resolveApiKey: async () => "",
		});

		expect(result.results).toEqual([]);
	});
});
