import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { getBuiltinModel as getModel } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import type { Executor } from "../src/executor.js";
import { createFileStore } from "../src/file-store.js";
import type { SubAgentToolOptions } from "../src/subagents/types.js";
import { createSubAgentInlineTool } from "../src/tools/subagent.js";
import { getSubAgentRunManager, testManagers } from "./helpers/background-runtime.js";
import { useTempDirs } from "./helpers/fixtures.js";

/**
 * The internal run's tool-call side: how long one turn can be held by delegations (the grace
 * deadline is shared per turn), and how a provider error is survived (retry in place, then the
 * backup model) instead of failing the run on the first 429.
 */

const model = getModel("openai", "gpt-4o-mini")!;
const backupModel = getModel("openai", "gpt-4o")!;
const createTempWorkspace = useTempDirs("pipiclaw-subagent-resilience-");
const fakeExecutor: Executor = {
	async exec() {
		return { stdout: "", stderr: "", code: 0 };
	},
};

function barrier() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function assistant(text: string, options: { error?: string } = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options.error ? "error" : "stop",
		errorMessage: options.error,
		timestamp: Date.now(),
	};
}

/** A worker whose prompt and each continue() append the next scripted assistant message. */
function scriptedWorker(script: AssistantMessage[], seen: { continues: number; models: string[] }) {
	const state: { messages: AgentMessage[]; tools: []; model?: Model<Api> } = { messages: [], tools: [], model };
	const step = async () => {
		seen.models.push(state.model?.id ?? "?");
		const next = script.shift();
		if (next) state.messages = [...state.messages, next];
	};
	return {
		state,
		subscribe: () => () => {},
		abort: () => {},
		prompt: async (input: string) => {
			state.messages = [{ role: "user", content: input, timestamp: Date.now() } as AgentMessage];
			await step();
		},
		continue: async () => {
			seen.continues++;
			await step();
		},
		waitForIdle: async () => {},
	};
}

function makeTool(overrides: Partial<SubAgentToolOptions> & Pick<SubAgentToolOptions, "createWorker">) {
	const workspaceDir = createTempWorkspace();
	const deskDir = join(workspaceDir, "dingtalk:dm:123");
	mkdirSync(deskDir, { recursive: true });
	return createSubAgentInlineTool({
		...testManagers("dingtalk:dm:123"),
		executor: fakeExecutor,
		fileStore: createFileStore(),
		getCurrentModel: () => model,
		getAvailableModels: () => [model, backupModel],
		resolveApiKey: async () => "test-key",
		workspaceDir,
		deskDir,
		runtimeContext: { workspaceDir, desk: "news", deskDir, channelId: "dingtalk:dm:123" },
		retryBaseDelayMs: 1,
		...overrides,
	});
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("");
}

