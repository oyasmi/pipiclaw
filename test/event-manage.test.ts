import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseScheduledEventContent } from "../src/runtime/events.js";
import type { SecurityConfig } from "../src/security/types.js";
import { type EventManageToolOptions, manageEvent } from "../src/tools/event-manage.js";

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

const validPeriodic = JSON.stringify({
	type: "periodic",
	channelId: "dm_1",
	text: "推进任务 weekly-report",
	schedule: "0 10 * * 1",
	timezone: "Asia/Shanghai",
});

describe("manageEvent create", () => {
	it("writes a valid periodic event that the watcher parser can load back", async () => {
		const result = await manageEvent(opts(), {
			action: "create",
			name: "task.dm_1.weekly-report.schedule",
			definition: validPeriodic,
		});
		expect(result.eventType).toBe("periodic");
		expect(await listEventFiles()).toEqual(["task.dm_1.weekly-report.schedule.json"]);
		const onDisk = await readFile(join(eventsDir, "task.dm_1.weekly-report.schedule.json"), "utf-8");
		const parsed = parseScheduledEventContent(onDisk, "x.json");
		expect(parsed.type).toBe("periodic");
		expect(parsed.channelId).toBe("dm_1");
	});

	it("writes a valid one-shot event", async () => {
		const result = await manageEvent(opts(), {
			action: "create",
			name: "task.dm_1.weekly-report.checkin",
			definition: JSON.stringify({ type: "one-shot", text: "回访", at: futureIso(30) }),
		});
		expect(result.eventType).toBe("one-shot");
		expect(result.channelId).toBe("dm_1");
	});

	it("defaults channelId to the current channel when omitted", async () => {
		const result = await manageEvent(opts(), {
			action: "create",
			name: "no-channel",
			definition: JSON.stringify({ type: "one-shot", text: "x", at: futureIso(30) }),
		});
		expect(result.channelId).toBe("dm_1");
	});

	it("normalizes .json suffix (foo === foo.json)", async () => {
		await manageEvent(opts(), {
			action: "create",
			name: "foo",
			definition: JSON.stringify({ type: "one-shot", text: "x", at: futureIso(30) }),
		});
		await expect(
			manageEvent(opts(), {
				action: "create",
				name: "foo.json",
				definition: JSON.stringify({ type: "one-shot", text: "y", at: futureIso(30) }),
			}),
		).rejects.toThrow(/already exists/);
	});

	it("leaves no .tmp file and only the .json event behind (atomic write)", async () => {
		await manageEvent(opts(), { action: "create", name: "clean", definition: validPeriodic });
		const files = await listEventFiles();
		expect(files).toEqual(["clean.json"]);
		expect(files.every((f) => f.endsWith(".json"))).toBe(true);
	});

	it("rejects invalid JSON without writing a file", async () => {
		await expect(manageEvent(opts(), { action: "create", name: "bad", definition: "{ not json" })).rejects.toThrow(
			/not valid JSON/,
		);
		expect(await listEventFiles()).toEqual([]);
	});

	it("rejects a definition missing required fields", async () => {
		await expect(
			manageEvent(opts(), { action: "create", name: "bad", definition: JSON.stringify({ type: "periodic" }) }),
		).rejects.toThrow();
		expect(await listEventFiles()).toEqual([]);
	});

	it("rejects immediate events", async () => {
		await expect(
			manageEvent(opts(), {
				action: "create",
				name: "imm",
				definition: JSON.stringify({ type: "immediate", text: "go" }),
			}),
		).rejects.toThrow(/immediate/);
		expect(await listEventFiles()).toEqual([]);
	});

	it("rejects one-shot scheduled sooner than 2 minutes out", async () => {
		await expect(
			manageEvent(opts(), {
				action: "create",
				name: "soon",
				definition: JSON.stringify({ type: "one-shot", text: "x", at: futureIso(1) }),
			}),
		).rejects.toThrow(/2 minutes/);
	});

	it("rejects a periodic cron firing more often than every 30 minutes", async () => {
		await expect(
			manageEvent(opts(), {
				action: "create",
				name: "toofast",
				definition: JSON.stringify({
					type: "periodic",
					text: "x",
					schedule: "* * * * *",
					timezone: "Asia/Shanghai",
				}),
			}),
		).rejects.toThrow(/30 minutes/);
	});

	it("allows a sub-30-minute periodic cron when it carries a preAction gate", async () => {
		const result = await manageEvent(opts(), {
			action: "create",
			name: "task.dm_1.demo.agentmux",
			definition: JSON.stringify({
				type: "periodic",
				text: "x",
				schedule: "*/10 * * * *",
				timezone: "Asia/Shanghai",
				preAction: { type: "bash", command: "echo hi" },
			}),
		});
		expect(result.eventType).toBe("periodic");
		expect(await listEventFiles()).toEqual(["task.dm_1.demo.agentmux.json"]);
	});

	it("still rejects a sub-30-minute periodic cron without a preAction gate", async () => {
		await expect(
			manageEvent(opts(), {
				action: "create",
				name: "nogate",
				definition: JSON.stringify({
					type: "periodic",
					text: "x",
					schedule: "*/10 * * * *",
					timezone: "Asia/Shanghai",
				}),
			}),
		).rejects.toThrow(/30 minutes/);
	});

	it("rejects a preAction-gated periodic below the 5-minute hard sub-floor", async () => {
		await expect(
			manageEvent(opts(), {
				action: "create",
				name: "toofast-gated",
				definition: JSON.stringify({
					type: "periodic",
					text: "x",
					schedule: "*/4 * * * *",
					timezone: "Asia/Shanghai",
					preAction: { type: "bash", command: "echo hi" },
				}),
			}),
		).rejects.toThrow(/5 minutes/);
	});

	it("rejects an invalid cron schedule", async () => {
		await expect(
			manageEvent(opts(), {
				action: "create",
				name: "badcron",
				definition: JSON.stringify({
					type: "periodic",
					text: "x",
					schedule: "not a cron",
					timezone: "Asia/Shanghai",
				}),
			}),
		).rejects.toThrow(/cron/i);
	});

	it("rejects an invalid timezone", async () => {
		await expect(
			manageEvent(opts(), {
				action: "create",
				name: "badtz",
				definition: JSON.stringify({
					type: "periodic",
					text: "x",
					schedule: "0 10 * * 1",
					timezone: "Not/AZone",
				}),
			}),
		).rejects.toThrow(/timezone/i);
	});

	it("rejects when a preAction command is blocked by the guard", async () => {
		await expect(
			manageEvent(opts({ commandGuardConfig: guard({ additionalDenyPatterns: ["blockme"] }) }), {
				action: "create",
				name: "guarded",
				definition: JSON.stringify({
					type: "one-shot",
					text: "x",
					at: futureIso(30),
					preAction: { type: "bash", command: "echo blockme" },
				}),
			}),
		).rejects.toThrow(/guard/i);
		expect(await listEventFiles()).toEqual([]);
	});

	it("rejects a traversal name", async () => {
		await expect(
			manageEvent(opts(), { action: "create", name: "../../escape", definition: validPeriodic }),
		).rejects.toThrow(/Invalid event name/);
	});

	it("rejects a definition whose channelId is a different channel", async () => {
		await expect(
			manageEvent(opts(), {
				action: "create",
				name: "cross",
				definition: JSON.stringify({ type: "one-shot", channelId: "dm_other", text: "x", at: futureIso(30) }),
			}),
		).rejects.toThrow(/does not match/);
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

describe("manageEvent update", () => {
	async function seed(name: string, definition: string): Promise<void> {
		await manageEvent(opts(), { action: "create", name, definition });
	}

	it("replaces an existing event and re-validates", async () => {
		await seed("upd", validPeriodic);
		const result = await manageEvent(opts(), {
			action: "update",
			name: "upd",
			definition: JSON.stringify({
				type: "periodic",
				text: "changed",
				schedule: "0 9 * * 1",
				timezone: "Asia/Shanghai",
			}),
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
				definition: JSON.stringify({ type: "one-shot", text: "x", at: futureIso(30) }),
			}),
		).rejects.toThrow(/immediate/);
	});

	it("rejects updating an event owned by another channel", async () => {
		const { mkdir } = await import("node:fs/promises");
		await mkdir(eventsDir, { recursive: true });
		await writeFile(
			join(eventsDir, "other.json"),
			JSON.stringify({
				type: "periodic",
				channelId: "dm_other",
				text: "x",
				schedule: "0 10 * * 1",
				timezone: "Asia/Shanghai",
			}),
		);
		await expect(manageEvent(opts(), { action: "update", name: "other", definition: validPeriodic })).rejects.toThrow(
			/another channel/,
		);
	});
});

describe("manageEvent delete", () => {
	it("deletes an owned event", async () => {
		await manageEvent(opts(), { action: "create", name: "gone", definition: validPeriodic });
		const result = await manageEvent(opts(), { action: "delete", name: "gone" });
		expect(result.deleted).toBe(true);
		expect(await listEventFiles()).toEqual([]);
	});

	it("is a no-op for a non-existent event", async () => {
		const result = await manageEvent(opts(), { action: "delete", name: "never" });
		expect(result.deleted).toBe(false);
	});

	it("refuses to delete an event owned by another channel", async () => {
		const { mkdir } = await import("node:fs/promises");
		await mkdir(eventsDir, { recursive: true });
		await writeFile(
			join(eventsDir, "foreign.json"),
			JSON.stringify({
				type: "periodic",
				channelId: "dm_other",
				text: "x",
				schedule: "0 10 * * 1",
				timezone: "Asia/Shanghai",
			}),
		);
		await expect(manageEvent(opts(), { action: "delete", name: "foreign" })).rejects.toThrow(/another channel/);
		expect(await listEventFiles()).toEqual(["foreign.json"]);
	});
});
