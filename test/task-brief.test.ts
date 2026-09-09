import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PLAYBOOKS_DIR } from "../src/paths.js";
import { buildTaskStepBrief } from "../src/tasks/brief.js";
import { createCycle } from "../src/tasks/cycle.js";
import { renderTaskDocument } from "../src/tasks/ledger.js";
import { appendTaskLog, resetTaskLogAppenders } from "../src/tasks/log.js";
import { useTempDirs } from "./helpers/fixtures.js";

const tempDir = useTempDirs("pipiclaw-task-brief-");
afterEach(resetTaskLogAppenders);

describe("task step context", () => {
	it("recovers an unhandled expiry from durable history and stops announcing it after a recovery step", async () => {
		const channelDir = tempDir();
		await mkdir(join(channelDir, "tasks"));
		const path = join(channelDir, "tasks", "work.md");
		await writeFile(path, renderTaskDocument({ state: "open", cycle: createCycle("c-1") }, "# Work\n"));
		await appendTaskLog(channelDir, "work", {
			cycle: "c-1",
			kind: "expired",
			ticket: "run_lost",
			action: "reopened",
		});
		// A verification result landing after the expiry must not erase the recovery instruction.
		await appendTaskLog(channelDir, "work", {
			cycle: "c-1",
			kind: "round",
			n: 1,
			verifyRunId: "run_v",
			verdict: "fail",
			strength: "advisory",
		});
		const brief = await buildTaskStepBrief({ channelDir, taskId: "work" });
		expect(brief).toContain(path);
		expect(brief).toContain(join(PLAYBOOKS_DIR, "task-loop.md"));
		expect(brief).toMatch(/<task_recovery kind="expired">[\s\S]*run_lost[\s\S]*<\/task_recovery>/);
		await appendTaskLog(channelDir, "work", {
			cycle: "c-1",
			kind: "step",
			seq: 1,
			outcome: "continue",
			note: "checked producer state",
			tools: ["read"],
		});
		expect(await buildTaskStepBrief({ channelDir, taskId: "work" })).not.toContain("<task_recovery");
		await writeFile(path, renderTaskDocument({ state: "open", cycle: createCycle("c-2") }, "# Work\n"));
		expect(await buildTaskStepBrief({ channelDir, taskId: "work" })).not.toContain("run_lost");
	});
});
