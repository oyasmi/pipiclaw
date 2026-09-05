import { describe, expect, it } from "vitest";
import { formatLocalTime, parseLocalTime } from "../src/shared/local-time.js";
import { RecoverableToolError } from "../src/shared/recoverable-error.js";
import { describeTicket, parseTicket, resolveTicket, type TicketContext, ticketExpired } from "../src/tasks/ticket.js";

const NOW = new Date("2026-09-05T10:00:00+08:00");

function context(overrides: Partial<TicketContext> = {}): TicketContext {
	return {
		now: NOW,
		taskId: "T",
		channelId: "dm_1",
		findRun: () => undefined,
		findJob: () => undefined,
		findEvent: () => undefined,
		...overrides,
	};
}

const liveRun = { taskId: "T", startedAt: NOW.getTime(), deadlineAt: NOW.getTime() + 600_000 };
const liveJob = { taskId: "T", status: "running", startedAt: NOW.getTime() };

describe("resolveTicket validation matrix (spec 051, D2)", () => {
	// The whole point of the ticket is that a park names something the runtime can check. These
	// are the four rejections that would otherwise reproduce F1: a park that nothing can redeem.
	it("rejects a run ticket whose run does not exist, already settled, or belongs to another task", () => {
		expect(() => resolveTicket({ kind: "run", id: "run_x" }, context())).toThrow(/No run "run_x"/);

		expect(() =>
			resolveTicket({ kind: "run", id: "run_x" }, context({ findRun: () => ({ ...liveRun, settledAt: 1 }) })),
		).toThrow(/already settled/);

		expect(() =>
			resolveTicket({ kind: "run", id: "run_x" }, context({ findRun: () => ({ ...liveRun, taskId: "OTHER" }) })),
		).toThrow(/belongs to task OTHER/);
	});

	it("rejects a job ticket that is already finished or owned by another task", () => {
		expect(() =>
			resolveTicket({ kind: "job", id: "job_1" }, context({ findJob: () => ({ ...liveJob, status: "completed" }) })),
		).toThrow(/is completed/);
		expect(() =>
			resolveTicket({ kind: "job", id: "job_1" }, context({ findJob: () => ({ ...liveJob, taskId: "OTHER" }) })),
		).toThrow(/belongs to task OTHER/);
	});

	it("rejects a signal ticket unless the event is periodic, in this channel, and names this task", () => {
		const periodic = { type: "periodic" as const, channelId: "dm_1", schedule: "*/30 * * * *" };
		expect(() => resolveTicket({ kind: "signal", event: "task.dm_1.T.checkin" }, context())).toThrow(/No event/);
		expect(() =>
			resolveTicket(
				{ kind: "signal", event: "task.dm_1.T.checkin" },
				context({ findEvent: () => ({ type: "one-shot", channelId: "dm_1" }) }),
			),
		).toThrow(/one-shot/);
		expect(() =>
			resolveTicket(
				{ kind: "signal", event: "task.dm_1.T.checkin" },
				context({ findEvent: () => ({ ...periodic, channelId: "dm_2" }) }),
			),
		).toThrow(/another channel/);
		// INV-7's write side: an event that does not name this task could never redeem its ticket.
		expect(() =>
			resolveTicket({ kind: "signal", event: "task.dm_1.OTHER.checkin" }, context({ findEvent: () => periodic })),
		).toThrow(/does not belong to this task/);
	});

	it("rejects a time ticket in the past and a schedule ticket on a task with no cadence", () => {
		expect(() => resolveTicket({ kind: "time", at: "2020-01-01T00:00:00+08:00" }, context())).toThrow(
			/not in the future/,
		);
		expect(() => resolveTicket({ kind: "schedule" }, context())).toThrow(/needs the task to have a `schedule`/);
	});

	it("reports every rejection as recoverable, so the model can fix the call itself", () => {
		expect(() => resolveTicket({ kind: "run", id: "run_x" }, context())).toThrow(RecoverableToolError);
		expect(() => resolveTicket({ kind: "nope" }, context())).toThrow(RecoverableToolError);
	});
});

describe("backstop derivation (spec 051, D2)", () => {
	// INV-2: every persisted ticket carries a `by`, and the model never supplies it. A ticket the
	// model could leave open-ended is exactly the 13-day silence this mechanism replaced.
	it("stamps a backstop on every ticket kind", () => {
		const tickets = [
			resolveTicket({ kind: "time", at: "+2h" }, context()),
			resolveTicket({ kind: "schedule" }, context({ schedule: "0 3 * * *" })),
			resolveTicket({ kind: "run", id: "r" }, context({ findRun: () => liveRun })),
			resolveTicket({ kind: "job", id: "j" }, context({ findJob: () => liveJob })),
			resolveTicket({ kind: "ask", asked: "merge?" }, context()),
			resolveTicket(
				{ kind: "signal", event: "task.dm_1.T.checkin" },
				context({ findEvent: () => ({ type: "periodic", channelId: "dm_1", schedule: "*/30 * * * *" }) }),
			),
		];
		for (const ticket of tickets) {
			const by = parseLocalTime(ticket.by);
			expect(by, ticket.kind).toBeDefined();
			expect(by!, ticket.kind).toBeGreaterThan(NOW.getTime());
		}
	});

	it("gives a run ten minutes past its own deadline, not an arbitrary constant", () => {
		const ticket = resolveTicket({ kind: "run", id: "r" }, context({ findRun: () => liveRun }));
		expect(parseLocalTime(ticket.by)).toBe(liveRun.deadlineAt + 10 * 60_000);
	});

	it("gives a schedule ticket one missed occurrence and a signal ticket two", () => {
		const every30 = { type: "periodic" as const, channelId: "dm_1", schedule: "*/30 * * * *" };
		const schedule = resolveTicket({ kind: "schedule" }, context({ schedule: "*/30 * * * *" }));
		const signal = resolveTicket(
			{ kind: "signal", event: "task.dm_1.T.checkin" },
			context({ findEvent: () => every30 }),
		);
		expect(parseLocalTime(signal.by)! - parseLocalTime(schedule.by)!).toBe(30 * 60_000);
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
		const ticket = resolveTicket({ kind: "ask", asked: "merge?" }, context());
		expect(parseTicket(JSON.stringify(ticket))).toEqual(ticket);
		expect(parseTicket('{"kind":"ask","asked":"x"}')).toBeUndefined();
		expect(parseTicket('{"kind":"ask","asked":"x","by":"nope"}')).toBeUndefined();
		expect(parseTicket("not json")).toBeUndefined();
	});

	it("describes each kind well enough for a receipt to name what is being waited on", () => {
		expect(describeTicket({ kind: "run", id: "run_9", by: "x" })).toContain("run_9");
		expect(describeTicket({ kind: "ask", asked: "merge?", by: "x" })).toContain("merge?");
	});
});
