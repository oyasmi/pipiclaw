vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs/promises")>()),
}));

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
			[expect.objectContaining({ channel: "channel", text: "progress", id: first.id, kind: "report", taskId: "T" })],
			[expect.objectContaining({ channel: "channel", text: "final", id: second.id, kind: "report", taskId: "T" })],
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

it("isolates corrupt and unreadable predecessors without losing FIFO or blocking new reports", async () => {
	// Mutation 2026-11-08: removing the corrupt-owner fence sends later before first (confirmed red).
	// Risk: one corrupt file poisons every task; ignoring it instead lets the same task's final overtake progress.
	const fs = await import("node:fs/promises");
	const read = fs.readFile;
	for (const mode of ["json", "structure", "EIO", "EACCES"]) {
		const bad = await queueTaskReport(dir, "T", 1, "channel", "first");
		const path = join(dir, "tasks", ".delivery", `${bad.id}.json`);
		const raw = await read(path, "utf-8");
		if (mode === "json") await writeFile(path, "{broken");
		if (mode === "structure") await writeFile(path, JSON.stringify({ ...bad, order: "bad" }));
		const fault = vi.spyOn(fs, "readFile").mockImplementation((...args: Parameters<typeof read>) => {
			if (String(args[0]) === path && ["EIO", "EACCES"].includes(mode))
				return Promise.reject(Object.assign(new Error(mode), { code: mode }));
			return read(...args);
		});
		await queueTaskReport(dir, "T", 1, "channel", "later");
		await writeFile(join(dir, "tasks", "H.md"), renderTaskDocument({ state: "running" }, "# H\n"));
		await queueTaskReport(dir, "H", 1, "channel", "healthy");
		const send = vi.fn(async () => true);
		await drainTaskDeliveries(dir, send, () => true);
		expect(send.mock.calls).toEqual([
			[expect.objectContaining({ channel: "channel", text: "healthy", taskId: "H" })],
		]);
		expect(await read(path, "utf-8")).toBe(
			mode === "json" ? "{broken" : mode === "structure" ? JSON.stringify({ ...bad, order: "bad" }) : raw,
		);
		fault.mockRestore();
		await writeFile(path, raw);
		await drainTaskDeliveries(dir, send, () => true);
		expect(send.mock.calls.slice(1)).toEqual([
			[expect.objectContaining({ channel: "channel", text: "first", id: bad.id })],
			[expect.objectContaining({ channel: "channel", text: "later", taskId: "T" })],
		]);
	}
	// No trustworthy owner (no report journal): preserve the evidence and fence all delivery.
	const unknown = join(dir, "tasks", ".delivery", "00000000-0000-0000-0000-000000000000.json");
	await writeFile(unknown, "{unknown");
	await queueTaskReport(dir, "T", 2, "channel", "new");
	const send = vi.fn(async () => true);
	await drainTaskDeliveries(dir, send, () => true);
	expect(send).not.toHaveBeenCalled();
	await rm(unknown);
	await drainTaskDeliveries(dir, send, () => true);
	expect(send).toHaveBeenCalledOnce();
});
