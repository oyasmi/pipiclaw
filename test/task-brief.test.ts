import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PLAYBOOKS_DIR } from "../src/paths.js";
import { BOARD_REF_LINE_BUDGET, buildTaskBoard, renderTaskBoard, renderTaskBoardForUser } from "../src/tasks/board.js";
import { BRIEF_INPUT_LIMIT, buildTaskStepBrief, contractSha } from "../src/tasks/brief.js";
import { createUsage } from "../src/tasks/budget.js";
import { renderStandardTaskBody, renderTaskDocument } from "../src/tasks/contract.js";
import type { TaskFrontmatter } from "../src/tasks/frontmatter.js";
import {
	appendTaskLog,
	newInputs,
	readTaskLog,
	renderTaskLogLineForUser,
	resetTaskLogAppenders,
} from "../src/tasks/loop-log.js";
import { archiveTask, readStoredTask } from "../src/tasks/store.js";
import { useTempDirs } from "./helpers/fixtures.js";

const tempDir = useTempDirs("pipiclaw-task-brief-");
afterEach(resetTaskLogAppenders);

async function writeTask(deskDir: string, id: string, body: string, fields: Partial<TaskFrontmatter> = {}) {
	await mkdir(join(deskDir, "tasks"), { recursive: true });
	const path = join(deskDir, "tasks", `${id}.md`);
	await writeFile(path, renderTaskDocument({ state: "queued", usage: createUsage(), ...fields }, body));
	return path;
}

/** The brief the lane would build for the task's next step, from the log as it stands now. */
async function briefOf(deskDir: string, id: string, full = true): Promise<string> {
	const document = await readStoredTask(deskDir, id);
	const records = await readTaskLog(deskDir, id);
	const brief = await buildTaskStepBrief({
		deskDir,
		document: document!,
		seq: 1,
		records,
		inputs: newInputs(records),
		full,
		pending: [],
	});
	return brief.text;
}

const step = (seq = 1) => ({ kind: "step" as const, seq, reason: "continue" as const, brief: "delta" as const });
const stepEnd = (seq = 1, note = "did it") => ({
	kind: "step_end" as const,
	seq,
	result: "ok" as const,
	next: "continue" as const,
	note,
	tools: ["read"],
});

