#!/usr/bin/env node
// One-off migration of a Pipiclaw app home from per-channel directories to dots (spec 058, D20).
//
//   node scripts/migrate-to-dots.mjs [--home <dir>] --map <old-dir>=<dot> ... [--drop <old-dir> ...]
//                                    [--dry-run] [--no-backup] [--as-home <dir>]
//   node scripts/migrate-to-dots.mjs [--home <dir>] --verify [--as-home <dir>]
//
// Zero dependencies and no import of src/ or dist/: it must keep understanding the old layout after
// the runtime has forgotten it. Structured as inventory → plan → apply → verify; `--dry-run` prints
// the plan and writes nothing. `--as-home` is for rehearsing on a copy: absolute paths inside the
// copy still name the original home, so they are rewritten as if the copy lived there.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LEGACY_PREFIXES = ["dm_", "group_", "tui_"];
const DOT_NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
/** Files of a channel directory that belong to its conversation, not to the dot body (D2). */
const SESSION_FILE =
	/^(?:\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f-]+\.jsonl|context\.jsonl|active-session\.json|log\.jsonl(?:\.\d+)?|\.sync-offset|last_prompt\.json)$/;
/** A character that can continue a path segment: a prefix followed by one of these is a different name. */
const PATH_CHAR = /[A-Za-z0-9._\-+=@%~\u0080-￿]/;
const REWRITE_MAX_BYTES = 20 * 1024 * 1024;
const BINARY_PROBE_BYTES = 8 * 1024;
/** Workspace-root entries the path rewrite never touches. */
const REWRITE_SKIP = new Set([".git", ".legacy", ".pipiclaw", "node_modules"]);

/** The pre-058 channel directory name — used only to recognise the old layout. */
function legacyDirName(channelId) {
	return channelId.replaceAll("/", "__");
}

function kindOf(dir) {
	return dir.startsWith("dm_") ? "dm" : dir.startsWith("group_") ? "group" : "tui";
}

