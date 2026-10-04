import { describe, expect, it } from "vitest";
import { formatLocalTime, parseLocalTime } from "../src/shared/local-time.js";
import { RecoverableToolError } from "../src/shared/recoverable-error.js";
import {
	type PendingWorkRef,
	parseTicket,
	resolveTicket,
	type TicketContext,
	ticketExpired,
} from "../src/tasks/ticket.js";

const NOW = new Date("2026-09-05T10:00:00+08:00");

function context(pending: PendingWorkRef[] = []): TicketContext {
	return { now: NOW, pendingWork: () => pending };
}

describe("resolveTicket validation (spec 052, D3)", () => {
	// A park has to name something the runtime can check, or it reproduces the 13-day silence.
	it("refuses a work ticket when nothing bound to the task is in flight", () => {
		expect(() => resolveTicket({ kind: "work" }, context())).toThrow(
			/nothing to wait for|no delegation or background job/,
		);
	});

	it("rejects a time ticket in the past and an unknown kind (including the retired ones)", () => {
		expect(() => resolveTicket({ kind: "time", at: "2020-01-01T00:00:00+08:00" }, context())).toThrow(
			/not in the future/,
		);
		for (const retired of ["run", "job", "signal", "schedule", "nope"]) {
			expect(() => resolveTicket({ kind: retired }, context()), retired).toThrow(/Unknown ticket kind/);
		}
	});

	it("reports every rejection as recoverable, so the model can fix the call itself", () => {
		expect(() => resolveTicket({ kind: "work" }, context())).toThrow(RecoverableToolError);
		expect(() => resolveTicket({ kind: "ask" }, context())).toThrow(RecoverableToolError);
	});
});

describe("backstop derivation", () => {
	// Every persisted ticket carries a `by`, and the model never supplies it.
	it("stamps a future backstop on every ticket kind", () => {
		const tickets = [
			resolveTicket({ kind: "time", at: "+2h" }, context()),
			resolveTicket({ kind: "work" }, context([{ ref: "run_a", deadlineMs: NOW.getTime() + 60_000 }])),
			resolveTicket({ kind: "ask", asked: "merge?" }, context()),
		];
		for (const ticket of tickets) {
			expect(parseLocalTime(ticket.by), ticket.kind).toBeGreaterThan(NOW.getTime());
		}
	});

	it("waits for the latest of the in-flight work, plus ten minutes of slack", () => {
		const ticket = resolveTicket(
			{ kind: "work" },
			context([
				{ ref: "run_a", deadlineMs: NOW.getTime() + 60_000 },
				{ ref: "job_b", deadlineMs: NOW.getTime() + 3_600_000 },
			]),
		);
		expect(ticket).toMatchObject({ kind: "work", refs: ["run_a", "job_b"] });
		expect(parseLocalTime(ticket.by)).toBe(NOW.getTime() + 3_600_000 + 10 * 60_000);
	});
});

describe("ticket expiry and round-trip", () => {
	it("treats an unparseable backstop as expired, so a broken park never goes silent", () => {
		expect(ticketExpired({ kind: "ask", asked: "x", by: "not-a-time" }, NOW)).toBe(true);
		expect(ticketExpired({ kind: "ask", asked: "x", by: formatLocalTime(new Date(NOW.getTime() + 1000)) }, NOW)).toBe(
			false,
		);
	});

	it("round-trips through JSON and rejects anything without a valid backstop", () => {
		const ticket = resolveTicket({ kind: "work" }, context([{ ref: "run_a", deadlineMs: NOW.getTime() + 1000 }]));
		expect(parseTicket(JSON.stringify(ticket))).toEqual(ticket);
		expect(parseTicket('{"kind":"ask","asked":"x"}')).toBeUndefined();
		expect(parseTicket('{"kind":"ask","asked":"x","by":"nope"}')).toBeUndefined();
		// v4 kinds no longer parse: a park on one falls back to `open` via INV-1 instead of dangling.
		expect(parseTicket('{"kind":"run","id":"r","by":"2099-01-01T00:00:00+08:00"}')).toBeUndefined();
		expect(parseTicket("not json")).toBeUndefined();
	});
});
