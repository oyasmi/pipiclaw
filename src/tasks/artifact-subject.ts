import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
		const [head, unstaged, staged] = await Promise.all([
			execFileAsync("git", ["-C", workingDirectory, "rev-parse", "HEAD"], { maxBuffer: 1024 * 1024 }),
			execFileAsync("git", ["-C", workingDirectory, "diff", "--no-ext-diff", "--binary"], {
				maxBuffer: 4 * 1024 * 1024,
			}),
			execFileAsync("git", ["-C", workingDirectory, "diff", "--cached", "--no-ext-diff", "--binary"], {
				maxBuffer: 4 * 1024 * 1024,
			}),
		]);
		return createHash("sha256")
			.update([head.stdout.trim(), stdout, unstaged.stdout, staged.stdout].join("\0"))
			.digest("hex");
	} catch {
		return undefined;
	}
}
