import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseTaskFrontmatter } from "../../src/shared/task-ledger.js";
import { createRuntimeHarness, type E2ERuntimeHarness } from "../support/runtime-harness.js";
import { canRunE2E, getE2ESkipReason } from "../support/setup.js";

const describeE2E = canRunE2E() ? describe : describe.skip;

// The task ledger is the load-bearing mechanism for autonomous long-running
// work (docs/tasks.md): a real model must (1) turn a natural-language request
// into a governed task file via task_manage, and (2) correctly resume that
// task from a driver-style wake prompt — the exact text the native task
// driver sends in production (src/runtime/task-driver.ts,
// createTaskDriverEvent). No prior e2e spec exercised this at all; the DoD
// deliberately avoids anything that would trigger the (slow, multi-tool-call)
// independent verifier lane, which is out of scope for this spec.
describeE2E("E2E: task lifecycle", () => {
	let harness: E2ERuntimeHarness;
	const taskId = "e2e-lifecycle-task";

	beforeAll(async () => {
		harness = await createRuntimeHarness();
	});

	afterAll(async () => {
		await harness.shutdown();
	});

	function activeTaskPath(): string {
		return join(harness.channelDir, "tasks", `${taskId}.md`);
	}
	function archivedTaskPath(): string {
		return join(harness.channelDir, "tasks", "archive", `${taskId}.md`);
	}
	/** The task may still be open (progress-only) or fully closed and archived by the same turn. */
	function currentTaskPath(): string {
		return existsSync(archivedTaskPath()) ? archivedTaskPath() : activeTaskPath();
	}

	it("creates a governed task from natural language", async () => {
		await harness.sendUserMessage(
			`帮我建一个任务台账，id 用 ${taskId}，标题随意，目标是记录一个数字。` +
				"DoD 只写一条 checkbox：把数字 42 记录到任务的 Current Cycle 里。" +
				"verification 用 evidence 模式（不需要独立验证）。现在先不要开始做，只创建任务即可。",
		);

		expect(existsSync(activeTaskPath()), getE2ESkipReason() ?? undefined).toBe(true);
		const frontmatter = parseTaskFrontmatter(readFileSync(activeTaskPath(), "utf-8"));
		expect(frontmatter.readable).toBe(true);
		expect(frontmatter.status).not.toBe("done");
		expect(frontmatter.control?.verification.mode).toBe("evidence");
		// DoD must be real checklist items, not prose/numbered text — see the
		// `uncheckedTaskAcceptanceItems` regression coverage in task-ledger.test.ts
		// for the parser contract this depends on.
		expect(readFileSync(activeTaskPath(), "utf-8")).toMatch(/-\s+\[[ xX]\]/);
	});

	it("resumes the task from a driver-style wake prompt and checkpoints progress", async () => {
		const before = readFileSync(activeTaskPath(), "utf-8");

		// Mirrors createTaskDriverEvent's real production text (src/runtime/task-driver.ts)
		// closely enough to exercise the same SOP a live driver wake would trigger.
		await harness.sendUserMessage(
			`[TASK_DRIVER:${taskId}] Resume task ${taskId}. Open tasks/${taskId}.md, advance the next concrete step, ` +
				"and atomically record what changed with task_manage progress (or task_manage done if the DoD is fully " +
				"satisfied). If no user-visible update is needed, respond with [SILENT].",
		);

		// The evidence-mode DoD is trivially satisfiable in one turn, so the model may
		// legitimately drive straight through progress -> done -> archive, not just
		// checkpoint and stop. Either outcome is correct; both must leave a task file
		// behind with the checkpoint evidence and parsable control metadata.
		expect(existsSync(currentTaskPath()), getE2ESkipReason() ?? undefined).toBe(true);
		const after = readFileSync(currentTaskPath(), "utf-8");
		expect(after).not.toBe(before);
		expect(after).toContain("42");

		const frontmatter = parseTaskFrontmatter(after);
		expect(frontmatter.readable).toBe(true); // control JSON still parses after the agent's edit
	});
});
