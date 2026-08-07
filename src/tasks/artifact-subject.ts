import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * git quotes a path containing special characters in double quotes with C-style escapes (spec
 * 040, D9). `JSON.parse` accepts the same escape set for the characters git actually emits
 * (`\"`, `\\`, `\t`, `\n`) and is close enough for a hash input; a path so exotic it defeats this
 * still contributes *a* value to the hash; it just won't be the literal decoded path.
 */
function unquoteGitPath(raw: string): string {
	if (raw.startsWith('"') && raw.endsWith('"')) {
		try {
			return JSON.parse(raw) as string;
		} catch {
			return raw;
		}
	}
	return raw;
}

/**
 * Fold untracked-file *content* into the subject, not just their path/status (D9). `git status
 * --porcelain` reports an untracked file as present, but two different untracked files with the
 * same name are indistinguishable to it — a verifier that edits an untracked file's content
 * (or reverts it after inspection) previously left no trace in `workspaceSubjectHash` at all.
 * Best-effort per file: an unreadable entry (deleted mid-scan, a directory, a permission error)
 * still contributes its path to the hash, just not content — this function must never throw, since
 * its caller already treats the whole subject computation as best-effort.
 */
async function untrackedFileDigest(workingDirectory: string, statusOutput: string): Promise<string> {
	const paths = statusOutput
		.split("\n")
		.filter((line) => line.startsWith("?? "))
		.map((line) => unquoteGitPath(line.slice(3).trim()))
		.filter(Boolean)
		.sort();

	const hash = createHash("sha256");
	for (const relativePath of paths) {
		hash.update(relativePath);
		try {
			hash.update(await readFile(join(workingDirectory, relativePath)));
		} catch {
			// Unreadable — the path alone still went into the hash above.
		}
	}
	return hash.digest("hex");
}

/**
 * A compact, deterministic description of the code/artifact subject a verifier
 * observed. It intentionally uses only Git's own view, keeping verification
 * cheap and understandable for a local coding runtime.
 */
export async function workspaceSubjectHash(workingDirectory: string): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync(
			"git",
			["-C", workingDirectory, "status", "--porcelain=v1", "--untracked-files=all"],
			{ maxBuffer: 4 * 1024 * 1024 },
		);
		const [head, unstaged, staged, untrackedDigest] = await Promise.all([
			execFileAsync("git", ["-C", workingDirectory, "rev-parse", "HEAD"], { maxBuffer: 1024 * 1024 }),
			execFileAsync("git", ["-C", workingDirectory, "diff", "--no-ext-diff", "--binary"], {
				maxBuffer: 4 * 1024 * 1024,
			}),
			execFileAsync("git", ["-C", workingDirectory, "diff", "--cached", "--no-ext-diff", "--binary"], {
				maxBuffer: 4 * 1024 * 1024,
			}),
			untrackedFileDigest(workingDirectory, stdout),
		]);
		return createHash("sha256")
			.update([head.stdout.trim(), stdout, unstaged.stdout, staged.stdout, untrackedDigest].join("\0"))
			.digest("hex");
	} catch {
		return undefined;
	}
}
