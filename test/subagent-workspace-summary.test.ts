import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { changedPathsSummary, snapshotWorkspace } from "../src/subagents/workspace-summary.js";
import { useTempDirs } from "./helpers/fixtures.js";

const tempDir = useTempDirs("pipiclaw-workspace-summary-");

function gitRepo(): string {
	const dir = tempDir();
	const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
	git("init", "-q");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "Test");
	writeFileSync(join(dir, "a.ts"), "a\n");
	writeFileSync(join(dir, "b.ts"), "b\n");
	git("add", ".");
	git("commit", "-q", "-m", "init");
	return dir;
}

describe("write-run workspace summary", () => {
	it("credits a run only with what it changed, not what was already dirty when it started", async () => {
		const dir = gitRepo();
		// Dirty before the run: the leader's own edit, and an untracked scratch file.
		const shared = join(dir, "a.ts");
		appendFileSync(shared, "leader edit\n");
		utimesSync(shared, 1, 1);
		writeFileSync(join(dir, "scratch.md"), "notes\n");
		const baseline = await snapshotWorkspace(dir);

		// The run: edits a clean file, adds a new one, and touches a file that was already dirty.
		appendFileSync(join(dir, "b.ts"), "run edit\n");
		writeFileSync(join(dir, "new.ts"), "new\n");
		writeFileSync(shared, "a\nworker edit\n"); // Same-length edit needs the mtime to be noticed.
		utimesSync(shared, 2, 2);

		const summary = await changedPathsSummary(dir, baseline);
		expect(summary).toContain("b.ts");
		expect(summary).toContain("new.ts");
		expect(summary).toContain("a.ts");
		expect(summary).not.toContain("scratch.md");
		expect(summary).toContain("1 path(s) already dirty");
	});

	it("reports nothing when the run changed nothing, and says when there is no baseline", async () => {
		const dir = gitRepo();
		appendFileSync(join(dir, "a.ts"), "leader edit\n");
		const baseline = await snapshotWorkspace(dir);
		expect(await changedPathsSummary(dir, baseline)).toBeUndefined();
		expect(await changedPathsSummary(dir)).toContain("no pre-run baseline");
		expect(await snapshotWorkspace(tempDir())).toBeUndefined(); // not a git checkout
		// Spec 067: both optional Git paths must actually terminate a stuck executable.
		const bin = tempDir();
		const marker = join(bin, "terminated");
		const executable = join(bin, "git");
		writeFileSync(
			executable,
			`#!${process.execPath}\nconst fs = require("node:fs");\nprocess.on("SIGTERM", () => { fs.appendFileSync(${JSON.stringify(marker)}, "term\\n"); process.exit(1); });\nsetTimeout(() => process.exit(0), 5000);\n`,
		);
		chmodSync(executable, 0o755);
		vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
		try {
			await expect(Promise.all([snapshotWorkspace(dir), changedPathsSummary(dir)])).resolves.toEqual([
				undefined,
				undefined,
			]);
			expect(readFileSync(marker, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
		} finally {
			vi.unstubAllEnvs();
		}
	});
});