function readJson(file) {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

function tryReadJson(file) {
	try {
		return readJson(file);
	} catch {
		return undefined;
	}
}

function exists(file) {
	return fs.existsSync(file);
}

function listDir(dir) {
	try {
		return fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------------------------
// Arguments

export function parseArgs(argv) {
	const options = { home: path.join(os.homedir(), ".pipiclaw"), map: [], drop: [], dryRun: false, backup: true };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		const value = () => {
			const next = argv[++index];
			if (next === undefined) throw new Error(`${arg} needs a value`);
			return next;
		};
		if (arg === "--home") options.home = path.resolve(value());
		else if (arg === "--as-home") options.asHome = path.resolve(value());
		else if (arg === "--map") {
			const spec = value();
			const at = spec.lastIndexOf("=");
			if (at <= 0) throw new Error(`--map expects <old-dir>=<dot>, got "${spec}"`);
			options.map.push({ dir: spec.slice(0, at), dot: spec.slice(at + 1) });
		} else if (arg === "--drop") options.drop.push(value());
		else if (arg === "--dry-run") options.dryRun = true;
		else if (arg === "--no-backup") options.backup = false;
		else if (arg === "--verify") options.verify = true;
		else if (arg === "--help" || arg === "-h") options.help = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return options;
}

// ---------------------------------------------------------------------------------------------
// Inventory: what the old home contains, without deciding anything

/** Channel ids named in CHANNELS.md (`| \`<id>\` | name | last | ... |`), with their names. */
function readChannelIndex(workspaceDir) {
	const rows = new Map();
	let text = "";
	try {
		text = fs.readFileSync(path.join(workspaceDir, "CHANNELS.md"), "utf8");
	} catch {
		return rows;
	}
	for (const line of text.split("\n")) {
		const match = /^\|\s*`([^`]+)`\s*\|\s*([^|]*)\|\s*([^|]*)\|/.exec(line);
		if (match) rows.set(match[1], { name: match[2].trim(), lastMessageAt: match[3].trim() });
	}
	return rows;
}

/**
 * The real channel id behind an old directory (D20): `.channel-meta.json`, then a CHANNELS.md row
 * whose escaped id is the directory name, then the directory name itself when nothing was escaped
 * in it. Every source that answers must agree.
 */
function resolveChannelId(dir, channelDir, index) {
	if (kindOf(dir) === "tui") return { channelId: "tui", oldChannelId: dir, source: "tui directory" };
	const candidates = [];
	const meta = tryReadJson(path.join(channelDir, ".channel-meta.json"));
	if (meta && typeof meta === "object") {
		const id =
			meta.conversationType === "2"
				? typeof meta.conversationId === "string" && `group_${meta.conversationId}`
				: typeof meta.senderId === "string" && `dm_${meta.senderId}`;
		if (id) candidates.push({ id, source: ".channel-meta.json" });
	}
	for (const id of index.keys()) {
		if (legacyDirName(id) === dir) candidates.push({ id, source: "CHANNELS.md" });
	}
	if (!dir.includes("__")) candidates.push({ id: dir, source: "directory name" });
	if (candidates.length === 0) {
		return { problem: `cannot recover the real channel id of ${dir}: no .channel-meta.json or CHANNELS.md row` };
	}
	const ids = new Set(candidates.map((candidate) => candidate.id));
	if (ids.size > 1) {
		return {
			problem: `conflicting channel ids for ${dir}: ${candidates.map((c) => `${c.id} (${c.source})`).join(", ")}`,
		};
	}
	const [id] = ids;
	if (legacyDirName(id) !== dir || kindOf(id) !== kindOf(dir)) {
		return { problem: `channel id ${id} (${candidates[0].source}) does not name directory ${dir}` };
	}
	return { channelId: id, oldChannelId: id, source: candidates.map((c) => c.source).join(" + ") };
}

function directorySize(dir) {
	let bytes = 0;
	let files = 0;
	const walk = (current) => {
		for (const entry of listDir(current)) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile()) {
				files++;
				bytes += fs.statSync(full).size;
			}
		}
	};
	walk(dir);
	return { files, bytes };
}

/** `pipiclaw …`, `node …/bin/pipiclaw …` or `node …/pipiclaw/dist/main.js …`: only the program run counts. */
function isPipiclawCommand(argv) {
	const program = path.basename(argv[0] ?? "") === "node" ? argv[1] : argv[0];
	if (!program) return false;
	return path.basename(program) === "pipiclaw" || /(?:^|\/)pipiclaw\/dist\/main\.js$/.test(program);
}

/**
 * Running pipiclaw processes on this home. A process is attributed to a home by its
 * `PIPICLAW_HOME` (or `$HOME/.pipiclaw`); one whose environment cannot be read counts.
 */
function findRunningProcesses(home) {
	const found = [];
	let pids = [];
	try {
		pids = fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name));
	} catch {
		return { found, checked: false };
	}
	const target = realpathOr(home);
	for (const pid of pids) {
		if (Number(pid) === process.pid) continue;
		let argv;
		try {
			argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
		} catch {
			continue;
		}
		if (!isPipiclawCommand(argv)) continue;
		let processHome;
		try {
			const env = new Map(
				fs
					.readFileSync(`/proc/${pid}/environ`, "utf8")
					.split("\0")
					.map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]),
			);
			processHome = env.get("PIPICLAW_HOME") || (env.get("HOME") && path.join(env.get("HOME"), ".pipiclaw"));
		} catch {
			processHome = undefined;
		}
		if (processHome === undefined || realpathOr(processHome) === target) {
			found.push({ pid: Number(pid), command: argv.join(" ").slice(0, 200) });
		}
	}
	return { found, checked: true };
}

function realpathOr(file) {
	try {
		return fs.realpathSync(file);
	} catch {
		return path.resolve(file);
	}
}

export function inventory(home) {
	const workspaceDir = path.join(home, "workspace");
	const stateDir = path.join(home, "state");
	const problems = [];
	if (!exists(workspaceDir)) problems.push(`no workspace at ${workspaceDir}`);
	const dotsDir = path.join(workspaceDir, "dots");
	if (exists(dotsDir) && listDir(dotsDir).length > 0) {
		problems.push(`${dotsDir} already exists and is not empty: this home has been migrated`);
	}
	if (!exists(path.join(stateDir, "task-migration-v5.done"))) {
		problems.push("state/task-migration-v5.done is missing: run Pipiclaw 0.9.x once to finish the v5 task migration");
	}
	const processes = findRunningProcesses(home);
	for (const proc of processes.found) problems.push(`pipiclaw is running on this home (pid ${proc.pid}): ${proc.command}`);

	const index = readChannelIndex(workspaceDir);
	const legacy = [];
	for (const entry of listDir(workspaceDir)) {
		if (!entry.isDirectory() || !LEGACY_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue;
		const dir = entry.name;
		const channelDir = path.join(workspaceDir, dir);
		const resolved = resolveChannelId(dir, channelDir, index);
		const names = listDir(channelDir).map((item) => item.name);
		const tasksDir = path.join(channelDir, "tasks");
		const project = tryReadJson(path.join(channelDir, "project.json"));
		legacy.push({
			dir,
			kind: kindOf(dir),
			channelId: resolved.channelId,
			oldChannelId: resolved.oldChannelId,
			idSource: resolved.source,
			problem: resolved.problem,
			name: resolved.oldChannelId ? index.get(resolved.oldChannelId)?.name : undefined,
			lastMessageAt: resolved.oldChannelId ? index.get(resolved.oldChannelId)?.lastMessageAt : undefined,
			sessionFiles: names.filter((name) => SESSION_FILE.test(name)).length,
			openTasks: listDir(tasksDir).filter((item) => item.isFile() && item.name.endsWith(".md")).length,
			hasMemory: names.includes("MEMORY.md") || names.includes("memory"),
			projectRoot: typeof project?.projectRoot === "string" ? project.projectRoot : undefined,
			...directorySize(channelDir),
		});
	}
	legacy.sort((a, b) => a.dir.localeCompare(b.dir));
	for (const item of legacy) if (item.problem) problems.push(item.problem);

	const events = [];
	const eventsDir = path.join(workspaceDir, "events");
	for (const entry of listDir(eventsDir)) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const value = tryReadJson(path.join(eventsDir, entry.name));
		events.push({
			file: entry.name,
			channelId: typeof value?.channelId === "string" ? value.channelId : undefined,
		});
	}
	return {
		home,
		workspaceDir,
		stateDir,
		processCheck: processes.checked,
		problems,
		legacy,
		events: events.sort((a, b) => a.file.localeCompare(b.file)),
	};
}

// ---------------------------------------------------------------------------------------------
// Plan: every move and write, decided up front; refuses with a list of problems instead

/** The absolute roots whose `workspace/<old-dir>` prefixes get rewritten. */
function rewriteRoots(home, asHome) {
	const roots = [home];
	if (asHome && asHome !== home) roots.push(asHome);
	const effective = asHome ?? home;
	if (realpathOr(effective) === realpathOr(path.join(os.homedir(), ".pipiclaw"))) roots.push("~/.pipiclaw");
	return roots;
}

export function plan(inv, options) {
	const errors = [...inv.problems];
	const byDir = new Map(inv.legacy.map((item) => [item.dir, item]));
	const assigned = new Map();
	const dots = new Set();
	for (const { dir, dot } of options.map) {
		if (!byDir.has(dir)) errors.push(`--map ${dir}: no such legacy channel directory`);
		if (!DOT_NAME.test(dot)) {
			errors.push(`--map ${dir}=${dot}: invalid dot name (1-32 lowercase letters, digits or hyphens)`);
		}
		if (dots.has(dot)) errors.push(`dot ${dot} is mapped twice: one old directory per dot (bind more channels later)`);
		if (assigned.has(dir)) errors.push(`${dir} is given twice`);
		dots.add(dot);
		assigned.set(dir, { action: "map", dot });
	}
	for (const dir of options.drop) {
		if (!byDir.has(dir)) errors.push(`--drop ${dir}: no such legacy channel directory`);
		if (assigned.has(dir)) errors.push(`${dir} is given twice`);
		assigned.set(dir, { action: "drop" });
	}
	const unassigned = inv.legacy.filter((item) => !assigned.has(item.dir)).map((item) => item.dir);
	if (unassigned.length > 0) {
		errors.push(`every legacy directory needs --map or --drop; missing: ${unassigned.join(", ")}`);
	}

	const { home, workspaceDir, stateDir } = inv;
	const migrations = [];
	const drops = [];
	for (const item of inv.legacy) {
		const decision = assigned.get(item.dir);
		if (!decision || item.problem) continue;
		if (decision.action === "drop") {
			drops.push({ dir: item.dir, oldChannelId: item.oldChannelId, to: path.join(workspaceDir, ".legacy", item.dir) });
			continue;
		}
		const dotDir = path.join(workspaceDir, "dots", decision.dot);
		const conversation = `${item.kind}-1`;
		migrations.push({
			...item,
			dot: decision.dot,
			from: path.join(workspaceDir, item.dir),
			dotDir,
			conversation,
			conversationDir: path.join(dotDir, "conversations", conversation),
		});
	}
	/** Old channel id (what records and events carry) → its migration. */
	const byOldChannel = new Map(migrations.map((item) => [item.oldChannelId, item]));

	const eventMoves = inv.events.map((event) => {
		const target = event.channelId === undefined ? undefined : byOldChannel.get(event.channelId);
		return {
			file: event.file,
			channelId: event.channelId,
			to: target ? path.join(target.dotDir, "events") : path.join(workspaceDir, ".legacy", "events"),
			dot: target?.dot,
		};
	});

	const rewrites = [];
	for (const root of rewriteRoots(home, options.asHome)) {
		for (const item of migrations) {
			const oldDir = `${root}/workspace/${item.dir}`;
			const newDir = `${root}/workspace/dots/${item.dot}`;
			for (const entry of listDir(item.from)) {
				if (SESSION_FILE.test(entry.name)) {
					rewrites.push([`${oldDir}/${entry.name}`, `${newDir}/conversations/${item.conversation}/${entry.name}`]);
				}
			}
			rewrites.push([oldDir, newDir]);
		}
		for (const item of drops) rewrites.push([`${root}/workspace/${item.dir}`, `${root}/workspace/.legacy/${item.dir}`]);
	}
	rewrites.sort((a, b) => b[0].length - a[0].length);

	return {
		ok: errors.length === 0,
		errors,
		home,
		workspaceDir,
		stateDir,
		backup: options.backup,
		migrations,
		drops,
		eventMoves,
		rewrites,
		bindings: migrations
			.filter((item) => item.kind !== "tui")
			.map((item) => ({ channelId: item.channelId, dot: item.dot })),
	};
}

// ---------------------------------------------------------------------------------------------
// Apply

function move(from, to, log) {
	fs.mkdirSync(path.dirname(to), { recursive: true });
	if (exists(to)) throw new Error(`refusing to overwrite ${to}`);
	fs.renameSync(from, to);
	log.push({ move: from, to });
}

function writeAtomically(file, content, mode) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.migrate-${process.pid}.tmp`;
	fs.writeFileSync(temp, content, mode === undefined ? undefined : { mode });
	fs.renameSync(temp, file);
}

function writeJson(file, value) {
	writeAtomically(file, `${JSON.stringify(value, null, "\t")}\n`);
}

/** Insert `channel:` at its FIELD_ORDER place: after `state` and `paused`, before everything else. */
export function insertTaskChannel(text, channelId) {
	if (!text.startsWith("---\n")) return { text, changed: false };
	const end = text.indexOf("\n---", 4);
	if (end < 0) return { text, changed: false };
	const lines = text.slice(4, end).split("\n");
	if (lines.some((line) => /^channel:/.test(line))) return { text, changed: false };
	let at = 0;
	while (at < lines.length && /^(state|paused):/.test(lines[at])) at++;
	lines.splice(at, 0, `channel: ${channelId}`);
	return { text: `---\n${lines.join("\n")}${text.slice(end)}`, changed: true };
}

/** Rewrite a dispatch id that embeds an old channel id to the dot form the runtime now produces. */
function migrateDispatchId(id, oldChannelId, dot) {
	for (const kind of ["subagent", "job", "task"]) {
		const prefix = `${kind}:${oldChannelId}:`;
		if (id.startsWith(prefix)) return `${kind}:${dot}:${id.slice(prefix.length)}`;
	}
	if (id.startsWith("event:")) return `event:${dot}:${id.slice("event:".length)}`;
	return id;
}

function buildRewriter(rewrites) {
	if (rewrites.length === 0) return undefined;
	const table = new Map(rewrites);
	const pattern = new RegExp(
		`(?:${rewrites.map(([from]) => escapeRegExp(from)).join("|")})(?!${PATH_CHAR.source})`,
		"g",
	);
	return (text) => {
		let count = 0;
		const result = text.replace(pattern, (match) => {
			count++;
			return table.get(match);
		});
		return { text: result, count };
	};
}

function isRewritable(file) {
	const stat = fs.lstatSync(file);
	if (!stat.isFile() || stat.size > REWRITE_MAX_BYTES) return false;
	const fd = fs.openSync(file, "r");
	try {
		const probe = Buffer.alloc(Math.min(BINARY_PROBE_BYTES, stat.size));
		fs.readSync(fd, probe, 0, probe.length, 0);
		return !probe.includes(0);
	} finally {
		fs.closeSync(fd);
	}
}

/** D20 step 7's scope: the dots, other workspace content, and the state that stores paths. */
function rewriteScope(p) {
	const files = [];
	const walk = (dir) => {
		for (const entry of listDir(dir)) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile()) files.push(full);
		}
	};
	for (const entry of listDir(p.workspaceDir)) {
		if (REWRITE_SKIP.has(entry.name)) continue;
		const full = path.join(p.workspaceDir, entry.name);
		if (entry.isDirectory()) walk(full);
		else if (entry.isFile()) files.push(full);
	}
	for (const name of ["subagent-runs", "jobs", "dispatch"]) walk(path.join(p.stateDir, name));
	return files;
}

