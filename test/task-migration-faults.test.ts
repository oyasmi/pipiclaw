import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real temp filesystem; only the listed calls are made to fail, once the test arms them.
const faults = vi.hoisted(() => ({ fail: undefined as undefined | ((op: string, path: string) => Error | undefined) }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const wrap =
		<K extends "readdir" | "readFile" | "rename" | "rm">(op: K) =>
		(...args: Parameters<(typeof actual)[K]>) => {
			const error = faults.fail?.(op, String(args[0]));
			if (error) return Promise.reject(error);
			return (actual[op] as (...a: unknown[]) => unknown)(...args);
		};
	return { ...actual, readdir: wrap("readdir"), readFile: wrap("readFile"), rename: wrap("rename"), rm: wrap("rm") };
});

const { migrateTasksToV5 } = await import("../src/runtime/task-migration.js");
const { resetTaskLogAppenders } = await import("../src/tasks/log.js");
const { archiveTask, readStoredTask } = await import("../src/tasks/store.js");

const CONTROL = '{"version":3,"verification":{"required":true,"status":"pending"}}';
const eacces = () => Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
const SLEEPING = `---\nstatus: sleeping\nschedule: 0 9 * * *\ncontrol: ${CONTROL}\n---\n# Daily\n\n## Goal\nG\n`;
const ACTIVE = `---\nstatus: active\ncontrol: ${CONTROL}\n---\n# Old\n`;

