import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import * as log from "../log.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import type { RetainedWorktreeInfo } from "../tasks/control.js";
import { isTerminal, type ManagedWorktreeSummary, type RunRecord, WORKTREE_RETENTION_MS } from "./run-record.js";

const execFileAsync = promisify(execFile);
const GIT_WORKTREE_TIMEOUT_MS = 15_000;
const WORKTREE_META_FILENAME = ".worktree.json";
const CHANGED_FILES_CAP = 100;

interface ManagedWorktreeMeta {
	repoRoot: string;
	gitCommonDir: string;
	baseHead: string;
	worktreeRoot: string;
	workingDirectory: string;
	createdBranch: string | null;
}

export interface PreparedManagedWorktree {
	workingDirectory: string;
	worktreeRoot: string;
	baseDir: string;
	baseHead: string;
	branch: string | null;
}

export type ReclaimWorktreeOutcome =
	| { status: "none" }
	| { status: "removed"; path: string; branch: string | null }
	| {
			status: "retained";
			path: string;
			branch: string | null;
			headSha: string;
			reason: "dirty" | "unmerged";
	  };

function safeRunSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 48) || "run";
}

async function runGitRaw(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
		maxBuffer: 4 * 1024 * 1024,
		timeout: GIT_WORKTREE_TIMEOUT_MS,
	});
	return stdout;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
	return (await runGitRaw(cwd, args)).trim();
}

async function readWorktreeMeta(artifactDir: string): Promise<ManagedWorktreeMeta | undefined> {
	try {
		return JSON.parse(await readFile(join(artifactDir, WORKTREE_META_FILENAME), "utf-8")) as ManagedWorktreeMeta;
	} catch {
		return undefined;
	}
}

async function removeWorktreeDirectory(meta: ManagedWorktreeMeta): Promise<void> {
	await runGit(meta.repoRoot, ["worktree", "remove", "--force", meta.worktreeRoot]).catch(async () => {
		await rm(meta.worktreeRoot, { recursive: true, force: true }).catch(() => undefined);
		await runGit(meta.repoRoot, ["worktree", "prune"]).catch(() => undefined);
	});
}

async function deleteBranchIfAtBase(meta: ManagedWorktreeMeta): Promise<void> {
	if (!meta.createdBranch) return;
	const branchSha = await runGit(meta.repoRoot, ["rev-parse", "--verify", `refs/heads/${meta.createdBranch}`]).catch(
		() => undefined,
	);
	if (branchSha && branchSha === meta.baseHead) {
		await runGit(meta.repoRoot, ["branch", "-D", meta.createdBranch]).catch(() => undefined);
	}
}

async function deleteBranchIfMerged(meta: ManagedWorktreeMeta): Promise<void> {
	if (!meta.createdBranch) return;
	const branchSha = await runGit(meta.repoRoot, ["rev-parse", "--verify", `refs/heads/${meta.createdBranch}`]).catch(
		() => undefined,
	);
	if (!branchSha) return;
	if (branchSha === meta.baseHead) {
		await runGit(meta.repoRoot, ["branch", "-D", meta.createdBranch]).catch(() => undefined);
		return;
	}
	await runGit(meta.repoRoot, ["branch", "-d", meta.createdBranch]).catch(() => undefined);
}

/**
 * Create an isolated Git worktree at `<gitCommonDir>/pipiclaw-worktrees/<runId>` (`.git/pipiclaw-worktrees/<runId>`)
 * on branch `pipiclaw/<runId>` (falling back to detached HEAD only on ref collision) so concurrent write
 * delegations never collide on the main checkout.
 */
export async function prepareManagedWorktree(
	baseWorkingDir: string,
	artifactDir: string,
	runId: string,
): Promise<PreparedManagedWorktree> {
	let repoRoot: string;
	let gitCommonDir: string;
	let baseHead: string;
	try {
		repoRoot = realpathSync(await runGit(baseWorkingDir, ["rev-parse", "--show-toplevel"]));
		const rawCommonDir = await runGit(baseWorkingDir, ["rev-parse", "--git-common-dir"]);
		gitCommonDir = realpathSync(resolve(baseWorkingDir, rawCommonDir));
		baseHead = await runGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);
	} catch {
		throw new RecoverableToolError(
			`Cannot create worktree from "${baseWorkingDir}": it is not inside a Git repository with an existing commit. Omit worktree=true or pass a Git checkout in workingDirectory.`,
		);
	}
	const canonicalBase = realpathSync(baseWorkingDir);
	const subdir = relative(repoRoot, canonicalBase);
	const safeId = safeRunSegment(runId);
	const worktreeRoot = join(gitCommonDir, "pipiclaw-worktrees", safeId);
	const candidateBranch = `pipiclaw/${safeId}`;
	await mkdir(dirname(worktreeRoot), { recursive: true });

	let createdBranch: string | null = candidateBranch;
	try {
		await runGit(repoRoot, ["worktree", "add", "-B", candidateBranch, worktreeRoot, baseHead]);
	} catch {
		createdBranch = null;
		try {
			await runGit(repoRoot, ["worktree", "add", "--detach", worktreeRoot, baseHead]);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new RecoverableToolError(
				`Failed to create managed Git worktree at "${worktreeRoot}": ${detail}. Omit worktree=true or pass an existing checkout via workingDirectory.`,
			);
		}
	}

	const canonicalWorktreeRoot = realpathSync(worktreeRoot);
	const workingDirectory = realpathSync(subdir ? join(canonicalWorktreeRoot, subdir) : canonicalWorktreeRoot);
	const meta: ManagedWorktreeMeta = {
		repoRoot,
		gitCommonDir,
		baseHead,
		worktreeRoot: canonicalWorktreeRoot,
		workingDirectory,
		createdBranch,
	};
	await mkdir(artifactDir, { recursive: true });
	await writeFile(join(artifactDir, WORKTREE_META_FILENAME), JSON.stringify(meta), "utf-8");
	return {
		workingDirectory,
		worktreeRoot: canonicalWorktreeRoot,
		baseDir: canonicalBase,
		baseHead,
		branch: createdBranch,
	};
}

