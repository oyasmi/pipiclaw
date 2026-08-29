import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { parseTaskFrontmatter } from "../../../src/tasks/ledger.js";
import { verificationAttestationPath } from "../../../src/tasks/verification.js";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";
import { waitFor } from "../helpers/wait.js";

function makeGitRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "pipiclaw-e2e-verify-subject-"));
	const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
	git("init", "-q");
	git("config", "user.email", "e2e@example.com");
	git("config", "user.name", "e2e");
	writeFileSync(join(dir, "app.txt"), "shipped feature\n");
	git("add", "-A");
	git("commit", "-qm", "feature");
	return dir;
}

describe("E2E deterministic: verify chain", () => {
	let harness: DeterministicHarness;
	const taskId = "e2e-verify-task";
	afterEach(async () => {
		harness.assertNoUnmatchedRequests();
		await harness.shutdown();
	});

	function verifierRunId(): string {
		const dir = join(harness.homeDir, "state", "subagent-runs", harness.channelId);
		return readdirSync(dir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")))
			.find((r) => r.purpose === "verify").runId;
	}

	it("A14: purpose=verify run → attestation → task_verify imports PASS → task_close completes", async () => {
		// 0.9.1 fixed a deadlock in this chain and it had no full-stack lock. Mutation check:
		// drop the bodyHash comparison in verifyTask and task_verify still passes when the
		// task body is edited after the attestation was written.
		harness = await createDeterministicHarness({ subagentSyncGraceMs: 60 });
		const subjectDir = makeGitRepo();
		const taskPath = join(harness.channelDir, "tasks", `${taskId}.md`);
		const gate = harness.model.script.hold({ when: (r) => r.systemPrompt.includes("E2E_VERIFY_CHILD") });

		harness.model.script.route({
			name: "work-and-dispatch-verifier",
			when: (r) => r.isMainTurn && r.systemPrompt.includes("## Pipiclaw") && r.lastUserText.includes("上线并验收"),
			respond: [
				reply.toolCall("task_create", {
					id: taskId,
					title: "上线一个特性",
					goal: "把特性上线并通过独立验收",
					dod: "- [ ] 特性已上线并通过独立验收",
					verificationRequired: true,
				}),
				// Check the DoD box before dispatching so the verifier attests the checked body.
				reply.toolCall("edit", {
					path: taskPath,
					oldText: "- [ ] 特性已上线并通过独立验收",
					newText: "- [x] 特性已上线并通过独立验收",
				}),
				reply.toolCall("subagent_inline", {
					task: "Independently verify the task DoD.",
					systemPrompt: "You are a verifier. Marker E2E_VERIFY_CHILD.",
					taskId,
					purpose: "verify",
					mutates: "read",
					workingDirectory: subjectDir,
				}),
				reply.text("验收子代理已派发。"),
			],
			repeat: true,
		});
		harness.model.script.route({
			name: "verifier",
			when: (r) => r.systemPrompt.includes("E2E_VERIFY_CHILD"),
			respond: [reply.text("Checked the DoD against the repo. Everything is in place.\nVERDICT: PASS")],
			repeat: true,
		});

		await harness.sendUserMessage("帮我把特性上线并验收");
		gate.release();

		// Verifier settles in the background and writes its attestation.
		await waitFor(
			"verifier attestation",
			() => existsSync(verificationAttestationPath(harness.channelDir, verifierRunId())),
			{ timeoutMs: 15_000, intervalMs: 100 },
		);
		const runId = verifierRunId();
		const attestation = JSON.parse(readFileSync(verificationAttestationPath(harness.channelDir, runId), "utf-8"));
		expect(attestation.taskId).toBe(taskId);
		expect(attestation.verdict).toBe("pass");

		// Import the PASS and close the task.
		harness.model.script.route({
			name: "import-and-close",
			when: (r) => r.isMainTurn && r.systemPrompt.includes("## Pipiclaw") && r.lastUserText.includes("导入验收"),
			respond: [
				reply.toolCall("task_verify", { id: taskId, verifierRunId: runId }),
				reply.toolCall("task_close", {
					id: taskId,
					outcome: "complete",
					summary: "特性已上线并通过独立验收",
					evidence: `verifier run ${runId} PASS`,
				}),
				reply.text("已完成并归档。"),
			],
			repeat: true,
		});
		await harness.sendUserMessage("导入验收结果并关闭任务");

		// The task is completed: the active file is gone, the archived copy records
		// the verification as passed against this exact verifier run.
		expect(existsSync(join(harness.channelDir, "tasks", `${taskId}.md`))).toBe(false);
		const archivedRaw = readFileSync(join(harness.channelDir, "tasks", "archive", `${taskId}.md`), "utf-8");
		expect(archivedRaw).toContain("outcome: completed");
		const done = parseTaskFrontmatter(archivedRaw);
		expect(done.control?.verification.status).toBe("passed");
		expect(done.control?.verification.runId).toBe(runId);
	});
});
