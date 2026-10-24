import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { CompactionSummary } from "../../../src/agent/session/compaction-summary.js";
import { getDeskMemoryQueue } from "../../../src/memory/desk-memory-queue.js";
import { crash, startDaemon } from "../../support/daemon-process.js";
import { startMockProvider } from "../../support/mock-provider/server.js";
import { bindChannelOnDisk, createDeterministicHarness, reply } from "../../support/runtime-harness.js";
import { cleanupE2ETestHome, createDeterministicHome } from "../../support/setup.js";

function seed(conversationDir: string, deskDir: string, homeDir: string): void {
	const manager = SessionManager.open(join(conversationDir, "context.jsonl"), conversationDir, deskDir);
	const usage = {
		input: 160000,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 160010,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	manager.appendMessage({ role: "user", content: "PRESERVED_GOAL keep the deployment restriction", timestamp: 1 });
	manager.appendMessage({
		role: "assistant",
		content: [
			{ type: "text", text: "confirmed" },
			{ type: "toolCall", id: "historic-read", name: "read", arguments: { path: "critical-config.ts" } },
		],
		timestamp: 2,
		api: "openai-completions",
		provider: "e2e-mock",
		model: "mock-main",
		stopReason: "stop",
		usage,
	});
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "historic-read",
		toolName: "read",
		content: [{ type: "text", text: "historic contents" }],
		isError: false,
		timestamp: 2,
	});
	manager.appendMessage({ role: "user", content: "RECENT_WORK continue", timestamp: 3 });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "x".repeat(90000) }],
		timestamp: 4,
		api: "openai-completions",
		provider: "e2e-mock",
		model: "mock-main",
		stopReason: "stop",
		usage,
	});
	const modelsPath = join(homeDir, "models.json");
	const models = JSON.parse(readFileSync(modelsPath, "utf8"));
	models.providers["e2e-mock"].models[0].reasoning = true;
	models.providers["e2e-mock"].compat.supportsReasoningEffort = true;
	writeFileSync(modelsPath, JSON.stringify(models));
}

const summaryRequest = (request: { systemPrompt: string }) =>
	request.systemPrompt.includes("context summarization assistant");
const reflectRequest = (request: { systemPrompt: string }) => request.systemPrompt.includes("memory reflection worker");

