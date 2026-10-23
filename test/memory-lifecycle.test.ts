import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drainBoundaryReflectWork, hasBoundaryReflectWork } from "../src/memory/boundary-work.js";
import { readMemoryMaintenanceState, updateMemoryMaintenanceState } from "../src/memory/maintenance-state.js";
import { useTempDirs } from "./helpers/fixtures.js";

vi.mock("../src/memory/reflect.js", () => ({ runReflect: vi.fn() }));
vi.mock("../src/memory/review-log.js", () => ({ appendMemoryReviewLog: vi.fn() }));

import { reduceSummaryPayloads, splitSummaryInput } from "../src/agent/session/compaction-input.js";
import { MemoryLifecycle } from "../src/memory/lifecycle.js";
import { runReflect } from "../src/memory/reflect.js";
import { appendMemoryReviewLog } from "../src/memory/review-log.js";

const tempDir = useTempDirs("pipiclaw-boundary-work-");

const CONVERSATION = {
	dot: "news",
	dotDir: "/tmp/dots/news",
	cwd: "/tmp/dots/news",
	channelId: "dm_123",
	conversation: "dm-1",
	conversationDir: "/tmp/dots/news/conversations/dm-1",
};

const DEFAULT_REFLECT_RESULT = {
	skipped: false,
	condensed: false,
	journalAppended: 1,
	journalSkippedDuplicate: 0,
	added: ["x"],
	updated: [],
	deleted: [],
	touched: [],
	renamed: [],
	expiredProbation: [],
	rejected: [],
	discarded: [],
} as never;

beforeEach(() => {
	vi.mocked(runReflect).mockResolvedValue(DEFAULT_REFLECT_RESULT);
	vi.mocked(appendMemoryReviewLog).mockResolvedValue(undefined);
});

afterEach(() => {
	vi.useRealTimers();
	vi.resetAllMocks();
});

async function waitForAssertion(assertion: () => void): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 40; attempt++) {
		try {
			assertion();
			return;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	}
	throw lastError;
}

function createFakePi() {
	const handlers = new Map<string, (event: any) => Promise<void> | void>();
	return {
		api: {
			on(eventName: string, handler: (event: any) => Promise<void> | void) {
				handlers.set(eventName, handler);
			},
		},
		handlers,
	};
}

function createLifecycle(
	recordMemoryActivity?: ConstructorParameters<typeof MemoryLifecycle>[0]["recordMemoryActivity"],
) {
	return new MemoryLifecycle({
		conversation: CONVERSATION,
		workspaceDir: "/tmp",
		getMessages: () => [{ role: "assistant", content: "live state" }] as never[],
		getSessionEntries: () => [],
		getModel: () => ({ provider: "test", id: "noop" }) as never,
		resolveApiKey: async () => "",
		recordMemoryActivity,
	});
}

