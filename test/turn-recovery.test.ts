import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	planTurnRecovery,
	recoverInterruptedTurn,
	scanWorkspaceForInterruptedTurns,
} from "../src/agent/turn-recovery.js";
import { useTempDirs } from "./helpers/fixtures.js";

const makeTempDir = useTempDirs("pipiclaw-turn-recovery-");

const fallbackModel = { api: "anthropic-messages" as const, provider: "anthropic" as const, model: "fallback" };

function openSession(): SessionManager {
	const dir = makeTempDir();
	return SessionManager.open(join(dir, "context.jsonl"), dir);
}

function appendUser(manager: SessionManager, text = "hi"): void {
	manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
}

function appendAssistant(
	manager: SessionManager,
	content: Array<{ type: "text"; text: string } | { type: "toolCall"; id: string; name: string; arguments: object }>,
	stopReason: "stop" | "toolUse" = "stop",
): void {
	manager.appendMessage({
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	});
}

function appendToolResult(manager: SessionManager, toolCallId: string, toolName = "bash"): void {
	manager.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: Date.now(),
	});
}

describe("planTurnRecovery", () => {
	it("three parallel tool calls, first two fulfilled, third missing: repairs only the third", () => {
		const m = openSession();
		appendUser(m);
		appendAssistant(
			m,
			[
				{ type: "toolCall", id: "tc1", name: "bash", arguments: {} },
				{ type: "toolCall", id: "tc2", name: "read", arguments: {} },
				{ type: "toolCall", id: "tc3", name: "write", arguments: {} },
			],
			"toolUse",
		);
		appendToolResult(m, "tc1", "bash");
		appendToolResult(m, "tc2", "read");
		const plan = planTurnRecovery(m.getBranch());
		expect(plan.kind).toBe("append-tool-results");
		if (plan.kind !== "append-tool-results") throw new Error("unreachable");
		expect(plan.calls.map((c) => c.id)).toEqual(["tc3"]);
		expect(plan.calls[0].name).toBe("write");
	});

	it("blocks repair for ambiguous branches instead of guessing", () => {
		// Duplicate tool result for the same call.
		const duplicated = openSession();
		appendUser(duplicated);
		appendAssistant(duplicated, [{ type: "toolCall", id: "tc1", name: "bash", arguments: {} }], "toolUse");
		appendToolResult(duplicated, "tc1");
		appendToolResult(duplicated, "tc1");
		expect(planTurnRecovery(duplicated.getBranch()).kind).toBe("blocked");

		// A new user message after a missing tool call is not silently repaired.
		const superseded = openSession();
		appendUser(superseded);
		appendAssistant(superseded, [{ type: "toolCall", id: "tc1", name: "bash", arguments: {} }], "toolUse");
		appendUser(superseded, "actually never mind");
		expect(planTurnRecovery(superseded.getBranch()).kind).toBe("blocked");

		// An unrelated assistant message after a missing tool call is equally ambiguous.
		const derailed = openSession();
		appendUser(derailed);
		appendAssistant(derailed, [{ type: "toolCall", id: "tc1", name: "bash", arguments: {} }], "toolUse");
		appendAssistant(derailed, [{ type: "text", text: "unrelated" }]);
		expect(planTurnRecovery(derailed.getBranch()).kind).toBe("blocked");
	});
});

