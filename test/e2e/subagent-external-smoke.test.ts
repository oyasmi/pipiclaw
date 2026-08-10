import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SECURITY_CONFIG } from "../../src/security/config.js";
import { launchExternalRun } from "../../src/subagents/external/run.js";
import { configureSubAgentRuntime, getSubAgentRunManager, type RunHarness } from "../../src/subagents/runs.js";
import { useTempDirs } from "../helpers/fixtures.js";

/**
 * Spec 042, D12: a real, non-mocked smoke test against the actual `claude`/`codex` CLIs on this
 * machine — every other harness test drives `parseOutcome` with hand-written fixtures, which only
 * proves the code agrees with itself, not with the real CLI's current output schema. This is the
 * one place that gap is closed, and it is opt-in on purpose: it needs the target CLI installed and
 * already authenticated, which no CI box can assume. Never part of `npm run test` or `npm run
 * check` — only `npm run test:e2e` with `PIPICLAW_E2E_HARNESS` set runs it.
 *
 * Not a gate: a failure here means "the adapter has likely drifted from the CLI's current
 * protocol", worth investigating, not necessarily a regression in this commit.
 */

const REQUESTED_HARNESSES = (process.env.PIPICLAW_E2E_HARNESS ?? "")
	.split(",")
	.map((value) => value.trim())
	.filter((value): value is RunHarness => value === "claude-code" || value === "codex-cli");

const createTempWorkspace = useTempDirs("pipiclaw-subagent-e2e-smoke-");

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const tick = () => {
			if (predicate()) return resolve();
			if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
			setTimeout(tick, 250);
		};
		tick();
	});
}

const HARNESS_COMMAND: Record<RunHarness, string> = {
	"claude-code": "claude -p --dangerously-skip-permissions",
	"codex-cli": "codex exec --sandbox read-only --skip-git-repo-check",
	exec: "true", // never requested via PIPICLAW_E2E_HARNESS; exec has no protocol to drift.
};

const describeSmoke = REQUESTED_HARNESSES.length > 0 ? describe : describe.skip;

describeSmoke("external harness smoke (spec 042, D12, opt-in via PIPICLAW_E2E_HARNESS)", () => {
	it.each(REQUESTED_HARNESSES.map((harness) => [harness] as const))(
		"%s: a minimal real dispatch completes with non-empty output",
		async (harness) => {
			const workspaceDir = createTempWorkspace();
			const channelId = `dm_e2e_smoke_${harness}`;
			const artifactDir = join(workspaceDir, channelId, "subagent-artifacts", `run-smoke-${harness}`);
			mkdirSync(artifactDir, { recursive: true });
			configureSubAgentRuntime({});

			const result = await launchExternalRun({
				runId: `run-smoke-${harness}`,
				channelId,
				label: "e2e smoke",
				agent: "smoke",
				source: "inline",
				harness,
				command: HARNESS_COMMAND[harness],
				maxWallTimeSec: 60,
				systemPrompt: "You are a smoke-test agent.",
				task: 'Reply with exactly the word "OK" and nothing else.',
				workingDirectory: workspaceDir,
				artifactDir,
				purpose: "work",
				workspaceDir,
				securityConfig: DEFAULT_SECURITY_CONFIG,
			});
			expect(result.ok).toBe(true);

			const manager = getSubAgentRunManager(channelId);
			await waitFor(() => manager.get(`run-smoke-${harness}`)?.status !== "running", 55_000);

			const record = manager.get(`run-smoke-${harness}`);
			// A failure here is a real, actionable signal (CLI missing, not logged in, or the
			// adapter's protocol assumptions drifted) — not asserted away, on purpose.
			expect(record?.status, record?.failureReason ?? "no failure reason recorded").toBe("completed");
			expect(record?.usage.total ?? 0, "expected some usage to be reported").toBeGreaterThan(0);
		},
		60_000,
	);
});