export function apply(p, now = new Date()) {
	const stamp = now.toISOString().replace(/[:.]/g, "-");
	const report = { version: 1, startedAt: now.toISOString(), home: p.home, moves: [], dots: [], notes: [] };
	let backupDir;
	if (p.backup) {
		backupDir = path.join(p.home, "backups", `pre-dots-${stamp}`);
		fs.mkdirSync(backupDir, { recursive: true });
		for (const name of ["workspace", "state"]) {
			if (exists(path.join(p.home, name))) copyPreserving(path.join(p.home, name), path.join(backupDir, name));
		}
		report.backupDir = backupDir;
	}
	// Written after the backup, so restoring the backup does not restore the marker.
	const inProgress = path.join(p.stateDir, "dots-migration.inprogress");
	fs.mkdirSync(p.stateDir, { recursive: true });
	fs.writeFileSync(inProgress, `${now.toISOString()}\n`);

	const log = report.moves;
	const conversationsMeta = tryReadJson(path.join(p.stateDir, "dingtalk", "conversations.json")) ?? {};
	for (const item of p.migrations) {
		fs.mkdirSync(item.conversationDir, { recursive: true });
		const meta = tryReadJson(path.join(item.from, ".channel-meta.json"));
		for (const entry of listDir(item.from)) {
			const from = path.join(item.from, entry.name);
			if (SESSION_FILE.test(entry.name)) move(from, path.join(item.conversationDir, entry.name), log);
			else if (entry.name === ".channel-meta.json") fs.rmSync(from);
			else if (entry.name === "project.json") fs.rmSync(from);
			else move(from, path.join(item.dotDir, entry.name), log);
		}
		fs.rmdirSync(item.from);
		if (meta && item.kind !== "tui") conversationsMeta[item.channelId] = meta;
		writeJson(path.join(item.dotDir, "dot.json"), {
			version: 1,
			name: item.dot,
			createdAt: now.toISOString(),
			conversations: { [item.channelId]: { dir: item.conversation, createdAt: now.toISOString() } },
		});
		const tasksEdited = [];
		const tasksDir = path.join(item.dotDir, "tasks");
		for (const entry of listDir(tasksDir)) {
			if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
			const file = path.join(tasksDir, entry.name);
			const edited = insertTaskChannel(fs.readFileSync(file, "utf8"), item.channelId);
			if (edited.changed) {
				writeAtomically(file, edited.text, fs.statSync(file).mode);
				tasksEdited.push(entry.name);
			}
		}
		report.dots.push({
			dot: item.dot,
			from: item.dir,
			channelId: item.channelId,
			conversation: item.conversation,
			bound: item.kind !== "tui",
			projectRoot: item.projectRoot,
			tasksGivenChannel: tasksEdited,
		});
	}
	if (p.migrations.length > 0) writeJson(path.join(p.stateDir, "dingtalk", "conversations.json"), conversationsMeta);
	for (const item of p.drops) move(path.join(p.workspaceDir, item.dir), item.to, log);

	const eventsDir = path.join(p.workspaceDir, "events");
	for (const event of p.eventMoves) {
		move(path.join(eventsDir, event.file), path.join(event.to, event.file), log);
		const marker = path.join(eventsDir, `${event.file}.error.txt`);
		if (exists(marker)) move(marker, path.join(event.to, `${event.file}.error.txt`), log);
	}
	if (exists(eventsDir)) {
		for (const entry of listDir(eventsDir)) {
			move(path.join(eventsDir, entry.name), path.join(p.workspaceDir, ".legacy", "events", entry.name), log);
		}
		fs.rmdirSync(eventsDir);
	}

	migrateState(p, report);

	const rewrite = buildRewriter(p.rewrites);
	report.rewrites = [];
	if (rewrite) {
		for (const file of rewriteScope(p)) {
			if (!isRewritable(file)) continue;
			const text = fs.readFileSync(file, "utf8");
			const result = rewrite(text);
			if (result.count === 0) continue;
			writeAtomically(file, result.text, fs.statSync(file).mode);
			report.rewrites.push({ file, count: result.count });
		}
	}

	writeJson(path.join(p.workspaceDir, "dots", "bindings.json"), {
		version: 1,
		bindings: Object.fromEntries(p.bindings.map((b) => [b.channelId, { dot: b.dot, boundAt: now.toISOString() }])),
	});
	const done = {
		version: 1,
		migratedAt: now.toISOString(),
		dots: Object.fromEntries(p.migrations.map((item) => [item.dot, { from: item.dir, channelId: item.channelId }])),
		dropped: p.drops.map((item) => item.dir),
	};
	writeJson(path.join(p.stateDir, "dots-migration.done"), done);
	report.finishedAt = new Date().toISOString();
	const reportPath = backupDir
		? path.join(backupDir, "migration-report.json")
		: path.join(p.stateDir, "dots-migration-report.json");
	writeJson(reportPath, report);
	fs.rmSync(inProgress);
	return { report, reportPath };
}

