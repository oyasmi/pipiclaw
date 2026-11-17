import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireWorkspaceLease, releaseWorkspaceLease } from "../../../src/subagents/workspace-lease.js";
import { SUBAGENT_TOOL_NAMES } from "../../../src/tools/contract/names.js";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";

describe("E2E deterministic: internal sub-agent chain", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		await harness.shutdown();
	});

	it("A16: an internal write-delegation settles its run record, honors leaseOwnerRunId, and supports isolated worktree=true", async () => {
		// Mutation checks:
		// 1. Skip settleRun's lease release -> the second non-worktree write delegation fails with lease conflict.
		// 2. Omit `leaseOwnerRunId` in `internal/worker.ts` -> the child's own `write` tool call fails against its
		//    own exclusive checkout lease and `child-out.txt` is never written.
		// 3. Omit `worktree: true` isolation in `dispatch.ts` -> `A16_WORKTREE` collides with the active lease on `repoDir`.
		harness = await createDeterministicHarness({ services: true });
		const deskDir = join(harness.workspaceDir, `desk-${harness.desk}`);
		const repoDir = join(deskDir, "repo");
		mkdirSync(repoDir, { recursive: true });
		execFileSync("git", ["init"], { cwd: repoDir });
		execFileSync("git", ["config", "user.email", "e2e@example.com"], { cwd: repoDir });
		execFileSync("git", ["config", "user.name", "E2E"], { cwd: repoDir });
		writeFileSync(join(repoDir, "README.md"), "init\n", "utf-8");
		execFileSync("git", ["add", "README.md"], { cwd: repoDir });
		execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });

		const registerChild = (marker: string) =>
			harness.model.script.route({
				name: `child-${marker}`,
				when: (r) => r.systemPrompt.includes(`E2E_A16_HELPER for ${marker}.`),
				respond: [
					reply.toolCall("write", { path: "child-out.txt", content: `from-${marker}\n` }),
					reply.text("child ok"),
				],
			});
		const delegate = (marker: string, extra: Record<string, unknown> = {}) => {
			registerChild(marker);
			return {
				name: `parent-${marker}`,
				when: (r: { isMainTurn: boolean; lastUserText: string; systemPrompt: string }) =>
					r.isMainTurn && r.systemPrompt.includes("## Pipiclaw") && r.lastUserText.includes(marker),
				respond: [
					reply.toolCall("subagent_inline", {
						task: `Do work for ${marker}.`,
						systemPrompt: `E2E_A16_HELPER for ${marker}.`,
						mutates: "write",
						tools: [...SUBAGENT_TOOL_NAMES],
						...extra,
					}),
					reply.text(`${marker} done`),
				],
			};
		};
		harness.model.script.route(delegate("A16_FIRST"));
		harness.model.script.route(delegate("A16_SECOND"));
		harness.model.script.route(delegate("A16_WORKTREE", { workingDirectory: repoDir, worktree: true }));

		await harness.sendUserMessage("A16_FIRST run");
		expect(existsSync(join(deskDir, "child-out.txt"))).toBe(true);
		// A21 shares this exact delegation path: inspect the child's actual provider request,
		// rather than starting a second runtime just to check the same child's capabilities.
		// Exercise the widest supported role, not just the default subset.
		// Mutation check: injecting job at the worker's final SDK tool assignment fails here.
		const child = harness.model.requests.find((request) => request.matchedRoute === "child-A16_FIRST");
		expect(child?.tools).toContain("read");
		for (const forbidden of ["send_media", "job", "subagent", "subagent_inline"]) {
			expect(child!.tools, `child must not have ${forbidden}`).not.toContain(forbidden);
		}

		// Run record persisted and marked settled.
		const runsDir = join(harness.homeDir, "state", "subagent-runs", harness.desk);
		const records = readdirSync(runsDir).filter((f) => f.endsWith(".json"));
		expect(records.length).toBeGreaterThan(0);
		const record = JSON.parse(readFileSync(join(runsDir, records[0]), "utf-8"));
		expect(record.status).toBe("completed");
		expect(record.settledAt ?? record.finishedAt).toBeDefined();

		// The exclusive workspace write lease was released — a second write delegation runs.
		await harness.sendUserMessage("A16_SECOND run");
		expect(readFileSync(join(deskDir, "child-out.txt"), "utf-8")).toBe("from-A16_SECOND\n");

		// While `repoDir` holds an exclusive write lease, `worktree: true` runs in `.git/pipiclaw-worktrees/<runId>`
		// without touching the main checkout and persists structured worktree metadata on the settled RunRecord.
		const held = acquireWorkspaceLease({
			runId: "run_hold_repo",
			channelId: "dingtalk:dm:other",
			workingDirectory: repoDir,
		});
		expect(held.ok).toBe(true);
		try {
			await harness.sendUserMessage("A16_WORKTREE run");
		} finally {
			if (held.ok) releaseWorkspaceLease(held.leaseKey, "run_hold_repo");
		}
		expect(existsSync(join(repoDir, "child-out.txt"))).toBe(false);
		const allRecords = readdirSync(runsDir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => JSON.parse(readFileSync(join(runsDir, f), "utf-8")));
		const wtRecord = allRecords.find((entry) => entry.worktree !== undefined);
		expect(wtRecord?.worktree).toMatchObject({
			branch: `pipiclaw/${wtRecord?.runId}`,
			changedFiles: ["child-out.txt"],
			dirty: true,
			cleaned: false,
		});
		expect(existsSync(join(repoDir, ".git", "pipiclaw-worktrees", wtRecord.runId, "child-out.txt"))).toBe(true);
	});
});
