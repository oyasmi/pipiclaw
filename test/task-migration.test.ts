import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseScheduledEventContent } from "../src/events/events.js";
import { buildTemplate, convertBody, migrateTasksToV5, parseV4Frontmatter } from "../src/runtime/task-migration.js";
import { readTaskLog, resetTaskLogAppenders } from "../src/tasks/log.js";
import { readStoredTask } from "../src/tasks/store.js";

const FUTURE = "2099-01-01T00:00:00+08:00";
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
	"## 上次结果",
	"- c-1 完成：已发布",
	"",
].join("\n");

function v4(front: Record<string, string>, body = BODY): string {
	return `---\n${Object.entries(front)
		.map(([key, value]) => `${key}: ${value}`)
		.join("\n")}\n---\n${body}`;
}
const CYCLE =
	'{"id":"c-1","startedAt":"2026-09-05T09:00:00+08:00","steps":7,"rounds":2,"usd":3.2,"usdEstimated":true,"expired":1}';

describe("v4 → v5 conversion (spec 052, D12)", () => {
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

	it("turns a recurring task waiting for its next occurrence into an event template and retires it", async () => {
		await write(
			"daily",
			v4({
				state: "parked",
				schedule: "0 9 * * *",
				ticket: `{"kind":"schedule","at":"${FUTURE}","by":"${FUTURE}"}`,
				cycle: CYCLE,
				budget: '{"steps":30,"rounds":3,"wallMin":90,"usd":4}',
				verify: "required",
			}),
		);

		await migrateTasksToV5(workspaceDir, stateDir);

		const event = parseScheduledEventContent(await readFile(eventPath("daily"), "utf-8"), "daily.json");
		expect(event).toMatchObject({ type: "periodic", channelId: "dm_1", schedule: "0 9 * * *" });
		// The template carries what each occurrence needs: Manual and Verification fold into the Goal,
		// checkboxes are reset, Plan items become Work Items, and only steps/usd survive in the budget.
		expect(event.task?.goal).toContain("每天整理一份日报。");
		expect(event.task?.goal).toContain("发布前查询频道真实状态。");
		expect(event.task?.goal).toContain("Check every DoD item.");
		expect(event.task?.goal).not.toContain("Independent verification:");
		expect(event.task?.dod).not.toContain("[x]");
		expect(event.task?.items?.map((item) => item.text)).toEqual(["收集素材", "起草"]);
		expect(event.task?.budget).toEqual({ steps: 30, usd: 4 });

		// Waiting between occurrences: nothing left to run, so the task is archived, not duplicated.
		expect(existsSync(join(channelDir, "tasks", "daily.md"))).toBe(false);
		expect(await readFile(join(channelDir, "tasks", "archive", "daily.md"), "utf-8")).toContain("outcome: cancelled");
		expect(existsSync(join(channelDir, "tasks", ".v4", "daily.md"))).toBe(true);
		expect(
			(await readTaskLog(channelDir, "daily")).map((record) => record.kind === "note" && record.note).join("\n"),
		).toContain("事件模板 daily");
	});

	it("lets the occurrence in flight finish as an instance of the new event", async () => {
		await write("daily", v4({ state: "open", schedule: "0 9 * * *", cycle: CYCLE }));
		await migrateTasksToV5(workspaceDir, stateDir);

		const task = await readStoredTask(channelDir, "daily");
		expect(task?.fields).toMatchObject({ state: "open", origin: "daily" });
		expect(task?.fields.usage).toMatchObject({ steps: 7, usd: 3.2, usdEstimated: true, expired: 1 });
		expect(existsSync(eventPath("daily"))).toBe(true);
	});

	it("converts the body: Plan becomes Work Items, 上次结果 goes, authored sections stay", () => {
		const converted = convertBody(BODY);
		expect(converted).toContain("## Work Items");
		expect(converted).not.toContain("## Plan");
		expect(converted).not.toContain("上次结果");
		expect(converted).toContain("- [x] P1 收集素材");
		for (const kept of ["## Goal", "## DoD", "## Manual", "## Verification"]) expect(converted).toContain(kept);
	});

	it("never leaves a park on a source that no longer exists", async () => {
		await write(
			"lost-run",
			v4({ state: "parked", ticket: `{"kind":"run","id":"run_gone","by":"${FUTURE}"}`, cycle: CYCLE }, "# T\n"),
		);
		await write(
			"sensor",
			v4(
				{
					state: "parked",
					ticket: `{"kind":"signal","event":"task.dm_1.sensor.check","by":"${FUTURE}"}`,
					cycle: CYCLE,
				},
				"# S\n",
			),
		);
		await write(
			"asking",
			v4({ state: "parked", ticket: `{"kind":"ask","asked":"merge?","by":"${FUTURE}"}`, cycle: CYCLE }, "# A\n"),
		);

		await migrateTasksToV5(workspaceDir, stateDir);

		for (const id of ["lost-run", "sensor"]) {
			const task = await readStoredTask(channelDir, id);
			expect(task?.fields.state, id).toBe("open");
			expect(
				(await readTaskLog(channelDir, id)).some((record) => record.kind === "note"),
				id,
			).toBe(true);
		}
		expect((await readStoredTask(channelDir, "asking"))?.fields.ticket).toMatchObject({
			kind: "ask",
			asked: "merge?",
		});
	});

	it("keeps a wait on a run that is still in flight, as a work ticket", async () => {
		const runsDir = join(stateDir, "subagent-runs", "dm_1");
		await mkdir(runsDir, { recursive: true });
		await writeFile(
			join(runsDir, "run_live.json"),
			JSON.stringify({ runId: "run_live", taskId: "waiting", status: "running", startedAt: Date.now() }),
		);
		await writeFile(
			join(runsDir, "run_other.json"),
			JSON.stringify({ runId: "run_other", taskId: "someone-else", status: "running", startedAt: Date.now() }),
		);
		await write(
			"waiting",
			v4({ state: "parked", ticket: `{"kind":"run","id":"run_live","by":"${FUTURE}"}`, cycle: CYCLE }, "# W\n"),
		);

		await migrateTasksToV5(workspaceDir, stateDir);

		const ticket = (await readStoredTask(channelDir, "waiting"))?.fields.ticket;
		expect(ticket).toMatchObject({ kind: "work", refs: ["run_live"] });
	});

	it("moves task-owned sensor events away and says so on the owning task", async () => {
		await write("sensor", v4({ state: "open", cycle: CYCLE }, "# S\n"));
		await mkdir(join(workspaceDir, "events"), { recursive: true });
		await writeFile(eventPath("task.dm_1.sensor.check"), "{}");
		await writeFile(eventPath("unrelated"), "{}");

		await migrateTasksToV5(workspaceDir, stateDir);

		expect(existsSync(eventPath("task.dm_1.sensor.check"))).toBe(false);
		expect(existsSync(join(channelDir, "tasks", ".v4", "events", "task.dm_1.sensor.check.json"))).toBe(true);
		expect(existsSync(eventPath("unrelated"))).toBe(true);
		expect(
			(await readTaskLog(channelDir, "sensor")).some(
				(record) => record.kind === "note" && record.note.includes("signal"),
			),
		).toBe(true);
	});

	it("runs once, leaves v3 files and already-converted files alone, and never deletes an original", async () => {
		await write("old", '---\nstatus: active\nenabled: true\ncontrol: {"version":3}\n---\n# Old\n');
		await write(
			"fresh",
			`---\nstate: open\nusage: {"startedAt":"2026-09-05T09:00:00+08:00","steps":0,"usd":0,"usdEstimated":false,"expired":0}\n---\n# Fresh\n`,
		);
		await write("v4only", v4({ state: "open", cycle: CYCLE }, "# V\n"));
		const oldContent = await readFile(join(channelDir, "tasks", "old.md"), "utf-8");

		await migrateTasksToV5(workspaceDir, stateDir);

		expect(await readFile(join(channelDir, "tasks", "old.md"), "utf-8")).toBe(oldContent);
		expect(existsSync(join(channelDir, "tasks", ".v4", "fresh.md"))).toBe(false);
		expect((await readdir(join(channelDir, "tasks", ".v4"))).sort()).toEqual(["v4only.md"]);
		expect(existsSync(join(stateDir, "task-migration-v5.done"))).toBe(true);

		// Marker-gated: a file that regresses to v4 afterwards is not touched a second time.
		await write("late", v4({ state: "open", cycle: CYCLE }, "# L\n"));
		await migrateTasksToV5(workspaceDir, stateDir);
		expect(await readFile(join(channelDir, "tasks", "late.md"), "utf-8")).toContain("cycle:");
	});

	it("falls back to a runtime pause when a recurring task cannot be expressed as a template", async () => {
		// A Goal-less, DoD-less body cannot become a valid template, and the schedule must not be lost silently.
		await write("odd", v4({ state: "open", schedule: "0 9 * * *", cycle: CYCLE }, "# Odd\n\n## DoD\nprose only\n"));
		await migrateTasksToV5(workspaceDir, stateDir);
		const task = await readStoredTask(channelDir, "odd");
		expect(task?.fields.paused?.by).toBe("runtime");
		expect(existsSync(eventPath("odd"))).toBe(false);
	});

	it("parses a template's DoD fallback and reads v4 frontmatter faithfully", () => {
		const parsed = parseV4Frontmatter(v4({ state: "parked", schedule: "0 9 * * *", cycle: CYCLE }));
		expect(parsed).toMatchObject({ state: "parked", schedule: "0 9 * * *", v4Keys: true, v3: false });
		expect(buildTemplate("x", "# X\n\n## Goal\nG\n", parsed!).template?.dod).toBe("- [ ] 完成上述目标");
	});
});
