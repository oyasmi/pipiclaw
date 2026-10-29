import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createUsage } from "../../../src/tasks/budget.js";
import { renderStandardTaskBody, renderTaskDocument } from "../../../src/tasks/contract.js";
import { parseTaskFrontmatter } from "../../../src/tasks/frontmatter.js";
import { readTaskLog } from "../../../src/tasks/loop-log.js";
import { crash, startDaemon } from "../../support/daemon-process.js";
import { startMockProvider } from "../../support/mock-provider/server.js";
import { bindChannelOnDisk, E2E_DESK, reply } from "../../support/runtime-harness.js";
import { cleanupE2ETestHome, createDeterministicHome } from "../../support/setup.js";

describe("E2E deterministic: task commit recovery", () => {
	it("replays a committed step once and preserves an input claimed before a SIGKILL", async () => {
		// R1/R5: a process with no old callbacks must recover the log/snapshot gap and unread input.
		// Mutation checks (2026-10-29): disable checkpoint replay -> restored user wait is lost;
		// restore last-step input boundaries -> UNSEEN_AFTER_CLAIM is absent from the provider request.
		// Both mutations turned this case red, then were restored.
		const model = await startMockProvider();
		const home = createDeterministicHome({ mockBaseUrl: model.baseUrl });
		const channelId = "dingtalk:dm:e2e_user";
		const deskDir = join(home.workspaceDir, `desk-${E2E_DESK}`);
		const tasks = join(deskDir, "tasks");
		const fields = (id: string) => parseTaskFrontmatter(readFileSync(join(tasks, `${id}.md`), "utf8")).fields;
		const seed = (id: string) => {
			mkdirSync(tasks, { recursive: true });
			writeFileSync(
				join(tasks, `${id}.md`),
				renderTaskDocument(
					{ state: "queued", channel: channelId, usage: createUsage() },
					renderStandardTaskBody({ title: id, goal: "Check recovery", dod: "- [ ] Verified" }),
				),
			);
		};
		let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
		try {
			await bindChannelOnDisk(home.workspaceDir, channelId);
			seed("committed");
			model.script.route({
				name: "ask",
				when: (request) => request.lastUserText.includes("[TASK_STEP:committed #1]"),
				respond: [reply.toolCall("task_ask", { question: "Proceed?" })],
			});
			const held = model.script.hold({
				when: (request) => request.lastUserText.includes("[TASK_STEP:committed #1]"),
			});
			daemon = await startDaemon(home.homeDir);
			await daemon.call("task-scan");
			await held.arrived;
			// Hold the real snapshot rename after the journal commit, then kill the process.
			await daemon.call("task-hold-commit", { taskId: "committed" });
			const barrier = daemon.call("task-drain");
			held.release();
			expect(await barrier).toBe("task-commit-held");
			const ended = (await readTaskLog(deskDir, "committed")).find((record) => record.kind === "step_end");
			expect(ended).toMatchObject({ next: "user", checkpoint: { state: "waiting", usage: { steps: 1 } } });
			expect(fields("committed")).toMatchObject({ state: "running", usage: { steps: 0 } });
			await crash(daemon.child);
			daemon = await startDaemon(home.homeDir);
			await daemon.call("task-scan");
			await daemon.call("task-drain");
			expect(fields("committed")).toMatchObject({
				state: "waiting",
				waiting: { kind: "user", question: "Proceed?" },
				usage: { steps: 1 },
			});
			expect(
				(await readTaskLog(deskDir, "committed")).filter((record) => record.kind === "ask_delivered"),
			).toHaveLength(1);
			await daemon.call("task-scan");
			expect(model.requests).toHaveLength(1);

			seed("unseen");
			await daemon.call("turn", { channelId, text: "/tasks msg unseen UNSEEN_AFTER_CLAIM" });
			expect(
				(await readTaskLog(deskDir, "unseen")).some(
					(record) => record.kind === "message" && record.text === "UNSEEN_AFTER_CLAIM",
				),
			).toBe(true);
			await daemon.call("task-begin", { taskId: "unseen" });
			await crash(daemon.child); // The claimed input has never entered a runner or session.
			model.script.route({
				name: "recover-input",
				when: (request) => request.lastUserText.includes("[TASK_STEP:unseen #2]"),
				respond: [reply.toolCall("task_wait", { until: "+1h" })],
			});
			daemon = await startDaemon(home.homeDir);
			await daemon.call("task-scan");
			await daemon.call("task-drain");
			const recovered = model.requests.find((request) => request.matchedRoute === "recover-input");
			expect(recovered?.lastUserText).toContain("UNSEEN_AFTER_CLAIM");
			expect(fields("unseen")).toMatchObject({ state: "waiting", waiting: { kind: "time" }, usage: { steps: 2 } });
			expect((await readTaskLog(deskDir, "unseen")).filter((record) => record.kind === "input_ack")).toHaveLength(1);
			expect(model.unmatched()).toEqual([]);
		} finally {
			if (daemon) await crash(daemon.child);
			await model.close();
			cleanupE2ETestHome(home.homeDir);
		}
	});
});
