import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderTaskDocument } from "../src/tasks/ledger.js";
import {
	appendTaskLog,
	readTaskLog,
	resetTaskLogAppenders,
	taskArchiveLogPath,
	taskLogPath,
} from "../src/tasks/log.js";
import { archiveTask } from "../src/tasks/store.js";
import { logTaskDispatch, logTaskSettlement } from "../src/tasks/work-log.js";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "task-log-"));
	await mkdir(join(dir, "tasks"), { recursive: true });
	await writeFile(join(dir, "tasks", "T.md"), renderTaskDocument({ state: "open" }, "# T\n"));
});

afterEach(async () => {
	await resetTaskLogAppenders();
});

describe("loop log (spec 051, D5)", () => {
	it("filters by kind, and keeps the most recent when limited", async () => {
		for (const index of [0, 1, 2]) {
			await appendTaskLog(dir, "T", {
				kind: "step",
				seq: index + 1,
				outcome: "continue",
				note: `note ${index + 1}`,
				tools: [],
			});
		}
		await appendTaskLog(dir, "T", { kind: "dispatch", ref: "run_v" });

		expect((await readTaskLog(dir, "T", { kinds: ["step"] })).length).toBe(3);
		expect((await readTaskLog(dir, "T", { kinds: ["dispatch"] })).length).toBe(1);
		const last = await readTaskLog(dir, "T", { limit: 1 });
		expect(last[0]?.kind).toBe("dispatch");
	});

	// A hand-edited or half-written line must not make a whole task's history unreadable — the
	// log is the only durable trace of what each step did.
	it("skips unparseable lines instead of failing the read", async () => {
		await appendTaskLog(dir, "T", { kind: "step", seq: 1, outcome: "continue", note: "ok", tools: [] });
		await appendFile(taskLogPath(dir, "T"), '{not json\n{"ts":"x"}\n');
		const records = await readTaskLog(dir, "T");
		expect(records.length).toBe(1);
		expect(records[0]?.kind).toBe("step");
	});

	it("returns nothing for a task that has never logged", async () => {
		expect(await readTaskLog(dir, "missing")).toEqual([]);
	});

	it("falls back to the archived log when the active one is gone (batch 2.5)", async () => {
		// archiveTask moves <id>.jsonl into tasks/archive/. task_log on a completed task should
		// still return its history. Mutation check: remove the taskArchiveLogPath fallback in
		// readTaskLog and this returns [].
		await appendTaskLog(dir, "done-task", {
			kind: "step",
			seq: 1,
			outcome: "continue",
			note: "n",
			tools: [],
		});
		await resetTaskLogAppenders();
		await mkdir(join(dir, "tasks", "archive"), { recursive: true });
		const { rename } = await import("node:fs/promises");
		await rename(taskLogPath(dir, "done-task"), join(dir, "tasks", "archive", "done-task.jsonl"));

		const records = await readTaskLog(dir, "done-task");
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ kind: "step", note: "n" });
	});

	// R9: `MAX_LOG_BYTES` rotation moves older records into `.1`/`.2` behind the caller's back.
	// A read that only looked at the current file made rotated-out history invisible to
	// `task_log`, step briefs, and round accounting alike even though it was still on disk.
	it("reads records from rotated shards (.1/.2), oldest first, alongside the current file", async () => {
		await appendFile(
			`${taskLogPath(dir, "T")}.2`,
			`${JSON.stringify({ ts: "t1", kind: "step", seq: 1, outcome: "continue", note: "oldest", tools: [] })}\n`,
		);
		await appendFile(
			`${taskLogPath(dir, "T")}.1`,
			`${JSON.stringify({ ts: "t2", kind: "step", seq: 2, outcome: "continue", note: "middle", tools: [] })}\n`,
		);
		await appendTaskLog(dir, "T", {
			kind: "step",
			seq: 3,
			outcome: "continue",
			note: "newest",
			tools: [],
		});

		const records = await readTaskLog(dir, "T");
		expect(records.map((r) => (r.kind === "step" ? r.note : undefined))).toEqual(["oldest", "middle", "newest"]);

		// limit/cycle/kinds filters apply across the combined, chronologically-ordered history.
		expect((await readTaskLog(dir, "T", { limit: 1 }))[0]).toMatchObject({ kind: "step", seq: 3 });
	});

	it("archiveTask moves rotated shards along with the current file, and readTaskLog still sees all of them", async () => {
		await appendFile(
			`${taskLogPath(dir, "T")}.2`,
			`${JSON.stringify({ ts: "t1", kind: "step", seq: 1, outcome: "continue", note: "oldest", tools: [] })}\n`,
		);
		await appendFile(
			`${taskLogPath(dir, "T")}.1`,
			`${JSON.stringify({ ts: "t2", kind: "step", seq: 2, outcome: "continue", note: "middle", tools: [] })}\n`,
		);
		await appendTaskLog(dir, "T", {
			kind: "step",
			seq: 3,
			outcome: "continue",
			note: "newest",
			tools: [],
		});
		await resetTaskLogAppenders();

		await archiveTask(dir, "T", "completed");

		expect(existsSync(taskLogPath(dir, "T"))).toBe(false);
		expect(existsSync(`${taskLogPath(dir, "T")}.1`)).toBe(false);
		expect(existsSync(`${taskLogPath(dir, "T")}.2`)).toBe(false);
		expect(existsSync(taskArchiveLogPath(dir, "T"))).toBe(true);
		expect(existsSync(`${taskArchiveLogPath(dir, "T")}.1`)).toBe(true);
		expect(existsSync(`${taskArchiveLogPath(dir, "T")}.2`)).toBe(true);

		const records = await readTaskLog(dir, "T");
		expect(records.map((r) => (r.kind === "step" ? r.note : undefined))).toEqual(["oldest", "middle", "newest"]);
	});
});

describe("work log (spec 052, D4)", () => {
	it("records a dispatch and its settlement, and puts the cost on the task's usage", async () => {
		await writeFile(
			join(dir, "tasks", "U.md"),
			renderTaskDocument(
				{
					state: "open",
					usage: { startedAt: "2026-09-05T09:00:00+08:00", steps: 0, usd: 1, usdEstimated: false, expired: 0 },
				},
				"# U\n",
			),
		);
		await logTaskDispatch(dir, "U", { ref: "run_1", item: "W2", agent: "builder", purpose: "work" });
		await logTaskSettlement(
			dir,
			"U",
			{ ref: "run_1", item: "W2", status: "completed", output: "/o/output.md" },
			{ usd: 2.5, estimated: true },
		);

		const records = await readTaskLog(dir, "U");
		expect(records.map((record) => record.kind)).toEqual(["dispatch", "settle"]);
		expect(records[1]).toMatchObject({ ref: "run_1", status: "completed", usd: 2.5, usdEstimated: true });
		const { readStoredTask } = await import("../src/tasks/store.js");
		expect((await readStoredTask(dir, "U"))?.fields.usage).toMatchObject({ usd: 3.5, usdEstimated: true });
	});

	it("writes nothing for a task that no longer exists", async () => {
		await logTaskDispatch(dir, "gone", { ref: "run_1" });
		await logTaskSettlement(dir, "gone", { ref: "run_1", status: "completed" });
		expect(await readTaskLog(dir, "gone")).toEqual([]);
	});
});
