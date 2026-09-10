import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseScheduledEventContent } from "../src/runtime/events.js";
import type { SecurityConfig } from "../src/security/types.js";
import { type EventDefinitionInput, type EventManageToolOptions, manageEvent } from "../src/tools/event-manage.js";

function guard(overrides: Partial<SecurityConfig["commandGuard"]> = {}): SecurityConfig["commandGuard"] {
	return { enabled: true, additionalDenyPatterns: [], allowPatterns: [], blockObfuscation: true, ...overrides };
}

function futureIso(minutesFromNow: number): string {
	return new Date(Date.now() + minutesFromNow * 60_000).toISOString();
}

let workspaceDir: string;
let eventsDir: string;

function opts(overrides: Partial<EventManageToolOptions> = {}): EventManageToolOptions {
	return {
		workspaceDir,
		channelId: "dm_1",
		commandGuardConfig: guard(),
		...overrides,
	};
}

async function listEventFiles(): Promise<string[]> {
	if (!existsSync(eventsDir)) return [];
	return (await readdir(eventsDir)).sort();
}

beforeEach(async () => {
	workspaceDir = await mkdtemp(join(tmpdir(), "event-manage-"));
	eventsDir = join(workspaceDir, "events");
});

afterEach(async () => {
	await rm(workspaceDir, { recursive: true, force: true });
});

const validPeriodic: EventDefinitionInput = {
	type: "periodic",
	text: "推进任务 weekly-report",
	schedule: "0 10 * * 1",
};

