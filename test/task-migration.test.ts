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

	it("reads v3 frontmatter faithfully and falls back to a default DoD in templates", () => {
		const parsed = parseV3Frontmatter(
			v3({ status: "sleeping", enabled: "false", schedule: "0 9 * * *", control: CONTROL }),
		);
		expect(parsed).toMatchObject({ status: "sleeping", enabled: false, schedule: "0 9 * * *", v5: false });
		expect(buildTemplate("x", "# X\n\n## Goal\nG\n").template?.dod).toBe("- [ ] 完成上述目标");
	});
});