describe("task step brief (spec 064, D15)", () => {
	it("sends the contract whole once, then only what is new — and again when the contract changes", async () => {
		const deskDir = tempDir();
		const path = await writeTask(deskDir, "work", "# Work\n\n## Goal\nShip it.\n");
		const full = await briefOf(deskDir, "work");
		expect(full).toContain(path);
		expect(full).toContain(join(PLAYBOOKS_DIR, "task-lead.md"));
		expect(full).toContain(`<task_contract id="work" sha="${contractSha("# Work\n\n## Goal\nShip it.\n")}">`);
		expect(full).toContain("Ship it.");

		await appendTaskLog(deskDir, "work", step());
		await appendTaskLog(deskDir, "work", { kind: "message", from: "u", channel: "c", text: "also do X" });
		const delta = await briefOf(deskDir, "work", false);
		expect(delta).not.toContain("<task_contract");
		expect(delta).not.toContain("Ship it.");
		expect(delta).toMatch(/<task_inputs>[\s\S]*also do X[\s\S]*<\/task_inputs>/);
		expect(delta).toContain("<task_state>");

		expect(contractSha("# Work\n\n## Goal\nShip it differently.\n")).not.toBe(
			contractSha("# Work\n\n## Goal\nShip it.\n"),
		);
	});

	it("shows results as data, stalls and resumes as events, and a failed previous step first", async () => {
		const deskDir = tempDir();
		await writeTask(deskDir, "work", "# Work\n");
		const oldId = await appendTaskLog(deskDir, "work", {
			kind: "settle",
			ref: "run_old",
			status: "completed",
			tail: "OLD_TAIL",
		});
		await appendTaskLog(deskDir, "work", { kind: "input_ack", ids: [oldId] });
		await appendTaskLog(deskDir, "work", step(1));
		await appendTaskLog(deskDir, "work", { ...stepEnd(1), result: "timeout", error: "too slow" });
		await appendTaskLog(deskDir, "work", step(2));
		await appendTaskLog(deskDir, "work", {
			kind: "settle",
			ref: "run_new",
			item: "W2",
			status: "completed",
			tail: "NEW_TAIL",
			changed: "M src/export.ts",
			output: "/o/new.md",
		});
		await appendTaskLog(deskDir, "work", { kind: "stall", ref: "run_slow", silentMinutes: 12 });
		await appendTaskLog(deskDir, "work", { kind: "resume", grants: { steps: 5 } });

		const brief = await briefOf(deskDir, "work", false);
		const inputs = /<task_inputs>([\s\S]*)<\/task_inputs>/.exec(brief)?.[1] ?? "";
		expect(inputs).toContain("<untrusted_agent_output>\nNEW_TAIL\n</untrusted_agent_output>");
		expect(inputs).toContain("M src/export.ts");
		expect(inputs).toContain("/o/new.md");
		expect(inputs).toContain("run_slow");
		expect(inputs).toContain("追加预算");
		// What the previous step already saw does not come back.
		expect(inputs).not.toContain("OLD_TAIL");
		await appendTaskLog(deskDir, "work", stepEnd(2));
		await appendTaskLog(deskDir, "work", { ...stepEnd(3, "boom"), result: "error", error: "provider down" });
		expect(await briefOf(deskDir, "work", false)).toMatch(/上一步异常[\s\S]*provider down/);
	});

	it("folds the oldest inputs beyond the limit into a pointer", async () => {
		const deskDir = tempDir();
		await writeTask(deskDir, "work", "# Work\n");
		await appendTaskLog(deskDir, "work", step());
		for (let index = 0; index < BRIEF_INPUT_LIMIT + 3; index++) {
			await appendTaskLog(deskDir, "work", { kind: "message", from: "u", channel: "c", text: `msg-${index}` });
		}
		const brief = await briefOf(deskDir, "work", false);
		expect(brief).toContain("另有 3 条较早的输入");
		expect(brief).not.toContain("msg-2\n");
		expect(brief).toContain(`msg-${BRIEF_INPUT_LIMIT + 2}`);
	});

	it("carries the previous occurrence into the first step of a spawned instance only", async () => {
		const deskDir = tempDir();
		await writeTask(deskDir, "weekly-20260928-0900", "# W\n", { origin: "weekly" });
		await appendTaskLog(deskDir, "weekly-20260928-0900", {
			kind: "report",
			seq: 3,
			text: "本周周报：合并 12 个 PR",
			delivered: true,
		});
		await appendTaskLog(deskDir, "weekly-20260928-0900", {
			kind: "close",
			outcome: "done",
			by: "leader",
			note: "published, id=68",
			steps: 4,
			usd: 1,
		});
		await archiveTask(deskDir, "weekly-20260928-0900", "completed");
		// A different event whose name merely starts with this one's must not be mistaken for it.
		await writeTask(deskDir, "weekly-extra-20260929-0900", "# X\n", { origin: "weekly-extra" });
		await archiveTask(deskDir, "weekly-extra-20260929-0900", "completed");
		await writeTask(deskDir, "weekly-20261005-0900", "# W\n", { origin: "weekly" });

		const first = await briefOf(deskDir, "weekly-20261005-0900");
		expect(first).toMatch(/<previous_occurrence id="weekly-20260928-0900"[\s\S]*published, id=68/);
		// What the previous occurrence actually delivered, not only how it closed.
		expect(first).toMatch(/<previous_occurrence[\s\S]*本周周报：合并 12 个 PR[\s\S]*<\/previous_occurrence>/);
		expect(first).not.toContain("weekly-extra");

		await appendTaskLog(deskDir, "weekly-20261005-0900", step());
		await appendTaskLog(deskDir, "weekly-20261005-0900", stepEnd());
		expect(await briefOf(deskDir, "weekly-20261005-0900")).not.toContain("<previous_occurrence");
	});
});

