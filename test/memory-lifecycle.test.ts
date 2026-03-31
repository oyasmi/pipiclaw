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

import { MemoryLifecycle } from "../src/memory-lifecycle.js";
import { runInlineConsolidation } from "../src/memory-consolidation.js";
import { updateChannelSessionMemory } from "../src/session-memory.js";

afterEach(() => {
	vi.clearAllMocks();
});

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
			getModel: () => ({ provider: "test", id: "noop" } as never),
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
			getModel: () => ({ provider: "test", id: "noop" } as never),
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
});
