import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { getBindingsPath } from "../../../src/desk/paths.js";
import { createDeskRecord } from "../../../src/desk/registry.js";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";

describe("E2E deterministic: path guard", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		await harness.shutdown();
	});

	it("A19: an out-of-bounds write is rejected + audited", async () => {
		// `/srv` is outside the default roots (workspace, home, temp) without being a denied system
		// prefix, so the refusal comes from the allowed-roots check itself. Mutation check
		// (2026-10-18, spec 058 P1): making `pathAllowedByDefaults` return true lets the write
		// reach the file system — nothing is audited and the refusal never reaches the model.
		harness = await createDeterministicHarness();
		const target = "/srv/pipiclaw-e2e-guard/out.txt";
		harness.model.script.route({
			name: "write-outside",
			when: (r) => r.isMainTurn && r.lastUserText.includes("WRITE_OUTSIDE"),
			respond: [
				reply.toolCall("write", { path: target, content: "hello from the agent" }),
				reply.text("处理完毕。"),
			],
		});

		await harness.sendUserMessage("WRITE_OUTSIDE 请写文件");
		expect(existsSync(target)).toBe(false);
		expect(JSON.stringify(harness.mainTurnRequests().at(-1)?.messages)).toContain(
			"outside workspace, home, and temp paths",
		);
		expect(harness.readAuditLog()).toContain("out.txt");
		// Spec 053 D5.2: the model keeps the English refusal (asserted above), while the channel
		// gets a line rendered from the refusal's structured form — it names the blocked path and
		// carries none of the model text. Mutation check (2026-10-12): dropping the `blocked`
		// branch in session-events.ts falls back to the error's first line ("Path blocked
		// [outside-allowed-roots]"), which has no path, and the first assertion goes red.
		const delivered = harness.deliveries.map((d) => d.text ?? "").join("\n");
		expect(delivered).toContain(target);
		expect(delivered).not.toMatch(/Path blocked|Resolved path/);
	});

	it("A19: `/desk bind` is refused while the channel has a turn in flight", async () => {
		// Catches a rebind under a running turn: its runner would be disposed mid-turn and its tail
		// written into a desk the channel no longer belongs to. Mutation check (2026-10-18): removing
		// the busy check in `DeskRuntime.bind` rebinds mid-turn — `bindings.json` changes and the
		// next turn lands in `lab`.
		harness = await createDeterministicHarness();
		createDeskRecord(harness.workspaceDir, "lab", new Date());
		harness.model.script.route({
			name: "turn",
			when: (r) => r.isMainTurn,
			respond: [reply.text("ok")],
			repeat: true,
		});
		const bindingsBefore = readFileSync(getBindingsPath(harness.workspaceDir), "utf8");
		const gate = harness.model.script.hold({ when: (r) => r.isMainTurn && r.lastUserText.includes("HELD_TURN") });
		await harness.sendUserMessageNoWait("HELD_TURN");
		await gate.arrived;
		try {
			// The busy transport answers `/desk` at once, on the runtime-command path.
			await harness.sendUserMessageNoWait("/desk bind lab");
		} finally {
			gate.release();
		}
		await harness.waitForIdle();
		expect(readFileSync(getBindingsPath(harness.workspaceDir), "utf8")).toBe(bindingsBefore);

		await harness.sendUserMessage("AFTER_REFUSAL");
		expect(readFileSync(join(harness.conversationDir, "context.jsonl"), "utf8")).toContain("AFTER_REFUSAL");
		expect(existsSync(join(harness.workspaceDir, "desk-lab", "conversations", "dm-1"))).toBe(false);
	});
});
