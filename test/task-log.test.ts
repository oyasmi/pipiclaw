import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderTaskDocument } from "../src/tasks/ledger.js";
import { appendTaskLog, readTaskLog, renderTaskLogLine, resetTaskLogAppenders, taskLogPath } from "../src/tasks/log.js";
import { readCycleRounds, recordVerificationRound } from "../src/tasks/rounds.js";
import { openCycle } from "../src/tasks/store.js";

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
	it("filters by cycle and kind, and keeps the most recent when limited", async () => {
		for (const [index, cycle] of ["c-1", "c-1", "c-2"].entries()) {
			await appendTaskLog(dir, "T", {
				cycle,
				kind: "step",
				seq: index + 1,
				outcome: "continue",
				note: `note ${index + 1}`,
				tools: [],
			});
		}
		await appendTaskLog(dir, "T", {
			cycle: "c-2",
			kind: "round",
			n: 1,
			verifyRunId: "run_v",
			verdict: "pass",
			strength: "advisory",
		});

		expect((await readTaskLog(dir, "T", { cycle: "c-1" })).length).toBe(2);
		expect((await readTaskLog(dir, "T", { kinds: ["round"] })).length).toBe(1);
		const last = await readTaskLog(dir, "T", { limit: 1 });
		expect(last[0]?.kind).toBe("round");
	});

	// A hand-edited or half-written line must not make a whole task's history unreadable — the
	// log is the only durable trace of what each step did.
	it("skips unparseable lines instead of failing the read", async () => {
		await appendTaskLog(dir, "T", { cycle: "c-1", kind: "step", seq: 1, outcome: "continue", note: "ok", tools: [] });
		await appendFile(taskLogPath(dir, "T"), '{not json\n{"ts":"x"}\n');
		const records = await readTaskLog(dir, "T");
		expect(records.length).toBe(1);
		expect(records[0]?.kind).toBe("step");
	});

	it("returns nothing for a task that has never logged", async () => {
		expect(await readTaskLog(dir, "missing")).toEqual([]);
	});

	it("renders a rejected verdict with the reason it was rejected", () => {
		const line = renderTaskLogLine({
			ts: "t",
			cycle: "c-1",
			kind: "round",
			n: 2,
			verifyRunId: "run_v",
			verdict: "fail",
			strength: "advisory",
			reason: "task contract changed after verification",
		});
		expect(line).toContain("FAIL");
		expect(line).toContain("contract changed");
	});
});

describe("rework accounting (spec 051, D7)", () => {
	it("counts rounds onto the cycle and reports when the ceiling is reached", async () => {
		await openCycle(dir, "T");
		const first = await recordVerificationRound(
			{ channelDir: dir, taskId: "T", verifyRunId: "run_1", verdict: "fail", strength: "advisory", usd: 1 },
			2,
		);
		expect(first).toMatchObject({ round: 1, overBudget: false });

		const second = await recordVerificationRound(
			{ channelDir: dir, taskId: "T", verifyRunId: "run_2", verdict: "pass", strength: "advisory" },
			2,
		);
		expect(second).toMatchObject({ round: 2, overBudget: true });

		const rounds = await readCycleRounds(dir, "T", first?.cycleId);
		expect(rounds.map((record) => record.verdict)).toEqual(["fail", "pass"]);
	});

	// Rounds are scoped to a cycle: a verdict from an earlier cycle says nothing about this one.
	it("reads back only the rounds recorded against the requested cycle", async () => {
		const opened = await openCycle(dir, "T");
		await recordVerificationRound(
			{ channelDir: dir, taskId: "T", verifyRunId: "run_1", verdict: "pass", strength: "advisory" },
			4,
		);
		expect((await readCycleRounds(dir, "T", opened?.cycleId)).map((record) => record.verifyRunId)).toEqual(["run_1"]);
		expect(await readCycleRounds(dir, "T", "c-other")).toEqual([]);
	});

	it("does nothing for a task with no open cycle", async () => {
		expect(
			await recordVerificationRound(
				{ channelDir: dir, taskId: "T", verifyRunId: "run_1", verdict: "pass", strength: "advisory" },
				4,
			),
		).toBeUndefined();
	});
});
