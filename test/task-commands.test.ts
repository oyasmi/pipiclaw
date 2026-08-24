import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleTasksCommand } from "../src/runtime/task-commands.js";
import { formatLocalTime } from "../src/shared/local-time.js";
import { createDefaultTaskControl } from "../src/tasks/control.js";
import { renderStandardTaskBody, renderTaskDocument } from "../src/tasks/ledger.js";
import { nextTaskWake } from "../src/tasks/task-schedule.js";

const CHANNEL_ID = "dm_1";
const FUTURE = "2026-08-05T18:00:00+08:00";
const BODY = renderStandardTaskBody({ title: "Task", goal: "Do it.", dod: "- [x] Done" });

function doc(front: string, body = BODY): string {
	return `---\n${front}\n---\n\n${body}`;
}

describe("/tasks v2 commands", () => {
	let workspaceDir: string;
	let channelDir: string;
	let tasksDir: string;

	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), "task-commands-v2-"));
		channelDir = join(workspaceDir, CHANNEL_ID);
		tasksDir = join(channelDir, "tasks");
		await mkdir(join(tasksDir, "archive"), { recursive: true });
	});
	afterEach(async () => {
		await rm(workspaceDir, { recursive: true, force: true });
	});

	function run(args: string, dispatchTask?: (id: string, generation?: number) => Promise<boolean>): Promise<string> {
		return handleTasksCommand({ args, channelDir, workspaceDir, channelId: CHANNEL_ID, dispatchTask });
	}

	async function writeTask(id: string, front: string, body = BODY): Promise<void> {
		await writeFile(join(tasksDir, `${id}.md`), doc(front, body));
	}

	it("pause/resume changes only enabled and stop, preserving stage and wake", async () => {
		const control = createDefaultTaskControl();
		await writeFile(
			join(tasksDir, "waiting.md"),
			renderTaskDocument(
				{
					status: "waiting",
					wake: FUTURE,
					schedule: "0 9 * * 1",
					control,
				},
				BODY,
			),
		);
		await expect(run("pause waiting")).resolves.toContain("已停用任务 waiting");
		const paused = await readFile(join(tasksDir, "waiting.md"), "utf-8");
		expect(paused).toContain("status: waiting");
		expect(paused).toContain("enabled: false");
		expect(paused).toContain(`wake: ${FUTURE}`);
		expect(paused).toContain("schedule: 0 9 * * 1");
		expect(paused).toContain('"by":"user"');

		await expect(run("resume waiting")).resolves.toContain("已重新启用任务 waiting");
		const resumed = await readFile(join(tasksDir, "waiting.md"), "utf-8");
		expect(resumed).toContain("status: waiting");
		expect(resumed).toContain("enabled: true");
		expect(resumed).toContain(`wake: ${FUTURE}`);
		expect(resumed).not.toContain('"stop"');
	});

	it("run converts a waiting task to active and dispatches it", async () => {
		const control = createDefaultTaskControl();
		await writeTask("waiting", `status: waiting\nwake: ${FUTURE}\ncontrol: ${JSON.stringify(control)}`);
		const dispatches: Array<{ id: string; generation?: number }> = [];
		const result = await run("run waiting", async (id, generation) => {
			dispatches.push({ id, generation });
			return true;
		});
		expect(result).toContain("已把任务 waiting 排入一次立即执行");
		expect(dispatches).toHaveLength(1);
		expect(dispatches[0]?.id).toBe("waiting");
		const stored = await readFile(join(tasksDir, "waiting.md"), "utf-8");
		expect(stored).toContain("status: active");
		expect(stored).not.toContain("wake:");
	});

	it("run sleeping explicitly opens a recurring cycle", async () => {
		await writeTask(
			"weekly",
			`status: sleeping\nschedule: 0 9 * * 1\nwake: ${formatLocalTime(nextTaskWake("0 9 * * 1")!)}\ncontrol: ${JSON.stringify(createDefaultTaskControl())}`,
		);
		const ids: string[] = [];
		await run("run weekly", async (id) => {
			ids.push(id);
			return true;
		});
		expect(ids).toEqual(["weekly"]);
		const stored = await readFile(join(tasksDir, "weekly.md"), "utf-8");
		expect(stored).toContain("status: active");
		expect(stored).not.toContain("wake:");
		expect(stored).toContain('"cycleId":"cycle-');
	});

	it("lists state dimensions without effects or approval and rejects retired actions without writing", async () => {
		const control = createDefaultTaskControl(true);
		control.verification.status = "passed";
		await writeFile(join(tasksDir, "measured.md"), renderTaskDocument({ status: "active", control }, BODY));
		const list = await run("");
		expect(list).toContain("状态：进行中");
		expect(list).toContain("验收：需要验收，已通过");
		expect(list).not.toMatch(/approval|sideEffects|effects/i);

		const before = await readFile(join(tasksDir, "measured.md"), "utf-8");
		const unknown = await run("approve measured");
		expect(unknown).toContain("未知的 /tasks 动作：approve");
		expect(unknown).toContain("/tasks pause <id>");
		expect(await readFile(join(tasksDir, "measured.md"), "utf-8")).toBe(before);
	});

	it("doctor diagnoses invalid state combinations with direct next steps", async () => {
		await writeTask(
			"bad",
			`status: active\nwake: 2099-01-01T00:00:00+08:00\ncontrol: ${JSON.stringify(createDefaultTaskControl())}`,
		);
		const out = await run("doctor");
		expect(out).toContain("处于 active，但它的 wake 在未来");
		expect(out).toContain("下一步：");
	});

	it("doctor does not gate resumability on waitingFor's cosmetic value", async () => {
		// A future wake alone is a durable resumption source; waitingFor is display-only and
		// no longer part of this check (spec 043).
		await writeTask(
			"future-wait",
			`status: waiting\nwake: ${FUTURE}\ncontrol: ${JSON.stringify({ ...createDefaultTaskControl(), waitingFor: "job" })}`,
		);
		expect(await run("doctor")).toContain("未发现任务台账问题");
	});

	it("doctor recognizes a clean parked user wait and reports forgotten external waits", async () => {
		await writeTask(
			"parked",
			`status: waiting\ncontrol: ${JSON.stringify({ ...createDefaultTaskControl(), waitingFor: "external-signal" })}`,
		);
		const out = await run("doctor");
		expect(out).toContain("没有可靠的恢复方式");
		expect(out).toContain("/tasks run parked");
	});

	it("shows archive outcome and rejects path traversal", async () => {
		await writeFile(
			join(tasksDir, "archive", "old.md"),
			doc("outcome: cancelled\nclosedAt: 2026-08-04T10:00:00+08:00", "# Old"),
		);
		expect(await run("archive")).toContain("old — Old");
		expect(await run("show old")).toContain("outcome: cancelled");
		expect(await run("show ../../secret")).toMatch(/Invalid task id/);
	});

	it("truncates a huge task file to a head snippet with a pointer to the real file", async () => {
		// Review 2026-08-24 §2.4/§3.2: `/tasks show` used to dump the whole file with no cap.
		const hugeBody = renderStandardTaskBody({ title: "Big", goal: "x".repeat(10_000), dod: "- [ ] todo" });
		await writeTask("huge", "status: active", hugeBody);
		const shown = await run("show huge");
		expect(shown.length).toBeLessThan(hugeBody.length);
		expect(shown).toContain("内容过长已截断");
		expect(shown).toContain(join(tasksDir, "huge.md"));
	});

	it("keeps a valid recurring schedule without requiring a separate event", async () => {
		await writeTask(
			"weekly",
			`status: sleeping\nschedule: 0 9 * * 1\nwake: ${formatLocalTime(nextTaskWake("0 9 * * 1")!)}`,
		);
		expect(await run("doctor")).toContain("未发现任务台账问题");
		expect(existsSync(join(tasksDir, "weekly.md"))).toBe(true);
	});
});
