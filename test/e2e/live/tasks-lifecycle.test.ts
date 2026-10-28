import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseTaskFrontmatter } from "../../../src/tasks/frontmatter.js";
import { createRuntimeHarness, type E2ERuntimeHarness } from "../../support/runtime-harness.js";
import { canRunE2E, getE2ESkipReason } from "../../support/setup.js";
import { waitFor } from "../helpers/wait.js";

const describeE2E = canRunE2E() ? describe : describe.skip;

// The task ledger is the load-bearing mechanism for autonomous long-running work: a real model
// must (1) turn a natural-language request into a governed task file via task_create, and (2) have
// the task lane run it in the background — real task brief, task-session tools, closing it with
// task_close — while the chat stays free (spec 064). The DoD deliberately avoids anything that would
// trigger a (slow, multi-tool-call) independent verifier.
describeE2E("E2E: task lifecycle", () => {
	let harness: E2ERuntimeHarness;
	const taskId = "e2e-lifecycle-task";

	beforeAll(async () => {
		harness = await createRuntimeHarness({ startServices: true });
	});

	afterAll(async () => {
		await harness.shutdown();
	});

	function activeTaskPath(): string {
		return join(harness.deskDir, "tasks", `${taskId}.md`);
	}
	function archivedTaskPath(): string {
		return join(harness.deskDir, "tasks", "archive", `${taskId}.md`);
	}
	it("creates a governed task from natural language", async () => {
		await harness.sendUserMessage(
			`帮我建一个任务台账，id 用 ${taskId}，标题随意，目标是记录一个数字。` +
				"DoD 只写一条 checkbox：把数字 42 记录下来。" +
				"创建后它会在后台自己推进。",
		);

		const path = existsSync(activeTaskPath()) ? activeTaskPath() : archivedTaskPath();
		expect(existsSync(path), getE2ESkipReason() ?? undefined).toBe(true);
		const frontmatter = parseTaskFrontmatter(readFileSync(path, "utf-8"));
		expect(frontmatter.readable).toBe(true);
		expect(frontmatter.fields.outcome).toBeUndefined();
		// DoD must be real checklist items, not prose/numbered text — see the
		// `uncheckedTaskAcceptanceItems` regression coverage in task-ledger.test.ts
		// for the parser contract this depends on.
		expect(readFileSync(path, "utf-8")).toMatch(/-\s+\[[ xX]\]/);
	});

	it("runs the task in the background: the lane drives it to its end and leaves the evidence in the log", async () => {
		await waitFor("the task to be archived", () => existsSync(archivedTaskPath()), {
			timeoutMs: 240_000,
			intervalMs: 2_000,
		});
		const frontmatter = parseTaskFrontmatter(readFileSync(archivedTaskPath(), "utf-8"));
		expect(frontmatter.readable).toBe(true);
		expect(frontmatter.fields.outcome).toBe("completed");
		// The evidence lives in the task's log, not inline in the contract.
		expect(readFileSync(join(harness.deskDir, "tasks", "archive", `${taskId}.jsonl`), "utf-8")).toContain("42");
	});
});
