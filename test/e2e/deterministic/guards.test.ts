import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";
import { waitFor } from "../helpers/wait.js";

describe("E2E deterministic: path guard & /project", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		harness.assertNoUnmatchedRequests();
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

		// Move the root to B, then the same write is inside the boundary.
		const setReply = await harness.runCommand("project", `set ${rootB}`);
		expect(setReply).not.toContain("无法");
		await harness.sendUserMessage("WRITE_B 再试一次");
		expect(existsSync(targetInB)).toBe(true);
		expect(readFileSync(targetInB, "utf-8")).toContain("hello from the agent");
	});

	it("A19: /project set is refused while a turn is running", async () => {
		harness = await createDeterministicHarness({ projectAccess: true });
		harness.model.script.route({ name: "t", when: (r) => r.isMainTurn, respond: [reply.text("ok")], repeat: true });
		const gate = harness.model.script.hold({ when: (r) => r.isMainTurn && r.lastUserText.includes("LONG") });

		await harness.sendUserMessageNoWait("LONG 任务开始");
		await waitFor("turn running", () => harness.mainTurnRequests().length >= 1, { intervalMs: 20 });

		const reply1 = await harness.runCommand("project", `set ${harness.projectRootB}`);
		expect(reply1).toContain("回合正在进行");

		gate.release();
		await harness.waitForIdle();
	});
});