describe("v3 → v5 conversion under injected filesystem faults", () => {
	let root: string;
	let workspaceDir: string;
	let stateDir: string;
	let channelDir: string;
	const markerPath = () => join(stateDir, "task-migration-v5.done");
	const report = async () =>
		JSON.parse(await readFile(join(stateDir, "task-migration-v5.failed.json"), "utf-8")).failures;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "task-migration-faults-"));
		workspaceDir = join(root, "workspace");
		stateDir = join(root, "state");
		channelDir = join(workspaceDir, "dm_1");
		await mkdir(join(channelDir, "tasks"), { recursive: true });
	});
	afterEach(async () => {
		faults.fail = undefined;
		await resetTaskLogAppenders();
		await rm(root, { recursive: true, force: true });
	});

	it("does not treat an unreadable task directory as empty: no marker, failure reported, original untouched", async () => {
		await writeFile(join(channelDir, "tasks", "old.md"), ACTIVE);
		faults.fail = (op, path) => (op === "readdir" && path === join(channelDir, "tasks") ? eacces() : undefined);

		await expect(migrateTasksToV5(workspaceDir, stateDir)).rejects.toThrow(/failed for 1 item/);

		expect(existsSync(markerPath())).toBe(false);
		expect(await report()).toMatchObject([
			{ channelId: "dm_1", stage: "scan", error: expect.stringContaining("EACCES") },
		]);
		expect(await readFile(join(channelDir, "tasks", "old.md"), "utf-8")).toBe(ACTIVE);

		// Once the directory is readable again the same start converts it.
		faults.fail = undefined;
		await migrateTasksToV5(workspaceDir, stateDir);
		expect((await readStoredTask(channelDir, "old"))?.fields.state).toBe("open");
		expect(existsSync(markerPath())).toBe(true);
	});

	it("does not treat an unreadable events directory as empty", async () => {
		await mkdir(join(workspaceDir, "events"), { recursive: true });
		await writeFile(join(workspaceDir, "events", "task.dm_1.old.sensor.json"), "{}");
		faults.fail = (op, path) => (op === "readdir" && path === join(workspaceDir, "events") ? eacces() : undefined);

		await expect(migrateTasksToV5(workspaceDir, stateDir)).rejects.toThrow(/failed for 1 item/);

		expect(existsSync(markerPath())).toBe(false);
		expect(await report()).toMatchObject([{ channelId: "dm_1", stage: "events" }]);
		expect(existsSync(join(workspaceDir, "events", "task.dm_1.old.sensor.json"))).toBe(true);
	});

	it("keeps a pre-existing archive when the final archive step fails, and restores the original", async () => {
		await writeFile(join(channelDir, "tasks", "daily.md"), SLEEPING);
		await mkdir(join(channelDir, "tasks", "archive"), { recursive: true });
		await writeFile(join(channelDir, "tasks", "archive", "daily.md"), "earlier archive");
		await writeFile(join(channelDir, "tasks", "archive", "daily.jsonl"), "earlier log\n");

		await expect(migrateTasksToV5(workspaceDir, stateDir)).rejects.toThrow(/failed for 1 item/);

		expect(await readFile(join(channelDir, "tasks", "archive", "daily.md"), "utf-8")).toBe("earlier archive");
		expect(await readFile(join(channelDir, "tasks", "archive", "daily.jsonl"), "utf-8")).toBe("earlier log\n");
		expect(await readFile(join(channelDir, "tasks", "daily.md"), "utf-8")).toBe(SLEEPING);
		expect(existsSync(join(workspaceDir, "events", "daily.json"))).toBe(false);
		expect(existsSync(markerPath())).toBe(false);
		expect(await report()).toMatchObject([{ task: "daily", stage: "archive", rollback: "ok" }]);
	});

	it("fails the migration, without a marker, when the active contract cannot be removed after archiving", async () => {
		await writeFile(join(channelDir, "tasks", "daily.md"), SLEEPING);
		await mkdir(join(channelDir, "tasks", "archive"), { recursive: true });
		faults.fail = (op, path) =>
			op === "rm" && path === join(channelDir, "tasks", "daily.md") ? eacces() : undefined;

		await expect(migrateTasksToV5(workspaceDir, stateDir)).rejects.toThrow(/failed for 1 item/);

		expect(existsSync(markerPath())).toBe(false);
		expect(existsSync(join(channelDir, "tasks", "archive", "daily.md"))).toBe(false);
		expect(existsSync(join(channelDir, "tasks", "archive", "daily.jsonl"))).toBe(false);
		expect(await report()).toMatchObject([{ task: "daily", stage: "archive", rollback: "ok" }]);
	});

	it("detects an archived-log rename failure: nothing is half-archived and no marker is written", async () => {
		await writeFile(join(channelDir, "tasks", "daily.md"), SLEEPING);
		faults.fail = (op, path) =>
			op === "rename" && path === join(channelDir, "tasks", "daily.jsonl") ? eacces() : undefined;

		await expect(migrateTasksToV5(workspaceDir, stateDir)).rejects.toThrow(/failed for 1 item/);

		expect(existsSync(markerPath())).toBe(false);
		expect(existsSync(join(channelDir, "tasks", "archive", "daily.md"))).toBe(false);
		expect(existsSync(join(workspaceDir, "events", "daily.json"))).toBe(false);
		expect(await readFile(join(channelDir, "tasks", "daily.md"), "utf-8")).toBe(SLEEPING);
		expect(await report()).toMatchObject([
			{ task: "daily", stage: "archive", error: expect.stringContaining("EACCES") },
		]);
	});

	it("fails discovery loudly when the workspace root cannot be listed: no marker, report, retry still converts", async () => {
		await writeFile(join(channelDir, "tasks", "old.md"), ACTIVE);
		faults.fail = (op, path) => (op === "readdir" && path === workspaceDir ? eacces() : undefined);

		await expect(migrateTasksToV5(workspaceDir, stateDir)).rejects.toThrow(/failed for 1 item/);

		expect(existsSync(markerPath())).toBe(false);
		expect(await report()).toMatchObject([
			{ channelId: "*", stage: "discover", error: expect.stringContaining("EACCES") },
		]);
		expect(await readFile(join(channelDir, "tasks", "old.md"), "utf-8")).toBe(ACTIVE);

		faults.fail = undefined;
		await migrateTasksToV5(workspaceDir, stateDir);
		expect(existsSync(markerPath())).toBe(true);
		expect(await readFile(join(channelDir, "tasks", "old.md"), "utf-8")).toContain("state: open");
	});

	it("does not migrate a group channel under a fabricated id when CHANNELS.md is missing", async () => {
		const escapedGroupDir = join(workspaceDir, "group_cidYDhGqxhJOzS7VDv__eDInUw==");
		await mkdir(join(escapedGroupDir, "tasks"), { recursive: true });
		await writeFile(join(escapedGroupDir, "tasks", "old.md"), ACTIVE);

		await expect(migrateTasksToV5(workspaceDir, stateDir)).rejects.toThrow(/failed for 1 item/);

		expect(existsSync(markerPath())).toBe(false);
		expect(await report()).toMatchObject([
			{ channelId: "*", stage: "discover", error: expect.stringContaining("real channel id") },
		]);
		expect(await readFile(join(escapedGroupDir, "tasks", "old.md"), "utf-8")).toBe(ACTIVE);
	});

	it("keeps every old log and reports a failed rollback when the archive undo itself fails", async () => {
		await writeFile(join(channelDir, "tasks", "daily.md"), SLEEPING);
		await writeFile(join(channelDir, "tasks", "daily.jsonl"), "active\n");
		await writeFile(join(channelDir, "tasks", "daily.jsonl.1"), "shard\n");
		const tasks = join(channelDir, "tasks");
		const archive = join(tasks, "archive");
		faults.fail = (op, path) => {
			if (op !== "rename") return undefined;
			// Forward move of the shard, and the undo of the already-moved active log.
			if (path === join(tasks, "daily.jsonl.1") || path === join(archive, "daily.jsonl")) return eacces();
			return undefined;
		};

		await expect(migrateTasksToV5(workspaceDir, stateDir)).rejects.toThrow(/failed for 1 item/);

		expect(existsSync(markerPath())).toBe(false);
		// Neither old log was deleted: the active one is stranded in the archive, the shard is untouched.
		expect(await readFile(join(archive, "daily.jsonl"), "utf-8")).toContain("active");
		expect(await readFile(join(tasks, "daily.jsonl.1"), "utf-8")).toBe("shard\n");
		const [entry] = await report();
		expect(entry).toMatchObject({ task: "daily", stage: "archive" });
		expect(entry.rollback).toMatch(/rollback failed.*undo of partial archive failed.*daily\.jsonl/s);

		// The failed rollback blocks later starts instead of silently retrying.
		faults.fail = undefined;
		await expect(migrateTasksToV5(workspaceDir, stateDir)).rejects.toThrow(/blocked/);
		expect(await readFile(join(archive, "daily.jsonl"), "utf-8")).toContain("active");
	});

	describe("an existing failure report that cannot be trusted", () => {
		const reportPath = () => join(stateDir, "task-migration-v5.failed.json");
		const cases: Array<[string, string]> = [
			["corrupt JSON", '{"failures":['],
			["not an object", "[]"],
			["no failures array", '{"failures":"x"}'],
			["empty failures array", '{"failures":[]}'],
			["entry that is not an object", '{"failures":["boom"]}'],
			["entry missing rollback", '{"failures":[{"channelId":"dm_1","stage":"task","error":"e"}]}'],
			[
				"entry with non-string rollback",
				'{"failures":[{"channelId":"dm_1","stage":"task","error":"e","rollback":true}]}',
			],
			[
				"entry with non-string task",
				'{"failures":[{"channelId":"dm_1","task":1,"stage":"task","error":"e","rollback":"ok"}]}',
			],
		];

		async function expectBlocked(content: string | undefined) {
			await expect(migrateTasksToV5(workspaceDir, stateDir)).rejects.toThrow(/blocked/);
			faults.fail = undefined;
			expect(existsSync(markerPath())).toBe(false);
			if (content !== undefined) expect(await readFile(reportPath(), "utf-8")).toBe(content);
			else expect(existsSync(reportPath())).toBe(true);
		}

		it.each(cases)("blocks and keeps the report: %s", async (_name, content) => {
			await mkdir(stateDir, { recursive: true });
			await writeFile(reportPath(), content);
			await expectBlocked(content);
		});

		it("blocks and keeps the report when it cannot be read (EACCES)", async () => {
			await mkdir(stateDir, { recursive: true });
			const content = JSON.stringify({
				failures: [{ channelId: "dm_1", stage: "task", error: "e", rollback: "ok" }],
			});
			await writeFile(reportPath(), content);
			faults.fail = (op, path) => (op === "readFile" && path === reportPath() ? eacces() : undefined);
			await expectBlocked(content);
		});

		it("still retries and clears a well-formed report whose rollbacks all succeeded", async () => {
			await mkdir(stateDir, { recursive: true });
			await writeFile(
				reportPath(),
				JSON.stringify({
					at: "x",
					failures: [{ channelId: "dm_1", task: "t", stage: "archive", error: "e", rollback: "ok" }],
				}),
			);
			await migrateTasksToV5(workspaceDir, stateDir);
			expect(existsSync(markerPath())).toBe(true);
			expect(existsSync(reportPath())).toBe(false);
		});
	});
});

