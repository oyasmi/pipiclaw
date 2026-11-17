import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireWorkspaceLease, releaseWorkspaceLease } from "../src/subagents/workspace-lease.js";
import { prepareManagedWorktree, reclaimManagedWorktree, settleManagedWorktree } from "../src/subagents/worktree.js";
import { useTempDirs } from "./helpers/fixtures.js";

const tempDir = useTempDirs("pipiclaw-worktree-");
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: "pipe" }).trim();

async function checkout() {
	const repo = tempDir();
	git(repo, "init", "-q");
	git(repo, "config", "user.name", "Test");
	git(repo, "config", "user.email", "test@example.com");
	writeFileSync(join(repo, "base.txt"), "base\n");
	git(repo, "add", "base.txt");
	git(repo, "commit", "-qm", "base");
	const artifactDir = join(tempDir(), "run");
	const prepared = await prepareManagedWorktree(repo, artifactDir, "run_test");
	return { repo, artifactDir, ...prepared };
}

describe("managed worktree cleanup", () => {
	it("settles an unchanged worktree under its owner's lease without releasing that lease", async () => {
		const wt = await checkout();
		const owner = acquireWorkspaceLease({ runId: "owner", channelId: "test", workingDirectory: wt.workingDirectory });
		expect(owner.ok).toBe(true);
		try {
			expect(await settleManagedWorktree(wt.artifactDir, undefined, "owner")).toMatchObject({
				cleaned: true,
				dirty: false,
			});
			expect(existsSync(wt.worktreeRoot)).toBe(false);
			expect(git(wt.repo, "branch", "--list", wt.branch!)).toBe("");
			const competitor = acquireWorkspaceLease({
				runId: "other",
				channelId: "test",
				workingDirectory: wt.workingDirectory,
			});
			expect(competitor.ok).toBe(false);
		} finally {
			if (owner.ok) releaseWorkspaceLease(owner.leaseKey, "owner");
		}
	});

	it("preserves uncommitted files and recovery metadata when Git inspection fails", async () => {
		// Regression: an inspection error used to fabricate dirty=false/baseHead and force-delete
		// this worktree. Mutation verified (2026-11-17): restoring the pre-fix worktree module
		// fails on ENOENT for valuable.txt; the locked-removal case below also fails.
		const wt = await checkout();
		const valuable = join(wt.worktreeRoot, "valuable.txt");
		writeFileSync(valuable, "unfinished work\n");
		const index = git(wt.worktreeRoot, "rev-parse", "--git-path", "index");
		const savedIndex = readFileSync(index);
		writeFileSync(index, "broken index");
		await settleManagedWorktree(wt.artifactDir);
		expect(readFileSync(valuable, "utf-8")).toBe("unfinished work\n");
		expect(existsSync(join(wt.artifactDir, ".worktree.json"))).toBe(true);
		expect(git(wt.repo, "branch", "--list", wt.branch!)).not.toBe("");
		expect(await reclaimManagedWorktree(wt.artifactDir)).toMatchObject({ status: "retained", reason: "unavailable" });
		// Repairing Git must not lose the original dirty-state protection or prevent later cleanup.
		writeFileSync(index, savedIndex);
		expect(await settleManagedWorktree(wt.artifactDir)).toMatchObject({
			dirty: true,
			cleaned: false,
			changedFiles: ["valuable.txt"],
		});
		expect(await reclaimManagedWorktree(wt.artifactDir)).toMatchObject({ status: "retained", reason: "dirty" });
		unlinkSync(valuable);
		expect(await settleManagedWorktree(wt.artifactDir)).toMatchObject({ cleaned: true });
	});

	it("honors Git's final removal refusal and retries without destroying the worktree", async () => {
		// A clean inspection is not permission to bypass Git's worktree lock or a later dirty write.
		const wt = await checkout();
		git(wt.repo, "worktree", "lock", wt.worktreeRoot);
		expect(await settleManagedWorktree(wt.artifactDir)).toMatchObject({ cleaned: false });
		expect(await reclaimManagedWorktree(wt.artifactDir)).toMatchObject({ status: "retained", reason: "unavailable" });
		expect(readFileSync(join(wt.worktreeRoot, "base.txt"), "utf-8")).toBe("base\n");
		expect(existsSync(join(wt.artifactDir, ".worktree.json"))).toBe(true);
		git(wt.repo, "worktree", "unlock", wt.worktreeRoot);
		expect(await reclaimManagedWorktree(wt.artifactDir)).toMatchObject({ status: "removed" });
		expect(existsSync(join(wt.artifactDir, ".worktree.json"))).toBe(false);
	});
});