function copyPreserving(from, to) {
	try {
		execFileSync("cp", ["-a", from, to], { stdio: "pipe" });
	} catch {
		fs.cpSync(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
	}
}

function migrateState(p, report) {
	const legacyState = path.join(p.stateDir, ".legacy");
	const byOldChannel = new Map(p.migrations.map((item) => [item.oldChannelId, item]));
	const byDir = new Map(p.migrations.map((item) => [item.dir, item]));
	const droppedDirs = new Set(p.drops.map((item) => item.dir));
	const log = report.moves;

	// Memory maintenance state: one file per old directory → per (dot, conversation).
	const memoryDir = path.join(p.stateDir, "memory");
	for (const entry of listDir(memoryDir)) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const dir = entry.name.slice(0, -".json".length);
		const item = byDir.get(dir);
		const from = path.join(memoryDir, entry.name);
		if (item) {
			const state = tryReadJson(from);
			if (state && typeof state === "object") {
				writeJson(path.join(memoryDir, item.dot, `${item.conversation}.json`), { ...state, channelId: item.channelId });
				fs.rmSync(from);
				log.push({ move: from, to: path.join(memoryDir, item.dot, `${item.conversation}.json`) });
				continue;
			}
		}
		if (item || droppedDirs.has(dir) || LEGACY_PREFIXES.some((prefix) => dir.startsWith(prefix))) {
			move(from, path.join(legacyState, "memory", entry.name), log);
		}
	}

	// Sub-agent run records: `state/subagent-runs/<old-dir>/` → `<dot>/`.
	const runsDir = path.join(p.stateDir, "subagent-runs");
	for (const entry of listDir(runsDir)) {
		if (!entry.isDirectory()) continue;
		const item = byDir.get(entry.name);
		const from = path.join(runsDir, entry.name);
		if (item) move(from, path.join(runsDir, item.dot), log);
		else move(from, path.join(legacyState, "subagent-runs", entry.name), log);
	}

	// Job records: classified by channel (a group id's `/` used to nest directories, D10).
	const jobsDir = path.join(p.stateDir, "jobs");
	const jobFiles = [];
	const walkJobs = (dir) => {
		for (const entry of listDir(dir)) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walkJobs(full);
			else if (entry.isFile() && entry.name.endsWith(".json")) jobFiles.push(full);
		}
	};
	walkJobs(jobsDir);
	for (const file of jobFiles) {
		const record = tryReadJson(file);
		const channelId =
			typeof record?.channelId === "string" ? record.channelId : path.relative(jobsDir, path.dirname(file)).split(path.sep).join("/");
		const item = byOldChannel.get(channelId) ?? byDir.get(channelId);
		if (item && record) {
			const to = path.join(jobsDir, item.dot, path.basename(file));
			writeJson(to, { ...record, channelId: item.channelId });
			fs.rmSync(file);
			log.push({ move: file, to });
		} else {
			move(file, path.join(legacyState, "jobs", path.relative(jobsDir, file)), log);
		}
	}
	removeEmptyDirs(jobsDir, new Set(p.migrations.map((item) => path.join(jobsDir, item.dot))));

	// Durable dispatch records: stamp the dot, and the dot-form id the wake verifier expects.
	const dispatchDir = path.join(p.stateDir, "dispatch");
	for (const entry of listDir(dispatchDir)) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const file = path.join(dispatchDir, entry.name);
		const record = tryReadJson(file);
		const item = record?.event?.channelId === undefined ? undefined : byOldChannel.get(record.event.channelId);
		if (!item) {
			move(file, path.join(legacyState, "dispatch", entry.name), log);
			continue;
		}
		const id = migrateDispatchId(String(record.id), item.oldChannelId, item.dot);
		const event = { ...record.event, channelId: item.channelId, dot: item.dot };
		if (event.dispatchId) event.dispatchId = migrateDispatchId(String(event.dispatchId), item.oldChannelId, item.dot);
		const to = path.join(dispatchDir, `${encodeURIComponent(id)}.json`);
		writeJson(to, { ...record, id, event });
		if (to !== file) fs.rmSync(file);
		log.push({ move: file, to });
	}

	// Usage ledger: each line gains the dot its channel now belongs to (history otherwise untouched).
	const usageDir = path.join(p.stateDir, "usage");
	let usageLines = 0;
	for (const entry of listDir(usageDir)) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
		const file = path.join(usageDir, entry.name);
		const lines = fs.readFileSync(file, "utf8").split("\n");
		let changed = false;
		const out = lines.map((line) => {
			if (!line.trim()) return line;
			let value;
			try {
				value = JSON.parse(line);
			} catch {
				return line;
			}
			const item = typeof value.channelId === "string" ? byOldChannel.get(value.channelId) : undefined;
			if (!item || value.dot) return line;
			changed = true;
			usageLines++;
			return JSON.stringify({ ...value, dot: item.dot });
		});
		if (changed) writeAtomically(file, out.join("\n"), fs.statSync(file).mode);
	}
	report.usageLinesStamped = usageLines;
}

