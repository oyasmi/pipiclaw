import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { taskArchiveCommitPath } from "../../../src/tasks/archive.js";
import { createUsage } from "../../../src/tasks/budget.js";
import { renderStandardTaskBody, renderTaskDocument } from "../../../src/tasks/contract.js";
import { readTaskDeliveries } from "../../../src/tasks/delivery.js";
import { readTaskLog } from "../../../src/tasks/loop-log.js";
import { readStoredTask } from "../../../src/tasks/store.js";
import { crash, startDaemon } from "../../support/daemon-process.js";
import { startMockProvider } from "../../support/mock-provider/server.js";
import { bindChannelOnDisk, E2E_DESK, reply } from "../../support/runtime-harness.js";
import { cleanupE2ETestHome, createDeterministicHome } from "../../support/setup.js";

const channel = "dingtalk:dm:e2e_user";
function seed(deskDir: string, id: string): void {
	mkdirSync(join(deskDir, "tasks"), { recursive: true });
	writeFileSync(
		join(deskDir, "tasks", `${id}.md`),
		renderTaskDocument(
			{ state: "queued", channel, usage: createUsage() },
			renderStandardTaskBody({ title: id, goal: "Verify delivery and recovery", dod: "- [x] verified" }),
		),
	);
}

describe("E2E deterministic: task closure recovery", () => {
	it("finishes archive publication and cleanup after SIGKILL at every phase without rerunning the leader", async () => {
		// Regression: process-local rollback cannot repair moved logs or a published archive with a live source.
		// Covers real bootstrap → leader → close → filesystem commits → fresh-process recovery.
		// Mutation check (2026-10-30): disable recoverTaskArchives in the lane; the active source
		// survives restart and this case fails its disk-state assertion. Restored after confirming red.
		// Also disable committedAfterPause admission: cancel-intent stays paused after restart;
		// confirmed red (2026-10-30), then restored. Reuse recovered daemons between crash phases.
		const model = await startMockProvider();
		const home = createDeterministicHome({ mockBaseUrl: model.baseUrl });
		const deskDir = join(home.workspaceDir, `desk-${E2E_DESK}`);
		let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
		try {
			await bindChannelOnDisk(home.workspaceDir, channel);
			for (const point of ["cancel-intent", "log", "contract", "cleanup"]) {
				const cancelling = point === "cancel-intent";
				const id = `archive-${point}`;
				seed(deskDir, id);
				for (const suffix of [".1", ".2"])
					writeFileSync(
						join(deskDir, "tasks", `${id}.jsonl${suffix}`),
						`${JSON.stringify({ id: `prior-${suffix}`, ts: "2026-10-01T00:00:00+08:00", kind: "message", from: "u", channel, text: suffix })}\n`,
					);
				model.script.route({
					name: id,
					when: (r) => r.lastUserText.includes(`[TASK_STEP:${id} #1]`),
					respond: [
						reply.toolCall("task_report", { text: id }),
						reply.toolCall("task_close", { id, outcome: "complete", note: id }),
					],
				});
				daemon ??= await startDaemon(home.homeDir);
				await daemon.call("task-hold-archive", { taskId: id, point: cancelling ? "intent" : point });
				if (cancelling)
					expect(await daemon.call("turn", { channelId: channel, text: `/tasks cancel ${id}` })).toBe(
						"task-archive-held",
					);
				else {
					await daemon.call("task-scan");
					expect(await daemon.call("task-drain")).toBe("task-archive-held");
				}
				expect(existsSync(taskArchiveCommitPath(deskDir, id))).toBe(!cancelling);
				await crash(daemon.child);
				const requests = model.requests.length;
				daemon = await startDaemon(home.homeDir);
				await daemon.call("task-scan");
				await daemon.call("task-drain");
				expect(await readStoredTask(deskDir, id)).toBeUndefined();
				expect((await readStoredTask(deskDir, id, true))?.fields.outcome).toBe(
					cancelling ? "cancelled" : "completed",
				);
				expect(existsSync(taskArchiveCommitPath(deskDir, id))).toBe(false);
				for (const suffix of ["", ".1", ".2"]) {
					expect(existsSync(join(deskDir, "tasks", `${id}.jsonl${suffix}`))).toBe(false);
					expect(existsSync(join(deskDir, "tasks", "archive", `${id}.jsonl${suffix}`))).toBe(true);
				}
				const records = await readTaskLog(deskDir, id);
				expect((await readStoredTask(deskDir, id, true))?.fields.closedAt).toBe(
					records.find((record) => record.kind === "close")?.ts,
				);
				expect(records.filter((record) => record.kind === "message").map((record) => record.id)).toEqual([
					"prior-.2",
					"prior-.1",
				]);
				expect(records.filter((record) => record.kind === "close")).toHaveLength(1);
				expect(await readTaskDeliveries(deskDir)).toEqual([]);
				await daemon.call("task-scan");
				expect(model.requests).toHaveLength(requests);
			}
			expect(model.unmatched()).toEqual([]);
		} finally {
			if (daemon) await crash(daemon.child);
			await model.close();
			cleanupE2ETestHome(home.homeDir);
		}
	});

	it("holds completion for failed delivery and recovers an unconfirmed accepted receipt after SIGKILL", async () => {
		// Regression: failed reports used to archive as completed; completion receipts were lost after archive.
		// A fresh daemon proves durable retry, including the unavoidable remote-acceptance/local-ack gap.
		// Mutation check (2026-10-30): skip persisting queueTaskReport; this case fails because the
		// report has no durable retry record after the failed send. Restored after confirming red.
		const model = await startMockProvider();
		const home = createDeterministicHome({ mockBaseUrl: model.baseUrl });
		const deskDir = join(home.workspaceDir, `desk-${E2E_DESK}`);
		const id = "delivery-recovery";
		let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
		try {
			await bindChannelOnDisk(home.workspaceDir, channel);
			seed(deskDir, id);
			model.script.route({
				name: id,
				when: (r) => r.lastUserText.includes(`[TASK_STEP:${id} #1]`),
				respond: [
					reply.toolCall("task_report", { text: id }),
					reply.toolCall("task_close", { id, outcome: "complete", note: id }),
				],
			});
			daemon = await startDaemon(home.homeDir);
			await daemon.call("task-delivery-mode", { mode: "fail", kind: "report" });
			await daemon.call("task-scan");
			await daemon.call("task-drain");
			expect(existsSync(join(deskDir, "tasks", "archive", `${id}.md`))).toBe(false);
			expect((await readStoredTask(deskDir, id))?.fields.usage?.steps).toBe(1);
			expect(await readTaskDeliveries(deskDir)).toMatchObject([{ taskId: id, kind: "report", attempts: 1 }]);
			const requests = model.requests.length;
			await daemon.call("turn", { channelId: channel, text: `/tasks msg ${id} NEW_SCOPE_DURING_DELIVERY` });
			expect((await readTaskLog(deskDir, id)).some((record) => record.kind === "message")).toBe(false);
			expect(model.requests).toHaveLength(requests);
			await crash(daemon.child);

			daemon = await startDaemon(home.homeDir);
			await daemon.call("task-clock", { text: "60001" });
			await daemon.call("task-delivery-mode", { mode: "hold", kind: "receipt" });
			expect(await daemon.call("task-scan")).toBe("task-delivery-held");
			expect((await readStoredTask(deskDir, id, true))?.fields.outcome).toBe("completed");
			expect(await readTaskDeliveries(deskDir)).toMatchObject([{ taskId: id, kind: "receipt", attempts: 1 }]);
			await crash(daemon.child);

			daemon = await startDaemon(home.homeDir);
			await daemon.call("task-clock", { text: "120002" });
			await daemon.call("task-scan");
			await daemon.call("task-drain");
			expect(await readTaskDeliveries(deskDir)).toEqual([]);
			expect((await readTaskLog(deskDir, id)).filter((record) => record.kind === "report")).toMatchObject([
				{ delivered: true },
			]);
			expect((await readTaskLog(deskDir, id)).filter((record) => record.kind === "close")).toHaveLength(1);
			const deliveries = readFileSync(join(home.homeDir, "state", "captured-deliveries.jsonl"), "utf-8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { kind: string; accepted: boolean; text: string });
			expect(deliveries.filter((delivery) => delivery.kind === "report" && delivery.accepted)).toHaveLength(1);
			expect(deliveries.filter((delivery) => delivery.kind === "receipt" && delivery.accepted)).toHaveLength(2);
			const receipts = deliveries.filter((delivery) => delivery.kind === "receipt" && delivery.accepted);
			expect(receipts[0]!.text).toBe(receipts[1]!.text);
			expect(model.requests).toHaveLength(requests);
			expect(model.unmatched()).toEqual([]);
		} finally {
			if (daemon) await crash(daemon.child);
			await model.close();
			cleanupE2ETestHome(home.homeDir);
		}
	});
});
