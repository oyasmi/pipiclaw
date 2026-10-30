import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileStore } from "../src/file-store.js";
import { createUsage } from "../src/tasks/budget.js";
import { renderTaskDocument } from "../src/tasks/contract.js";
import { appendTaskLog, readTaskLog, resetTaskLogAppenders } from "../src/tasks/loop-log.js";
import {
	archivedTaskPath,
	beginStep,
	closeTask,
	endStep,
	pauseTask,
	readStoredTask,
	reconcileTaskState,
	requeueWaiting,
	resumeTask,
} from "../src/tasks/store.js";
import { createEditTool } from "../src/tools/edit.js";
import { createWriteTool } from "../src/tools/write.js";
import { spawnLockHolder } from "./helpers/lock-holder.js";

let dir: string;

const ok = { result: "ok" as const, note: "did it", tools: ["bash"] };
const noFacts = { result: "ok" as const, closed: false, pausedByUser: false, pendingWork: 0 };

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "task-store-"));
	await mkdir(join(dir, "tasks"), { recursive: true });
	await writeFile(
		join(dir, "tasks", "T.md"),
		renderTaskDocument({ state: "queued", usage: createUsage() }, "# T\n\n## Goal\nDo it.\n"),
	);
});

afterEach(async () => {
	await resetTaskLogAppenders();
});

describe("a step's two writes (spec 064, D14)", () => {
	it("begins by writing state and the step record together, reading the news in the same lock hold", async () => {
		// A message that landed before the step is news to it; one that lands after the `step` record is news to the next.
		const beforeId = await appendTaskLog(dir, "T", { kind: "message", from: "u", channel: "c", text: "before" });
		const begun = await beginStep(dir, "T", { brief: "full" });
		expect(begun).toMatchObject({ seq: 1, reason: "start" });
		expect(begun?.inputs.map((input) => input.kind)).toEqual(["message"]);
		expect((await readStoredTask(dir, "T"))?.fields.state).toBe("running");

		await appendTaskLog(dir, "T", { kind: "input_ack", ids: [beforeId] });
		await appendTaskLog(dir, "T", { kind: "message", from: "u", channel: "c", text: "during" });
		const ended = await endStep(dir, "T", { seq: 1, ...ok, facts: { ...noFacts, pendingWork: 1 } });
		expect(ended?.derivation.next).toBe("work");
		const document = await readStoredTask(dir, "T");
		expect(document?.fields).toMatchObject({ state: "waiting", waiting: { kind: "work" }, usage: { steps: 1 } });
		expect((await beginStep(dir, "T", { brief: "delta" }))?.inputs.map((input) => input.kind)).toEqual(["message"]);
	});

	it("refuses to begin a step on a task the user paused or that waits for the user", async () => {
		await pauseTask(dir, "T", { by: "user", reason: "hold" });
		expect(await beginStep(dir, "T", { brief: "full" })).toBeUndefined();
		await resumeTask(dir, "T");
		await beginStep(dir, "T", { brief: "full" });
		await endStep(dir, "T", {
			seq: 1,
			...ok,
			facts: { ...noFacts, asked: { question: "merge?" } },
		});
		expect(await beginStep(dir, "T", { brief: "delta" })).toBeUndefined();
	});

	it("leaves a task the user paused mid-step paused, whatever the step then asked for", async () => {
		await beginStep(dir, "T", { brief: "full" });
		await pauseTask(dir, "T", { by: "user", reason: "hold" });
		const ended = await endStep(dir, "T", { seq: 1, ...ok, facts: { ...noFacts, asked: { question: "q?" } } });
		expect(ended?.derivation.next).toBe("paused");
		expect((await readStoredTask(dir, "T"))?.fields).toMatchObject({ state: "paused", usage: { steps: 1 } });
	});
});

describe("pause and resume", () => {
	it("pause records itself once; resume puts the grant on top of what was spent", async () => {
		const usage = { ...createUsage(), steps: 4, usd: 1.5 };
		await writeStored({
			state: "paused",
			paused: { by: "runtime", reason: "budget", at: "2026-01-01T00:00:00+08:00" },
			usage,
		});

		expect(await pauseTask(dir, "T", { by: "user", reason: "again" })).toBeUndefined();
		expect(await resumeTask(dir, "T", { steps: 10, usd: 5 })).toBeDefined();
		const resumed = await readStoredTask(dir, "T");
		expect(resumed?.fields).toMatchObject({ state: "queued", paused: undefined, budget: { steps: 14, usd: 6.5 } });
		expect(await resumeTask(dir, "T")).toBeUndefined();
		expect((await readTaskLog(dir, "T")).map((record) => record.kind)).toEqual(["resume"]);
	});

	it("wakes a wait only from a wait", async () => {
		expect(await requeueWaiting(dir, "T")).toBeDefined();
		await writeStored({
			state: "waiting",
			waiting: { kind: "user", question: "q", since: "2026-01-01T00:00:00+08:00" },
		});
		await requeueWaiting(dir, "T");
		expect((await readStoredTask(dir, "T"))?.fields).toMatchObject({ state: "queued", waiting: undefined });
	});
});

