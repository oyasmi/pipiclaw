import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { RecoverableToolError } from "../shared/recoverable-error.js";

const execFileAsync = promisify(execFile);
const GIT_WORKTREE_TIMEOUT_MS = 15_000;
const WORKTREE_META_FILENAME = ".worktree.json";

interface ManagedWorktreeMeta {
	repoRoot: string;
	baseHead: string;
	worktreeRoot: string;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
		maxBuffer: 4 * 1024 * 1024,
		timeout: GIT_WORKTREE_TIMEOUT_MS,
	});
	return stdout.trim();
}

/**
 * Create a detached Git worktree under `<artifactDir>/worktree` from `baseWorkingDir`'s HEAD so
 * concurrent write delegations can execute in isolated checkouts without colliding on the main tree.
 */
export async function prepareManagedWorktree(baseWorkingDir: string, artifactDir: string): Promise<string> {
	let repoRoot: string;
	let baseHead: string;
	try {
		repoRoot = realpathSync(await runGit(baseWorkingDir, ["rev-parse", "--show-toplevel"]));
		baseHead = await runGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);
	} catch {
		throw new RecoverableToolError(
			`Cannot create worktree from "${baseWorkingDir}": it is not inside a Git repository with an existing commit. Omit worktree=true or pass a Git checkout in workingDirectory.`,
		);
	}
	const canonicalBase = realpathSync(baseWorkingDir);
	const subdir = relative(repoRoot, canonicalBase);
	const worktreeRoot = join(artifactDir, "worktree");
	try {
		await runGit(repoRoot, ["worktree", "add", "--detach", worktreeRoot, baseHead]);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new RecoverableToolError(
			`Failed to create managed Git worktree at "${worktreeRoot}": ${detail}. Omit worktree=true or pass an existing checkout via workingDirectory.`,
		);
	}
	const meta: ManagedWorktreeMeta = {
		repoRoot,
		baseHead,
		worktreeRoot: realpathSync(worktreeRoot),
	};
	await writeFile(join(artifactDir, WORKTREE_META_FILENAME), JSON.stringify(meta), "utf-8");
	return realpathSync(subdir ? join(meta.worktreeRoot, subdir) : meta.worktreeRoot);
}

/**
 * Remove a runtime-managed worktree upon settlement/cancel if and only if it has no uncommitted
 * changes and its HEAD has not advanced; dirty or committed worktrees stay on disk for inspection/merge.
 */
export async function cleanupManagedWorktreeIfUnchanged(artifactDir: string): Promise<void> {
	const metaPath = join(artifactDir, WORKTREE_META_FILENAME);
	let meta: ManagedWorktreeMeta;
	try {
		meta = JSON.parse(await readFile(metaPath, "utf-8")) as ManagedWorktreeMeta;
	} catch {
		return;
	}
	try {
		const head = await runGit(meta.worktreeRoot, ["rev-parse", "--verify", "HEAD"]);
		const status = await runGit(meta.worktreeRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
		if (head !== meta.baseHead || status.length > 0) {
			return;
		}
	} catch {
		// Worktree directory already missing or broken: prune administrative metadata below.
	}
	await runGit(meta.repoRoot, ["worktree", "remove", "--force", meta.worktreeRoot]).catch(async () => {
		await rm(meta.worktreeRoot, { recursive: true, force: true }).catch(() => undefined);
		await runGit(meta.repoRoot, ["worktree", "prune"]).catch(() => undefined);
	});
	await unlink(metaPath).catch(() => undefined);
}
