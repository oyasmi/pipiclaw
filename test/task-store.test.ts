import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUsage } from "../src/tasks/budget.js";
import { renderTaskDocument } from "../src/tasks/ledger.js";
import { readTaskLog, resetTaskLogAppenders } from "../src/tasks/log.js";
import {
	expireTicket,
	parkTask,
	readStoredTask,
	redeemTicket,
	resumeTask,
	writeStoredTask,
} from "../src/tasks/store.js";
import type { Ticket } from "../src/tasks/ticket.js";

const WORK_TICKET: Ticket = { kind: "work", refs: ["run_a"], by: "2099-01-01T00:00:00+08:00" };
const STALE_TICKET: Ticket = { kind: "work", refs: ["run_a"], by: "2000-01-01T00:00:00+08:00" };

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "task-store-"));
	await mkdir(join(dir, "tasks"), { recursive: true });
	await writeFile(
		join(dir, "tasks", "T.md"),
		renderTaskDocument({ state: "open", usage: createUsage() }, "# T\n\n## Goal\nDo it.\n"),
	);
});

afterEach(async () => {
	await resetTaskLogAppenders();
});

describe("redeemTicket (INV-1)", () => {
	it("only redeems a matching ticket, and only once", async () => {
		await parkTask(dir, "T", WORK_TICKET);

		// A wake for a task parked on a different kind of ticket must not reopen it.
		expect(await redeemTicket(dir, "T", (ticket) => ticket.kind === "ask")).toBeUndefined();
		expect((await readStoredTask(dir, "T"))?.fields.state).toBe("parked");

		const first = await redeemTicket(dir, "T", (ticket) => ticket.kind === "work");
		expect(first?.ticket).toEqual(WORK_TICKET);
		expect((await readStoredTask(dir, "T"))?.fields.state).toBe("open");

		// At-least-once delivery: replaying the same settlement is a no-op, not a second reopen.
		expect(await redeemTicket(dir, "T", (ticket) => ticket.kind === "work")).toBeUndefined();
	});

	it("refuses to redeem a paused task", async () => {
		await parkTask(dir, "T", WORK_TICKET);
		const document = await readStoredTask(dir, "T");
		document!.fields.paused = { by: "user", reason: "hold", at: "2026-01-01T00:00:00+08:00" };
		await writeStoredTask(document!);
		expect(await redeemTicket(dir, "T", () => true)).toBeUndefined();
	});

	it("clears the consecutive-expiry count when a wait ends normally", async () => {
		await parkTask(dir, "T", STALE_TICKET);
		await expireTicket(dir, "T");
		expect((await readStoredTask(dir, "T"))?.fields.usage?.expired).toBe(1);

		await parkTask(dir, "T", WORK_TICKET);
		await redeemTicket(dir, "T", () => true);
		expect((await readStoredTask(dir, "T"))?.fields.usage?.expired).toBe(0);
	});
});

describe("expireTicket — the backstop", () => {
	// Mutation check: make `expireTicket` only log, as v3's `missed recurring occurrence` did,
	// and this goes red — which is precisely the 13-day silence it guards.
	it("reopens on the first expiry and stops the task on the second consecutive one", async () => {
		await parkTask(dir, "T", STALE_TICKET);

		const first = await expireTicket(dir, "T");
		expect(first?.outcome).toBe("reopened");
		expect((await readStoredTask(dir, "T"))?.fields.state).toBe("open");

		await parkTask(dir, "T", STALE_TICKET);
		const second = await expireTicket(dir, "T");
		expect(second?.outcome).toBe("paused");
		const document = await readStoredTask(dir, "T");
		// Stays parked *and* paused: the user is now the only thing that can restart it.
		expect(document?.fields.state).toBe("parked");
		expect(document?.fields.paused?.by).toBe("runtime");

		const log = await readTaskLog(dir, "T", { kinds: ["expired"] });
		expect(log.map((record) => (record.kind === "expired" ? record.action : ""))).toEqual(["reopened", "paused"]);
	});

	it("does nothing for a task that is not parked", async () => {
		expect(await expireTicket(dir, "T")).toBeUndefined();
	});
});

describe("resumeTask", () => {
	it("reopens a task that was stopped on a dead ticket instead of re-pausing it forever", async () => {
		await parkTask(dir, "T", STALE_TICKET);
		await expireTicket(dir, "T");
		await parkTask(dir, "T", STALE_TICKET);
		await expireTicket(dir, "T");
		expect((await readStoredTask(dir, "T"))?.fields.paused).toBeDefined();

		await resumeTask(dir, "T");
		const resumed = await readStoredTask(dir, "T");
		expect(resumed?.fields.state).toBe("open");
		expect(resumed?.fields.paused).toBeUndefined();
		expect(resumed?.fields.ticket).toBeUndefined();
		expect(resumed?.fields.usage?.expired).toBe(0);
	});

	it("keeps a live ticket when resuming a user pause", async () => {
		await parkTask(dir, "T", WORK_TICKET);
		const document = await readStoredTask(dir, "T");
		document!.fields.paused = { by: "user", reason: "hold", at: "2026-01-01T00:00:00+08:00" };
		await writeStoredTask(document!);
		await resumeTask(dir, "T");
		expect((await readStoredTask(dir, "T"))?.fields).toMatchObject({ state: "parked", ticket: WORK_TICKET });
	});
});
