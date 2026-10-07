import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseScheduledEventContent } from "../src/events/events.js";
import { buildTemplate, convertBody, migrateTasksToV5, parseV3Frontmatter } from "../src/runtime/task-migration.js";
import { readTaskLog, resetTaskLogAppenders } from "../src/tasks/log.js";
import { readStoredTask } from "../src/tasks/store.js";

const BODY = [
	"# 日报",
	"",
	"## Goal",
	"每天整理一份日报。",
	"",
	"## DoD",
	"- [x] 内容完整",
	"- [x] 已发布",
	"",
	"## Manual",
	"发布前查询频道真实状态。",
	"",
	"## Verification",
	"Independent verification: required",
	"- Check every DoD item.",
	"",
	"## Plan",
	"- [x] P1 收集素材",
	"- [ ] P2 起草",
	"",
	"## Current Cycle",
	"- c-1 进行中",
	"",
	"## History",
	"- c-0 完成",
	"",
].join("\n");

function v3(front: Record<string, string>, body = BODY): string {
	return `---\n${Object.entries(front)
		.map(([key, value]) => `${key}: ${value}`)
		.join("\n")}\n---\n${body}`;
}
const CONTROL = '{"version":3,"verification":{"required":true,"status":"pending"}}';

describe("v3 → v5 conversion (spec 052)", () => {
	let root: string;
	let workspaceDir: string;
	let stateDir: string;
	let channelDir: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "task-migration-"));
		workspaceDir = join(root, "workspace");
		stateDir = join(root, "state");
		channelDir = join(workspaceDir, "dm_1");
		await mkdir(join(channelDir, "tasks"), { recursive: true });
	});
	afterEach(async () => {
		await resetTaskLogAppenders();
		await rm(root, { recursive: true, force: true });
	});

	const write = (id: string, content: string) => writeFile(join(channelDir, "tasks", `${id}.md`), content);
	const eventPath = (name: string) => join(workspaceDir, "events", `${name}.json`);

	it("turns a sleeping recurring task into an event template and retires it", async () => {
		await write(
			"daily",
			v3({ status: "sleeping", schedule: "0 9 * * *", wake: "2099-01-01T09:00:00+08:00", control: CONTROL }),
		);

		await migrateTasksToV5(workspaceDir, stateDir);

		const event = parseScheduledEventContent(await readFile(eventPath("daily"), "utf-8"), "daily.json");
		expect(event).toMatchObject({ type: "periodic", channelId: "dm_1", schedule: "0 9 * * *" });
		// Manual and Verification fold into the Goal, checkboxes reset, Plan items become Work Items.
		expect(event.task?.goal).toContain("每天整理一份日报。");
		expect(event.task?.goal).toContain("发布前查询频道真实状态。");
		expect(event.task?.goal).toContain("Check every DoD item.");
		expect(event.task?.goal).not.toContain("Independent verification:");
		expect(event.task?.dod).not.toContain("[x]");
		expect(event.task?.items?.map((item) => item.text)).toEqual(["收集素材", "起草"]);

		// Sleeping between occurrences: nothing left to run, so the task is archived, not duplicated.
		expect(existsSync(join(channelDir, "tasks", "daily.md"))).toBe(false);
		expect(await readFile(join(channelDir, "tasks", "archive", "daily.md"), "utf-8")).toContain("outcome: cancelled");
		expect(existsSync(join(channelDir, "tasks", ".v3", "daily.md"))).toBe(true);
	});

	it("lets the occurrence in flight finish as an instance of the new event", async () => {
		await write("daily", v3({ status: "active", schedule: "0 9 * * *", control: CONTROL }));
		await migrateTasksToV5(workspaceDir, stateDir);

		const task = await readStoredTask(channelDir, "daily");
		expect(task?.fields).toMatchObject({ state: "open", origin: "daily" });
		expect(task?.body).toContain("## Work Items");
		expect(existsSync(eventPath("daily"))).toBe(true);
	});

	it("converts the body: Plan becomes Work Items, per-cycle sections go, authored sections stay", () => {
		const converted = convertBody(BODY);
		expect(converted).toContain("## Work Items");
		for (const gone of ["## Plan", "Current Cycle", "History", "c-0 完成"]) expect(converted).not.toContain(gone);
		expect(converted).toContain("- [x] P1 收集素材");
		for (const kept of ["## Goal", "## DoD", "## Manual", "## Verification"]) expect(converted).toContain(kept);
	});

	it("never starts a disabled task, and never leaves a park behind", async () => {
		await write("off", v3({ status: "active", enabled: "false", control: CONTROL }, "# Off\n"));
		await write(
			"stopped",
			v3(
				{
					status: "active",
					control: '{"version":3,"stop":{"by":"governor","reason":"预算用尽","at":"2026-09-01T09:00:00+08:00"}}',
				},
				"# S\n",
			),
		);
		await write("waiting", v3({ status: "waiting", wake: "2099-01-01T00:00:00+08:00", control: CONTROL }, "# W\n"));

		await migrateTasksToV5(workspaceDir, stateDir);

		expect((await readStoredTask(channelDir, "off"))?.fields.paused?.by).toBe("user");
		expect((await readStoredTask(channelDir, "stopped"))?.fields.paused?.reason).toBe("预算用尽");
		const waiting = await readStoredTask(channelDir, "waiting");
		expect(waiting?.fields).toMatchObject({ state: "open" });
		expect(waiting?.fields.paused).toBeUndefined();
		expect((await readTaskLog(channelDir, "waiting")).some((record) => record.kind === "note")).toBe(true);
	});

	it("never turns a stopped recurring task into a runnable event template", async () => {
		const stop = '{"version":3,"stop":{"by":"governor","reason":"预算用尽","at":"2026-09-01T09:00:00+08:00"}}';
		await write("off", v3({ status: "active", enabled: "false", schedule: "0 9 * * *", control: CONTROL }));
		await write("halted", v3({ status: "active", schedule: "0 9 * * *", control: stop }));
		await write("napping", v3({ status: "sleeping", enabled: "false", schedule: "0 9 * * *", control: CONTROL }));

		await migrateTasksToV5(workspaceDir, stateDir);

		for (const id of ["off", "halted", "napping"]) {
			const task = await readStoredTask(channelDir, id);
			expect(task?.fields.paused?.by).toBe("user");
			expect(task?.fields.origin).toBeUndefined();
			expect(existsSync(eventPath(id))).toBe(false);
			expect(existsSync(join(channelDir, "tasks", ".v3", `${id}.md`))).toBe(true);
			const notes = (await readTaskLog(channelDir, id)).filter((record) => record.kind === "note");
			expect(JSON.stringify(notes)).toContain("0 9 * * *");
		}
		expect((await readStoredTask(channelDir, "halted"))?.fields.paused?.reason).toBe("预算用尽");
		expect(existsSync(join(workspaceDir, "events"))).toBe(false);
	});

	it("moves task-owned sensor events away and says so on the owning task", async () => {
		await write("sensor", v3({ status: "active", control: CONTROL }, "# S\n"));
		await mkdir(join(workspaceDir, "events"), { recursive: true });
		await writeFile(eventPath("task.dm_1.sensor.check"), "{}");
		await writeFile(eventPath("unrelated"), "{}");

		await migrateTasksToV5(workspaceDir, stateDir);

		expect(existsSync(eventPath("task.dm_1.sensor.check"))).toBe(false);
		expect(existsSync(join(channelDir, "tasks", ".v3", "events", "task.dm_1.sensor.check.json"))).toBe(true);
		expect(existsSync(eventPath("unrelated"))).toBe(true);
	});

	it("runs once, leaves v5 files alone, and never deletes an original", async () => {
		await write("old", v3({ status: "active", control: CONTROL }, "# Old\n"));
		await write(
			"fresh",
			`---\nstate: open\nusage: {"startedAt":"2026-09-05T09:00:00+08:00","steps":0,"usd":0,"usdEstimated":false,"expired":0}\n---\n# Fresh\n`,
		);

		await migrateTasksToV5(workspaceDir, stateDir);

		expect((await readdir(join(channelDir, "tasks", ".v3"))).sort()).toEqual(["old.md"]);
		expect(await readFile(join(channelDir, "tasks", ".v3", "old.md"), "utf-8")).toContain("status: active");
		expect(existsSync(join(stateDir, "task-migration-v5.done"))).toBe(true);

		// Marker-gated: a v3 file appearing afterwards is not touched a second time.
		await write("late", v3({ status: "active", control: CONTROL }, "# L\n"));
		await migrateTasksToV5(workspaceDir, stateDir);
		expect(await readFile(join(channelDir, "tasks", "late.md"), "utf-8")).toContain("status:");
	});

	it("preserves unsupported v4 files byte-for-byte, including mixed state/status input", async () => {
		// Regression: a state-based beta task must not be mistaken for v3 and rewritten, losing its wait/usage.
		const original = v3({
			state: "parked",
			status: "waiting",
			cycle: '{"steps":7,"usd":2}',
			ticket: '{"kind":"run","by":"2099-01-01T00:00:00+08:00"}',
			schedule: "0 9 * * *",
		});
		await write("beta", original);
		await migrateTasksToV5(workspaceDir, stateDir);
		expect(await readFile(join(channelDir, "tasks", "beta.md"), "utf-8")).toBe(original);
		expect(existsSync(join(channelDir, "tasks", ".v3", "beta.md"))).toBe(false);
		expect(existsSync(eventPath("beta"))).toBe(false);
	});

	it("falls back to a runtime pause when a recurring task cannot be expressed as a template", async () => {
		// A DoD without checklist items cannot become a valid template, and the schedule must not be lost silently.
		await write(
			"odd",
			v3({ status: "active", schedule: "0 9 * * *", control: CONTROL }, "# Odd\n\n## DoD\nprose only\n"),
		);
		await migrateTasksToV5(workspaceDir, stateDir);
		const task = await readStoredTask(channelDir, "odd");
		expect(task?.fields.paused?.by).toBe("runtime");
		expect(existsSync(eventPath("odd"))).toBe(false);
	});

	it("pauses a stopped task whose stop reason is missing or blank instead of reopening it", async () => {
		await write("nostop", v3({ status: "active", control: '{"version":3,"stop":{"by":"governor"}}' }, "# N\n"));
		await write("blank", v3({ status: "active", control: '{"version":3,"stop":{"reason":"   "}}' }, "# B\n"));
		await write("empty", v3({ status: "active", control: '{"version":3,"stop":{"reason":""}}' }, "# E\n"));

		await migrateTasksToV5(workspaceDir, stateDir);

		for (const id of ["nostop", "blank", "empty"]) {
			const task = await readStoredTask(channelDir, id);
			expect(task?.fields.paused?.by).toBe("user");
			expect(task?.fields.paused?.reason).toBeTruthy();
		}
	});

	it("never overwrites an existing backup and keeps both copies", async () => {
		await mkdir(join(channelDir, "tasks", ".v3"), { recursive: true });
		await writeFile(join(channelDir, "tasks", ".v3", "old.md"), "earlier backup");
		await write("old", v3({ status: "active", control: CONTROL }, "# Old\n"));

		await migrateTasksToV5(workspaceDir, stateDir);

		expect(await readFile(join(channelDir, "tasks", ".v3", "old.md"), "utf-8")).toBe("earlier backup");
		expect(await readFile(join(channelDir, "tasks", ".v3", "old.backup-1.md"), "utf-8")).toContain("status: active");
	});

	it("never overwrites a same-named task-owned event backup and keeps both copies", async () => {
		await mkdir(join(channelDir, "tasks", ".v3", "events"), { recursive: true });
		await writeFile(join(channelDir, "tasks", ".v3", "events", "task.dm_1.old.sensor.json"), "earlier backup");
		await mkdir(join(workspaceDir, "events"), { recursive: true });
		await writeFile(eventPath("task.dm_1.old.sensor"), '{"new":true}');

		await migrateTasksToV5(workspaceDir, stateDir);

		const backups = join(channelDir, "tasks", ".v3", "events");
		expect(await readFile(join(backups, "task.dm_1.old.sensor.json"), "utf-8")).toBe("earlier backup");
		expect(await readFile(join(backups, "task.dm_1.old.sensor.backup-1.json"), "utf-8")).toBe('{"new":true}');
		expect(existsSync(eventPath("task.dm_1.old.sensor"))).toBe(false);
	});

	describe("failures", () => {
		const SLEEPING = v3({ status: "sleeping", schedule: "0 9 * * *", control: CONTROL });
		const reportPath = () => join(stateDir, "task-migration-v5.failed.json");
		const markerPath = () => join(stateDir, "task-migration-v5.done");
		const report = async () => JSON.parse(await readFile(reportPath(), "utf-8")).failures;

		it("rolls back a template already written when the archive step fails, and blocks the marker", async () => {
			await write("daily", SLEEPING);
			// `archive` being a file makes the final archive step fail after the template and task were written.
			await writeFile(join(channelDir, "tasks", "archive"), "not a directory");

			await expect(migrateTasksToV5(workspaceDir, stateDir)).rejects.toThrow(/failed for 1 item/);

			expect(existsSync(eventPath("daily"))).toBe(false);
			expect(await readFile(join(channelDir, "tasks", "daily.md"), "utf-8")).toBe(SLEEPING);
			expect(existsSync(join(channelDir, "tasks", "daily.jsonl"))).toBe(false);
			expect(existsSync(markerPath())).toBe(false);
			expect(await report()).toMatchObject([{ channelId: "dm_1", task: "daily", stage: "archive", rollback: "ok" }]);
		});

		it("reports the template stage and leaves the v3 original untouched", async () => {
			await write("daily", SLEEPING);
			await mkdir(workspaceDir, { recursive: true });
			await writeFile(join(workspaceDir, "events"), "not a directory");

			await expect(migrateTasksToV5(workspaceDir, stateDir)).rejects.toThrow();

			expect(await readFile(join(channelDir, "tasks", "daily.md"), "utf-8")).toBe(SLEEPING);
			expect(await report()).toMatchObject([{ task: "daily", stage: "template", rollback: "ok" }]);
			expect(existsSync(markerPath())).toBe(false);
		});

		it("reports the backup stage and does not touch the task", async () => {
			await write("old", v3({ status: "active", control: CONTROL }, "# Old\n"));
			await mkdir(join(channelDir, "tasks", ".v3", "old.md"), { recursive: true });

			await expect(migrateTasksToV5(workspaceDir, stateDir)).rejects.toThrow();

			expect(await readFile(join(channelDir, "tasks", "old.md"), "utf-8")).toContain("status: active");
			expect(await report()).toMatchObject([{ task: "old", stage: "backup" }]);
		});

		it("keeps converted siblings, retries failed tasks on the next start, and clears the report", async () => {
			await write("good", v3({ status: "active", control: CONTROL }, "# Good\n"));
			await write("daily", SLEEPING);
			await writeFile(join(channelDir, "tasks", "archive"), "not a directory");
			await expect(migrateTasksToV5(workspaceDir, stateDir)).rejects.toThrow();
			expect((await readStoredTask(channelDir, "good"))?.fields.state).toBe("open");

			await rm(join(channelDir, "tasks", "archive"));
			await migrateTasksToV5(workspaceDir, stateDir);

			expect(existsSync(join(channelDir, "tasks", "archive", "daily.md"))).toBe(true);
			expect(existsSync(eventPath("daily"))).toBe(true);
			expect(existsSync(reportPath())).toBe(false);
			expect(existsSync(markerPath())).toBe(true);
		});

		it("keeps blocking while a report records a failed rollback", async () => {
			await mkdir(stateDir, { recursive: true });
			await writeFile(
				reportPath(),
				JSON.stringify({
					failures: [
						{ channelId: "dm_1", task: "x", stage: "task", error: "e", rollback: "restore original: EACCES" },
					],
				}),
			);
			await expect(migrateTasksToV5(workspaceDir, stateDir)).rejects.toThrow(/blocked/);
			expect(existsSync(markerPath())).toBe(false);
		});
	});

	it("reads v3 frontmatter faithfully and falls back to a default DoD in templates", () => {
		const parsed = parseV3Frontmatter(
			v3({ status: "sleeping", enabled: "false", schedule: "0 9 * * *", control: CONTROL }),
		);
		expect(parsed).toMatchObject({ status: "sleeping", enabled: false, schedule: "0 9 * * *", v5: false });
		expect(buildTemplate("x", "# X\n\n## Goal\nG\n").template?.dod).toBe("- [ ] 完成上述目标");
	});
});