function removeEmptyDirs(dir, keep) {
	for (const entry of listDir(dir)) {
		if (!entry.isDirectory()) continue;
		const full = path.join(dir, entry.name);
		removeEmptyDirs(full, keep);
		if (!keep.has(full) && listDir(full).length === 0) fs.rmdirSync(full);
	}
}

// ---------------------------------------------------------------------------------------------
// Verify (read-only)

export function verify(home, asHome) {
	const workspaceDir = path.join(home, "workspace");
	const stateDir = path.join(home, "state");
	const problems = [];
	const dotsDir = path.join(workspaceDir, "dots");
	const records = new Map();
	for (const entry of listDir(dotsDir)) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		const record = tryReadJson(path.join(dotsDir, entry.name, "dot.json"));
		if (!record || record.version !== 1 || typeof record.conversations !== "object") {
			problems.push(`dots/${entry.name}/dot.json is missing or unreadable`);
		} else if (record.name !== entry.name) {
			problems.push(`dots/${entry.name}/dot.json names "${record.name}"`);
		} else records.set(entry.name, record);
	}
	const bindings = tryReadJson(path.join(dotsDir, "bindings.json"));
	if (!bindings || bindings.version !== 1 || typeof bindings.bindings !== "object") {
		problems.push("dots/bindings.json is missing or unreadable");
	} else {
		for (const [channelId, binding] of Object.entries(bindings.bindings)) {
			const record = records.get(binding?.dot);
			if (!record) problems.push(`binding ${channelId} → ${binding?.dot}: no such available dot`);
			else if (!record.conversations[channelId]) {
				problems.push(`binding ${channelId} → ${binding.dot}: no conversation registered in dot.json`);
			}
		}
	}
	for (const entry of listDir(workspaceDir)) {
		if (entry.isDirectory() && LEGACY_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) {
			problems.push(`legacy channel directory left in the workspace: ${entry.name}`);
		}
	}
	const eventsDir = path.join(workspaceDir, "events");
	const strayEvents = listDir(eventsDir).filter((entry) => entry.name.endsWith(".json"));
	if (strayEvents.length > 0) {
		problems.push(`events outside any dot: ${strayEvents.map((entry) => entry.name).join(", ")}`);
	}
	for (const [dot] of records) {
		const tasksDir = path.join(dotsDir, dot, "tasks");
		for (const entry of listDir(tasksDir)) {
			if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
			const text = fs.readFileSync(path.join(tasksDir, entry.name), "utf8");
			const end = text.indexOf("\n---", 4);
			const frontmatter = text.startsWith("---\n") && end > 0 ? text.slice(4, end) : "";
			if (!/^channel:\s*\S/m.test(frontmatter)) problems.push(`dots/${dot}/tasks/${entry.name} has no channel`);
		}
	}
	const roots = rewriteRoots(home, asHome);
	const leftover = new RegExp(
		`(?:${roots.map((root) => escapeRegExp(`${root}/workspace/`)).join("|")})(?:dm_|group_|tui_)[^\\s"'\`)]*`,
		"g",
	);
	for (const file of rewriteScope({ workspaceDir, stateDir })) {
		if (!isRewritable(file)) continue;
		const matches = fs.readFileSync(file, "utf8").match(leftover);
		if (matches) problems.push(`old path in ${file}: ${matches[0]}${matches.length > 1 ? ` (+${matches.length - 1})` : ""}`);
	}
	return problems;
}