/** Propagate `.worktree.json` to a resumed `follow_up` run's artifact directory so settlement tracks it. */
export async function copyManagedWorktreeMeta(sourceArtifactDir: string, targetArtifactDir: string): Promise<boolean> {
	const meta = await readWorktreeMeta(sourceArtifactDir);
	if (!meta) return false;
	await mkdir(targetArtifactDir, { recursive: true });
	await writeFile(join(targetArtifactDir, WORKTREE_META_FILENAME), JSON.stringify(meta), "utf-8");
	return true;
}

/** Read structured `branch`, `headSha`, and `changedFiles` state of a managed worktree without mutating it. */
export async function inspectManagedWorktree(artifactDir: string): Promise<ManagedWorktreeSummary | undefined> {
	const meta = await readWorktreeMeta(artifactDir);
	if (!meta) return undefined;
	if (!existsSync(meta.worktreeRoot)) {
		return {
			path: meta.worktreeRoot,
			baseHead: meta.baseHead,
			branch: null,
			headSha: meta.baseHead,
			changedFiles: [],
			dirty: false,
			cleaned: true,
		};
	}
	try {
		const [headSha, branch, statusText, diffOut, untrackedOut] = await Promise.all([
			runGit(meta.worktreeRoot, ["rev-parse", "--verify", "HEAD"]),
			runGit(meta.worktreeRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]).then(
				(name) => name || null,
				() => null,
			),
			runGit(meta.worktreeRoot, ["status", "--porcelain=v1", "--untracked-files=all"]),
			runGitRaw(meta.worktreeRoot, ["diff", "--name-only", "-z", meta.baseHead]).catch(() => ""),
			runGitRaw(meta.worktreeRoot, ["ls-files", "--others", "--exclude-standard", "-z"]).catch(() => ""),
		]);
		const seen = new Set<string>();
		for (const raw of [...diffOut.split("\0"), ...untrackedOut.split("\0")]) {
			if (raw) seen.add(raw);
		}
		return {
			path: meta.worktreeRoot,
			baseHead: meta.baseHead,
			branch,
			headSha,
			changedFiles: Array.from(seen).slice(0, CHANGED_FILES_CAP),
			dirty: statusText.length > 0,
			cleaned: false,
		};
	} catch {
		return {
			path: meta.worktreeRoot,
			baseHead: meta.baseHead,
			branch: meta.createdBranch,
			headSha: meta.baseHead,
			changedFiles: [],
			dirty: false,
			cleaned: false,
		};
	}
}

/**
 * Inspect a runtime-managed worktree upon run settlement/cancel and auto-remove it immediately when
 * unchanged (no commits beyond `baseHead` and no uncommitted/untracked files). Worktrees with commits
 * or dirty edits stay on disk so the parent session/task can verify and merge them.
 */
export async function settleManagedWorktree(
	artifactDir: string,
	precomputed?: ManagedWorktreeSummary,
): Promise<ManagedWorktreeSummary | undefined> {
	const metaPath = join(artifactDir, WORKTREE_META_FILENAME);
	if (precomputed) {
		if (precomputed.cleaned) await unlink(metaPath).catch(() => undefined);
		return precomputed;
	}
	const meta = await readWorktreeMeta(artifactDir);
	if (!meta) return undefined;
	const summary = await inspectManagedWorktree(artifactDir);
	if (!summary) return undefined;
	if (!summary.dirty && summary.headSha === meta.baseHead) {
		await removeWorktreeDirectory(meta);
		await deleteBranchIfAtBase(meta);
		await unlink(metaPath).catch(() => undefined);
		return { ...summary, cleaned: true };
	}
	return summary;
}

export async function cleanupManagedWorktreeIfUnchanged(artifactDir: string): Promise<void> {
	await settleManagedWorktree(artifactDir);
}

/**
 * Reclaim a settled run's managed worktree when its parent task closes or its retention window expires:
 * - Clean and either unchanged (`headSha === baseHead`) or merged into `repoRoot`'s `HEAD` -> `git worktree remove`.
 * - Dirty working tree or unmerged commits -> preserved on disk and reported back to the caller.
 */
