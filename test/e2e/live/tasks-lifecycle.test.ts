import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTaskDriverEvent } from "../../../src/runtime/task-driver.js";
import { parseTaskFrontmatterV4 } from "../../../src/tasks/frontmatter.js";
import { readActiveTasks } from "../../../src/tasks/ledger.js";
import { createRuntimeHarness, type E2ERuntimeHarness } from "../../support/runtime-harness.js";
import { canRunE2E, getE2ESkipReason } from "../../support/setup.js";

const describeE2E = canRunE2E() ? describe : describe.skip;

// The task ledger is the load-bearing mechanism for autonomous long-running
// work (docs/tasks.md): a real model must (1) turn a natural-language request
// into a governed task file via the task_create / task_update / task_close tools
// (spec 046 split the old single `task_manage` tool), and (2) correctly resume
// that task from the *real* driver wake prompt built by createTaskDriverEvent
// (src/runtime/task-driver.ts) — not a hand-copied paraphrase, which cannot
// catch drift in the very text it is meant to guard (spec 048 F3). The DoD
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
				"DoD 只写一条 checkbox：把数字 42 记录下来。" +
				"不要求独立验收。现在先不要开始做，只创建任务即可。",
		);

		expect(existsSync(activeTaskPath()), getE2ESkipReason() ?? undefined).toBe(true);
		const frontmatter = parseTaskFrontmatterV4(readFileSync(activeTaskPath(), "utf-8"));
		expect(frontmatter.readable).toBe(true);
		expect(frontmatter.fields.state).not.toBe("done");
		expect(frontmatter.fields.verify).toBeUndefined();
		// DoD must be real checklist items, not prose/numbered text — see the
		// `uncheckedTaskAcceptanceItems` regression coverage in task-ledger.test.ts
		// for the parser contract this depends on.
		expect(readFileSync(activeTaskPath(), "utf-8")).toMatch(/-\s+\[[ xX]\]/);
	});

	it("resumes the task from a driver-style wake prompt and checkpoints progress", async () => {
		const before = readFileSync(activeTaskPath(), "utf-8");

		// Use the exact wake text production sends, derived from the task file on disk.
		const entry = (await readActiveTasks(join(harness.channelDir, "tasks"))).find((e) => e.id === taskId);
		expect(entry, "task must exist before it can be resumed").toBeDefined();
		const driverEvent = createTaskDriverEvent(harness.channelId, entry!, Date.now());
		await harness.sendUserMessage(driverEvent.text, { user: "TASK_DRIVER", userName: "TASK_DRIVER" });

		// The DoD is trivially satisfiable in one step, so the model may legitimately drive
		// straight through to `done` and archive rather than parking. Either outcome is correct;
		// both must leave a readable contract behind, and the evidence in the loop log.
		expect(existsSync(currentTaskPath()), getE2ESkipReason() ?? undefined).toBe(true);
		const after = readFileSync(currentTaskPath(), "utf-8");
		expect(after).not.toBe(before);

		const frontmatter = parseTaskFrontmatterV4(after);
		expect(frontmatter.readable).toBe(true); // frontmatter still parses after the agent's edit
		// The evidence lives in the loop log now, not inline in the contract (spec 051, D5).
		const logPath = existsSync(join(harness.channelDir, "tasks", `${taskId}.jsonl`))
			? join(harness.channelDir, "tasks", `${taskId}.jsonl`)
			: join(harness.channelDir, "tasks", "archive", `${taskId}.jsonl`);
		expect(readFileSync(logPath, "utf-8")).toContain("42");
	});
});
