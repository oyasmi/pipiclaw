import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "./helpers/fixtures.js";

/**
 * Spec 058, D20: the one-off migration of a pre-dot home. Run as the deployer runs it — a separate
 * `node` process on a real directory tree — because its job is data integrity on disk.
 */
const SCRIPT = fileURLToPath(new URL("../scripts/migrate-to-dots.mjs", import.meta.url));
const tempDir = useTempDirs("pipiclaw-migrate-");

const GROUP_ID = "group_cidAB/cd+EF==";
const GROUP_DIR = "group_cidAB__cd+EF==";

function run(home: string, ...args: string[]) {
	const result = spawnSync(process.execPath, [SCRIPT, "--home", home, ...args], { encoding: "utf8" });
	return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

function write(file: string, content: string): void {
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, content);
}

/** Every file under `dir` with its content, for "nothing was written" comparisons. */
function snapshot(dir: string): Record<string, string> {
	const files: Record<string, string> = {};
	const walk = (current: string) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else files[full.slice(dir.length)] = readFileSync(full, "utf8");
		}
	};
	walk(dir);
	return files;
}

/**
 * A pre-058 home: a DM, a group whose id has a `/` (recoverable only from `.channel-meta.json`), a
 * DM whose id is a prefix of another's (`dm_162403` / `dm_1624031`), and a TUI directory.
 */
function legacyHome(): string {
	const home = tempDir();
	const ws = join(home, "workspace");
	const state = join(home, "state");
	write(join(state, "task-migration-v5.done"), "v5\n");
	write(
		join(ws, "CHANNELS.md"),
		"| 频道 ID | 名称 | 最近消息 | 主题 |\n| --- | --- | --- | --- |\n| `dm_162403` | 泙漫 | 2026-10-01 |  |\n",
	);
	// DM with a session, memory, a task and an artifact path pointing into the old directory.
	const dm = join(ws, "dm_162403");
	write(join(dm, "context.jsonl"), `{"type":"session","cwd":"${dm}"}\n`);
	write(join(dm, "2026-07-12T06-30-39-192Z_019f5505-4f58.jsonl"), "{}\n");
	write(join(dm, "active-session.json"), '{"version":1,"file":"2026-07-12T06-30-39-192Z_019f5505-4f58.jsonl"}\n');
	write(
		join(dm, "log.jsonl"),
		`{"text":"see ${dm}/report.md, ${dm}/active-session.json, ${dm}/context.jsonl.bak and ${ws}/dm_1624031/other.md"}\n`,
	);
	write(join(dm, "context.jsonl.bak"), "{}\n");
	write(join(dm, "MEMORY.md"), "# Memory\n");
	write(join(dm, "report.md"), "report\n");
	write(join(dm, "project.json"), '{"version":1,"projectRoot":"/srv/project"}\n');
	write(join(dm, "tasks", "weekly.md"), "---\nstate: open\nusage: {}\n---\n# Weekly\n");
	write(join(dm, "tasks", "archive", "old.md"), "---\nstate: done\n---\n# Old\n");
	// A sibling whose id has `dm_162403` as a prefix.
	write(join(ws, "dm_1624031", "MEMORY.md"), "# Other\n");
	// A group: `__` in the directory name, the real id only in its metadata.
	const group = join(ws, GROUP_DIR);
	write(
		join(group, ".channel-meta.json"),
		'{"conversationId":"cidAB/cd+EF==","conversationType":"2","senderId":"u1"}',
	);
	write(join(group, "context.jsonl"), "{}\n");
	write(join(ws, "tui_local", "log.jsonl"), "{}\n");
	// Events, state, dispatch, usage.
	write(
		join(ws, "events", "digest.json"),
		JSON.stringify({ type: "periodic", channelId: "dm_162403", schedule: "0 9 * * *", text: "x" }),
	);
	write(
		join(ws, "events", "group.json"),
		JSON.stringify({ type: "periodic", channelId: GROUP_ID, schedule: "0 9 * * *", text: "y" }),
	);
	write(
		join(ws, "events", "orphan.json"),
		JSON.stringify({ type: "periodic", channelId: "dm_gone", schedule: "0 9 * * *", text: "z" }),
	);
	write(join(state, "memory", "dm_162403.json"), '{"channelId":"dm_162403","dirty":true}');
	write(
		join(state, "subagent-runs", "dm_162403", "run_a.json"),
		`{"runId":"run_a","channelId":"dm_162403","outputPath":"${dm}/subagent-artifacts/run_a/output.md","wakeClaimDispatchId":"subagent:dm_162403:run_a:done"}`,
	);
	// The D10 bug: a group's job record nested under the raw id's `/`.
	write(join(state, "jobs", "group_cidAB", "cd+EF==", "job_1.json"), '{"id":"job_1","status":"running"}');
	const wakeId = "job:dm_162403:job_2:done";
	// Its completion wake was claimed by the old process, which stopped before finishing it.
	write(
		join(state, "jobs", "dm_162403", "job_2.json"),
		JSON.stringify({ id: "job_2", channelId: "dm_162403", status: "completed", wakeClaimDispatchId: wakeId }),
	);
	write(
		join(state, "dispatch", `${encodeURIComponent(wakeId)}.json`),
		JSON.stringify({
			version: 1,
			id: wakeId,
			status: "queued",
			event: { channelId: "dm_162403", dispatchId: wakeId, text: "done" },
		}),
	);
	write(
		join(state, "usage", "usage-2026-10.jsonl"),
		`${JSON.stringify({ channelId: "dm_162403", cost: 1 })}\n${JSON.stringify({ channelId: GROUP_ID, cost: 2 })}\n`,
	);
	return home;
}

