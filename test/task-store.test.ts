import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderTaskDocument } from "../src/tasks/ledger.js";
import { readTaskLog, resetTaskLogAppenders } from "../src/tasks/log.js";
import { expireTicket, openCycle, parkTask, readStoredTask, redeemTicket } from "../src/tasks/store.js";
import type { Ticket } from "../src/tasks/ticket.js";

const RUN_TICKET: Ticket = { kind: "run", id: "run_a", by: "2099-01-01T00:00:00+08:00" };
const STALE_TICKET: Ticket = { kind: "run", id: "run_a", by: "2000-01-01T00:00:00+08:00" };

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "task-store-"));
	await mkdir(join(dir, "tasks"), { recursive: true });
	await writeFile(join(dir, "tasks", "T.md"), renderTaskDocument({ state: "open" }, "# T\n\n## Goal\nDo it.\n"));
});

afterEach(async () => {
	await resetTaskLogAppenders();
});

describe("redeemTicket (INV-4)", () => {
	it("only redeems the ticket that is actually held, and only once", async () => {
		await parkTask(dir, "T", RUN_TICKET);

		// A settlement for a different run must not reopen a task waiting on something else — this
		// is what stops one delegation's completion from resuming an unrelated park.
		expect(await redeemTicket(dir, "T", (ticket) => ticket.kind === "run" && ticket.id === "run_b")).toBeUndefined();
		expect((await readStoredTask(dir, "T"))?.fields.state).toBe("parked");

		const first = await redeemTicket(dir, "T", (ticket) => ticket.kind === "run" && ticket.id === "run_a");
		expect(first?.ticket).toEqual(RUN_TICKET);
		expect((await readStoredTask(dir, "T"))?.fields.state).toBe("open");

		// At-least-once delivery: replaying the same settlement is a no-op, not a second reopen.
		expect(await redeemTicket(dir, "T", (ticket) => ticket.kind === "run" && ticket.id === "run_a")).toBeUndefined();
	});

	it("refuses to redeem a paused task", async () => {
		await parkTask(dir, "T", RUN_TICKET);
		const document = await readStoredTask(dir, "T");
		document!.fields.paused = { by: "user", reason: "hold", at: "2026-01-01T00:00:00+08:00" };
		const { writeStoredTask } = await import("../src/tasks/store.js");
		await writeStoredTask(document!);
		expect(await redeemTicket(dir, "T", () => true)).toBeUndefined();
	});
});

describe("expireTicket — the D2-INV backstop", () => {
	// Mutation check (2026-09-05): make `expireTicket` only log, as v3's `missed recurring
	// occurrence` did, and this case goes red — which is precisely the 13-day silence it guards.
	it("reopens on the first expiry and stops the task on the second", async () => {
		await openCycle(dir, "T");
		await parkTask(dir, "T", STALE_TICKET);

		const first = await expireTicket(dir, "T");
		expect(first?.outcome).toBe("reopened");
		expect((await readStoredTask(dir, "T"))?.fields.state).toBe("open");
		expect((await readStoredTask(dir, "T"))?.fields.cycle?.expired).toBe(1);

		await parkTask(dir, "T", STALE_TICKET);
		const second = await expireTicket(dir, "T");
		expect(second?.outcome).toBe("paused");
		const document = await readStoredTask(dir, "T");
		// Stays parked *and* paused: the user is now the only thing that can restart it, which is
		// the point — a silent third expiry is exactly the failure this replaces.
		expect(document?.fields.state).toBe("parked");
		expect(document?.fields.paused?.by).toBe("runtime");

		const log = await readTaskLog(dir, "T", { kinds: ["expired"] });
		expect(log.map((record) => (record.kind === "expired" ? record.action : ""))).toEqual(["reopened", "paused"]);
	});

	it("does nothing for a task that is not parked", async () => {
		expect(await expireTicket(dir, "T")).toBeUndefined();
	});
});

describe("openCycle", () => {
	it("starts fresh counters and clears any park", async () => {
		await parkTask(dir, "T", RUN_TICKET);
		const opened = await openCycle(dir, "T", new Date("2026-09-05T10:00:00+08:00"));
		expect(opened?.cycleId).toBe("c-2026-09-05");
		expect(opened?.document.fields).toMatchObject({ state: "open", ticket: undefined });
		expect(opened?.document.fields.cycle).toMatchObject({ steps: 0, rounds: 0, usd: 0, expired: 0 });
	});

	it("disambiguates a second cycle opened on the same day", async () => {
		const day = new Date("2026-09-05T10:00:00+08:00");
		await openCycle(dir, "T", day);
		expect((await openCycle(dir, "T", day))?.cycleId).toBe("c-2026-09-05-2");
	});

	it("refuses to open a cycle on a paused task", async () => {
		const document = await readStoredTask(dir, "T");
		document!.fields.paused = { by: "user", reason: "hold", at: "2026-01-01T00:00:00+08:00" };
		const { writeStoredTask } = await import("../src/tasks/store.js");
		await writeStoredTask(document!);
		expect(await openCycle(dir, "T")).toBeUndefined();
	});
});
