// Rehearse the v3 -> v5 task conversion on a throwaway copy. Usage (after `npm run build`):
//   node scripts/rehearse-task-migration.mjs [appHome]      (default: $PIPICLAW_HOME or ~/.pipiclaw)
// Only `workspace/events/` and each channel's `tasks/` (minus `.sessions/`) are copied, read-only, into a
// fresh temp dir; the migration function is called directly on that copy. No bootstrap, so no DingTalk
// connection, event watcher, task driver or external executor is started, and the source is never written.
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const source = resolve(process.argv[2] ?? process.env.PIPICLAW_HOME ?? join(homedir(), ".pipiclaw"));
const sourceWorkspace = join(source, "workspace");
if (!existsSync(sourceWorkspace)) {
	console.error(`No workspace/ under ${source}`);
	process.exit(2);
}
const scratch = mkdtempSync(join(tmpdir(), "pipiclaw-migration-rehearsal-"));
const workspace = join(scratch, "workspace");
const stateDir = join(scratch, "state");

cpSync(sourceWorkspace, workspace, {
	recursive: true,
	filter: (src) => {
		const rel = relative(sourceWorkspace, src);
		if (!rel) return true;
		const parts = rel.split(sep);
		if (parts.includes(".sessions")) return false;
		if (parts[0] === "events") return true;
		return parts.length === 1 || parts[1] === "tasks";
	},
});
const eventsBefore = new Set(existsSync(join(workspace, "events")) ? readdirSync(join(workspace, "events")) : []);

const { migrateTasksToV5 } = await import(pathToFileURL(resolve("dist/runtime/task-migration.js")).href);
let failed = false;
try {
	await migrateTasksToV5(workspace, stateDir);
} catch (error) {
	failed = true;
	console.error(`MIGRATION FAILED: ${error instanceof Error ? error.message : error}`);
	const report = join(stateDir, "task-migration-v5.failed.json");
	if (existsSync(report)) console.error(readFileSync(report, "utf-8"));
}

const eventsAfter = existsSync(join(workspace, "events")) ? readdirSync(join(workspace, "events")) : [];
console.log(`Source (read only): ${source}`);
console.log(`Rehearsal copy:     ${scratch}`);
console.log("Event templates that a real start would create (watcher would load these):");
for (const name of eventsAfter.filter((n) => !eventsBefore.has(n))) console.log(`  + events/${name}`);
for (const channel of readdirSync(workspace, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== "events")) {
	const tasks = join(workspace, channel.name, "tasks");
	if (!existsSync(tasks)) continue;
	for (const file of readdirSync(tasks).filter((n) => n.endsWith(".md"))) {
		const head = readFileSync(join(tasks, file), "utf-8").split("\n").slice(0, 12);
		const state = head.find((l) => l.startsWith("state:")) ?? "(no state:)";
		const paused = head.some((l) => l.startsWith("paused:")) ? " paused" : "";
		console.log(`  ${channel.name}/${file}: ${state}${paused}`);
	}
}
console.log(`Inspect tasks/.v3/, tasks/*.jsonl notes and archive/ under ${scratch}; delete it when done.`);
process.exit(failed ? 1 : 0);
