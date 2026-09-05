import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convertLegacyTaskFields, migrateTasksToV4 } from "../src/runtime/task-migration.js";
import { readTaskLog, resetTaskLogAppenders } from "../src/tasks/log.js";
import { readStoredTask } from "../src/tasks/store.js";

const NOW = new Date("2026-09-05T10:00:00+08:00");

let workspaceDir: string;
let stateDir: string;

beforeEach(async () => {
	const root = await mkdtemp(join(tmpdir(), "task-migration-v4-"));
	workspaceDir = join(root, "workspace");
	stateDir = join(root, "state");
	await mkdir(join(workspaceDir, "dm_a", "tasks"), { recursive: true });
});

afterEach(async () => {
	await resetTaskLogAppenders();
});

describe("v3 → v4 field mapping (spec 051, D14)", () => {
	// The headline repair. On the author's machine `fix-tui-typecheck` sat `waiting` with a purely
	// decorative `waitingFor: external-signal`, no wake and no live run — nothing could ever
	// resume it, and it had been silent for nine days. v4 has no such state, so upgrading is also
	// the fix: it reopens, carrying an explanation of why.
	it("reopens a waiting task whose resumption source cannot be reconstructed", () => {
		const { fields, repairNote } = convertLegacyTaskFields(
			{
				status: "waiting",
				enabled: true,
				control: { nextAction: "在稳定环境重跑 npm run check", cycleId: "cycle-2026-08-27" },
			},
			NOW,
		);
		expect(fields.state).toBe("open");
		expect(fields.ticket).toBeUndefined();
		expect(repairNote).toContain("没有任何可兑现的恢复来源");
		// The model's own record of what it meant to do next is preserved, not thrown away.
		expect(repairNote).toContain("npm run check");
	});

	it("keeps a waiting task parked when its wake is still a real future moment", () => {
		const { fields, repairNote } = convertLegacyTaskFields(
			{ status: "waiting", enabled: true, wake: "2026-09-06T09:00:00+08:00" },
			NOW,
		);
		expect(fields.state).toBe("parked");
		expect(fields.ticket).toMatchObject({ kind: "time" });
		expect(repairNote).toBeUndefined();
	});

	it("parks a sleeping recurring task on its schedule ticket", () => {
		const { fields } = convertLegacyTaskFields(
			{ status: "sleeping", enabled: true, schedule: "0 3 * * *", wake: "2026-09-06T03:00:00+08:00" },
			NOW,
		);
		expect(fields.state).toBe("parked");
		expect(fields.ticket?.kind).toBe("schedule");
		expect(fields.schedule).toBe("0 3 * * *");
	});

	it("maps the retired pairs: disabled → paused, deadline → budget.until, verification → verify", () => {
		const { fields } = convertLegacyTaskFields(
			{
				status: "active",
				enabled: false,
				control: {
					deadline: "2026-09-09T18:00:00+08:00",
					verification: { required: true },
					stop: { by: "governor", reason: "no progress", at: "2026-09-01T00:00:00+08:00" },
				},
			},
			NOW,
		);
		expect(fields.paused).toMatchObject({ by: "runtime", reason: "no progress" });
		expect(fields.budget?.until).toBe("2026-09-09T18:00:00+08:00");
		expect(fields.verify).toBe("required");
	});

	it("carries an archived task straight through as done", () => {
		const { fields } = convertLegacyTaskFields(
			{ enabled: true, outcome: "completed", closedAt: "2026-08-01T00:00:00+08:00" },
			NOW,
		);
		expect(fields).toMatchObject({ state: "done", outcome: "completed", closedAt: "2026-08-01T00:00:00+08:00" });
	});
});

describe("migrateTasksToV4", () => {
	const v3 = [
		"---",
		"status: waiting",
		"enabled: true",
		'control: {"version":3,"waitingFor":"external-signal","verification":{"required":false,"status":"pending"}}',
		"---",
		"# Fix TUI typecheck",
		"",
		"## Goal",
		"Make npm run check pass.",
		"",
		"## DoD",
		"- [ ] check passes",
		"",
		"## Current Cycle",
		"- 已派发 worker run_zpy4mq。",
		"",
		"## History",
		"",
		"### Current Cycle (cycle-2026-08-20) — closed",
		"- 上一轮的记录。",
		"",
	].join("\n");

	it("rewrites the contract, imports History into the loop log, and backs the original up", async () => {
		const channelDir = join(workspaceDir, "dm_a");
		await writeFile(join(channelDir, "tasks", "fix-tui.md"), v3);

		await migrateTasksToV4(workspaceDir, stateDir);

		const document = await readStoredTask(channelDir, "fix-tui");
		expect(document?.fields.state).toBe("open");
		// The two sections the contract no longer carries are gone from the body…
		expect(document?.body).not.toContain("## Current Cycle");
		expect(document?.body).not.toContain("## History");
		// …but nothing is lost: the closed cycle is in the loop log, and the open one became the
		// single 上次结果 paragraph alongside the repair explanation.
		expect(document?.body).toContain("## 上次结果");
		expect(document?.body).toContain("run_zpy4mq");
		const log = await readTaskLog(channelDir, "fix-tui");
		expect(log.some((record) => record.kind === "step" && record.note.includes("上一轮的记录"))).toBe(true);

		expect(existsSync(join(channelDir, "tasks", ".v3", "fix-tui.md"))).toBe(true);
		expect(await readFile(join(channelDir, "tasks", ".v3", "fix-tui.md"), "utf-8")).toBe(v3);
	});

	it("runs once and leaves an already-migrated file alone", async () => {
		const channelDir = join(workspaceDir, "dm_a");
		const path = join(channelDir, "tasks", "fix-tui.md");
		await writeFile(path, v3);
		await migrateTasksToV4(workspaceDir, stateDir);
		const first = await readFile(path, "utf-8");

		// The marker gates it; a second boot must not re-import the history it already moved.
		await migrateTasksToV4(workspaceDir, stateDir);
		expect(await readFile(path, "utf-8")).toBe(first);
		expect((await readTaskLog(channelDir, "fix-tui")).length).toBe(1);
	});

	// Spec 051, D8 keeps the events subsystem untouched; a migration that "helpfully" rewrote an
	// event file would be exactly the kind of scope creep the decision was made to avoid.
	it("does not touch workspace/events", async () => {
		await mkdir(join(workspaceDir, "events"), { recursive: true });
		const eventPath = join(workspaceDir, "events", "daily.json");
		const definition = '{"type":"periodic","channelId":"dm_a","text":"x","schedule":"10 1 * * *"}';
		await writeFile(eventPath, definition);
		await writeFile(join(workspaceDir, "dm_a", "tasks", "fix-tui.md"), v3);

		await migrateTasksToV4(workspaceDir, stateDir);
		expect(await readFile(eventPath, "utf-8")).toBe(definition);
	});
});
