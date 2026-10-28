import type {
	AgentSession,
	ExtensionAPI,
	ModelRuntime,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionCompaction } from "../src/agent/session/compaction.js";
import { COMPACTION_IDLE_TIMEOUT_MS, CompactionSummary } from "../src/agent/session/compaction-summary.js";
import { TurnPipeline } from "../src/agent/turn/turn-pipeline.js";
import { createEmptyRunState } from "../src/agent/types.js";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("compaction deadline and stale requests", () => {
	it("does not automatically compact when the feature is disabled", async () => {
		// Missing product-switch guard used to turn an automatic operation into SDK manual compaction.
		const prevent = vi.fn();
		const pipeline = new TurnPipeline({
			profile: { kind: "chat" },
			conversation: { channelId: "dingtalk:dm:test" } as never,
			workspaceDir: "/tmp",
			host: {
				settingsManager: { getCompactionEnabled: () => false },
				compaction: { canPrevent: () => true, prevent, cancel: vi.fn() },
				session: { model: { contextWindow: 200000 }, getContextUsage: () => ({ tokens: 160000 }) },
			} as never,
			models: {} as never,
			turnState: {} as never,
			isRetired: () => false,
			getRunState: createEmptyRunState,
		});
		await pipeline.maybeRunPreventiveCompactionForIncomingText("continue");
		expect(prevent).not.toHaveBeenCalled();
	});
	it.each(["snapshot", "auth"])(
		"cancels blocked %s without falling back or starting a late provider request",
		async (phase) => {
			// New failure: SDK emit swallows hook exceptions; cancellation must explicitly forbid default inference.
			vi.useFakeTimers();
			let release!: () => void;
			const blocked = new Promise<void>((resolve) => {
				release = resolve;
			});
			const abort = new AbortController();
			const model = { id: "mock", provider: "mock", contextWindow: 200000 };
			const stream = vi.fn();
			const session = {
				model,
				messages: [],
				agent: { streamFunction: stream },
				abortCompaction: () => abort.abort(),
			} as unknown as AgentSession;
			const runtime = {
				getPhysicalModel: () => model,
				getAuth: async () => {
					if (phase === "auth") await blocked;
					return { auth: { apiKey: "offline" } };
				},
			} as unknown as ModelRuntime;
			let handler!: (event: SessionBeforeCompactEvent) => Promise<unknown>;
			const compaction = new SessionCompaction({
				conversation: { channelId: "dingtalk:dm:test" } as never,
				getSession: () => session,
				getRuntime: () => runtime,
				preserveMemory: async () => {
					if (phase === "snapshot") await blocked;
				},
				ledger: { record: vi.fn(), summarize: vi.fn() },
				getRunState: () => createEmptyRunState(),
			});
			compaction.createExtensionFactory()({
				on: (name: string, fn: typeof handler) => {
					if (name === "session_before_compact") handler = fn;
				},
			} as unknown as ExtensionAPI);
			const pending = handler({
				signal: abort.signal,
				reason: "manual",
				preparation: {},
			} as SessionBeforeCompactEvent);
			await vi.advanceTimersByTimeAsync(COMPACTION_IDLE_TIMEOUT_MS);
			await expect(pending).resolves.toEqual({ cancel: true });
			expect(compaction.canPrevent()).toBe(false);
			release();
			await vi.advanceTimersByTimeAsync(0);
			expect(stream).not.toHaveBeenCalled();
		},
	);
});

