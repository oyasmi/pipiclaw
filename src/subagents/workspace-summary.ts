import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * P2-2: a plain-language "what changed" line for a completion wake, so the agent that reads it
 * does not have to spend its own first tool call finding out. `git status --porcelain` only — a
 * convenience for the reader, not evidence of anything.
 *
 * A checkout is often already dirty when a write run starts (the leader's own edits, an earlier
 * run's output). Reporting the raw status would credit all of that to this run, so a write run
 * takes a cheap baseline at dispatch — each dirty path's status plus size/mtime — and the summary
 * leaves out every path whose signature is unchanged. A pre-dirty file the run touched again gets
 * a new mtime and so still shows up.
 */

/** Dirty path → `<XY status>|<size>|<mtimeMs>` at dispatch time. */
export type WorkspaceBaseline = Record<string, string>;

/** Past this many dirty paths a baseline is not worth persisting on every run record; the summary
 *  then falls back to the raw status and says so. */
const BASELINE_MAX_ENTRIES = 500;

async function readPorcelain(workingDirectory: string): Promise<string[] | undefined> {
	try {
		const args = ["-C", workingDirectory, "status", "--porcelain=v1", "--untracked-files=all"];
		const { stdout } = await execFileAsync("git", args, { maxBuffer: 4 * 1024 * 1024 });
		return stdout
			.split("\n")
			.map((line) => line.trimEnd())
			.filter((line) => line.length > 3);
	} catch {
		return undefined;
	}
}

/** `XY path` or `XY orig -> path`; the path is what a later status line will be keyed by. */
function porcelainPath(line: string): string {
	const rest = line.slice(3);
	const arrow = rest.indexOf(" -> ");
	return arrow >= 0 ? rest.slice(arrow + 4) : rest;
}

async function pathSignature(workingDirectory: string, line: string): Promise<string> {
	const status = line.slice(0, 2);
	const path = porcelainPath(line);
	// A quoted path (special characters) is not worth unquoting for a convenience line: its status
	// alone still tells "unchanged since dispatch" apart from most real edits.
	if (path.startsWith('"')) return status;
	try {
		const info = await stat(join(workingDirectory, path));
		return `${status}|${info.size}|${info.mtimeMs}`;
	} catch {
		return `${status}|missing`;
	}
}

/** `undefined` when the directory is not a git checkout or is too dirty to baseline. */
export async function snapshotWorkspace(workingDirectory: string): Promise<WorkspaceBaseline | undefined> {
	const lines = await readPorcelain(workingDirectory);
	if (!lines || lines.length > BASELINE_MAX_ENTRIES) return undefined;
	const baseline: WorkspaceBaseline = {};
	await Promise.all(
		lines.map(async (line) => {
			baseline[porcelainPath(line)] = await pathSignature(workingDirectory, line);
		}),
	);
	return baseline;
}

/**
 * Returns `undefined` on any failure (not a git repo, `git` unavailable) or when nothing changed;
 * a caller with nothing to show should simply omit the line.
 */
export async function changedPathsSummary(
	workingDirectory: string,
	baseline?: WorkspaceBaseline,
	limit = 20,
): Promise<string | undefined> {
	const lines = await readPorcelain(workingDirectory);
	if (!lines) return undefined;
	let changed = lines;
	let unchangedCount = 0;
	if (baseline) {
		const flags = await Promise.all(
			lines.map(async (line) => {
				const before = baseline[porcelainPath(line)];
				return before !== undefined && before === (await pathSignature(workingDirectory, line));
			}),
		);
		changed = lines.filter((_, index) => !flags[index]);
		unchangedCount = lines.length - changed.length;
	}
	if (changed.length === 0) return undefined;
	const shown = changed
		.slice(0, limit)
		.map((line) => line.trim())
		.join(", ");
	const overflow = changed.length > limit ? ` (+${changed.length - limit} more)` : "";
	const note = baseline
		? unchangedCount > 0
			? ` (${unchangedCount} path(s) already dirty before the run and untouched are omitted)`
			: ""
		: " (no pre-run baseline: may include changes that predate this run)";
	return `${shown}${overflow}${note}`;
}
