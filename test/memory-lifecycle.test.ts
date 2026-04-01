import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/session-memory.js", () => ({
	updateChannelSessionMemory: vi.fn(),
}));

vi.mock("../src/memory-consolidation.js", () => ({
	runInlineConsolidation: vi.fn().mockResolvedValue({
		skipped: false,
		appendedMemoryEntries: 1,
		appendedHistoryBlock: true,
	}),
	runBackgroundMaintenance: vi.fn().mockResolvedValue({
		cleanedMemory: false,
		foldedHistory: false,
	}),
}));

import { runBackgroundMaintenance, runInlineConsolidation } from "../src/memory-consolidation.js";
import { MemoryLifecycle } from "../src/memory-lifecycle.js";
import { updateChannelSessionMemory } from "../src/session-memory.js";

afterEach(() => {
	vi.clearAllMocks();
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

describe("MemoryLifecycle", () => {
	it("refreshes session memory before compaction consolidation", async () => {
		const lifecycle = new MemoryLifecycle({
			channelId: "dm_123",
			channelDir: "/tmp/dm_123",
			getMessages: () => [],
			getSessionEntries: () => [],
			getModel: () => ({ provider: "test", id: "noop" }) as never,
			resolveApiKey: async () => "",
			getSessionMemorySettings: () => ({
				enabled: true,
				minTurnsBetweenUpdate: 2,
				minToolCallsBetweenUpdate: 4,
				forceRefreshBeforeCompact: true,
				forceRefreshBeforeNewSession: true,
			}),
		});
		const fakePi = createFakePi();
		lifecycle.createExtensionFactory()(fakePi.api as never);

		await fakePi.handlers.get("session_before_compact")?.({
			preparation: { messagesToSummarize: [] },
		});

		expect(updateChannelSessionMemory).toHaveBeenCalledTimes(1);
		expect(runInlineConsolidation).toHaveBeenCalledTimes(1);
		expect(vi.mocked(updateChannelSessionMemory).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(runInlineConsolidation).mock.invocationCallOrder[0],
		);
	});

	it("refreshes session memory before new-session consolidation", async () => {
		const lifecycle = new MemoryLifecycle({
			channelId: "dm_123",
			channelDir: "/tmp/dm_123",
			getMessages: () => [],
			getSessionEntries: () => [],
			getModel: () => ({ provider: "test", id: "noop" }) as never,
			resolveApiKey: async () => "",
			getSessionMemorySettings: () => ({
				enabled: true,
				minTurnsBetweenUpdate: 2,
				minToolCallsBetweenUpdate: 4,
				forceRefreshBeforeCompact: true,
				forceRefreshBeforeNewSession: true,
			}),
		});
		const fakePi = createFakePi();
		lifecycle.createExtensionFactory()(fakePi.api as never);

		await fakePi.handlers.get("session_before_switch")?.({
			reason: "new",
		});

		expect(updateChannelSessionMemory).toHaveBeenCalledTimes(1);
		expect(runInlineConsolidation).toHaveBeenCalledTimes(1);
	});

	it("coalesces threshold-driven session updates while one is pending", async () => {
		let resolveUpdate: (() => void) | null = null;
		vi.mocked(updateChannelSessionMemory).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveUpdate = () => resolve(undefined as never);
				}),
		);

		const lifecycle = new MemoryLifecycle({
			channelId: "dm_123",
			channelDir: "/tmp/dm_123",
			getMessages: () => [],
			getSessionEntries: () => [],
			getModel: () => ({ provider: "test", id: "noop" }) as never,
			resolveApiKey: async () => "",
			getSessionMemorySettings: () => ({
				enabled: true,
				minTurnsBetweenUpdate: 2,
				minToolCallsBetweenUpdate: 4,
				forceRefreshBeforeCompact: false,
				forceRefreshBeforeNewSession: false,
			}),
		});

		lifecycle.noteCompletedAssistantTurn();
		lifecycle.noteCompletedAssistantTurn();
		lifecycle.noteCompletedAssistantTurn();
		lifecycle.noteCompletedAssistantTurn();

		await Promise.resolve();
		expect(updateChannelSessionMemory).toHaveBeenCalledTimes(1);

		expect(resolveUpdate).not.toBeNull();
		resolveUpdate!();
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(updateChannelSessionMemory).toHaveBeenCalledTimes(1);

		lifecycle.noteCompletedAssistantTurn();
		lifecycle.noteCompletedAssistantTurn();
		await waitForAssertion(() => {
			expect(updateChannelSessionMemory).toHaveBeenCalledTimes(2);
		});
	});

	it("serializes background maintenance and keeps the queue alive after failures", async () => {
		let releaseFirstRun: (() => void) | null = null;
		vi.mocked(runBackgroundMaintenance)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						releaseFirstRun = () =>
							resolve({
								cleanedMemory: true,
								foldedHistory: false,
							});
					}),
			)
			.mockRejectedValueOnce(new Error("cleanup failed"))
			.mockResolvedValueOnce({
				cleanedMemory: false,
				foldedHistory: true,
			});

		const lifecycle = new MemoryLifecycle({
			channelId: "dm_123",
			channelDir: "/tmp/dm_123",
			getMessages: () => [],
			getSessionEntries: () => [],
			getModel: () => ({ provider: "test", id: "noop" }) as never,
			resolveApiKey: async () => "",
			getSessionMemorySettings: () => ({
				enabled: true,
				minTurnsBetweenUpdate: 2,
				minToolCallsBetweenUpdate: 4,
				forceRefreshBeforeCompact: false,
				forceRefreshBeforeNewSession: false,
			}),
		});
		const fakePi = createFakePi();
		lifecycle.createExtensionFactory()(fakePi.api as never);

		fakePi.handlers.get("session_compact")?.({});
		fakePi.handlers.get("session_compact")?.({});
		fakePi.handlers.get("session_switch")?.({ reason: "new" });
		await waitForAssertion(() => {
			expect(runBackgroundMaintenance).toHaveBeenCalledTimes(1);
		});
		expect(releaseFirstRun).not.toBeNull();
		releaseFirstRun!();

		await waitForAssertion(() => {
			expect(runBackgroundMaintenance).toHaveBeenCalledTimes(3);
		});
		expect(vi.mocked(runBackgroundMaintenance).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(runBackgroundMaintenance).mock.invocationCallOrder[1],
		);
		expect(vi.mocked(runBackgroundMaintenance).mock.invocationCallOrder[1]).toBeLessThan(
			vi.mocked(runBackgroundMaintenance).mock.invocationCallOrder[2],
		);
	});
});
