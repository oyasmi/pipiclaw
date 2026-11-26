import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testModelRequests } from "./helpers/model-requests.js";

vi.mock("../src/memory/sidecar-worker.js", () => ({
	runSidecarTask: vi.fn(),
	runRetriedSidecarTask: vi.fn(),
	SidecarParseError: class SidecarParseError extends Error {},
}));

import { readJournalDay } from "../src/memory/journal.js";
import { runRetriedSidecarTask } from "../src/memory/sidecar-worker.js";
import { applyMemoryOps, listMemoryEntries } from "../src/memory/store.js";
import { digestTaskArchives } from "../src/memory/task-archive-digest.js";
import { useTempDirs } from "./helpers/fixtures.js";

const createTempDir = useTempDirs("pipiclaw-task-archive-digest-");
const fakeModel = { id: "primary", provider: "test" } as never;

async function writeArchive(
	deskDir: string,
	id: string,
	frontmatter: Record<string, string>,
	body: string,
	logLines: Record<string, unknown>[],
): Promise<void> {
	const dir = join(deskDir, "tasks", "archive");
	await mkdir(dir, { recursive: true });
	const fm = Object.entries(frontmatter)
		.map(([k, v]) => `${k}: ${v}`)
		.join("\n");
	await writeFile(join(dir, `${id}.md`), `---\n${fm}\n---\n${body}\n`, "utf-8");
	await writeFile(join(dir, `${id}.jsonl`), `${logLines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf-8");
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe("task archive digester (B1)", () => {
	it("skips pre-launch archives, writes deterministic journal for recurring tasks, and reflects one-off tasks", async () => {
		const deskDir = createTempDir();
		const target = { desk: "default", deskDir };
		const launchMs = Date.parse("2026-11-26T00:00:00+08:00");

		// Pre-launch archive: must NOT be backfilled.
		await writeArchive(
			deskDir,
			"old-task",
			{ outcome: "completed", closedAt: "2026-11-25T23:00:00+08:00" },
			"# Old Task",
			[{ kind: "close", outcome: "completed", note: "old note", ts: "2026-11-25T23:00:00+08:00" }],
		);
		// Post-launch recurring instance: zero LLM calls, deterministic 1-line journal.
		await writeArchive(
			deskDir,
			"daily-news-20261126",
			{ outcome: "completed", closedAt: "2026-11-26T04:28:00+08:00", origin: "daily-news-briefing" },
			"# 每日新闻简报",
			[{ kind: "close", outcome: "completed", note: "已发送 Sent ID 124", ts: "2026-11-26T04:28:00+08:00" }],
		);
		// Post-launch one-off task: runs reflect and deletes stale agent entry.
		await applyMemoryOps(deskDir, [
			{ op: "add", name: "stale-p1-bug", type: "project", description: "HEAD has P1 bug", source: "agent" },
		]);
		await writeArchive(
			deskDir,
			"fix-p1-bug",
			{ outcome: "completed", closedAt: "2026-11-26T10:15:00+08:00", channel: "dingtalk:dm:1" },
			"# Fix P1 Bug\n\n## Goal\nFix the P1 bug.",
			[
				{ kind: "report", text: "P1 bug fixed and verified." },
				{ kind: "close", outcome: "completed", note: "已修复并验证通过", ts: "2026-11-26T10:15:00+08:00" },
			],
		);

		let capturedPrompt = "";
		vi.mocked(runRetriedSidecarTask).mockImplementationOnce(async (task) => {
			capturedPrompt = task.prompt;
			const text = JSON.stringify({
				journal: ["10:15 完成 fix-p1-bug：P1 缺陷已修复并验证通过"],
				ops: [{ op: "delete", name: "stale-p1-bug", confidence: 0.95, reason: "fixed by task" }],
				discarded: [],
			});
			return { rawText: text, output: task.parse(text) } as never;
		});

		const loadReflectRuntime = vi.fn(async () => ({
			workspaceDir: deskDir,
			model: fakeModel,
			modelRequests: testModelRequests(async () => "key"),
		}));

		const first = await digestTaskArchives({
			target,
			now: new Date("2026-11-26T10:20:00+08:00"),
			initialWatermarkMs: launchMs,
			loadReflectRuntime,
		});
		expect(first).toEqual({ initialized: true, recurringDigested: 1, oneOffDigested: 1, usedLlm: true });
		expect(loadReflectRuntime).toHaveBeenCalledTimes(1);
		expect(capturedPrompt).toContain("已修复并验证通过");
		expect(capturedPrompt).not.toContain("old note");

		const journal = await readJournalDay(deskDir, "2026-11-26");
		expect(journal).toContain("任务 daily-news-20261126（已完成）：已发送 Sent ID 124");
		expect(journal).toContain("10:15 完成 fix-p1-bug");
		expect(await listMemoryEntries(deskDir)).toEqual([]);

		// Re-running is idempotent: no additional LLM calls or journal lines.
		const second = await digestTaskArchives({
			target,
			now: new Date("2026-11-26T10:25:00+08:00"),
			initialWatermarkMs: launchMs,
			loadReflectRuntime,
		});
		expect(second).toEqual({ initialized: false, recurringDigested: 0, oneOffDigested: 0, usedLlm: false });
		expect(loadReflectRuntime).toHaveBeenCalledTimes(1);
	});
});
