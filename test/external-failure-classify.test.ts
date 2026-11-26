import { describe, expect, it } from "vitest";
import { classifyExternalFailure } from "../src/subagents/external/failure-classify.js";
import type { ExternalOutcome } from "../src/subagents/external/harness.js";
import { getExternalHarness } from "../src/subagents/external/registry.js";
import { buildExternalSettleInput } from "../src/subagents/external/settlement.js";
import { assertSubAgentInvariants, checkSubAgentInvariants } from "../src/subagents/invariants.js";
import type { RunHarness, RunRecord } from "../src/subagents/run-record.js";
import { createEmptyUsageTotals } from "../src/usage/totals.js";

const refusal: ExternalOutcome = {
	finalText: "",
	terminalSeen: true,
	protocolStatus: "failed",
	errorMessage: "HTTP 429: too many requests",
	exitCode: 1,
	observedExecutionActivity: false,
	usageKnown: false,
	costKnown: false,
};

describe("spec 073 external failures", () => {
	it("prefers durable blockers to rate limits and classifies protocol drift before transient errors", () => {
		const evidence = {
			protocolStatus: "failed",
			requiresProtocolTerminal: true,
			stderrTail: "429 rate_limit",
		} as const;
		expect(classifyExternalFailure({ ...evidence, errorMessage: "usage_limit_reached" })).toBe("quota_exceeded");
		expect(classifyExternalFailure({ ...evidence, errorMessage: "HTTP 403; usage limit exhausted" })).toBe(
			"auth_required",
		);
		expect(classifyExternalFailure({ ...evidence, resumeMismatch: true, authRefused: true })).toBe("resume_rejected");
		expect(classifyExternalFailure({ ...evidence, errorMessage: "provider.no-route" })).toBe("invalid_model");
		expect(classifyExternalFailure({ ...evidence, protocolStatus: "absent", exitCode: 0 })).toBe("schema_drift");
		expect(classifyExternalFailure({ ...evidence, protocolStatus: "unparsable" })).toBe("schema_drift");
		expect(classifyExternalFailure(evidence)).toBe("transient_upstream");

		// Real answer text can quote login, quota or resume errors. Only diagnostics classify a failure.
		const settled = buildExternalSettleInput({
			harnessId: "codex-cli",
			durationMs: 1,
			outcome: {
				...refusal,
				finalText: "Example errors: not logged in, quota, invalid session",
				errorMessage: "internal error",
			},
		});
		expect(settled.failureKind).toBe("runtime_error");
	});

	it("proves a pre-execution failure only with structured evidence and zero usage", () => {
		const settle = (
			outcome: ExternalOutcome,
			harnessId: RunHarness = "claude-code",
			terminationReason?: "timeout" | "cancelled",
		) => buildExternalSettleInput({ harnessId, outcome, terminationReason, durationMs: 1, maxWallTimeSec: 2 });
		expect(settle(refusal)).toMatchObject({ failureKind: "transient_upstream", failurePreExecution: true });
		expect(
			settle({ ...refusal, costKnown: true, usage: { cost: createEmptyUsageTotals().cost } }).failurePreExecution,
		).toBe(true);
		for (const outcome of [
			{ ...refusal, observedExecutionActivity: undefined },
			{ ...refusal, observedExecutionActivity: true, preExecution: true },
			{ ...refusal, observedNonZeroUsage: true },
			{ ...refusal, usage: { input: 1 } },
			{ ...refusal, usage: { cacheRead: 1 } },
			{ ...refusal, costKnown: true, usage: { cost: { ...createEmptyUsageTotals().cost, total: 0.01 } } },
		])
			expect(settle(outcome).failurePreExecution).toBe(false);
		expect(settle(refusal, "exec").failurePreExecution).toBe(false);
		expect(settle(refusal, "claude-code", "timeout")).toMatchObject({
			status: "failed",
			failureKind: "timeout",
			failurePreExecution: false,
		});
		const cancelled = settle(refusal, "claude-code", "cancelled");
		expect(cancelled.status).toBe("cancelled");
		expect(cancelled.failureKind).toBeUndefined();
		expect(cancelled.failurePreExecution).toBeUndefined();
	});

	it("classifies refusal frames from all four CLIs while requiring an intact stream without tool activity", () => {
		const streams = {
			"claude-code": (message: string) => ({ type: "result", is_error: true, errors: [message] }),
			"codex-cli": (message: string) => ({ type: "turn.failed", error: { message } }),
			"cursor-cli": (message: string) => ({ type: "result", is_error: true, result: message }),
			"antigravity-cli": (message: string) => ({ event: "result", result: { status: "ERROR", error: message } }),
		} satisfies Partial<Record<RunHarness, (message: string) => object>>;
		const toolFrames = {
			"claude-code": { type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } },
			"codex-cli": { type: "item.started", item: { type: "command_execution", command: "npm test" } },
			"cursor-cli": { type: "tool_call", subtype: "started" },
			"antigravity-cli": { event: "step_update", step_update: { step_type: "tool" } },
		};
		for (const id of Object.keys(streams) as Array<keyof typeof streams>) {
			const harness = getExternalHarness(id)!;
			const failures = [
				["Not logged in. Please sign in.", "auth_required"],
				["429: weekly limit reached", "quota_exceeded"],
				["429: too many requests", "transient_upstream"],
				["No conversation found with session ID: bad-id", "resume_rejected"],
			] as const;
			for (const [message, failureKind] of failures) {
				const eventsText = JSON.stringify(streams[id](message));
				const outcome = harness.parseOutcome({ eventsText, exitCode: 1 });
				expect(buildExternalSettleInput({ harnessId: id, outcome, durationMs: 1 }), id).toMatchObject({
					failureKind,
					failurePreExecution: true,
				});
			}
			for (const earlier of ["{torn}", '{"unrecognized":true}', JSON.stringify(toolFrames[id])]) {
				const outcome = harness.parseOutcome({
					eventsText: `${earlier}\n${JSON.stringify(streams[id]("HTTP 429"))}`,
					exitCode: 1,
				});
				expect(buildExternalSettleInput({ harnessId: id, outcome, durationMs: 1 }), id).toMatchObject({
					failureKind: "transient_upstream",
					failurePreExecution: false,
				});
			}
			const withoutStream = harness.parseOutcome({ eventsText: "", stderrTail: "HTTP 429", exitCode: 1 });
			expect(buildExternalSettleInput({ harnessId: id, outcome: withoutStream, durationMs: 1 }), id).toMatchObject({
				failureKind: "transient_upstream",
				failurePreExecution: false,
			});
		}
	});
});

