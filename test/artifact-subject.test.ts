import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workspaceSubjectHash } from "../src/tasks/artifact-subject.js";

// This hash is what binds an independent verifier's PASS to the exact code it
// looked at (spec 023/024): task_manage verify/done reject a stale subject.
// A silent regression here (e.g. forgetting to include staged diffs) would
// let a verifier's attestation survive further, unreviewed changes. It had
// no test coverage at all.
describe("workspaceSubjectHash", () => {
	let dir: string;

	function git(...args: string[]): void {
		execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "artifact-subject-"));
		git("init", "-q");
		git("config", "user.email", "test@example.com");
		git("config", "user.name", "Test");
		writeFileSync(join(dir, "a.txt"), "one\n");
		git("add", "a.txt");
		git("commit", "-q", "-m", "init");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns a stable hash for an unchanged clean checkout", async () => {
		const first = await workspaceSubjectHash(dir);
		const second = await workspaceSubjectHash(dir);
		expect(first).toBeDefined();
		expect(first).toBe(second);
	});

	it("changes when an unstaged edit is made to a tracked file", async () => {
		const before = await workspaceSubjectHash(dir);
		writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
		const after = await workspaceSubjectHash(dir);
		expect(after).not.toBe(before);
	});

	it("changes when a change is staged (not just committed)", async () => {
		const before = await workspaceSubjectHash(dir);
		writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
		git("add", "a.txt");
		const after = await workspaceSubjectHash(dir);
		expect(after).not.toBe(before);
	});

	it("changes when a new untracked file appears", async () => {
		const before = await workspaceSubjectHash(dir);
		writeFileSync(join(dir, "b.txt"), "new file\n");
		const after = await workspaceSubjectHash(dir);
		expect(after).not.toBe(before);
	});

	it("changes across commits even with an otherwise-clean tree", async () => {
		const before = await workspaceSubjectHash(dir);
		writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
		git("commit", "-a", "-q", "-m", "second commit");
		const after = await workspaceSubjectHash(dir);
		expect(after).not.toBe(before);
	});

	it("returns undefined for a directory that is not a Git repository", async () => {
		const plain = mkdtempSync(join(tmpdir(), "not-a-repo-"));
		try {
			await expect(workspaceSubjectHash(plain)).resolves.toBeUndefined();
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});
});