// ---------------------------------------------------------------------------------------------
// CLI

function formatBytes(bytes) {
	return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

export function formatInventory(inv) {
	const lines = [`Legacy channel directories in ${inv.workspaceDir}:`];
	for (const item of inv.legacy) {
		const id = item.channelId ? `${item.channelId} (from ${item.idSource})` : `UNRESOLVED: ${item.problem}`;
		lines.push(`  ${item.dir}`);
		lines.push(`    channel: ${id}${item.name ? `, name "${item.name}"` : ""}`);
		lines.push(
			`    ${item.files} files, ${formatBytes(item.bytes)}; ${item.sessionFiles} session files; ${item.openTasks} open tasks; memory: ${item.hasMemory ? "yes" : "no"}` +
				`${item.lastMessageAt ? `; last message ${item.lastMessageAt}` : ""}${item.projectRoot ? `; projectRoot ${item.projectRoot} (dropped)` : ""}`,
		);
	}
	if (inv.legacy.length === 0) lines.push("  (none)");
	lines.push(`Workspace events: ${inv.events.map((event) => `${event.file} → ${event.channelId ?? "?"}`).join(", ") || "(none)"}`);
	if (!inv.processCheck) lines.push("Warning: /proc is unavailable; could not check for running pipiclaw processes.");
	return lines.join("\n");
}

export function formatPlan(p) {
	const lines = [];
	for (const item of p.migrations) {
		lines.push(`map ${item.dir} → dot ${item.dot} (channel ${item.channelId}${item.kind === "tui" ? ", not bound" : ", bound"})`);
		for (const entry of listDir(item.from)) {
			const to = SESSION_FILE.test(entry.name)
				? path.join(item.conversationDir, entry.name)
				: entry.name === ".channel-meta.json"
					? "state/dingtalk/conversations.json (merged)"
					: entry.name === "project.json"
						? "(deleted)"
						: path.join(item.dotDir, entry.name);
			lines.push(`  ${entry.name} → ${to}`);
		}
	}
	for (const item of p.drops) lines.push(`drop ${item.dir} → ${item.to}`);
	for (const event of p.eventMoves) lines.push(`event ${event.file} → ${path.join(event.to, event.file)}`);
	lines.push("state: memory → state/memory/<dot>/<conversation>.json; subagent-runs/<dir> → <dot>; jobs by channel → <dot>;");
	lines.push("       dispatch records stamped with dot; usage lines stamped with dot");
	lines.push(`path rewrites (${p.rewrites.length}, longest first):`);
	for (const [from, to] of p.rewrites) lines.push(`  ${from} → ${to}`);
	lines.push(`bindings: ${p.bindings.map((b) => `${b.channelId} → ${b.dot}`).join(", ") || "(none)"}`);
	lines.push(p.backup ? `backup: ${p.home}/backups/pre-dots-<timestamp>/` : "backup: none (--no-backup)");
	return lines.join("\n");
}

const USAGE = `Usage:
  node scripts/migrate-to-dots.mjs [--home <dir>] --dry-run                     show the inventory
  node scripts/migrate-to-dots.mjs [--home <dir>] --map <old-dir>=<dot> ... [--drop <old-dir> ...]
                                   [--dry-run] [--no-backup] [--as-home <dir>]
  node scripts/migrate-to-dots.mjs [--home <dir>] --verify [--as-home <dir>]
Stop every pipiclaw process first. See docs/deployment-and-operations.md.`;

function main(argv) {
	let options;
	try {
		options = parseArgs(argv);
	} catch (error) {
		console.error(`${error.message}\n\n${USAGE}`);
		return 2;
	}
	if (options.help) {
		console.log(USAGE);
		return 0;
	}
	if (options.verify) {
		const problems = verify(options.home, options.asHome);
		if (problems.length === 0) {
			console.log(`Verified ${options.home}: dot layout is consistent.`);
			return 0;
		}
		console.error(`Verification failed for ${options.home}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
		return 1;
	}
	const inv = inventory(options.home);
	const p = plan(inv, options);
	if (options.dryRun) {
		console.log(formatInventory(inv));
		console.log("");
		if (p.ok) console.log(`Plan (dry run, nothing written):\n${formatPlan(p)}`);
		else console.log(`Cannot migrate yet:\n${p.errors.map((e) => `  - ${e}`).join("\n")}`);
		return p.ok ? 0 : 1;
	}
	if (!p.ok) {
		console.error(`Refusing to migrate ${options.home}; nothing was written:\n${p.errors.map((e) => `  - ${e}`).join("\n")}`);
		return 1;
	}
	try {
		const { report, reportPath } = apply(p);
		console.log(`Migrated ${options.home}: ${report.dots.length} dots, ${p.drops.length} dropped, ${report.rewrites.length} files with rewritten paths.`);
		for (const dot of report.dots) console.log(`  ${dot.from} → dots/${dot.dot} (${dot.channelId}${dot.bound ? "" : ", not bound"})`);
		console.log(`Report: ${reportPath}`);
		console.log(`Next: node scripts/migrate-to-dots.mjs --home ${options.home} --verify`);
		return 0;
	} catch (error) {
		console.error(`Migration failed: ${error.stack ?? error}`);
		console.error(`state/dots-migration.inprogress is kept, so Pipiclaw will refuse to start on this home.`);
		const backups = path.join(options.home, "backups");
		if (p.backup) {
			console.error(
				`Restore from the newest ${backups}/pre-dots-*/ directory:\n` +
					`  rm -rf ${options.home}/workspace ${options.home}/state && cp -a <backup>/workspace <backup>/state ${options.home}/`,
			);
		} else console.error("No backup was taken (--no-backup).");
		return 1;
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
	process.exitCode = main(process.argv.slice(2));
}