it("detects violated settlement and lease invariants without confusing isolated worktrees or ordinary readers", () => {
	const running: RunRecord = {
		runId: "run_active",
		channelId: "test",
		runtime: "external",
		agent: "agent",
		label: "label",
		source: "predefined",
		tools: [],
		purpose: "work",
		workingDirectory: "/repo",
		artifactDir: "/artifacts/run_active",
		status: "running",
		startedAt: 1,
		usage: createEmptyUsageTotals(),
		usageKnown: true,
		costKnown: false,
	};
	const complete: RunRecord = { ...running, runId: "run_done", status: "completed", settledAt: 2, finishedAt: 2 };
	const clean = {
		records: [running, complete],
		activeLeases: [{ runId: running.runId, leaseKey: "/repo", mode: "write" }],
	} as const;
	assertSubAgentInvariants(clean);

	const badRun = { ...running, settledAt: 3 };
	const broken = {
		...complete,
		settledAt: undefined,
		wakeEnqueued: true,
		failureKind: "timeout",
		failurePreExecution: true,
	} as const;
	const adjacent = { ...running, runId: "run_read" };
	const isolated = { ...running, runId: "run_isolated" };
	const ordinary = { ...running, runId: "run_use" };
	const violations = checkSubAgentInvariants({
		records: [badRun, broken, adjacent, isolated, ordinary],
		activeLeases: [
			...clean.activeLeases,
			{ runId: "run_done", leaseKey: "/repo", mode: "read" },
			{ runId: "run_read", leaseKey: "/repo/src", mode: "read" },
			{ runId: "run_isolated", leaseKey: "/repo/.git/pipiclaw-worktrees/another", mode: "write" },
			{ runId: "run_use", leaseKey: "/repo", mode: "use" },
		],
		diskRecords: new Map([running, broken, adjacent, isolated, ordinary].map((record) => [record.runId, record])),
	});
	expect(violations.map(({ invariant }) => invariant).sort()).toEqual([
		"INV-1",
		"INV-2",
		"INV-3",
		"INV-4",
		"INV-4",
		"INV-5",
		"INV-6",
	]);
	expect(violations.filter(({ invariant }) => invariant === "INV-4").map(({ runId }) => runId)).toEqual([
		"run_done",
		"run_read",
	]);
});
