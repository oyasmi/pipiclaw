import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PLAYBOOKS_DIR } from "../src/paths.js";
import { BOARD_REF_LINE_BUDGET, buildTaskBoard, renderTaskBoard } from "../src/tasks/board.js";
import { buildTaskStepBrief } from "../src/tasks/brief.js";
import { createUsage } from "../src/tasks/budget.js";
import type { TaskFrontmatter } from "../src/tasks/frontmatter.js";
import { renderStandardTaskBody, renderTaskDocument } from "../src/tasks/ledger.js";
import { appendTaskLog, resetTaskLogAppenders } from "../src/tasks/log.js";
import { archiveTask } from "../src/tasks/store.js";
import { useTempDirs } from "./helpers/fixtures.js";

const tempDir = useTempDirs("pipiclaw-task-brief-");
afterEach(resetTaskLogAppenders);

async function writeTask(channelDir: string, id: string, body: string, fields: Partial<TaskFrontmatter> = {}) {
	await mkdir(join(channelDir, "tasks"), { recursive: true });
	const path = join(channelDir, "tasks", `${id}.md`);
	await writeFile(path, renderTaskDocument({ state: "open", usage: createUsage(), ...fields }, body));
	return path;
}

const step = (note: string, seq = 1) => ({
	kind: "step" as const,
	seq,
	outcome: "continue" as const,
	note,
	tools: ["read"],
});

describe("task step brief", () => {
	it("recovers an unhandled expiry from durable history and stops announcing it after a recovery step", async () => {
		const channelDir = tempDir();
		const path = await writeTask(channelDir, "work", "# Work\n");
		await appendTaskLog(channelDir, "work", { kind: "expired", ticket: "run_lost", action: "reopened" });
		// A settlement landing after the expiry must not erase the recovery instruction.
		await appendTaskLog(channelDir, "work", { kind: "settle", ref: "run_x", status: "completed" });

		const brief = await buildTaskStepBrief({ channelDir, taskId: "work" });
		expect(brief).toContain(path);
		expect(brief).toContain(join(PLAYBOOKS_DIR, "task-lead.md"));
		expect(brief).toMatch(/<task_recovery kind="expired">[\s\S]*run_lost[\s\S]*<\/task_recovery>/);

		await appendTaskLog(channelDir, "work", step("checked producer state"));
		expect(await buildTaskStepBrief({ channelDir, taskId: "work" })).not.toContain("<task_recovery");
	});

	it("carries the previous occurrence into the first step of a spawned instance only", async () => {
		const channelDir = tempDir();
		await writeTask(channelDir, "weekly-20260928-0900", "# W\n", { origin: "weekly" });
		await appendTaskLog(channelDir, "weekly-20260928-0900", {
			kind: "close",
			outcome: "done",
			note: "published, id=68",
			steps: 4,
			usd: 1,
		});
		await archiveTask(channelDir, "weekly-20260928-0900", "completed");
		// A different event whose name merely starts with this one's must not be mistaken for it.
		await writeTask(channelDir, "weekly-extra-20260929-0900", "# X\n", { origin: "weekly-extra" });
		await archiveTask(channelDir, "weekly-extra-20260929-0900", "completed");
		await writeTask(channelDir, "weekly-20261005-0900", "# W\n", { origin: "weekly" });

		const first = await buildTaskStepBrief({ channelDir, taskId: "weekly-20261005-0900" });
		expect(first).toMatch(/<previous_occurrence id="weekly-20260928-0900"[\s\S]*published, id=68/);
		expect(first).not.toContain("weekly-extra");

		await appendTaskLog(channelDir, "weekly-20261005-0900", step("collected"));
		expect(await buildTaskStepBrief({ channelDir, taskId: "weekly-20261005-0900" })).not.toContain(
			"<previous_occurrence",
		);
	});
});

describe("team board (spec 052, D5)", () => {
	const body = renderStandardTaskBody({
		title: "T",
		goal: "G",
		dod: "- [ ] D",
		items: [{ text: "collect" }, { text: "implement" }, { text: "review" }],
	});

	it("groups dispatches under their item and marks only what settled since the last step as new", async () => {
		const channelDir = tempDir();
		await writeTask(channelDir, "T", body);
		await appendTaskLog(channelDir, "T", { kind: "dispatch", ref: "run_a", item: "W1", agent: "explorer" });
		await appendTaskLog(channelDir, "T", {
			kind: "settle",
			ref: "run_a",
			item: "W1",
			status: "completed",
			output: "/o/a.md",
		});
		await appendTaskLog(channelDir, "T", step("read a"));
		await appendTaskLog(channelDir, "T", { kind: "dispatch", ref: "run_b", item: "W2", agent: "builder" });
		await appendTaskLog(channelDir, "T", {
			kind: "dispatch",
			ref: "run_c",
			item: "W3",
			agent: "reviewer",
			purpose: "verify",
		});
		await appendTaskLog(channelDir, "T", {
			kind: "settle",
			ref: "run_b",
			item: "W2",
			status: "completed",
			output: "/o/b.md",
		});
		await appendTaskLog(channelDir, "T", { kind: "dispatch", ref: "job_x", agent: "job" });

		const board = await buildTaskBoard(channelDir, "T", body);
		const rendered = renderTaskBoard(board!);
		const lines = rendered.split("\n");
		expect(lines.find((line) => line.includes("run_a"))).not.toContain("★新");
		expect(lines.find((line) => line.includes("run_b"))).toContain("★新");
		expect(lines.find((line) => line.includes("run_c"))).toMatch(/verify.*running/);
		expect(lines.find((line) => line.includes("job_x"))).toContain("未关联工作项");
		// The board carries paths, never the output text.
		expect(rendered).toContain("/o/b.md");
	});

	it("is built from the log alone, so it survives the run record being garbage-collected", async () => {
		const channelDir = tempDir();
		await writeTask(channelDir, "T", body);
		await appendTaskLog(channelDir, "T", { kind: "dispatch", ref: "run_old", item: "W1", agent: "explorer" });
		await appendTaskLog(channelDir, "T", { kind: "settle", ref: "run_old", item: "W1", status: "completed" });
		expect(renderTaskBoard((await buildTaskBoard(channelDir, "T", body))!)).toContain("run_old");
	});

	it("folds already-seen settled refs beyond the line budget but never running or new ones", async () => {
		const channelDir = tempDir();
		await writeTask(channelDir, "T", body);
		const total = BOARD_REF_LINE_BUDGET + 5;
		for (let index = 0; index < total; index++) {
			await appendTaskLog(channelDir, "T", { kind: "dispatch", ref: `run_${index}`, agent: "a" });
			await appendTaskLog(channelDir, "T", { kind: "settle", ref: `run_${index}`, status: "completed" });
		}
		await appendTaskLog(channelDir, "T", step("seen all of those"));
		await appendTaskLog(channelDir, "T", { kind: "dispatch", ref: "run_live", agent: "a" });

		const board = await buildTaskBoard(channelDir, "T", body);
		expect(board?.hiddenSettled).toBe(total + 1 - BOARD_REF_LINE_BUDGET);
		expect(renderTaskBoard(board!)).toContain("run_live");
	});

	it("is absent from the brief when nothing was ever dispatched", async () => {
		const channelDir = tempDir();
		await writeTask(channelDir, "T", body);
		expect(await buildTaskStepBrief({ channelDir, taskId: "T" })).not.toContain("<task_board>");
	});
});