describe("archiveTask", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "archive-task-"));
		await mkdir(join(dir, "tasks"), { recursive: true });
		await writeFile(join(dir, "tasks", "t.md"), "---\nstate: open\n---\n# T\n");
		await writeFile(join(dir, "tasks", "t.jsonl"), "{}\n");
		await writeFile(join(dir, "tasks", "t.jsonl.1"), "{}\n");
	});
	afterEach(async () => {
		faults.fail = undefined;
		await rm(dir, { recursive: true, force: true });
	});

	it("refuses to overwrite an existing archive entry and changes nothing", async () => {
		await mkdir(join(dir, "tasks", "archive"), { recursive: true });
		await writeFile(join(dir, "tasks", "archive", "t.jsonl.1"), "older shard");

		await expect(archiveTask(dir, "t", "completed")).rejects.toThrow(/refusing to overwrite/);

		expect(await readFile(join(dir, "tasks", "archive", "t.jsonl.1"), "utf-8")).toBe("older shard");
		expect(existsSync(join(dir, "tasks", "t.md"))).toBe(true);
		expect(existsSync(join(dir, "tasks", "t.jsonl"))).toBe(true);
		expect(existsSync(join(dir, "tasks", "archive", "t.md"))).toBe(false);
	});

	it("rolls back log moves when a later shard cannot be moved", async () => {
		faults.fail = (op, path) => (op === "rename" && path === join(dir, "tasks", "t.jsonl.1") ? eacces() : undefined);

		await expect(archiveTask(dir, "t", "completed")).rejects.toThrow(/EACCES/);

		expect(existsSync(join(dir, "tasks", "t.md"))).toBe(true);
		expect(existsSync(join(dir, "tasks", "t.jsonl"))).toBe(true);
		expect(existsSync(join(dir, "tasks", "archive", "t.jsonl"))).toBe(false);
		expect(existsSync(join(dir, "tasks", "archive", "t.md"))).toBe(false);
	});
});