export async function reclaimManagedWorktree(artifactDir: string): Promise<ReclaimWorktreeOutcome> {
	const metaPath = join(artifactDir, WORKTREE_META_FILENAME);
	const meta = await readWorktreeMeta(artifactDir);
	if (!meta) return { status: "none" };

	if (!existsSync(meta.worktreeRoot)) {
		await runGit(meta.repoRoot, ["worktree", "prune"]).catch(() => undefined);
		await deleteBranchIfMerged(meta);
		await unlink(metaPath).catch(() => undefined);
		return { status: "removed", path: meta.worktreeRoot, branch: meta.createdBranch };
	}

	let headSha: string;
	let branch: string | null;
	let statusText: string;
	try {
		[headSha, branch, statusText] = await Promise.all([
			runGit(meta.worktreeRoot, ["rev-parse", "--verify", "HEAD"]),
			runGit(meta.worktreeRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]).then(
				(name) => name || null,
				() => null,
			),
			runGit(meta.worktreeRoot, ["status", "--porcelain=v1", "--untracked-files=all"]),
		]);
	} catch {
		return {
			status: "retained",
			path: meta.worktreeRoot,
			branch: meta.createdBranch,
			headSha: meta.baseHead,
			reason: "dirty",
		};
	}

	if (statusText.length > 0) {
		return {
			status: "retained",
			path: meta.worktreeRoot,
			branch,
			headSha,
			reason: "dirty",
		};
	}

	if (headSha !== meta.baseHead) {
		const merged = await runGit(meta.repoRoot, ["merge-base", "--is-ancestor", headSha, "HEAD"]).then(
			() => true,
			() => false,
		);
		if (!merged) {
			return {
				status: "retained",
				path: meta.worktreeRoot,
				branch,
				headSha,
				reason: "unmerged",
			};
		}
	}

	await removeWorktreeDirectory(meta);
	await deleteBranchIfMerged(meta);
	await unlink(metaPath).catch(() => undefined);
	return { status: "removed", path: meta.worktreeRoot, branch };
}

/**
 * Reclaim all managed worktrees bound to `taskId` when the task closes. Clean/merged worktrees are
 * removed automatically; dirty or unmerged worktrees stay on disk and are returned for user notice.
 */
export async function reclaimTaskManagedWorktrees(
	runs: Iterable<RunRecord>,
	taskId: string,
	onUpdated?: (record: RunRecord) => Promise<void> | void,
): Promise<RetainedWorktreeInfo[]> {
	const byPath = new Map<string, RunRecord[]>();
	const unindexed: RunRecord[] = [];
	for (const record of runs) {
		if (record.taskId !== taskId || !isTerminal(record.status)) continue;
		if (record.worktree?.cleaned) continue;
		const key = record.worktree?.path;
		if (key) {
			const group = byPath.get(key) ?? [];
			group.push(record);
			byPath.set(key, group);
		} else {
			unindexed.push(record);
		}
	}

	const retained: RetainedWorktreeInfo[] = [];
	const groups: RunRecord[][] = [...byPath.values(), ...unindexed.map((record) => [record])];
	for (const group of groups) {
		const latest = group.reduce((a, b) => ((b.finishedAt ?? b.startedAt) >= (a.finishedAt ?? a.startedAt) ? b : a));
		const outcome = await reclaimManagedWorktree(latest.artifactDir).catch(() => ({ status: "none" as const }));
		if (outcome.status === "removed") {
			for (const record of group) {
				if (record !== latest) {
					await unlink(join(record.artifactDir, WORKTREE_META_FILENAME)).catch(() => undefined);
				}
				if (record.worktree && !record.worktree.cleaned) {
					record.worktree = { ...record.worktree, cleaned: true };
					await onUpdated?.(record);
				}
			}
		} else if (outcome.status === "retained") {
			retained.push({
				runId: latest.runId,
				path: outcome.path,
				branch: outcome.branch,
				headSha: outcome.headSha,
				reason: outcome.reason,
			});
		}
	}
	return retained;
}

/** Periodic GC helper for standalone/expired runs past `WORKTREE_RETENTION_MS`. */
export async function sweepExpiredRunWorktree(
	record: RunRecord,
	now: number,
	persist: (record: RunRecord) => Promise<void>,
): Promise<void> {
	if (!record.settledAt || now - record.settledAt < WORKTREE_RETENTION_MS) return;
	if (record.worktree?.cleaned) return;
	const outcome = await reclaimManagedWorktree(record.artifactDir).catch(() => ({ status: "none" as const }));
	if (outcome.status === "removed" && record.worktree) {
		record.worktree = { ...record.worktree, cleaned: true };
		await persist(record);
	} else if (outcome.status === "retained" && !record.worktreeRetainWarned) {
		record.worktreeRetainWarned = true;
		await persist(record);
		log.logWarn("subagent.worktree.retained", "Managed worktree retained on expiry", {
			channelId: record.channelId,
			reason: outcome.reason,
			fields: {
				runId: record.runId,
				path: outcome.path,
				branch: outcome.branch ?? "detached",
				headSha: outcome.headSha,
			},
		});
	}
}