const FULL_MAP = [
	"--map",
	"dm_162403=news",
	"--map",
	`${GROUP_DIR}=team`,
	"--map",
	"tui_local=desk",
	"--drop",
	"dm_1624031",
];

describe("migrate-to-dots (spec 058, D20)", () => {
	it("migrates every channel directory into its dot, with state, events, tasks and paths in place", () => {
		// Failure caught: data lost or misplaced by the migration, or a path rewrite that corrupts a
		// sibling channel's paths.
		const home = legacyHome();
		const ws = join(home, "workspace");
		const state = join(home, "state");
		// Real-home rehearsal: historical examples and truncated paths are not references to any
		// migrated directory. Mutation: the old broad dm_/group_/tui_ scan rejects this home.
		const historicalExamples = [
			`${ws}/dm_*/HISTORY.md`,
			`${ws}/dm_<staffId>/`,
			`${ws}/dm_1624…`,
			`${ws}/dm_162403.`,
			`${ws}/dm_1624039/report.md`,
		].join("\n");
		write(join(ws, "dm_162403", "historical-examples.md"), historicalExamples);
		const result = run(home, ...FULL_MAP, "--no-backup");
		expect(result.code, result.out).toBe(0);

		const news = join(ws, "dots", "news");
		const conversation = join(news, "conversations", "dm-1");
		expect(readdirSync(conversation).sort()).toEqual([
			"2026-07-12T06-30-39-192Z_019f5505-4f58.jsonl",
			"active-session.json",
			"context.jsonl",
			"log.jsonl",
		]);
		expect(existsSync(join(news, "MEMORY.md")) && existsSync(join(news, "report.md"))).toBe(true);
		expect(existsSync(join(news, "project.json"))).toBe(false);
		expect(JSON.parse(readFileSync(join(news, "dot.json"), "utf8"))).toMatchObject({
			name: "news",
			conversations: { dm_162403: { dir: "dm-1" } },
		});
		expect(JSON.parse(readFileSync(join(ws, "dots", "team", "dot.json"), "utf8")).conversations).toHaveProperty([
			GROUP_ID,
		]);
		expect(JSON.parse(readFileSync(join(ws, "dots", "desk", "dot.json"), "utf8")).conversations).toHaveProperty([
			"tui",
		]);
		expect(JSON.parse(readFileSync(join(ws, "dots", "bindings.json"), "utf8")).bindings).toEqual({
			dm_162403: expect.objectContaining({ dot: "news" }),
			[GROUP_ID]: expect.objectContaining({ dot: "team" }),
		});
		expect(JSON.parse(readFileSync(join(state, "dingtalk", "conversations.json"), "utf8"))).toHaveProperty([
			GROUP_ID,
		]);
		expect(existsSync(join(ws, ".legacy", "dm_1624031", "MEMORY.md"))).toBe(true);

		expect(existsSync(join(news, "events", "digest.json"))).toBe(true);
		expect(existsSync(join(ws, "dots", "team", "events", "group.json"))).toBe(true);
		expect(existsSync(join(ws, ".legacy", "events", "orphan.json"))).toBe(true);
		expect(existsSync(join(ws, "events"))).toBe(false);
		expect(readFileSync(join(news, "tasks", "weekly.md"), "utf8")).toMatch(
			/^---\nstate: open\nchannel: dm_162403\nusage:/,
		);
		expect(readFileSync(join(news, "tasks", "archive", "old.md"), "utf8")).not.toContain("channel:");

		expect(JSON.parse(readFileSync(join(state, "memory", "news", "dm-1.json"), "utf8"))).toMatchObject({
			dirty: true,
		});
		expect(existsSync(join(state, "subagent-runs", "news", "run_a.json"))).toBe(true);
		expect(JSON.parse(readFileSync(join(state, "jobs", "team", "job_1.json"), "utf8"))).toMatchObject({
			channelId: GROUP_ID,
		});
		const newWake = "job:news:job_2:done";
		// A claimed-but-unfinished wake is resumed only when the claim names the migrated id.
		expect(JSON.parse(readFileSync(join(state, "jobs", "news", "job_2.json"), "utf8")).wakeClaimDispatchId).toBe(
			newWake,
		);
		expect(
			JSON.parse(readFileSync(join(state, "subagent-runs", "news", "run_a.json"), "utf8")).wakeClaimDispatchId,
		).toBe("subagent:news:run_a:done");
		expect(
			JSON.parse(readFileSync(join(state, "dispatch", `${encodeURIComponent(newWake)}.json`), "utf8")),
		).toMatchObject({
			id: newWake,
			event: { dot: "news", dispatchId: newWake },
		});
		expect(
			readFileSync(join(state, "usage", "usage-2026-10.jsonl"), "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l).dot),
		).toEqual(["news", "team"]);

		// Paths: into the dot (session files into the conversation), never into the prefix sibling.
		expect(readFileSync(join(conversation, "context.jsonl"), "utf8")).toContain(`"cwd":"${news}"`);
		const log = readFileSync(join(conversation, "log.jsonl"), "utf8");
		expect(log).toContain(`${news}/report.md`);
		expect(log).toContain(`${conversation}/active-session.json`);
		// Not a session file, so it moved to the dot root; the session-file key must not claim it.
		expect(log).toContain(`${news}/context.jsonl.bak`);
		expect(log).toContain(`${ws}/.legacy/dm_1624031/other.md`);
		expect(readFileSync(join(state, "subagent-runs", "news", "run_a.json"), "utf8")).toContain(
			`${news}/subagent-artifacts/run_a/output.md`,
		);
		expect(readFileSync(join(news, "historical-examples.md"), "utf8")).toBe(historicalExamples);
		expect(
			existsSync(join(state, "dots-migration.done")) && !existsSync(join(state, "dots-migration.inprogress")),
		).toBe(true);

		const verified = run(home, "--verify");
		expect(verified.code, verified.out).toBe(0);
	});

	it("refuses when a legacy directory is neither mapped nor dropped, writing nothing", () => {
		// Failure caught: a half-migrated home, with one channel's data left in the old layout.
		const home = legacyHome();
		const before = snapshot(home);
		const result = run(home, "--map", "dm_162403=news", "--map", `${GROUP_DIR}=team`, "--drop", "dm_1624031");
		expect(result.code).toBe(1);
		expect(result.out).toContain("tui_local");
		expect(snapshot(home)).toEqual(before);
	});

	it("refuses when a directory's real channel id is ambiguous or unrecoverable", () => {
		// Failure caught: binding a dot to a channel id no transport can deliver to.
		const home = legacyHome();
		const ws = join(home, "workspace");
		write(join(ws, "group_cidXY__zz==", "MEMORY.md"), "# no metadata\n");
		write(
			join(ws, "dm_162403", ".channel-meta.json"),
			'{"conversationId":"c","conversationType":"1","senderId":"someone_else"}',
		);
		const before = snapshot(home);
		const result = run(home, ...FULL_MAP, "--map", "group_cidXY__zz===x", "--no-backup");
		expect(result.code).toBe(1);
		expect(result.out).toContain("cannot recover the real channel id of group_cidXY__zz==");
		expect(result.out).toContain("conflicting channel ids for dm_162403");
		expect(snapshot(home)).toEqual(before);
	});

	it("refuses to run before its preconditions hold, writing nothing", () => {
		// Failure caught: migrating v3-format tasks the new runtime can no longer upgrade; moving the
		// directories a still-running background job will write its exit marker into.
		const cases: Array<[string, (home: string) => void]> = [
			["task-migration-v5.done", (home) => rmSync(join(home, "state", "task-migration-v5.done"))],
			[
				"background job job_live is still running",
				(home) =>
					write(
						join(home, "state", "jobs", "dm_162403", "job_live.json"),
						JSON.stringify({ id: "job_live", status: "running", pid: process.pid }),
					),
			],
		];
		for (const [expected, seed] of cases) {
			const home = legacyHome();
			seed(home);
			const before = snapshot(home);
			const result = run(home, ...FULL_MAP, "--no-backup");
			expect(result.code, expected).toBe(1);
			expect(result.out).toContain(expected);
			expect(snapshot(home)).toEqual(before);
		}
	});

	it("dry-run prints every move and writes nothing", () => {
		// Failure caught: a rehearsal that quietly changes the data it was meant to only describe.
		const home = legacyHome();
		const before = snapshot(home);
		const result = run(home, ...FULL_MAP, "--dry-run");
		expect(result.code, result.out).toBe(0);
		expect(snapshot(home)).toEqual(before);
		for (const expected of [
			`context.jsonl → ${join(home, "workspace", "dots", "news", "conversations", "dm-1", "context.jsonl")}`,
			`report.md → ${join(home, "workspace", "dots", "news", "report.md")}`,
			`drop dm_1624031 → ${join(home, "workspace", ".legacy", "dm_1624031")}`,
			`event orphan.json → ${join(home, "workspace", ".legacy", "events", "orphan.json")}`,
			`${GROUP_ID} → team`,
		]) {
			expect(result.out).toContain(expected);
		}
	});

	it("verify reports a leftover old path and an event outside every dot", () => {
		// Failure caught: a verification that passes whatever the layout looks like.
		const home = legacyHome();
		expect(run(home, ...FULL_MAP, "--no-backup").code).toBe(0);
		const ws = join(home, "workspace");
		write(join(ws, "dots", "news", "notes.md"), `see ${ws}/dm_162403/report.md\n`);
		write(join(ws, "events", "late.json"), "{}");
		const result = run(home, "--verify");
		expect(result.code).toBe(1);
		expect(result.out).toContain(`old path in ${join(ws, "dots", "news", "notes.md")}`);
		expect(result.out).toContain("events outside any dot: late.json");
	});
});
