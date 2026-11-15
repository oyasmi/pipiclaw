import { existsSync, readFileSync, realpathSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

		// The initial waiting card also consumes a display interval. Hold the model after the
		// refusal, then advance the progress clock so this checks guard rendering, not HTTP speed.
		const gate = harness.model.script.hold({
			when: (r) => r.isMainTurn && r.messages.some((message) => message.role === "tool"),
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const sending = harness.sendUserMessageNoWait("WRITE_OUTSIDE 请写文件");
		try {
			await gate.arrived;
			await vi.advanceTimersByTimeAsync(800);
		} finally {
			vi.useRealTimers();
			gate.release();
			await sending;
			await harness.waitForIdle();
		}
		expect(existsSync(target)).toBe(false);
		expect(JSON.stringify(harness.mainTurnRequests().at(-1)?.messages)).toContain(
			"outside workspace, home, and temp paths",
		);
		expect(harness.readAuditLog()).toContain("out.txt");
		// Spec 053 D5.2: the model keeps the English refusal (asserted above), while the channel
		// gets a line rendered from the refusal's structured form — it names the blocked path and
		// carries none of the model text. Mutation check (2026-10-12): dropping the `blocked`
		// branch in session-events.ts falls back to the error's first line ("Path blocked
		// [outside-allowed-roots]"), which has no path. Rechecked 2026-11-06 with controlled
		// progress timing: the error-line path assertion below goes red.
		const delivered = harness.deliveries.map((d) => d.text ?? "").join("\n");
		expect(delivered.split("\n").some((line) => line.includes("✕") && line.includes(target))).toBe(true);
		expect(delivered).not.toMatch(/Path blocked|Resolved path/);

		// P0-1 & P0-2 full-stack extension (2026-11-15):
		// 1) `appHomeDir` control-plane files (`security.json`, `auth.json`) live under temp in E2E;
		//    SessionHost -> createPipiclawTools -> guardPath must still refuse read/write and audit them.
		// 2) `write` and `bash` in the same desk turn must resolve relative paths against the desk's `cwd`,
		//    not the daemon's `process.cwd()`.
		// Mutation checks (2026-11-15, verified red): disabling `matchesAppHomeControlPlane` in
		// `path-guard.ts` lets `security.json` be overwritten; dropping `securityContext.cwd` in
		// `bash.ts` writes `bash-pwd.txt` in `process.cwd()` instead of `deskDir`.
		const securityPath = join(harness.homeDir, "security.json");
		const authPath = join(harness.homeDir, "auth.json");
		harness.model.script.route({
			name: "self-protect-and-desk-cwd",
			when: (r) => r.isMainTurn && r.lastUserText.includes("CHECK_CONTROL_AND_CWD"),
			respond: [
				reply.toolCall("write", { path: securityPath, content: '{"enabled":false}' }),
				reply.toolCall("read", { path: authPath }),
				reply.toolCall("write", { path: "desk-cwd-probe.txt", content: "DESK_CWD_OK" }),
				reply.toolCall("bash", { command: "pwd > bash-pwd.txt" }),
				reply.text("已完成检查。"),
			],
		});
		await harness.sendUserMessage("CHECK_CONTROL_AND_CWD");
		expect(existsSync(securityPath) ? readFileSync(securityPath, "utf8") : "").not.toContain('"enabled":false');
		expect(harness.readAuditLog()).toContain("security.json");
		expect(harness.readAuditLog()).toContain("auth.json");
		expect(readFileSync(join(harness.deskDir, "desk-cwd-probe.txt"), "utf8")).toBe("DESK_CWD_OK");
		expect(realpathSync(readFileSync(join(harness.deskDir, "bash-pwd.txt"), "utf8").trim())).toBe(
			realpathSync(harness.deskDir),
		);
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
