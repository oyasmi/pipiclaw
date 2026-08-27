import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	isTransientUntrackedPath,
	workspaceSubjectHash,
	workspaceSubjectSnapshot,
} from "../src/tasks/artifact-subject.js";

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

	it("changes when a tracked file is edited — unstaged or staged", async () => {
		const before = await workspaceSubjectHash(dir);
		writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
		const unstaged = await workspaceSubjectHash(dir);
		expect(unstaged).not.toBe(before);

		git("add", "a.txt");
		const staged = await workspaceSubjectHash(dir);
		expect(staged).not.toBe(unstaged);
	});

	// Spec 040, D9: `git status --porcelain` only reports an untracked file's path and status —
	// two different untracked files with the same name are indistinguishable to it. Before this
	// fix, an external verifier that edited an already-untracked file's *content* (or reverted it
	// after inspection) left the hash unchanged, so the attestation would not detect the change.
	it("changes when untracked files appear or change content, not just in presence", async () => {
		const before = await workspaceSubjectHash(dir);
		writeFileSync(join(dir, "b.txt"), "new file\n");
		const afterNewFile = await workspaceSubjectHash(dir);
		expect(afterNewFile).not.toBe(before);

		writeFileSync(join(dir, "b.txt"), "tampered\n");
		const afterEdit = await workspaceSubjectHash(dir);
		expect(afterEdit).not.toBe(afterNewFile);
	});

	it("changes across commits even with an otherwise-clean tree", async () => {
		const before = await workspaceSubjectHash(dir);
		writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
		git("commit", "-a", "-q", "-m", "second commit");
		const after = await workspaceSubjectHash(dir);
		expect(after).not.toBe(before);
	});

	it("keeps a base-relative subject stable when the already-verified diff is committed", async () => {
		writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
		writeFileSync(join(dir, "new-product.ts"), "export const product = true;\n");
		const snapshot = await workspaceSubjectSnapshot(dir);
		expect(snapshot).toBeDefined();
		if (!snapshot) return;

		git("add", "a.txt");
		git("add", "new-product.ts");
		git("commit", "-q", "-m", "verified content");
		const afterCommit = await workspaceSubjectHash(dir, {
			baseCommit: snapshot.baseCommit,
			baselineUntrackedPaths: snapshot.baselineUntrackedPaths,
		});
		expect(afterCommit).toBe(snapshot.hash);

		writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
		const afterRealChange = await workspaceSubjectHash(dir, {
			baseCommit: snapshot.baseCommit,
			baselineUntrackedPaths: snapshot.baselineUntrackedPaths,
		});
		expect(afterRealChange).not.toBe(snapshot.hash);
	});

	it("ignores only newly-created named test/build artifact paths, while protecting product untracked files", async () => {
		const snapshot = await workspaceSubjectSnapshot(dir);
		expect(snapshot).toBeDefined();
		if (!snapshot) return;

		mkdirSync(join(dir, "coverage"), { recursive: true });
		writeFileSync(join(dir, "coverage", "lcov.info"), "test output\n");
		const afterCoverage = await workspaceSubjectHash(dir, {
			baseCommit: snapshot.baseCommit,
			baselineUntrackedPaths: snapshot.baselineUntrackedPaths,
		});
		expect(afterCoverage).toBe(snapshot.hash);

		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "src", "new-product.ts"), "export const product = true;\n");
		const afterNewSource = await workspaceSubjectHash(dir, {
			baseCommit: snapshot.baseCommit,
			baselineUntrackedPaths: snapshot.baselineUntrackedPaths,
		});
		expect(afterNewSource).not.toBe(snapshot.hash);

		writeFileSync(join(dir, "existing-product.ts"), "before\n");
		const withExistingProduct = await workspaceSubjectSnapshot(dir);
		expect(withExistingProduct).toBeDefined();
		if (!withExistingProduct) return;
		writeFileSync(join(dir, "existing-product.ts"), "tampered\n");
		const afterExistingProductChange = await workspaceSubjectHash(dir, {
			baseCommit: withExistingProduct.baseCommit,
			baselineUntrackedPaths: withExistingProduct.baselineUntrackedPaths,
		});
		expect(afterExistingProductChange).not.toBe(withExistingProduct.hash);
	});

	it("preserves leading and trailing spaces in NUL-separated untracked paths", async () => {
		const spacedPath = " leading and trailing.txt ";
		writeFileSync(join(dir, spacedPath), "before\n");
		const snapshot = await workspaceSubjectSnapshot(dir);
		expect(snapshot?.baselineUntrackedPaths).toContain(spacedPath);
		if (!snapshot) return;

		writeFileSync(join(dir, spacedPath), "after\n");
		const after = await workspaceSubjectHash(dir, {
			baseCommit: snapshot.baseCommit,
			baselineUntrackedPaths: snapshot.baselineUntrackedPaths,
		});
		expect(after).not.toBe(snapshot.hash);
	});

	it("records regular-file versus symlink identity without following an outside target", async () => {
		const outsideDir = mkdtempSync(join(tmpdir(), "artifact-subject-outside-"));
		const outsideTarget = join(outsideDir, "target.txt");
		const subjectPath = join(dir, "product-artifact.txt");
		try {
			writeFileSync(outsideTarget, "same content\n");
			writeFileSync(subjectPath, "same content\n");
			const snapshot = await workspaceSubjectSnapshot(dir);
			expect(snapshot).toBeDefined();
			if (!snapshot) return;

			unlinkSync(subjectPath);
			symlinkSync(outsideTarget, subjectPath);
			const symlinkHash = await workspaceSubjectHash(dir, {
				baseCommit: snapshot.baseCommit,
				baselineUntrackedPaths: snapshot.baselineUntrackedPaths,
			});
			expect(symlinkHash).not.toBe(snapshot.hash);

			writeFileSync(outsideTarget, "changed outside checkout\n");
			const afterOutsideChange = await workspaceSubjectHash(dir, {
				baseCommit: snapshot.baseCommit,
				baselineUntrackedPaths: snapshot.baselineUntrackedPaths,
			});
			expect(afterOutsideChange).toBe(symlinkHash);

			unlinkSync(subjectPath);
			writeFileSync(subjectPath, "same content\n");
			const regularAgain = await workspaceSubjectHash(dir, {
				baseCommit: snapshot.baseCommit,
				baselineUntrackedPaths: snapshot.baselineUntrackedPaths,
			});
			expect(regularAgain).not.toBe(symlinkHash);
		} finally {
			rmSync(outsideDir, { recursive: true, force: true });
		}
	});

	it("protects ignored non-transient product files while excluding only ignored transient outputs", async () => {
		writeFileSync(join(dir, ".gitignore"), "ignored-*.txt\ncoverage/\n");
		git("add", ".gitignore");
		git("commit", "-q", "-m", "ignore generated paths");
		writeFileSync(join(dir, "ignored-product.txt"), "before\n");

		const snapshot = await workspaceSubjectSnapshot(dir);
		expect(snapshot?.baselineUntrackedPaths).toContain("ignored-product.txt");
		if (!snapshot) return;

		mkdirSync(join(dir, "coverage"), { recursive: true });
		writeFileSync(join(dir, "coverage", "lcov.info"), "generated\n");
		const afterTransient = await workspaceSubjectHash(dir, {
			baseCommit: snapshot.baseCommit,
			baselineUntrackedPaths: snapshot.baselineUntrackedPaths,
		});
		expect(afterTransient).toBe(snapshot.hash);

		writeFileSync(join(dir, "ignored-new.txt"), "new product\n");
		const afterIgnoredProduct = await workspaceSubjectHash(dir, {
			baseCommit: snapshot.baseCommit,
			baselineUntrackedPaths: snapshot.baselineUntrackedPaths,
		});
		expect(afterIgnoredProduct).not.toBe(snapshot.hash);

		writeFileSync(join(dir, "ignored-product.txt"), "tampered\n");
		const afterExistingIgnoredChange = await workspaceSubjectHash(dir, {
			baseCommit: snapshot.baseCommit,
			baselineUntrackedPaths: snapshot.baselineUntrackedPaths,
		});
		expect(afterExistingIgnoredChange).not.toBe(afterIgnoredProduct);
	});

	it("recognizes only the documented transient artifact scope", () => {
		expect(isTransientUntrackedPath("coverage/lcov.info")).toBe(true);
		expect(isTransientUntrackedPath("coverage/")).toBe(true);
		expect(isTransientUntrackedPath(".run/test.json")).toBe(true);
		expect(isTransientUntrackedPath("cypress/screenshots/spec.png")).toBe(true);
		expect(isTransientUntrackedPath("cypress/videos/spec.mp4")).toBe(true);
		expect(isTransientUntrackedPath("cypress/e2e/new-product.cy.ts")).toBe(false);
		expect(isTransientUntrackedPath("cypress/fixtures/product.json")).toBe(false);
		expect(isTransientUntrackedPath("cypress/downloads/product.json")).toBe(false);
		expect(isTransientUntrackedPath("src/new-product.ts")).toBe(false);
		expect(isTransientUntrackedPath("src/coverage/generated.js")).toBe(false);
		expect(isTransientUntrackedPath("src/.eslintcache")).toBe(false);
		expect(isTransientUntrackedPath("product/coverage-policy.ts")).toBe(false);
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