describe("recoverInterruptedTurn", () => {
	it("clean branch: no messages appended", () => {
		const m = openSession();
		appendUser(m);
		appendAssistant(m, [{ type: "text", text: "done" }]);
		const before = m.getBranch().length;
		const outcome = recoverInterruptedTurn(m, fallbackModel);
		expect(outcome).toEqual({ kind: "clean" });
		expect(m.getBranch().length).toBe(before);
	});

	it("appends a synthetic error tool result for a dangling call, marked isError", () => {
		const m = openSession();
		appendUser(m);
		appendAssistant(m, [{ type: "toolCall", id: "tc1", name: "write", arguments: {} }], "toolUse");
		const outcome = recoverInterruptedTurn(m, fallbackModel);
		expect(outcome).toEqual({ kind: "repaired", appendedToolResults: 1, appendedAbortedAssistant: false });

		const branch = m.getBranch();
		const result = branch.at(-1);
		if (result?.type !== "message" || result.message.role !== "toolResult") throw new Error("unexpected shape");
		expect(result.message.toolCallId).toBe("tc1");
		expect(result.message.isError).toBe(true);
		expect(result.message.usage).toBeUndefined();

		// Running it again is a no-op: idempotent.
		const second = recoverInterruptedTurn(m, fallbackModel);
		expect(second).toEqual({ kind: "clean" });
	});

	// Spec 047, D3.3: the recovery guidance must name the post-split tools, not `subagent_manage`.

	it("appends a runtime-authored aborted assistant when the branch ends on a user message", () => {
		const m = openSession();
		appendUser(m);
		const outcome = recoverInterruptedTurn(m, fallbackModel);
		expect(outcome).toEqual({ kind: "repaired", appendedToolResults: 0, appendedAbortedAssistant: true });

		const branch = m.getBranch();
		const result = branch.at(-1);
		if (result?.type !== "message" || result.message.role !== "assistant") throw new Error("unexpected shape");
		expect(result.message.stopReason).toBe("aborted");
		expect(result.message.usage.totalTokens).toBe(0);

		const second = recoverInterruptedTurn(m, fallbackModel);
		expect(second).toEqual({ kind: "clean" });
	});

	it("copies api/provider/model from the most recent real assistant, using the fallback identity only when none exists", () => {
		const withHistory = openSession();
		appendUser(withHistory);
		appendAssistant(withHistory, [{ type: "text", text: "first reply" }]);
		appendUser(withHistory, "second request");
		recoverInterruptedTurn(withHistory, fallbackModel);

		const last = withHistory.getBranch().at(-1);
		if (last?.type !== "message" || last.message.role !== "assistant") throw new Error("unexpected shape");
		expect(last.message.model).toBe("claude-sonnet-4-5");
		expect(last.message.model).not.toBe(fallbackModel.model);

		const withoutHistory = openSession();
		appendUser(withoutHistory);
		recoverInterruptedTurn(withoutHistory, fallbackModel);

		const fallbackResult = withoutHistory.getBranch().at(-1);
		if (fallbackResult?.type !== "message" || fallbackResult.message.role !== "assistant") {
			throw new Error("unexpected shape");
		}
		expect(fallbackResult.message.model).toBe(fallbackModel.model);
	});

	it("blocked outcome touches nothing", () => {
		const m = openSession();
		appendUser(m);
		appendAssistant(m, [{ type: "toolCall", id: "tc1", name: "bash", arguments: {} }], "toolUse");
		appendUser(m, "changed my mind");
		const before = m.getBranch().length;

		const outcome = recoverInterruptedTurn(m, fallbackModel);
		expect(outcome.kind).toBe("blocked");
		expect(m.getBranch().length).toBe(before);
	});
});

describe("scanWorkspaceForInterruptedTurns", () => {
	it("repairs a dangling tool call in a channel dir and skips non-channel siblings", async () => {
		const workspaceDir = makeTempDir();
		const channelDir = join(workspaceDir, "dm_scan_1");
		mkdirSync(channelDir, { recursive: true });
		mkdirSync(join(workspaceDir, "skills"), { recursive: true });
		mkdirSync(join(workspaceDir, "sub-agents"), { recursive: true });

		const m = SessionManager.open(join(channelDir, "context.jsonl"), channelDir);
		appendUser(m);
		appendAssistant(m, [{ type: "toolCall", id: "tc1", name: "bash", arguments: {} }], "toolUse");

		const report = await scanWorkspaceForInterruptedTurns(workspaceDir, fallbackModel);

		expect(report.scanned).toBe(1);
		expect(report.repaired).toHaveLength(1);
		expect(report.repaired[0].channelDir).toBe(channelDir);
		expect(report.blocked).toHaveLength(0);

		const reopened = SessionManager.open(join(channelDir, "context.jsonl"), channelDir);
		const last = reopened.getBranch().at(-1);
		if (last?.type !== "message" || last.message.role !== "toolResult") throw new Error("unexpected shape");
		expect(last.message.toolCallId).toBe("tc1");
	});

	it("reports a blocked channel without touching other channels", async () => {
		const workspaceDir = makeTempDir();
		const blockedDir = join(workspaceDir, "dm_scan_blocked");
		const cleanDir = join(workspaceDir, "dm_scan_clean");
		mkdirSync(blockedDir, { recursive: true });
		mkdirSync(cleanDir, { recursive: true });

		const blocked = SessionManager.open(join(blockedDir, "context.jsonl"), blockedDir);
		appendUser(blocked);
		appendAssistant(blocked, [{ type: "toolCall", id: "tc1", name: "bash", arguments: {} }], "toolUse");
		appendUser(blocked, "changed my mind");

		const clean = SessionManager.open(join(cleanDir, "context.jsonl"), cleanDir);
		appendUser(clean);
		appendAssistant(clean, [{ type: "text", text: "done" }]);

		const report = await scanWorkspaceForInterruptedTurns(workspaceDir, fallbackModel);

		expect(report.scanned).toBe(2);
		expect(report.repaired).toHaveLength(0);
		expect(report.blocked).toHaveLength(1);
		expect(report.blocked[0].channelDir).toBe(blockedDir);
	});

	it("returns an empty report for a workspace directory that doesn't exist", async () => {
		const report = await scanWorkspaceForInterruptedTurns(join(makeTempDir(), "nope"), fallbackModel);
		expect(report).toEqual({ scanned: 0, repaired: [], blocked: [] });
	});
});
