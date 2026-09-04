import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/memory/reflect.js", () => ({ runReflect: vi.fn() }));
vi.mock("../src/memory/review-log.js", () => ({ appendMemoryReviewLog: vi.fn() }));

import { boundCompactionMessages, MemoryLifecycle } from "../src/memory/lifecycle.js";
import { runReflect } from "../src/memory/reflect.js";
import { appendMemoryReviewLog } from "../src/memory/review-log.js";

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
		channelId: "dm_123",
		channelDir: "/tmp/dm_123",
		workspaceDir: "/tmp",
		getMessages: () => [{ role: "assistant", content: "live state" }] as never[],
		getSessionEntries: () => [],
		getModel: () => ({ provider: "test", id: "noop" }) as never,
		resolveApiKey: async () => "",
		recordMemoryActivity,
	});
}

describe("MemoryLifecycle", () => {
	it("bounds an oversized compaction request while retaining its head and tail", () => {
		const head = "ORIGINAL_GOAL ";
		const middle = "中".repeat(20_000);
		const tail = " CURRENT_STATE";
		const result = boundCompactionMessages(
			[{ role: "user", content: `${head}${middle}${tail}`, timestamp: Date.now() }] as never[],
			16_000,
			4_000,
		);

		expect(result.truncated).toBe(true);
		expect(result.boundedChars).toBeLessThan(result.originalChars);
		expect(result.messages).toHaveLength(1);
		const boundedText = (result.messages[0] as { content: Array<{ text: string }> }).content[0]?.text ?? "";
		expect(boundedText).toContain("ORIGINAL_GOAL");
		expect(boundedText).toContain("CURRENT_STATE");
		expect(boundedText).toContain("middle omitted");
	});

	it("reflects on the compaction window before session_before_compact resolves", async () => {
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

		const compactionMessages = [{ role: "user", content: "summarize this" }] as never[];
		const lifecycle = createLifecycle();
		const fakePi = createFakePi();
		lifecycle.createExtensionFactory()(fakePi.api as never);

		const beforeCompact = fakePi.handlers.get("session_before_compact")?.({
			preparation: { messagesToSummarize: compactionMessages },
		});
		await waitForAssertion(() => {
			expect(runReflect).toHaveBeenCalledTimes(1);
		});

		resolveReflect?.();
		await expect(beforeCompact).resolves.toBeUndefined();
		expect(vi.mocked(runReflect)).toHaveBeenCalledWith(
			expect.objectContaining({ channelId: "dm_123", messages: compactionMessages }),
		);
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
			channelId: "dm_123",
			channelDir: "/tmp/dm_123",
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
			expect.objectContaining({ kind: "assistant-turn-completed", channelId: "dm_123" }),
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