describe("closing", () => {
	it("records the close and archives the contract with its log", async () => {
		await writeFile(
			join(dir, "tasks", "T.md"),
			renderTaskDocument({ state: "queued", usage: createUsage() }, "# T\n\n## DoD\n- [x] checked\n"),
		);
		const reportId = await appendTaskLog(dir, "T", { kind: "report", seq: 1, text: "delivered", delivered: true });
		await closeTask(dir, "T", { outcome: "complete", by: "leader", note: "done", reportId });
		expect(existsSync(join(dir, "tasks", "T.md"))).toBe(false);
		expect(existsSync(archivedTaskPath(dir, "T"))).toBe(true);
		expect((await readStoredTask(dir, "T", true))?.fields.outcome).toBe("completed");
		expect(await readTaskLog(dir, "T")).toMatchObject([
			{ kind: "report" },
			{ kind: "close", outcome: "done", by: "leader" },
		]);
		expect(await closeTask(dir, "T", { outcome: "cancel", by: "user", note: "again" })).toBeUndefined();
	});
});

describe("restart reconciliation, written (D10)", () => {
	it("gives an interrupted step its end record exactly once", async () => {
		// R1/R5: crash after a committed log write but before snapshot/prompt persistence.
		const initial = await readFile(join(dir, "tasks", "T.md"), "utf-8");
		await appendTaskLog(dir, "T", { kind: "message", from: "u", channel: "c", text: "UNSEEN_INPUT" });
		await beginStep(dir, "T", { brief: "full" });
		await writeFile(join(dir, "tasks", "T.md"), initial);
		expect(await reconcileTaskState(dir, "T", 0)).toBe(true);
		expect(await reconcileTaskState(dir, "T", 0)).toBe(false);
		const records = await readTaskLog(dir, "T");
		expect(records.filter((record) => record.kind.startsWith("step")).map((record) => record.kind)).toEqual([
			"step",
			"step_end",
		]);
		expect(records.find((record) => record.kind === "step_end")).toMatchObject({
			result: "interrupted",
			next: "continue",
		});
		expect((await readStoredTask(dir, "T"))?.fields).toMatchObject({ state: "queued", usage: { steps: 1 } });
		const retry = await beginStep(dir, "T", { brief: "full" });
		expect(retry?.inputs).toEqual(expect.arrayContaining([expect.objectContaining({ text: "UNSEEN_INPUT" })]));
		const beforeEnd = await readFile(join(dir, "tasks", "T.md"), "utf-8");
		await endStep(dir, "T", { seq: 2, ...ok, usd: 4, facts: { ...noFacts, asked: { question: "merge?" } } });
		await writeFile(join(dir, "tasks", "T.md"), beforeEnd);
		expect(await reconcileTaskState(dir, "T", 0)).toBe(true);
		expect(await reconcileTaskState(dir, "T", 0)).toBe(false);
		expect((await readStoredTask(dir, "T"))?.fields).toMatchObject({
			state: "waiting",
			waiting: { kind: "user", question: "merge?" },
			usage: { steps: 2, usd: 4 },
		});
	});
});

describe("cross-process task mutation (spec 058, D6)", () => {
	it("waits while another process holds the task's lock", async () => {
		// Failure caught: withTaskMutation serializing only in-process would let a TUI's /tasks and
		// the daemon's lane rewrite the same task file from stale reads.
		const holder = await spawnLockHolder(join(dir, ".locks", "task-T.lock"));
		let settled = false;
		let edited = false;
		const edit = createEditTool(createFileStore(), { deskDir: dir, securityConfig: { enabled: false } as never })
			.execute("edit", { path: join(dir, "tasks", "T.md"), oldText: "Do it.", newText: "Done." })
			.then(() => {
				edited = true;
			});
		const paused = pauseTask(dir, "T", { by: "user", reason: "hold" }).finally(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(settled).toBe(false);
		expect(edited).toBe(false); // R9: generic edit must honor the runtime's task lock too.
		expect((await readStoredTask(dir, "T"))?.fields.state).toBe("queued");
		await holder.release();
		await Promise.all([paused, edit]);
		expect((await readStoredTask(dir, "T"))?.fields.state).toBe("paused");
		expect((await readStoredTask(dir, "T"))?.body).toContain("Done.");
		await createWriteTool(createFileStore(), { deskDir: dir, securityConfig: { enabled: false } as never }).execute(
			"write",
			{
				path: join(dir, "tasks", "T.md"),
				content: renderTaskDocument({ state: "running" }, "# T\n\n## Goal\nRevised.\n"),
			},
		);
		expect((await readStoredTask(dir, "T"))?.fields.state).toBe("paused");
		expect((await readStoredTask(dir, "T"))?.body).toContain("Revised.");
		await mkdir(join(dir, "tasks", ".closing"));
		await writeFile(join(dir, "tasks", ".closing", "T.json"), "{}");
		await expect(
			createEditTool(createFileStore(), { deskDir: dir, securityConfig: { enabled: false } as never }).execute(
				"edit",
				{ path: join(dir, "tasks", "T.md"), oldText: "Revised.", newText: "Lost." },
			),
		).rejects.toThrow(/committing its archive/);
		expect((await readStoredTask(dir, "T"))?.body).toContain("Revised.");
	});
});

async function writeStored(fields: Parameters<typeof renderTaskDocument>[0]): Promise<void> {
	await writeFile(join(dir, "tasks", "T.md"), renderTaskDocument(fields, "# T\n\n## Goal\nDo it.\n"));
}
