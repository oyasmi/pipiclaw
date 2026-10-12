import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { logTaskDispatch, logTaskSettlement } from "../src/tasks/bound-work.js";
import { renderTaskDocument } from "../src/tasks/contract.js";
import {
	appendTaskLog,
	readTaskLog,
	resetTaskLogAppenders,
	taskArchiveLogPath,
	taskLogPath,
} from "../src/tasks/loop-log.js";
import { archiveTask } from "../src/tasks/store.js";

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

		expect((await readTaskLog(dir, "T")).map((r) => (r.kind === "step" ? r.note : undefined))).toEqual([
			"oldest",
			"middle",
			"newest",
		]);
		expect((await readTaskLog(dir, "T", { limit: 1 }))[0]).toMatchObject({ kind: "step", seq: 3 });
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