function backgroundHarness() {
	const manager = SessionManager.inMemory("/tmp");
	const user = (content: string) => manager.appendMessage({ role: "user", content, timestamp: 1 });
	user(`ORIGINAL_GOAL ${"中".repeat(20000)}`);
	user(`VERIFIED ${"文".repeat(20000)}`);
	user("RECENT_WORK");
	user("x".repeat(90000));
	// Oversized final result: the cut must move back to the assistant call, keeping the pair intact.
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "large-read", name: "read", arguments: { path: "large.txt" } }],
		api: "openai-completions",
		provider: "mock",
		model: "mock",
		stopReason: "toolUse",
		timestamp: 2,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "large-read",
		toolName: "read",
		content: [{ type: "text", text: "R".repeat(120000) }],
		isError: false,
		timestamp: 3,
	});
	const session = {
		model: { provider: "mock", id: "mock", contextWindow: 200000 },
		sessionManager: manager,
		isIdle: true,
		settingsManager: SettingsManager.inMemory(),
		get messages() {
			return manager.buildSessionProjection().messages;
		},
		getContextUsage: () => ({
			tokens: manager.getBranch().some((entry) => entry.type === "compaction") ? null : 130000,
			contextWindow: 200000,
		}),
		refreshContext: vi.fn(),
		abort: vi.fn(async () => {}),
	} as unknown as AgentSession;
	let finish!: () => void;
	const gate = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const generate = vi.spyOn(CompactionSummary.prototype, "generate").mockImplementation(async (_session, event) => {
		await gate;
		return {
			summary: "WORKING_CHECKPOINT",
			firstKeptEntryId: event.preparation.firstKeptEntryId,
			tokensBefore: 130000,
			details: { pipiclawSummary: 1 },
		} as Awaited<ReturnType<CompactionSummary["generate"]>>;
	});
	const fault = vi.fn((_session: AgentSession, error: unknown) => new Error("quarantined", { cause: error }));
	const compaction = new SessionCompaction({
		conversation: { channelId: "dingtalk:dm:test" } as never,
		getSession: () => session,
		getRuntime: () => ({}) as ModelRuntime,
		preserveMemory: async () => {},
		ledger: { record: vi.fn(), summarize: vi.fn() },
		getRunState: createEmptyRunState,
		onPersistenceFault: fault,
	});
	return {
		manager,
		user,
		session,
		generate,
		compaction,
		fault,
		ready: async () => {
			finish();
			await gate;
			await Promise.resolve();
		},
	};
}

describe("background compaction provenance and adoption", () => {
	it("continues input while inference is held, then preserves the appended tail and consumes the candidate once", async () => {
		// Regression: a background worker must never abort the live session or overwrite newer messages.
		const h = backgroundHarness();
		await h.compaction.beforePrompt(1);
		const tail = h.user("APPENDED_DURING_SUMMARY");
		await h.compaction.beforePrompt(1);
		expect(h.generate).toHaveBeenCalledOnce();
		expect(h.session.abort).not.toHaveBeenCalled();
		const waiting = h.compaction.beforePrompt(50000);
		await h.ready();
		await waiting;
		expect(
			h.manager
				.buildSessionProjection()
				.entries.some((entry) => entry.sourceEntry.id === tail && entry.messages.length > 0),
		).toBe(true);
		expect(h.manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		await h.compaction.beforePrompt(1);
		expect(h.session.refreshContext).toHaveBeenCalledOnce();
	});

	it.each(["edit", "model", "branch", "retire", "compaction"])(
		"discards a late candidate after %s changes its provenance",
		async (change) => {
			// Each transition invalidates a distinct part of the immutable-prefix proof.
			const h = backgroundHarness();
			await h.compaction.beforePrompt(1);
			const original = h.manager.getBranch();
			if (change === "edit") h.manager.appendContextEdit(original[0]!.id, null);
			if (change === "model") Object.assign(h.session.model!, { id: "other" });
			if (change === "branch") h.manager.branch(original[0]!.id);
			if (change === "retire") h.compaction.retire();
			if (change === "compaction") h.manager.appendCompaction("other", original.at(-1)!.id, 130000);
			await h.ready();
			await h.compaction.beforePrompt(1);
			expect(
				h.manager
					.getBranch()
					.filter((entry) => entry.type === "compaction" && entry.summary.includes("WORKING_CHECKPOINT")),
			).toHaveLength(0);
			expect(h.session.refreshContext).not.toHaveBeenCalled();
			h.compaction.retire();
		},
	);

	it("keeps the original context and cools down when tail growth makes the checkpoint ineffective", async () => {
		const h = backgroundHarness();
		await h.compaction.beforePrompt(1);
		h.user("z".repeat(600000));
		await h.ready();
		await h.compaction.beforePrompt(0);
		expect(h.manager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
		expect(h.compaction.canPrevent()).toBe(false);
		expect(h.generate).toHaveBeenCalledOnce();
	});

	it("quarantines a persistence failure before a partial SDK commit can be used by another request", async () => {
		const h = backgroundHarness();
		await h.compaction.beforePrompt(1);
		await h.ready();
		vi.spyOn(h.manager, "appendCompaction").mockImplementation(() => {
			throw new Error("ENOSPC");
		});
		await expect(h.compaction.beforePrompt(1)).rejects.toThrow("quarantined");
		expect(h.fault).toHaveBeenCalledOnce();
		expect(h.session.abort).toHaveBeenCalledOnce();
		expect(h.session.refreshContext).not.toHaveBeenCalled();
	});
});