describe("internal sub-agent: provider error recovery", () => {
	it.each(["model", "credentials"])(
		"does not resume after explicit cancellation while awaiting backup %s",
		async (waitingFor) => {
			const seen = { continues: 0, models: [] as string[] };
			const entered = barrier();
			const release = barrier();
			const keysFor: string[] = [];
			const tool = makeTool({
				resolveFallbackModel: async () => {
					if (waitingFor === "model") {
						entered.resolve();
						await release.promise;
					}
					return backupModel;
				},
				resolveApiKey: async (requested) => {
					keysFor.push(requested.id);
					if (requested.id === backupModel.id && waitingFor === "credentials") {
						entered.resolve();
						await release.promise;
					}
					return "test-key";
				},
				createWorker: () =>
					scriptedWorker([assistant("", { error: "400 unsupported parameter" }), assistant("Done.")], seen),
			});
			const execution = tool.execute("call-cancel-fallback", { task: "Find it.", systemPrompt: "Look." });
			const outcome = execution.then(
				() => null,
				(error: unknown) => error,
			);
			await entered.promise;
			const manager = getSubAgentRunManager("dingtalk:dm:123");
			const run = manager.list().find((record) => record.status === "running")!;
			await manager.cancel(run.runId);
			// A second cancel must keep the same live handle until normal settlement owns cleanup.
			await manager.cancel(run.runId);
			release.resolve();
			const error = await outcome;
			expect(seen.continues).toBe(0);
			expect(error).toMatchObject({ name: "RecoverableToolError" });
			expect(seen.models).toEqual([model.id]);
			expect(manager.get(run.runId)?.status).toBe("cancelled");
			expect(manager.get(run.runId)?.model).toBe(`${model.provider}/${model.id}`);
			if (waitingFor === "model") expect(keysFor).toEqual([model.id]);
		},
	);

	it("retries a transient provider error in place and returns the recovered result", async () => {
		const seen = { continues: 0, models: [] as string[] };
		const tool = makeTool({
			createWorker: () =>
				scriptedWorker([assistant("", { error: "429 Too Many Requests" }), assistant("Recovered answer.")], seen),
		});

		const result = await tool.execute("call-retry", { task: "Find it.", systemPrompt: "Look." });

		expect(textOf(result)).toContain("Recovered answer.");
		expect(result.details.failed).toBe(false);
		expect(seen.continues).toBe(1);
	});

	it("switches to the backup model once retries cannot help, and bills the run to it", async () => {
		const seen = { continues: 0, models: [] as string[] };
		const keysFor: string[] = [];
		const tool = makeTool({
			resolveApiKey: async (requested) => {
				keysFor.push(requested.id);
				return "test-key";
			},
			resolveFallbackModel: async () => backupModel,
			createWorker: () =>
				scriptedWorker(
					[assistant("", { error: "400 invalid_request: unsupported parameter" }), assistant("Done.")],
					seen,
				),
		});

		const result = await tool.execute("call-fallback", { task: "Find it.", systemPrompt: "Look." });

		expect(textOf(result)).toContain("Done.");
		expect(textOf(result)).toContain("backup model");
		// The continuation ran on the backup model with the backup model's own key.
		expect(seen.models).toEqual([model.id, backupModel.id]);
		expect(keysFor).toContain(backupModel.id);
		const record = getSubAgentRunManager("dingtalk:dm:123").get(result.details.runId);
		expect(record?.model).toBe(`${backupModel.provider}/${backupModel.id}`);
	});

	it("does not retry or switch models on a context overflow, and fails recoverably", async () => {
		const seen = { continues: 0, models: [] as string[] };
		let fallbackAsked = false;
		const tool = makeTool({
			resolveFallbackModel: async () => {
				fallbackAsked = true;
				return backupModel;
			},
			createWorker: () =>
				scriptedWorker([assistant("", { error: "prompt is too long: 250000 tokens > 200000 maximum" })], seen),
		});

		await expect(tool.execute("call-overflow", { task: "Find it.", systemPrompt: "Look." })).rejects.toMatchObject({
			name: "RecoverableToolError",
		});
		expect(seen.continues).toBe(0);
		expect(fallbackAsked).toBe(false);
	});
});

describe("internal sub-agent: the sync grace window is shared per turn", () => {
	/** A worker that never finishes on its own — only the grace deadline returns the call. */
	function hangingWorker() {
		const state: { messages: AgentMessage[]; tools: [] } = { messages: [], tools: [] };
		return {
			state,
			subscribe: () => () => {},
			abort: () => {},
			prompt: () => new Promise<void>(() => {}),
			waitForIdle: async () => {},
		};
	}

	// Regression: a sequential tool in the same batch makes the SDK run every call one after another,
	// so three delegations used to block the channel for three back-to-back grace windows.
	it("gives a later delegation in the same turn only what is left of the first one's deadline", async () => {
		const graceMs = 300;
		const tool = makeTool({ syncGraceMs: graceMs, createWorker: hangingWorker });
		const turn = new AbortController();

		const first = await tool.execute("call-a", { task: "One.", systemPrompt: "Look." }, turn.signal);
		const startedSecond = Date.now();
		const second = await tool.execute("call-b", { task: "Two.", systemPrompt: "Look." }, turn.signal);
		const secondWaited = Date.now() - startedSecond;

		expect(first.details.dispatched).toBe(true);
		expect(second.details.dispatched).toBe(true);
		expect(secondWaited).toBeLessThan(graceMs / 2);

		// A new turn (a new signal) gets a full window again.
		const startedNextTurn = Date.now();
		await tool.execute("call-c", { task: "Three.", systemPrompt: "Look." }, new AbortController().signal);
		expect(Date.now() - startedNextTurn).toBeGreaterThanOrEqual(graceMs - 20);
	});
});
