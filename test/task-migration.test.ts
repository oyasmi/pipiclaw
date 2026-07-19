import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateLegacyTaskScheduleEvents } from "../src/runtime/task-migration.js";

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