describe("team board (spec 052, D5)", () => {
	const body = renderStandardTaskBody({
		title: "T",
		goal: "G",
		dod: "- [ ] D",
		items: [{ text: "collect" }, { text: "implement" }, { text: "review" }],
	});

	it("groups dispatches under their item, with paths and never the output text", async () => {
		const deskDir = tempDir();
		await writeTask(deskDir, "T", body);
		expect(await briefOf(deskDir, "T")).not.toContain("<task_board>");
		await appendTaskLog(deskDir, "T", { kind: "dispatch", ref: "run_a", item: "W1", agent: "explorer" });
		await appendTaskLog(deskDir, "T", {
			kind: "settle",
			ref: "run_a",
			item: "W1",
			status: "completed",
			output: "/o/a.md",
		});
		const oldInputs = (await readTaskLog(deskDir, "T")).filter(
			(record) => record.kind === "settle" || record.kind === "message",
		);
		await appendTaskLog(deskDir, "T", {
			kind: "input_ack",
			ids: oldInputs.flatMap((record) => (record.id ? [record.id] : [])),
		});
		await appendTaskLog(deskDir, "T", step());
		await appendTaskLog(deskDir, "T", { kind: "dispatch", ref: "run_b", item: "W2", agent: "builder" });
		await appendTaskLog(deskDir, "T", {
			kind: "dispatch",
			ref: "run_c",
			item: "W3",
			agent: "reviewer",
			purpose: "verify",
		});
		await appendTaskLog(deskDir, "T", {
			kind: "settle",
			ref: "run_b",
			item: "W2",
			status: "completed",
			output: "/o/b.md",
		});
		await appendTaskLog(deskDir, "T", { kind: "dispatch", ref: "job_x", agent: "job" });

		const board = buildTaskBoard(await readTaskLog(deskDir, "T"), body);
		const rendered = renderTaskBoard(board!);
		const lines = rendered.split("\n");
		expect(lines.find((line) => line.includes("run_a"))).toContain("/o/a.md");
		expect(lines.find((line) => line.includes("run_c"))).toMatch(/verify.*running/);
		expect(lines.find((line) => line.includes("job_x"))).toContain("未关联工作项");
		// The board carries paths, never the output text.
		expect(rendered).toContain("/o/b.md");
	});

	it("folds already-seen settled refs beyond the line budget but never running or new ones", async () => {
		const deskDir = tempDir();
		await writeTask(deskDir, "T", body);
		const total = BOARD_REF_LINE_BUDGET + 5;
		for (let index = 0; index < total; index++) {
			await appendTaskLog(deskDir, "T", { kind: "dispatch", ref: `run_${index}`, agent: "a" });
			await appendTaskLog(deskDir, "T", { kind: "settle", ref: `run_${index}`, status: "completed" });
		}
		await appendTaskLog(deskDir, "T", step());
		await appendTaskLog(deskDir, "T", { kind: "dispatch", ref: "run_live", agent: "a" });

		const board = buildTaskBoard(await readTaskLog(deskDir, "T"), body);
		expect(board?.hiddenSettled).toBe(total + 1 - BOARD_REF_LINE_BUDGET);
		expect(renderTaskBoard(board!)).toContain("run_live");
	});
});

// Spec 053 D2: `/tasks show` used to reuse the brief's renderers, so the chat got `↳` continuation
// lines (DingTalk drops the indent), `VERDICT`/`exit` field dumps and a pointer at the `task_log`
// tool. The user renderers share the data, not the output; these pin the shape, not the wording.
describe("user-facing task board and log (spec 053, D2)", () => {
	const body = renderStandardTaskBody({
		title: "T",
		goal: "G",
		dod: "- [ ] D",
		items: [{ text: "implement" }, { text: "review" }],
	});

	it("folds every ref of a work item into its one flat line and keeps model vocabulary out", async () => {
		const deskDir = tempDir();
		await writeTask(deskDir, "T", body);
		for (let index = 0; index < BOARD_REF_LINE_BUDGET + 2; index++) {
			await appendTaskLog(deskDir, "T", { kind: "dispatch", ref: `run_old${index}`, agent: "a" });
			await appendTaskLog(deskDir, "T", {
				kind: "settle",
				ref: `run_old${index}`,
				status: "failed",
				exitCode: 1,
			});
		}
		await appendTaskLog(deskDir, "T", step(1));
		await appendTaskLog(deskDir, "T", stepEnd(1, "waiting\non W1"));
		await appendTaskLog(deskDir, "T", { kind: "dispatch", ref: "run_a1", item: "W1", agent: "builder" });
		await appendTaskLog(deskDir, "T", { kind: "dispatch", ref: "run_a2", item: "W1", agent: "builder" });
		await appendTaskLog(deskDir, "T", {
			kind: "settle",
			ref: "run_a1",
			item: "W1",
			status: "completed",
			verdict: "pass",
			exitCode: 0,
		});

		const board = buildTaskBoard(await readTaskLog(deskDir, "T"), body);
		const rendered = renderTaskBoardForUser(board!, "T");
		const lines = rendered.split("\n");
		expect(lines.filter((line) => line.includes("run_a1"))).toHaveLength(1);
		expect(lines.find((line) => line.includes("run_a1"))).toContain("run_a2");
		// Fold notice is there (hidden refs exist) and points at a command, not a tool.
		expect(board?.hiddenSettled).toBeGreaterThan(0);
		expect(rendered).toContain("/tasks log T");

		const logLines = (await readTaskLog(deskDir, "T")).map(renderTaskLogLineForUser);
		for (const text of [rendered, ...logLines]) {
			expect(text).not.toMatch(/^\s/m);
			expect(text).not.toMatch(/task_log|VERDICT|↳|\bexit \d|\bcontinue\b|\bpark\b|\btimeout\b/);
		}
		// A multi-line note stays on its bullet.
		expect(logLines.every((line) => !line.includes("\n"))).toBe(true);
	});
});