describe("MemoryLifecycle", () => {
	it("contains boundary discovery I/O failures before they escape detached lifecycle work", async () => {
		// Regression: discovery used to reject outside the worker's catch, risking an unhandled rejection.
		const root = tempDir();
		const conversation = { ...CONVERSATION, dotDir: root };
		const appHomeDir = join(root, "app");
		await writeFile(join(root, ".memory-work"), "unavailable directory");
		await expect(
			drainBoundaryReflectWork({
				conversation,
				workspaceDir: root,
				appHomeDir,
				model: { provider: "test", id: "noop" } as never,
				resolveApiKey: async () => "",
			}),
		).resolves.toBeUndefined();
		expect(runReflect).not.toHaveBeenCalled();
		expect((await readMemoryMaintenanceState(appHomeDir, conversation)).failureBackoffUntil).toBeTruthy();
	});

	it("covers a large Chinese transcript across bounded chunks, including its middle", () => {
		const input = `ORIGINAL_GOAL ${"中".repeat(20000)} MIDDLE_CONSTRAINT ${"文".repeat(20000)} CURRENT_STATE`;
		const tool = {
			role: "toolResult" as const,
			toolCallId: "source-call",
			toolName: "read",
			// Each block fits the SDK limit; together they exceed it. The final error must survive.
			content: [
				{ type: "text" as const, text: `FILE_HEAD ${"x".repeat(1200)}` },
				{ type: "text" as const, text: "y".repeat(1200) },
				{ type: "text" as const, text: `${"z".repeat(1200)} FAILURE_AT_END` },
			],
			isError: true,
			timestamp: 2,
		};
		const reduced = reduceSummaryPayloads(
			[{ role: "user", content: input, timestamp: 1 }, tool, { ...tool, toolCallId: "source-call-2" }],
			[],
			"/tmp/original.jsonl",
		);
		const chunks = splitSummaryInput(reduced, 26000, 4000);
		expect(chunks.length).toBeGreaterThan(1);
		const all = JSON.stringify(chunks);
		expect(all).toContain("ORIGINAL_GOAL");
		expect(all).toContain("MIDDLE_CONSTRAINT");
		expect(all).toContain("CURRENT_STATE");
		expect(all).toContain("FAILURE_AT_END");
		expect(all).toContain("/tmp/original.jsonl");
		expect(all).toContain("sha256=");
		expect(all).toContain("Repeated payload");
		expect(tool.content.map((part) => part.text).join("\n").length).toBeGreaterThan(3600);
		expect(() =>
			splitSummaryInput([{ role: "user", content: "中".repeat(300000), timestamp: 1 }], 26000, 4000),
		).toThrow();
	});

	it("persists compaction memory without waiting on inference and resumes the work after recreation", async () => {
		const root = tempDir();
		const conversation = { ...CONVERSATION, dotDir: root, conversationDir: join(root, "conversations/dm-1") };
		const entries = [
			{
				type: "message",
				id: "u1",
				message: { role: "user", content: "remember the deployment decision", timestamp: 1 },
			},
			{
				type: "message",
				id: "a1",
				message: { role: "assistant", content: [{ type: "text", text: "confirmed" }], timestamp: 2 },
			},
			{ type: "message", id: "keep", message: { role: "user", content: "continue", timestamp: 3 } },
		] as never[];
		const options = {
			conversation,
			workspaceDir: root,
			appHomeDir: join(root, "app"),
			getMessages: () => [],
			getSessionEntries: () => entries,
			getModel: () => ({ provider: "test", id: "noop" }) as never,
			resolveApiKey: async () => "",
		};
		const lifecycle = new MemoryLifecycle(options);
		await lifecycle.prepareCompaction({
			branchEntries: entries,
			preparation: { firstKeptEntryId: "keep" },
			signal: new AbortController().signal,
		} as never);
		expect(runReflect).not.toHaveBeenCalled();
		expect(await hasBoundaryReflectWork(conversation)).toBe(true);
		const dir = join(root, ".memory-work", conversation.conversation);
		const file = (await readdir(dir)).find((name) => name.endsWith(".json"))!;
		const snapshot = await readFile(join(dir, file), "utf8");
		vi.mocked(runReflect).mockRejectedValueOnce(new Error("provider unavailable"));
		await new MemoryLifecycle(options).resumeBoundaryReflect();
		expect(await hasBoundaryReflectWork(conversation)).toBe(true);
		// Failed work remains pending during backoff; no captured closure is needed to retry later.
		await new MemoryLifecycle(options).resumeBoundaryReflect();
		expect(runReflect).toHaveBeenCalledOnce();
		await updateMemoryMaintenanceState(options.appHomeDir, conversation, (state) => ({
			...state,
			failureBackoffUntil: null,
		}));
		await new MemoryLifecycle(options).resumeBoundaryReflect();
		expect(runReflect).toHaveBeenCalledTimes(2);
		expect(vi.mocked(runReflect).mock.calls[0]![0].messages).toHaveLength(2);
		expect(await hasBoundaryReflectWork(conversation)).toBe(false);
		// A late/replayed enqueue cannot resurrect a completed operation.
		await writeFile(join(dir, file), snapshot);
		await new MemoryLifecycle(options).resumeBoundaryReflect();
		expect(runReflect).toHaveBeenCalledTimes(2);
	});

	it("returns immediately from new-session switch and reflects in the background", async () => {
		let resolveReflect: (() => void) | undefined;
		vi.mocked(runReflect).mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveReflect = () =>
						resolve({
							skipped: false,
							condensed: false,
							journalAppended: 0,
							journalSkippedDuplicate: 0,
							added: [],
							updated: [],
							deleted: [],
							touched: [],
							renamed: [],
							expiredProbation: [],
							rejected: [],
							discarded: [],
						} as never);
				}),
		);

		const liveMessages = [{ role: "assistant", content: "current state" }] as never[];
		const lifecycle = new MemoryLifecycle({
			conversation: CONVERSATION,
			workspaceDir: "/tmp",
			getMessages: () => liveMessages,
			getSessionEntries: () => [],
			getModel: () => ({ provider: "test", id: "noop" }) as never,
			resolveApiKey: async () => "",
		});
		const fakePi = createFakePi();
		lifecycle.createExtensionFactory()(fakePi.api as never);

		// The handler must not block on the LLM-backed reflect pass: it returns synchronously so
		// /new can create the new session immediately.
		const beforeSwitch = fakePi.handlers.get("session_before_switch")?.({ reason: "new" });
		expect(beforeSwitch).toBeUndefined();

		await waitForAssertion(() => {
			expect(runReflect).toHaveBeenCalledTimes(1);
		});

		resolveReflect?.();
		await lifecycle.whenNewSessionReflectSettled();
		expect(vi.mocked(runReflect)).toHaveBeenCalledWith(expect.objectContaining({ messages: liveMessages }));
	});

	it("records assistant turns for scheduled maintenance without running reflect inline", async () => {
		const recordMemoryActivity = vi.fn();
		const lifecycle = createLifecycle(recordMemoryActivity);

		lifecycle.noteCompletedAssistantTurn();
		lifecycle.noteCompletedAssistantTurn();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(recordMemoryActivity).toHaveBeenCalledTimes(2);
		expect(recordMemoryActivity).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "assistant-turn-completed", ref: CONVERSATION }),
		);
		expect(runReflect).not.toHaveBeenCalled();
	});

	it.each([
		{
			label: "flushes pending durable memory from a completed assistant turn",
			activity: (lifecycle: MemoryLifecycle) => lifecycle.noteCompletedAssistantTurn(),
			expectedFlush: true,
		},
		{
			label: "flushes a tool-only session even without an assistant turn",
			activity: (lifecycle: MemoryLifecycle) => lifecycle.noteToolCall(),
			expectedFlush: true,
		},
		{
			label: "skips the flush when there is no pending durable activity",
			activity: () => {},
			expectedFlush: false,
		},
	])("$label", async ({ activity, expectedFlush }) => {
		const lifecycle = createLifecycle();

		activity(lifecycle);

		await lifecycle.flushForShutdown();

		if (expectedFlush) {
			expect(runReflect).toHaveBeenCalledTimes(1);
		} else {
			expect(runReflect).not.toHaveBeenCalled();
		}
	});

	it("records boundary events after compaction and new-session starts without running reflect", async () => {
		const recordMemoryActivity = vi.fn();
		const lifecycle = createLifecycle(recordMemoryActivity);
		const fakePi = createFakePi();
		lifecycle.createExtensionFactory()(fakePi.api as never);

		fakePi.handlers.get("session_compact")?.({});
		fakePi.handlers.get("session_start")?.({ reason: "new" });

		expect(recordMemoryActivity).toHaveBeenCalledTimes(2);
		expect(recordMemoryActivity).toHaveBeenCalledWith(expect.objectContaining({ kind: "boundary" }));
		expect(runReflect).not.toHaveBeenCalled();
	});
});
