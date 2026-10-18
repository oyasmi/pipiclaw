/**
 * Startup refusal on a pre-dot layout (spec 058, D21). The runtime no longer understands
 * channel directories at the workspace root or workspace-level events, and running on top of them
 * would quietly ignore all of that state — so the daemon and the TUI stop before any service
 * starts and point the deployer at the migration script.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { docsUrl } from "../paths.js";

/** A refusal to start that the deployer must resolve; printed as a plain message, not a stack. */
export class StartupRefusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StartupRefusal";
	}
}

const LEGACY_CHANNEL_DIR_PREFIXES = ["dm_", "group_", "tui_"];

/** Every reason this home still has the pre-058 layout; empty when it is safe to start. */
function findLegacyLayout(paths: { workspaceDir: string; appHomeDir: string }): string[] {
	const problems: string[] = [];
	let entries: Array<{ name: string; isDirectory(): boolean }> = [];
	try {
		entries = readdirSync(paths.workspaceDir, { withFileTypes: true });
	} catch {
		// No workspace yet: a fresh install.
	}
	const legacyChannelDirs = entries
		.filter(
			(entry) => entry.isDirectory() && LEGACY_CHANNEL_DIR_PREFIXES.some((prefix) => entry.name.startsWith(prefix)),
		)
		.map((entry) => entry.name);
	if (legacyChannelDirs.length > 0) {
		problems.push(`legacy channel directories in ${paths.workspaceDir}: ${legacyChannelDirs.join(", ")}`);
	}
	const eventsDir = join(paths.workspaceDir, "events");
	try {
		const events = readdirSync(eventsDir).filter((name) => name.endsWith(".json"));
		if (events.length > 0) problems.push(`workspace-level events in ${eventsDir}: ${events.join(", ")}`);
	} catch {
		// No workspace events directory: nothing to migrate there.
	}
	const inProgress = join(paths.appHomeDir, "state", "dots-migration.inprogress");
	if (existsSync(inProgress)) {
		problems.push(`an interrupted dot migration (${inProgress}); restore from its backup before retrying`);
	}
	return problems;
}

export function assertNoLegacyLayout(paths: { workspaceDir: string; appHomeDir: string }): void {
	const problems = findLegacyLayout(paths);
	if (problems.length === 0) return;
	throw new StartupRefusal(
		[
			"Pipiclaw cannot start: this app home still uses the pre-dot layout (spec 058).",
			...problems.map((problem) => `  - ${problem}`),
			"Stop every Pipiclaw process, then migrate from a Pipiclaw checkout:",
			`  node scripts/migrate-to-dots.mjs --home ${paths.appHomeDir} --dry-run`,
			"and re-run it with --map <old-channel-dir>=<dot> (and --drop) for every listed directory.",
			`See ${docsUrl("deployment-and-operations.md")}`,
		].join("\n"),
	);
}
