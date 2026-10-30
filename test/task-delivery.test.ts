import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderTaskDocument } from "../src/tasks/contract.js";
import { deliverTaskMessage, drainTaskDeliveries, queueTaskReport, readTaskDeliveries } from "../src/tasks/delivery.js";
import * as taskLog from "../src/tasks/loop-log.js";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "task-delivery-"));
	await mkdir(join(dir, "tasks"));
	await writeFile(join(dir, "tasks", "T.md"), renderTaskDocument({ state: "running" }, "# T\n"));
});
afterEach(async () => {
	vi.restoreAllMocks();
	await taskLog.resetTaskLogAppenders();
	await rm(dir, { recursive: true, force: true });
});

describe("task delivery persistence", () => {
	it("backs off failures, preserves per-task order and refuses an unavailable channel without spending retries", async () => {
		// Risk: final delivery can overtake failed progress, or channel rebindings leak a stored report.
		const first = await queueTaskReport(dir, "T", 1, "channel", "progress");
		const second = await queueTaskReport(dir, "T", 1, "channel", "final");
		const now = Date.now();
		const send = vi.fn(async () => {
			expect(existsSync(join(dir, ".locks", "task-T.lock"))).toBe(false);
			throw new Error("offline");
		});
		const next = await drainTaskDeliveries(dir, send, () => true, now);
		expect(send).toHaveBeenCalledTimes(1);
		expect(await readTaskDeliveries(dir)).toMatchObject([
			{ id: first.id, attempts: 1 },
			{ id: second.id, attempts: 0 },
		]);
		await drainTaskDeliveries(dir, send, () => false, next! + 1);
		await drainTaskDeliveries(dir, send, () => true, now + 1);
		expect(send).toHaveBeenCalledTimes(1);
		const accepted = vi.fn(async () => true);
		await drainTaskDeliveries(dir, accepted, () => true, next! + 1);
		expect(accepted.mock.calls).toEqual([
			["channel", "progress"],
			["channel", "final"],
		]);
		expect(await readTaskDeliveries(dir)).toEqual([]);
		expect(await taskLog.readTaskLog(dir, "T", { kinds: ["report"], limit: 1 })).toMatchObject([
			{ id: second.id, delivered: true },
		]);
	});

	it("does not resend after remote acceptance was persisted but the task log receipt failed", async () => {
		// Risk: a disk fault between the delivery receipt and journal acknowledgment charges users duplicate reports.
		const message = await queueTaskReport(dir, "T", 1, "channel", "final");
		const append = taskLog.appendTaskLog;
		vi.spyOn(taskLog, "appendTaskLog").mockImplementationOnce(async () => {
			throw new Error("disk full");
		});
		const send = vi.fn(async () => true);
		const now = Date.now();
		await expect(deliverTaskMessage(dir, message.id, send, now)).rejects.toThrow("disk full");
		expect(await readTaskDeliveries(dir)).toMatchObject([{ id: message.id, sentAt: expect.any(String) }]);
		vi.mocked(taskLog.appendTaskLog).mockImplementation(append);
		await deliverTaskMessage(dir, message.id, send, now + 60_001);
		expect(send).toHaveBeenCalledTimes(1);
		expect(await readTaskDeliveries(dir)).toEqual([]);
		expect(await taskLog.readTaskLog(dir, "T", { kinds: ["report"] })).toMatchObject([{ delivered: true }]);
	});
});
