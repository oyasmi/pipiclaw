import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { readProjectSelection } from "../../../src/channel/project-scope-store.js";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";

describe("E2E deterministic: path guard & /project", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		await harness.shutdown();
	});

	it("A19: an out-of-bounds write is rejected + audited; /project set moves the root", async () => {
		// Mutation check: drop the isWithinProjectRoot / boundary check in path-guard and
		// the first write below succeeds (no rejection reaches the model, nothing audited).
		// `/project set` runs via the direct runtime-command path (as the TUI and the busy
		// DingTalk switch do); the idle transport queue reserves a turn for it and the
		// command then reports itself busy — tracked separately.
		harness = await createDeterministicHarness({ projectAccess: true });
		const rootB = harness.projectRootB!;
		const targetInB = join(rootB, "out.txt");
		const writeThenAnswer = () => [
			reply.toolCall("write", { path: targetInB, content: "hello from the agent" }),
			reply.text("处理完毕。"),
		];
		harness.model.script.route({
			name: "write-B",
			when: (r) => r.isMainTurn && r.lastUserText.includes("WRITE_B"),
			respond: [...writeThenAnswer(), ...writeThenAnswer()],
		});

		// Project root is A; a write into B is outside the boundary.
		await harness.sendUserMessage("WRITE_B 请写文件");
		expect(existsSync(targetInB)).toBe(false);
		expect(JSON.stringify(harness.mainTurnRequests().at(-1)?.messages)).toContain("outside the current project root");
		expect(harness.readAuditLog()).toContain("out.txt");
		// Spec 053 D5.2: the model keeps the English refusal (asserted above), while the channel
		// gets a line rendered from the refusal's structured form — it names the blocked path and
		// carries none of the model text. Mutation check (2026-10-12): dropping the `blocked`
		// branch in session-events.ts falls back to the error's first line ("Path blocked
		// [outside-allowed-roots]"), which has no path, and the first assertion goes red.
		const delivered = harness.deliveries.map((d) => d.text ?? "").join("\n");
		expect(delivered).toContain(targetInB);
		expect(delivered).not.toMatch(/Path blocked|Resolved path/);

		// Move the root to B, then the same write is inside the boundary.
		await harness.runCommand("project", `set ${rootB}`);
		expect(readProjectSelection(harness.channelDir)?.projectRoot).toBe(rootB);
		await harness.sendUserMessage("WRITE_B 再试一次");
		expect(existsSync(targetInB)).toBe(true);
		expect(readFileSync(targetInB, "utf-8")).toContain("hello from the agent");
	});

	it("A19: /project set is refused while a turn is running", async () => {
		harness = await createDeterministicHarness({ projectAccess: true });
		harness.model.script.route({ name: "t", when: (r) => r.isMainTurn, respond: [reply.text("ok")], repeat: true });
		const gate = harness.model.script.hold({ when: (r) => r.isMainTurn && r.lastUserText.includes("LONG") });

		await harness.sendUserMessageNoWait("LONG 任务开始");
		await gate.arrived;

		// Mechanism, not wording (AGENTS.md e2e rule #2): the busy-turn guard must actually block
		// the change, not just word a warning around one that went through anyway — assert the
		// persisted selection never moved to root B while the turn was running. Mutation check
		// (review 2026-08-30): short-circuiting `project-commands.ts`'s `options.isBusy()` check
		// turns this red (the selection moves to root B).
		await harness.runCommand("project", `set ${harness.projectRootB}`);
		expect(readProjectSelection(harness.channelDir)?.projectRoot).not.toBe(harness.projectRootB);

		gate.release();
		await harness.waitForIdle();
	});
});
