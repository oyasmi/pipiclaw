import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionRetryAttempt } from "../src/agent/session/session-adapter.js";

const error: AssistantMessage = {
	role: "assistant",
	content: [],
	api: "openai-completions",
	provider: "fixture",
	model: "fixture",
	stopReason: "error",
	errorMessage: "429",
	timestamp: 1,
	usage: {
		input: 10,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 10,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};
let directory: string;
afterEach(() => {
	vi.restoreAllMocks();
	if (directory) rmSync(directory, { recursive: true, force: true });
});
function setup() {
	directory = mkdtempSync(join(tmpdir(), "session-retry-"));
	const manager = SessionManager.open(join(directory, "session.jsonl"));
	manager.appendMessage({ role: "user", content: "same input", timestamp: 1 });
	manager.appendMessage({ ...error, stopReason: "stop", content: [{ type: "text", text: "old answer" }] });
	const session = { sessionManager: manager, refreshContext: vi.fn() };
	return { session, manager, attempt: new SessionRetryAttempt(session) };
}

describe("persistent retry admission", () => {
	it("rejects raw side effects even when omitted, and additional input or changed branches", () => {
		// An implementation inspecting only projection would rerun already executed tools.
		const { manager, attempt } = setup();
		const origin = manager.getLeafId()!;
		manager.appendMessage({ role: "user", content: "same input", timestamp: 1 });
		const tool = manager.appendMessage({
			...error,
			content: [{ type: "toolCall", id: "t", name: "write", arguments: {} }],
		});
		manager.appendContextEdit(tool, null);
		expect(attempt.classify()).toBeNull();
		manager.branch(origin);
		manager.appendMessage({ role: "user", content: "same input", timestamp: 1 });
		manager.appendMessage(error);
		manager.appendMessage({ role: "user", content: "steer", timestamp: 1 });
		expect(attempt.classify()).toBeNull();
		manager.branch(origin);
		manager.appendMessage({ role: "user", content: "same input", timestamp: 1 });
		manager.appendMessage(error);
		expect(attempt.prepare()?.kind).toBe("failed-turn");
		manager.branch(origin); // Rewinding to the pre-prompt leaf must not become "unsubmitted".
		expect(attempt.classify()).toBeNull();
		manager.branch(manager.getBranch()[0]!.id);
		expect(attempt.classify()).toBeNull();
	});

	it("omits only this attempt by ID, is idempotent, and survives reopening without deleting raw usage", () => {
		const { manager, attempt } = setup();
		const user = manager.appendMessage({ role: "user", content: "same input", timestamp: 1 });
		const failed = manager.appendMessage(error);
		expect(attempt.omitFailedContext()).toBe(true);
		expect(attempt.omitFailedContext()).toBe(true);
		const reopened = SessionManager.open(manager.getSessionFile()!);
		expect(
			reopened
				.getBranch()
				.filter((entry) => entry.type === "context_edit")
				.map((entry) => entry.targetId),
		).toEqual([user, failed]);
		expect(reopened.buildSessionContext().messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(reopened.getEntry(failed)).toMatchObject({ message: { usage: error.usage, stopReason: "error" } });
	});

	it("propagates partial append and refresh faults rather than authorizing cached-context reuse", () => {
		const { session, manager, attempt } = setup();
		const user = manager.appendMessage({ role: "user", content: "same input", timestamp: 1 });
		manager.appendMessage(error);
		const append = manager.appendContextEdit.bind(manager);
		vi.spyOn(manager, "appendContextEdit").mockImplementation((id, replacement) => {
			if (id !== user) throw new Error("injected write failure");
			return append(id, replacement);
		});
		const refresh = vi.spyOn(session, "refreshContext");
		expect(() => attempt.omitFailedContext()).toThrow("injected write failure");
		expect(refresh).not.toHaveBeenCalled();
		vi.restoreAllMocks();
		vi.spyOn(session, "refreshContext").mockImplementation(() => {
			throw new Error("refresh fault");
		});
		expect(() => attempt.omitFailedContext()).toThrow("refresh fault");
	});
});
