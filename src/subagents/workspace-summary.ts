import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * P2-2: a plain-language "what changed" line for a completion wake, so the agent that reads it
 * does not have to spend its own first tool call finding out. `git status --porcelain` only — a
 * convenience for the reader, not evidence of anything. Returns `undefined` on any failure (not a
 * git repo, `git` unavailable) or when nothing changed; a caller with nothing to show should
 * simply omit the line.
 */
export async function changedPathsSummary(workingDirectory: string, limit = 20): Promise<string | undefined> {
	let statusOutput: string;
	try {
		const args = ["-C", workingDirectory, "status", "--porcelain=v1", "--untracked-files=all"];
		statusOutput = (await execFileAsync("git", args, { maxBuffer: 4 * 1024 * 1024 })).stdout;
	} catch {
		return undefined;
	}
	const lines = statusOutput
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length === 0) return undefined;
	const shown = lines.slice(0, limit).join(", ");
	const overflow = lines.length > limit ? ` (+${lines.length - limit} more)` : "";
	return `${shown}${overflow}`;
}
