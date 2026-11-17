import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKTREE_RETENTION_MS } from "../../../src/subagents/run-record.js";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";

describe("E2E deterministic: worktree lifecycle", () => {
	it("an expired run's worktree survives an active external follow-up, then becomes reclaimable", async () => {
		// Regression: d2fadfd reclaimed a merged checkout by the old run's age while a resumed
		// CLI still used it. A16 has no external continuation or GC window, so cannot catch this.
		// Admission: +1 deterministic case. The socket handshake controls the CLI's lifetime;
		// provider holds wait for the real producer -> manager -> durable wake path to settle.
		// Mutation checks verified (2026-11-17): omit follow-up lease admission OR bypass cleanup's
		// lease exclusion. Each independently fails on ENOENT for feature.txt after collectGarbage.
		const server = createServer();
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const port = (server.address() as { port: number }).port;
		const connected = new Promise<Socket>((resolve) => server.once("connection", resolve));
		let harness: DeterministicHarness | undefined;
		let socket: Socket | undefined;
		const holds: Array<{ release(): void }> = [];
		try {
			harness = await createDeterministicHarness({
				services: true,
				seed: ({ homeDir, deskDir }) => {
					const repo = join(deskDir, "repo");
					mkdirSync(repo);
					const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
					git("init", "-q");
					git("config", "user.name", "E2E");
					git("config", "user.email", "e2e@example.com");
					writeFileSync(join(repo, "base.txt"), "base\n");
					git("add", ".");
					git("commit", "-qm", "base");
					const cli = join(homeDir, "fake-codex.mjs");
					writeFileSync(
						cli,
						`
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
const emit = (record) => console.log(JSON.stringify(record));
emit({type: "thread.started", thread_id: "worktree-thread"});
function finish() {
  if (readFileSync("feature.txt", "utf8") !== "feature\\n") process.exit(2);
  emit({type: "item.completed", item: {type: "agent_message", text: "work complete"}});
  emit({type: "turn.completed", usage: {input_tokens: 1, output_tokens: 1}});
}
if (process.argv.includes("resume")) {
  const socket = connect(${port}, "127.0.0.1");
  socket.on("data", () => { finish(); socket.end(); });
} else {
  writeFileSync("feature.txt", "feature\\n");
  execFileSync("git", ["add", "feature.txt"]);
  execFileSync("git", ["commit", "-qm", "feature"]);
  finish();
}
`,
					);
					const roles = join(deskDir, "..", "sub-agents");
					mkdirSync(roles, { recursive: true });
					writeFileSync(
						join(roles, "builder.md"),
						`---\nname: builder\ndescription: controlled worktree builder\nruntime: external\nharness: codex-cli\nmutates: write\ncommand: ${process.execPath} ${cli}\n---\nBuild the requested change.\n`,
					);
				},
			});
			const h = harness;
			const manager = h.runtime.runs.get(h.desk);
			h.model.script.route({
				name: "wake",
				when: (r) => r.isMainTurn && r.lastUserText.includes("[SUBAGENT:"),
				respond: [reply.text("[SILENT]")],
				repeat: true,
			});
			h.model.script.route({
				name: "build",
				when: (r) => r.isMainTurn && r.lastUserText.includes("BUILD_WORKTREE"),
				respond: [
					reply.toolCall("subagent", {
						agent: "builder",
						task: "Commit feature.txt",
						workingDirectory: join(h.deskDir, "repo"),
						worktree: true,
					}),
					reply.text("[SILENT]"),
				],
			});
			const built = h.model.script.hold({ when: (r) => r.isMainTurn && r.lastUserText.includes("[SUBAGENT:") });
			holds.push(built);
			await h.sendUserMessage("BUILD_WORKTREE");
			await built.arrived;
			built.release();
			await h.waitForIdle();
			const original = manager.list().find((record) => record.agent === "builder")!;
			expect(original).toMatchObject({
				status: "completed",
				sessionId: "worktree-thread",
				worktree: { cleaned: false },
			});
			expect(original.settledAt).toBeDefined();
			const wt = original.worktree!;
			execFileSync("git", ["merge", "--ff-only", wt.branch!], { cwd: join(h.deskDir, "repo"), stdio: "pipe" });
			h.model.script.route({
				name: "continue",
				when: (r) => r.isMainTurn && r.lastUserText.includes("CONTINUE_WORKTREE"),
				respond: [
					reply.toolCall("subagent_run", {
						op: "follow_up",
						runId: original.runId,
						task: "Verify the merged files",
					}),
					reply.text("[SILENT]"),
				],
			});
			await h.sendUserMessage("CONTINUE_WORKTREE");
			socket = await connected;
			const resumed = manager.list().find((record) => record.runId !== original.runId)!;
			expect(resumed).toMatchObject({ status: "running", workingDirectory: wt.path });
			await manager.collectGarbage(original.settledAt! + WORKTREE_RETENTION_MS + 1);
			expect(readFileSync(join(wt.path, "feature.txt"), "utf-8")).toBe("feature\n");
			expect(original.worktree?.cleaned).toBe(false);
			expect(original.worktreeRetainWarned).not.toBe(true);
			const finished = h.model.script.hold({
				when: (r) => r.isMainTurn && r.lastUserText.includes(`[SUBAGENT:${resumed.runId}]`),
			});
			holds.push(finished);
			socket.write("release");
			await finished.arrived;
			finished.release();
			await h.waitForIdle();
			expect(resumed).toMatchObject({ status: "completed", leaseKey: undefined });
			expect(resumed.settledAt).toBeDefined();
			await manager.collectGarbage(Date.now() + WORKTREE_RETENTION_MS + 1_000);
			expect(existsSync(wt.path)).toBe(false);
			expect(original.worktree?.cleaned).toBe(true);
			expect(existsSync(join(resumed.artifactDir, ".worktree.json"))).toBe(false);
		} finally {
			for (const hold of holds) hold.release();
			socket?.destroy();
			if (harness) await harness.shutdown();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
