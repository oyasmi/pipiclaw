import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateLegacyTaskScheduleEvents, migrateLegacyTaskState } from "../src/runtime/task-migration.js";
import { parseTaskFrontmatter } from "../src/tasks/ledger.js";

describe("migrateLegacyTaskScheduleEvents", () => {
	let workspaceDir: string;
	let eventsDir: string;

	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), "task-migration-"));
		eventsDir = join(workspaceDir, "events");
		await mkdir(eventsDir, { recursive: true });
	});
	afterEach(async () => {
		await rm(workspaceDir, { recursive: true, force: true });
	});

	async function writeTask(
		channelId: string,
		id: string,
		front: string,
		body = "# T\n\n## Current Cycle\n- x",
	): Promise<string> {
		const dir = join(workspaceDir, channelId, "tasks");
		await mkdir(dir, { recursive: true });
		const path = join(dir, `${id}.md`);
		await writeFile(path, `---\n${front}\n---\n\n${body}`);
		return path;
	}

	async function writeScheduleEvent(channelId: string, id: string, schedule: string): Promise<void> {
		await writeFile(
			join(eventsDir, `task.${channelId}.${id}.schedule.json`),
			JSON.stringify({ type: "periodic", channelId, text: `推进任务 ${id}`, schedule }),
		);
	}

	it("folds a residual .schedule event into the task frontmatter and deletes the event", async () => {
		const path = await writeTask("dm_a", "weekly", "status: active");
		await writeScheduleEvent("dm_a", "weekly", "0 9 * * 1");

		await migrateLegacyTaskScheduleEvents(workspaceDir);

		expect(await readFile(path, "utf-8")).toContain("schedule: 0 9 * * 1");
		expect(existsSync(join(eventsDir, "task.dm_a.weekly.schedule.json"))).toBe(false);
	});

	it("lets an existing frontmatter schedule win and still deletes the event", async () => {
		const path = await writeTask("dm_a", "weekly", "status: active\nschedule: 30 8 * * 5");
		await writeScheduleEvent("dm_a", "weekly", "0 9 * * 1");

		await migrateLegacyTaskScheduleEvents(workspaceDir);

		const onDisk = await readFile(path, "utf-8");
		expect(onDisk).toContain("schedule: 30 8 * * 5");
		expect(onDisk).not.toContain("0 9 * * 1");
		expect(existsSync(join(eventsDir, "task.dm_a.weekly.schedule.json"))).toBe(false);
	});

	it("removes an orphan .schedule event whose task no longer exists", async () => {
		// A channel dir must exist for discovery; the task file does not.
		await mkdir(join(workspaceDir, "dm_a", "tasks"), { recursive: true });
		await writeScheduleEvent("dm_a", "ghost", "0 9 * * 1");

		await migrateLegacyTaskScheduleEvents(workspaceDir);

		expect(existsSync(join(eventsDir, "task.dm_a.ghost.schedule.json"))).toBe(false);
	});

	it("leaves non-schedule task events untouched", async () => {
		await mkdir(join(workspaceDir, "dm_a", "tasks"), { recursive: true });
		await writeFile(
			join(eventsDir, "task.dm_a.weekly.checkin.json"),
			JSON.stringify({ type: "one-shot", channelId: "dm_a", text: "回访", at: "2026-07-09T10:00:00+08:00" }),
		);

		await migrateLegacyTaskScheduleEvents(workspaceDir);

		expect(existsSync(join(eventsDir, "task.dm_a.weekly.checkin.json"))).toBe(true);
	});
});

describe("migrateLegacyTaskState", () => {
	let workspaceDir: string;

	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), "task-state-migration-"));
	});
	afterEach(async () => {
		await rm(workspaceDir, { recursive: true, force: true });
	});

	async function writeTask(channelId: string, id: string, front: string): Promise<string> {
		const dir = join(workspaceDir, channelId, "tasks");
		await mkdir(dir, { recursive: true });
		const path = join(dir, `${id}.md`);
		await writeFile(path, `---\n${front}\n---\n\n# ${id}\n\n## Current Cycle\n- legacy note\n\n## History\n`);
		return path;
	}

	const legacyControl = JSON.stringify({
		version: 1,
		priority: "normal",
		pausedBy: "governor",
		blockedReason: "legacy stop",
		sideEffects: "external",
		externalApproval: "required",
		budget: { maxAttempts: 12 },
		usage: { attempts: 1, tokens: 2, costUsd: 0, wallTimeMinutes: 0 },
		verification: { mode: "evidence", status: "pending" },
	});

	it("maps v1 states conservatively, archives one-shot terminals, and is idempotent", async () => {
		const paused = await writeTask("dm_a", "paused", `status: paused\ncontrol: ${legacyControl}`);
		const recurring = await writeTask(
			"dm_a",
			"recurring",
			"status: done\nschedule: 0 9 * * 1\nwake: 2026-08-10T09:00:00+08:00",
		);
		const terminal = await writeTask("dm_a", "terminal", "status: done");

		await migrateLegacyTaskState(workspaceDir);

		const pausedFrontmatter = parseTaskFrontmatter(await readFile(paused, "utf-8"));
		expect(pausedFrontmatter).toMatchObject({ status: "active", enabled: false, control: { version: 2 } });
		expect(pausedFrontmatter.control).not.toHaveProperty("externalApproval");
		const recurringFrontmatter = parseTaskFrontmatter(await readFile(recurring, "utf-8"));
		expect(recurringFrontmatter).toMatchObject({ status: "sleeping", enabled: true, schedule: "0 9 * * 1" });
		expect(existsSync(join(workspaceDir, "dm_a", "tasks", "archive", "terminal.md"))).toBe(true);
		expect(existsSync(terminal)).toBe(false);

		const firstPaused = await readFile(paused, "utf-8");
		const firstRecurring = await readFile(recurring, "utf-8");
		await migrateLegacyTaskState(workspaceDir);
		expect(await readFile(paused, "utf-8")).toBe(firstPaused);
		expect(await readFile(recurring, "utf-8")).toBe(firstRecurring);
	});

	it("marks a legacy signal wait for review instead of waking it automatically", async () => {
		const path = await writeTask(
			"dm_a",
			"waiting",
			`status: waiting\ncontrol: ${JSON.stringify({
				version: 1,
				priority: "normal",
				budget: { maxAttempts: 12 },
				usage: { attempts: 0, tokens: 0, costUsd: 0, wallTimeMinutes: 0 },
				verification: { mode: "evidence", status: "pending" },
			})}`,
		);
		await migrateLegacyTaskState(workspaceDir);
		const content = await readFile(path, "utf-8");
		expect(content).toContain('"waitingFor":"external-signal"');
		expect(content).toContain("Migration note:");
		expect(content).toContain("status: waiting");
	});
});
