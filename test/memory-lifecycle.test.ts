import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/memory/session.js", () => ({
	updateChannelSessionMemory: vi.fn(),
}));

vi.mock("../src/memory/consolidation.js", () => ({
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

import { runBackgroundMaintenance, runInlineConsolidation } from "../src/memory/consolidation.js";
import { MemoryLifecycle } from "../src/memory/lifecycle.js";
import { updateChannelSessionMemory } from "../src/memory/session.js";

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
	it("queues session memory refresh for compaction without blocking consolidation", async () => {
		let resolveUpdate: (() => void) | undefined;
		vi.mocked(updateChannelSessionMemory).mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveUpdate = () => resolve(undefined as never);
				}),
		);

		const compactionMessages = [{ role: "user", content: "summarize this" }] as never[];
		const lifecycle = new MemoryLifecycle({
			channelId: "dm_123",
			channelDir: "/tmp/dm_123",
			getMessages: () => [{ role: "user", content: "live state" }] as never[],
			getSessionEntries: () => [],
			getModel: () => ({ provider: "test", id: "noop" }) as never,
			resolveApiKey: async () => "",
			getSessionMemorySettings: () => ({
				enabled: true,
				minTurnsBetweenUpdate: 2,
				minToolCallsBetweenUpdate: 4,
				timeoutMs: 30000,
				failureBackoffTurns: 3,
				forceRefreshBeforeCompact: true,
				forceRefreshBeforeNewSession: true,
			}),
		});
		const fakePi = createFakePi();
		lifecycle.createExtensionFactory()(fakePi.api as never);

		await fakePi.handlers.get("session_before_compact")?.({
			preparation: { messagesToSummarize: compactionMessages },
		});
		await Promise.resolve();

		expect(updateChannelSessionMemory).toHaveBeenCalledTimes(1);
		expect(runInlineConsolidation).toHaveBeenCalledTimes(1);
		expect(vi.mocked(updateChannelSessionMemory)).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: compactionMessages,
				timeoutMs: 30000,
			}),
		);
		resolveUpdate?.();
	});

	it("queues session memory refresh for new-session without blocking consolidation", async () => {
		let resolveUpdate: (() => void) | undefined;
		vi.mocked(updateChannelSessionMemory).mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveUpdate = () => resolve(undefined as never);
				}),
		);

		const liveMessages = [{ role: "assistant", content: "current state" }] as never[];
		const lifecycle = new MemoryLifecycle({
			channelId: "dm_123",
			channelDir: "/tmp/dm_123",
			getMessages: () => liveMessages,
			getSessionEntries: () => [],
			getModel: () => ({ provider: "test", id: "noop" }) as never,
			resolveApiKey: async () => "",
			getSessionMemorySettings: () => ({
				enabled: true,
				minTurnsBetweenUpdate: 2,
				minToolCallsBetweenUpdate: 4,
				timeoutMs: 30000,
				failureBackoffTurns: 3,
				forceRefreshBeforeCompact: true,
				forceRefreshBeforeNewSession: true,
			}),
		});
		const fakePi = createFakePi();
		lifecycle.createExtensionFactory()(fakePi.api as never);

		await fakePi.handlers.get("session_before_switch")?.({
			reason: "new",
		});
		await Promise.resolve();

		expect(updateChannelSessionMemory).toHaveBeenCalledTimes(1);
		expect(runInlineConsolidation).toHaveBeenCalledTimes(1);
		expect(vi.mocked(updateChannelSessionMemory)).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: liveMessages,
				timeoutMs: 30000,
			}),
		);
		resolveUpdate?.();
	});

	it("backs off threshold-triggered session updates after a failure", async () => {
		vi.mocked(updateChannelSessionMemory).mockRejectedValue(new Error("timeout"));

		const lifecycle = new MemoryLifecycle({
			channelId: "dm_123",
			channelDir: "/tmp/dm_123",
			getMessages: () => [],
			getSessionEntries: () => [],
			getModel: () => ({ provider: "test", id: "noop" }) as never,
			resolveApiKey: async () => "",
			getSessionMemorySettings: () => ({
				enabled: true,
				minTurnsBetweenUpdate: 1,
				minToolCallsBetweenUpdate: 99,
				timeoutMs: 30000,
				failureBackoffTurns: 2,
				forceRefreshBeforeCompact: true,
				forceRefreshBeforeNewSession: true,
			}),
		});

		lifecycle.noteCompletedAssistantTurn();
		await Promise.resolve();
		await Promise.resolve();
		expect(updateChannelSessionMemory).toHaveBeenCalledTimes(1);

		lifecycle.noteCompletedAssistantTurn();
		await Promise.resolve();
		lifecycle.noteCompletedAssistantTurn();
		await Promise.resolve();
		expect(updateChannelSessionMemory).toHaveBeenCalledTimes(1);

		lifecycle.noteCompletedAssistantTurn();
		await Promise.resolve();
		await Promise.resolve();
		expect(updateChannelSessionMemory).toHaveBeenCalledTimes(2);
	});

	it("keeps a queued compaction refresh when a threshold refresh is already running", async () => {
		let resolveFirstUpdate: (() => void) | undefined;
		vi.mocked(updateChannelSessionMemory)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveFirstUpdate = () => resolve(undefined as never);
					}),
			)
			.mockResolvedValue(undefined as never);

		const compactionMessages = [{ role: "user", content: "pre-compact snapshot" }] as never[];
		const lifecycle = new MemoryLifecycle({
			channelId: "dm_123",
			channelDir: "/tmp/dm_123",
			getMessages: () => [{ role: "assistant", content: "live state" }] as never[],
			getSessionEntries: () => [],
			getModel: () => ({ provider: "test", id: "noop" }) as never,
			resolveApiKey: async () => "",
			getSessionMemorySettings: () => ({
				enabled: true,
				minTurnsBetweenUpdate: 1,
				minToolCallsBetweenUpdate: 99,
				timeoutMs: 30000,
				failureBackoffTurns: 2,
				forceRefreshBeforeCompact: true,
				forceRefreshBeforeNewSession: true,
			}),
		});
		const fakePi = createFakePi();
		lifecycle.createExtensionFactory()(fakePi.api as never);

		lifecycle.noteCompletedAssistantTurn();
		await Promise.resolve();
		expect(updateChannelSessionMemory).toHaveBeenCalledTimes(1);

		await fakePi.handlers.get("session_before_compact")?.({
			preparation: { messagesToSummarize: compactionMessages },
		});
		expect(runInlineConsolidation).toHaveBeenCalledTimes(1);
		expect(updateChannelSessionMemory).toHaveBeenCalledTimes(1);

		resolveFirstUpdate?.();
		await Promise.resolve();
		await Promise.resolve();

		expect(updateChannelSessionMemory).toHaveBeenCalledTimes(2);
		expect(vi.mocked(updateChannelSessionMemory).mock.calls[1]?.[0]).toMatchObject({
			messages: compactionMessages,
			timeoutMs: 30000,
		});
	});

	it("does not block compaction when inline consolidation is slow", async () => {
		let resolveConsolidation: (() => void) | undefined;
		vi.mocked(runInlineConsolidation).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveConsolidation = () =>
						resolve({
							skipped: false,
							appendedMemoryEntries: 1,
							appendedHistoryBlock: true,
						});
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
				minTurnsBetweenUpdate: 99,
				minToolCallsBetweenUpdate: 99,
				timeoutMs: 30000,
				failureBackoffTurns: 3,
				forceRefreshBeforeCompact: false,
				forceRefreshBeforeNewSession: false,
			}),
		});
		const fakePi = createFakePi();
		lifecycle.createExtensionFactory()(fakePi.api as never);

		const beforeCompact = fakePi.handlers.get("session_before_compact")?.({
			preparation: { messagesToSummarize: [{ role: "user", content: "snapshot" }] },
		});

		await expect(beforeCompact).resolves.toBeUndefined();
		await Promise.resolve();
		expect(runInlineConsolidation).toHaveBeenCalledTimes(1);
		resolveConsolidation?.();
	});

	it("does not block new-session switch when inline consolidation is slow", async () => {
		let resolveConsolidation: (() => void) | undefined;
		vi.mocked(runInlineConsolidation).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveConsolidation = () =>
						resolve({
							skipped: false,
							appendedMemoryEntries: 1,
							appendedHistoryBlock: true,
						});
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
				minTurnsBetweenUpdate: 99,
				minToolCallsBetweenUpdate: 99,
				timeoutMs: 30000,
				failureBackoffTurns: 3,
				forceRefreshBeforeCompact: false,
				forceRefreshBeforeNewSession: false,
			}),
		});
		const fakePi = createFakePi();
		lifecycle.createExtensionFactory()(fakePi.api as never);

		const beforeSwitch = fakePi.handlers.get("session_before_switch")?.({
			reason: "new",
		});

		await expect(beforeSwitch).resolves.toBeUndefined();
		await Promise.resolve();
		expect(runInlineConsolidation).toHaveBeenCalledTimes(1);
		resolveConsolidation?.();
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
				timeoutMs: 30000,
				failureBackoffTurns: 3,
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
				timeoutMs: 30000,
				failureBackoffTurns: 3,
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