describe("manageEvent create", () => {
	it("writes valid periodic and one-shot events that the watcher parser can load back, binding the channel itself", async () => {
		const result = await manageEvent(opts(), {
			action: "create",
			name: "task.dm_1.weekly-report.schedule",
			definition: validPeriodic,
		});
		expect(result.eventType).toBe("periodic");
		expect(await listEventFiles()).toEqual(["task.dm_1.weekly-report.schedule.json"]);
		const onDisk = await readFile(join(eventsDir, "task.dm_1.weekly-report.schedule.json"), "utf-8");
		expect(onDisk).not.toContain("timezone");
		const parsed = parseScheduledEventContent(onDisk, "x.json");
		expect(parsed.type).toBe("periodic");
		expect(parsed.channelId).toBe("dm_1"); // bound by the tool, not supplied by the model

		const oneShot = await manageEvent(opts(), {
			action: "create",
			name: "task.dm_1.weekly-report.checkin",
			definition: { type: "one-shot", text: "回访", at: futureIso(30) },
		});
		expect(oneShot.eventType).toBe("one-shot");
		expect(oneShot.channelId).toBe("dm_1");
	});

	it("normalizes .json suffix (foo === foo.json)", async () => {
		await manageEvent(opts(), {
			action: "create",
			name: "foo",
			definition: { type: "one-shot", text: "x", at: futureIso(30) },
		});
		await expect(
			manageEvent(opts(), {
				action: "create",
				name: "foo.json",
				definition: { type: "one-shot", text: "y", at: futureIso(30) },
			}),
		).rejects.toThrow(/already exists/);
	});

	it("turns a missing discriminated field into a recoverable error without writing a file (batch 3.6)", async () => {
		await expect(
			manageEvent(opts(), { action: "create", name: "bad", definition: { type: "one-shot", text: "x" } }),
		).rejects.toThrow(/needs "at"/);
		await expect(
			manageEvent(opts(), { action: "create", name: "bad", definition: { type: "periodic", text: "x" } }),
		).rejects.toThrow(/needs "schedule"/);
		expect(await listEventFiles()).toEqual([]);
	});

	it("delegates create-time rejection of each validator boundary to the shared validator", async () => {
		const boundaries: Array<[string, EventDefinitionInput, RegExp]> = [
			["a one-shot sooner than 2 minutes out", { type: "one-shot", text: "x", at: futureIso(1) }, /2 minutes/],
			[
				"a one-shot beyond the Node timer limit",
				{ type: "one-shot", text: "x", at: futureIso(36_000) },
				/24\.8 days/,
			],
			[
				"a periodic cron firing more often than every 30 minutes",
				{ type: "periodic", text: "x", schedule: "* * * * *" },
				/30 minutes/,
			],
			["an invalid cron schedule", { type: "periodic", text: "x", schedule: "not a cron" }, /cron/i],
		];
		for (const [label, definition, expectedError] of boundaries) {
			await expect(manageEvent(opts(), { action: "create", name: "rejected", definition }), label).rejects.toThrow(
				expectedError,
			);
			expect(await listEventFiles()).toEqual([]);
		}
	});

	it("allows a sub-30-minute periodic cron when it carries a preAction gate", async () => {
		const result = await manageEvent(opts(), {
			action: "create",
			name: "task.dm_1.demo.sensor",
			definition: {
				type: "periodic",
				text: "x",
				schedule: "*/10 * * * *",
				preAction: { type: "bash", command: "echo hi" },
			},
		});
		expect(result.eventType).toBe("periodic");
		expect(await listEventFiles()).toEqual(["task.dm_1.demo.sensor.json"]);
	});

	it("maps the schema's timeoutMs onto the on-disk preAction.timeout (ms)", async () => {
		await manageEvent(opts(), {
			action: "create",
			name: "task.dm_1.demo.gated",
			definition: {
				type: "one-shot",
				text: "x",
				at: futureIso(30),
				preAction: { type: "bash", command: "echo hi", timeoutMs: 4000 },
			},
		});
		const onDisk = JSON.parse(await readFile(join(eventsDir, "task.dm_1.demo.gated.json"), "utf-8"));
		expect(onDisk.preAction).toMatchObject({ type: "bash", command: "echo hi", timeout: 4000 });
	});

	it("rejects a preAction-gated periodic below the 5-minute hard sub-floor", async () => {
		await expect(
			manageEvent(opts(), {
				action: "create",
				name: "toofast-gated",
				definition: {
					type: "periodic",
					text: "x",
					schedule: "*/4 * * * *",
					preAction: { type: "bash", command: "echo hi" },
				},
			}),
		).rejects.toThrow(/5 minutes/);
	});

	it("rejects when a preAction command is blocked by the guard", async () => {
		await expect(
			manageEvent(opts({ commandGuardConfig: guard({ additionalDenyPatterns: ["blockme"] }) }), {
				action: "create",
				name: "guarded",
				definition: {
					type: "one-shot",
					text: "x",
					at: futureIso(30),
					preAction: { type: "bash", command: "echo blockme" },
				},
			}),
		).rejects.toThrow(/guard/i);
		expect(await listEventFiles()).toEqual([]);
	});

	it("rejects a traversal name", async () => {
		await expect(
			manageEvent(opts(), { action: "create", name: "../../escape", definition: validPeriodic }),
		).rejects.toThrow(/Invalid event name/);
	});

	it("rejects create when >= 50 event files already exist", async () => {
		const { mkdir } = await import("node:fs/promises");
		await mkdir(eventsDir, { recursive: true });
		for (let i = 0; i < 50; i++) {
			await writeFile(join(eventsDir, `filler-${i}.json`), "{}");
		}
		await expect(
			manageEvent(opts(), { action: "create", name: "one-too-many", definition: validPeriodic }),
		).rejects.toThrow(/Too many/);
	});
});