describe("E2E deterministic: compaction", () => {
	it("prepares without blocking tools, adopts a completed checkpoint with its tail, and discards the next candidate on /new", async () => {
		// New cross-module failure: a detached session.compact() aborts the live tool loop or overwrites its newer tail.
		// The same lifecycle then exercises /new while a second candidate is held; no old generation may commit later.
		// Mutation checked 2026-10-22: disable adopt(); this case fails on the persisted compaction count.
		// Mutation checked 2026-10-23: remove early shutdown cancellation; the source-signal assertion fails.
		let firstReady!: () => void;
		let secondFinished!: () => void;
		let thirdFinished!: () => void;
		let shutdownCancelled = false;
		const ready = new Promise<void>((resolve) => {
			firstReady = resolve;
		});
		const finished = new Promise<void>((resolve) => {
			secondFinished = resolve;
		});
		const stopped = new Promise<void>((resolve) => {
			thirdFinished = resolve;
		});
		const original = CompactionSummary.prototype.generate;
		let generation = 0;
		const observe = vi.spyOn(CompactionSummary.prototype, "generate").mockImplementation(async function (
			this: CompactionSummary,
			...args
		) {
			const current = ++generation;
			try {
				const result = await original.apply(this, args);
				if (current === 1) firstReady();
				return result;
			} finally {
				if (current === 2) secondFinished();
				if (current === 3) {
					shutdownCancelled = args[1].signal.aborted;
					thirdFinished();
				}
			}
		});
		const harness = await createDeterministicHarness({
			seed: (paths) => {
				const manager = SessionManager.open(
					join(paths.conversationDir, "context.jsonl"),
					paths.conversationDir,
					paths.deskDir,
				);
				manager.appendMessage({ role: "user", content: `PREFIX_TO_REPLACE ${"中".repeat(40000)}`, timestamp: 0 });
				seed(paths.conversationDir, paths.deskDir, paths.homeDir);
				writeFileSync(join(paths.deskDir, "critical-config.ts"), "TAIL_FILE_RESULT");
			},
		});
		harness.model.script.route({
			name: "checkpoint",
			when: summaryRequest,
			respond: [reply.text("WORKING_CHECKPOINT")],
			repeat: true,
		});
		harness.model.script.route({
			name: "foreground",
			when: (request) => request.isMainTurn,
			respond: [
				reply.toolCall("read", { path: "critical-config.ts" }, "tail-read"),
				reply.toolCall("read", { path: "critical-config.ts" }, "tail-read-next"),
				reply.text("TAIL_COMPLETE"),
			],
			repeat: true,
		});
		const summary = harness.model.script.hold({ when: summaryRequest });
		const next = harness.model.script.hold({
			when: (request) => request.isMainTurn && JSON.stringify(request.raw).includes("tail-read"),
		});
		let later: ReturnType<typeof harness.model.script.hold> | undefined;
		let shutdownSummary: ReturnType<typeof harness.model.script.hold> | undefined;
		let shutdownMemory: ReturnType<typeof harness.model.script.hold> | undefined;
		let closing: Promise<void> | undefined;
		try {
			const running = harness.sendUserMessage("BACKGROUND_START");
			await summary.arrived;
			const inFlight = await next.arrived;
			expect(JSON.stringify(inFlight.raw)).toContain("TAIL_FILE_RESULT");
			summary.release();
			await ready;
			next.release();
			await running;
			// The next request in the same tool loop must already use the adopted projection.
			expect(JSON.stringify(harness.lastMainTurnRequest()!.raw)).toContain("WORKING_CHECKPOINT");
			expect(JSON.stringify(harness.lastMainTurnRequest()!.raw)).not.toContain("PREFIX_TO_REPLACE");
			const oldPath = join(harness.conversationDir, "context.jsonl");
			const entries = () =>
				readFileSync(oldPath, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
			expect(entries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
			await harness.sendUserMessage("AFTER_ADOPTION");
			const request = JSON.stringify(harness.lastMainTurnRequest()!.raw);
			expect(request).toContain("WORKING_CHECKPOINT");
			expect(request).toContain("tail-read");
			expect(request).toContain("BACKGROUND_START");
			expect(request).not.toContain("PREFIX_TO_REPLACE");
			later = harness.model.script.hold({ when: summaryRequest });
			harness.model.script.prependRoute({
				name: "grow",
				when: (request) => request.isMainTurn && request.lastUserText.includes("GROW_AGAIN"),
				repeat: true,
				respond: [
					{
						...reply.text("文".repeat(60000)),
						usage: { prompt_tokens: 130000, completion_tokens: 1, total_tokens: 130001 },
					},
				],
			});
			await harness.sendUserMessage("GROW_AGAIN");
			await later.arrived;
			await harness.sendUserMessage("/new");
			await finished;
			await harness.sendUserMessage("NEW_GENERATION");
			const fresh = JSON.stringify(harness.lastMainTurnRequest()!.raw);
			expect(fresh).not.toContain("WORKING_CHECKPOINT");
			expect(fresh).not.toContain("BACKGROUND_START");
			later.release();
			expect(entries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
			expect(harness.model.requests.filter(summaryRequest)).toHaveLength(2);
			shutdownSummary = harness.model.script.hold({ when: summaryRequest });
			await harness.sendUserMessage("GROW_AGAIN");
			await harness.sendUserMessage("GROW_AGAIN");
			await shutdownSummary.arrived;
			shutdownMemory = harness.model.script.hold({ when: reflectRequest });
			closing = harness.shutdown();
			await shutdownMemory.arrived;
			// Cancellation must settle before a blocked memory flush can finish, so exit cannot wait on the summary deadline.
			await stopped;
			expect(shutdownCancelled).toBe(true);
			shutdownMemory.release();
			shutdownSummary.release();
			await closing;
		} finally {
			summary.release();
			next.release();
			later?.release();
			shutdownSummary?.release();
			shutdownMemory?.release();
			observe.mockRestore();
			await (closing ?? harness.shutdown());
		}
	});

	it("compacts once with its own budget while a blocked memory worker leaves the channel usable", async () => {
		// Catches double /compact and synchronous reflect. Mutation (2026-10-22): remove the slash-command guard in turn-pipeline; custom instructions are lost and this case fails.
		const harness = await createDeterministicHarness({
			seed: (paths) => seed(paths.conversationDir, paths.deskDir, paths.homeDir),
		});
		harness.model.script.route({
			name: "compact",
			when: summaryRequest,
			respond: [reply.text("## Goal\nPRESERVED_GOAL")],
			repeat: true,
		});
		harness.model.script.route({
			name: "next",
			when: (request) => request.isMainTurn,
			respond: [reply.text(`continued${"y".repeat(90000)}`)],
			repeat: true,
		});
		const memory = harness.model.script.hold({ when: reflectRequest });
		try {
			await harness.sendUserMessage("/compact 保留部署限制");
			await memory.arrived;
			const summaries = harness.model.requests.filter(summaryRequest);
			expect(summaries).toHaveLength(1);
			expect(summaries[0]!.raw.max_completion_tokens ?? summaries[0]!.raw.max_tokens).toBeLessThanOrEqual(4096);
			expect(summaries[0]!.raw.reasoning_effort).not.toBe("medium");
			expect(summaries[0]!.lastUserText).toContain("保留部署限制");
			const entries = readFileSync(join(harness.conversationDir, "context.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(entries.filter((entry) => entry.type === "compaction")).toHaveLength(1);
			expect(
				readdirSync(join(harness.deskDir, ".memory-work", "dm-1")).filter((file) => file.endsWith(".json")),
			).toHaveLength(1);
			// The reflect request remains held: no cancellation or ordinary completion can hide a blocking hook.
			await harness.sendUserMessage("AFTER_COMPACTION");
			expect(harness.lastMainTurnRequest()?.matchedRoute).toBe("next");
			await harness.sendUserMessage("/compact");
			const twice = readFileSync(join(harness.conversationDir, "context.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(twice.filter((entry) => entry.type === "compaction")).toHaveLength(2);
			const latest = twice.filter((entry) => entry.type === "compaction").at(-1);
			expect(latest.details.readFiles).toContain("critical-config.ts");
			expect(harness.model.requests.filter(summaryRequest)).toHaveLength(2);
		} finally {
			memory.release();
			await getDeskMemoryQueue().run({ desk: harness.desk, deskDir: harness.deskDir }, async () => {});
			await harness.shutdown();
		}
	});

	it("recovers pending boundary memory after SIGKILL with idle maintenance disabled", async () => {
		// Catches lost detached reflect closures: only the real compaction producer may create the recovered work.
		// Mutation (2026-10-22): restore scheduler enabled-only gating; pending work remains and this case fails.
		const model = await startMockProvider();
		const home = createDeterministicHome({ mockBaseUrl: model.baseUrl });
		const channelId = "dingtalk:dm:e2e_user";
		const conversation = await bindChannelOnDisk(home.workspaceDir, channelId);
		seed(conversation.conversationDir, conversation.deskDir, home.homeDir);
		const settingsPath = join(home.homeDir, "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
		settings.memoryMaintenance = { enabled: false };
		writeFileSync(settingsPath, JSON.stringify(settings));
		model.script.route({
			name: "compact",
			when: summaryRequest,
			respond: [reply.text("## Goal\nPRESERVED_GOAL")],
			repeat: true,
		});
		const memory = model.script.hold({ when: reflectRequest });
		let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
		try {
			daemon = await startDaemon(home.homeDir);
			await daemon.call("turn", { channelId, text: "/compact" });
			await memory.arrived;
			const dir = join(conversation.deskDir, ".memory-work", conversation.conversation);
			expect(readdirSync(dir).filter((file) => file.endsWith(".json"))).toHaveLength(1);
			await crash(daemon.child);
			memory.release();
			daemon = await startDaemon(home.homeDir);
			// The actual runtime scheduler loads disk-backed work, without resurrecting the old callbacks.
			await daemon.call("maintenance");
			expect(readdirSync(dir).filter((file) => file.endsWith(".json"))).toHaveLength(0);
			expect(model.requests.filter(reflectRequest).length).toBeGreaterThanOrEqual(2);
			const state = JSON.parse(readFileSync(join(home.homeDir, "state/memory/e2e/dm-1.json"), "utf8"));
			expect(state.lastReflectedEntryId).toBeTruthy();
			expect(model.unmatched()).toHaveLength(0);
		} finally {
			memory.release();
			if (daemon) await crash(daemon.child);
			await model.close();
			cleanupE2ETestHome(home.homeDir);
		}
	});
});