describe("manageEvent show / update", () => {
	async function seed(name: string, definition: EventDefinitionInput): Promise<void> {
		await manageEvent(opts(), { action: "create", name, definition });
	}

	it("show returns the full stored definition for a safe update (batch 3.6)", async () => {
		await seed("upd", validPeriodic);
		const shown = await manageEvent(opts(), { action: "show", name: "upd" });
		expect(shown.action).toBe("show");
		const parsed = JSON.parse(shown.notice);
		expect(parsed).toMatchObject({ type: "periodic", channelId: "dm_1", schedule: "0 10 * * 1" });
	});

	it("show throws recoverably for a missing event", async () => {
		await expect(manageEvent(opts(), { action: "show", name: "ghost" })).rejects.toThrow(/does not exist/);
	});

	it("replaces an existing event and re-validates", async () => {
		await seed("upd", validPeriodic);
		const result = await manageEvent(opts(), {
			action: "update",
			name: "upd",
			definition: { type: "periodic", text: "changed", schedule: "0 9 * * 1" },
		});
		expect(result.action).toBe("update");
		const onDisk = parseScheduledEventContent(await readFile(join(eventsDir, "upd.json"), "utf-8"), "x.json");
		expect(onDisk.text).toBe("changed");
	});

	it("rejects update of a non-existent event", async () => {
		await expect(manageEvent(opts(), { action: "update", name: "ghost", definition: validPeriodic })).rejects.toThrow(
			/does not exist/,
		);
	});

	it("rejects rewriting an existing immediate event (re-arming guard)", async () => {
		const { mkdir } = await import("node:fs/promises");
		await mkdir(eventsDir, { recursive: true });
		await writeFile(join(eventsDir, "imm.json"), JSON.stringify({ type: "immediate", channelId: "dm_1", text: "x" }));
		await expect(
			manageEvent(opts(), {
				action: "update",
				name: "imm",
				definition: { type: "one-shot", text: "x", at: futureIso(30) },
			}),
		).rejects.toThrow(/could not be parsed/);
	});

	it("rejects updating an event owned by another channel", async () => {
		const { mkdir } = await import("node:fs/promises");
		await mkdir(eventsDir, { recursive: true });
		await writeFile(
			join(eventsDir, "other.json"),
			JSON.stringify({ type: "periodic", channelId: "dm_other", text: "x", schedule: "0 10 * * 1" }),
		);
		await expect(manageEvent(opts(), { action: "update", name: "other", definition: validPeriodic })).rejects.toThrow(
			/another channel/,
		);
	});
});

describe("manageEvent delete", () => {
	it("deletes an owned event and is a no-op for a non-existent one", async () => {
		await manageEvent(opts(), { action: "create", name: "gone", definition: validPeriodic });
		const result = await manageEvent(opts(), { action: "delete", name: "gone" });
		expect(result.deleted).toBe(true);
		expect(await listEventFiles()).toEqual([]);
		expect((await manageEvent(opts(), { action: "delete", name: "never" })).deleted).toBe(false);
	});

	it("refuses to delete an event owned by another channel", async () => {
		const { mkdir } = await import("node:fs/promises");
		await mkdir(eventsDir, { recursive: true });
		await writeFile(
			join(eventsDir, "foreign.json"),
			JSON.stringify({ type: "periodic", channelId: "dm_other", text: "x", schedule: "0 10 * * 1" }),
		);
		await expect(manageEvent(opts(), { action: "delete", name: "foreign" })).rejects.toThrow(/another channel/);
		expect(await listEventFiles()).toEqual(["foreign.json"]);
	});

	describe("action: list", () => {
		it("returns an empty notice when the channel has no events", async () => {
			const result = await manageEvent(opts(), { action: "list" });
			expect(result).toMatchObject({ action: "list", count: 0, names: [] });
			expect(result.notice).toContain("暂无");
		});

		it("lists only this channel's events, one line each", async () => {
			await manageEvent(opts(), { action: "create", name: "mine-periodic", definition: validPeriodic });
			await manageEvent(opts(), {
				action: "create",
				name: "mine-oneshot",
				definition: { type: "one-shot", text: "回访", at: futureIso(60) },
			});
			const { mkdir } = await import("node:fs/promises");
			await mkdir(eventsDir, { recursive: true });
			await writeFile(
				join(eventsDir, "foreign.json"),
				JSON.stringify({ type: "periodic", channelId: "dm_other", text: "x", schedule: "0 10 * * 1" }),
			);

			const result = await manageEvent(opts(), { action: "list" });
			expect(result.count).toBe(2);
			expect(result.names?.sort()).toEqual(["mine-oneshot", "mine-periodic"]);
			expect(result.notice).toContain("mine-periodic [periodic]");
			expect(result.notice).toContain("mine-oneshot [one-shot]");
			expect(result.notice).not.toContain("foreign");
			expect(result.notice).not.toContain("dm_other");
		});

		it("lists an unparseable file and flags it instead of failing the whole call", async () => {
			const { mkdir } = await import("node:fs/promises");
			await mkdir(eventsDir, { recursive: true });
			await writeFile(join(eventsDir, "broken.json"), "{ not json");
			await manageEvent(opts(), { action: "create", name: "ok-one", definition: validPeriodic });

			const result = await manageEvent(opts(), { action: "list" });
			expect(result.notice).toContain("broken ⚠ 无法解析");
			expect(result.notice).toContain("ok-one [periodic]");
			expect(result.names).toContain("broken");
		});
	});
});
