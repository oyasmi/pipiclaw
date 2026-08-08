import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getBuiltinModel as getModel } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import type { Executor } from "../src/executor.js";
import type { DingTalkEvent } from "../src/runtime/dingtalk.js";
import { configureSubAgentRuntime, getSubAgentRunManager } from "../src/subagents/runs.js";
import { createSubAgentTool, type SubAgentToolDetails } from "../src/subagents/tool.js";
import { useTempDirs } from "./helpers/fixtures.js";

/**
 * Spec 040, D2: a run that outlives the sync grace window degrades to a "still running"
 * placeholder instead of blocking the tool call. This exercises that race end to end through
 * the real `subagent` tool, using the `syncGraceMs` test seam (mirrors `convergenceWallClockMs`)
 * so the test does not have to wait out the real SYNC_GRACE_MS (120s).
 */

const model = getModel("openai", "gpt-4o-mini")!;
const createTempWorkspace = useTempDirs("pipiclaw-subagent-dispatch-");
const fakeExecutor: Executor = {
	async exec() {
		return { stdout: "", stderr: "", code: 0 };
	},
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("subagent tool: async dispatch past the sync grace window (spec 040, D2)", () => {
	it("returns a dispatched placeholder once the grace window elapses, then wakes the channel once the run actually finishes", async () => {
		const workspaceDir = createTempWorkspace();
		const channelDir = join(workspaceDir, "dm_123");
		mkdirSync(channelDir, { recursive: true });

		const dispatched: DingTalkEvent[] = [];
		configureSubAgentRuntime({
			dispatch: (event) => {
				dispatched.push(event);
				return true;
			},
		});

		let releasePrompt: (() => void) | undefined;
		const tool = createSubAgentTool({
			executor: fakeExecutor,
			getCurrentModel: () => model,
			getAvailableModels: () => [model],
			resolveApiKey: async () => "test-key",
			workspaceDir,
			channelDir,
			runtimeContext: { workspaceDir, channelId: "dm_123" },
			// Tiny grace window; maxWallTimeSec (default 300s via inline systemPrompt path) stays
			// far above it so the wall-clock budget timer cannot fire and confound the test.
			syncGraceMs: 20,
			createWorker: () => {
				const state: { messages: AgentMessage[]; tools: [] } = { messages: [], tools: [] };
				return {
					state,
					subscribe: () => () => {},
					abort: () => {},
					prompt: (_input: string) =>
						new Promise<void>((resolve) => {
							releasePrompt = () => {
								state.messages = [
									{
										role: "assistant",
										content: [{ type: "text", text: "Found it in src/index.ts." }],
										api: model.api,
										provider: model.provider,
										model: model.id,
										usage: {
											input: 5,
											output: 5,
											cacheRead: 0,
											cacheWrite: 0,
											totalTokens: 10,
											cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
										},
										stopReason: "stop",
										timestamp: Date.now(),
									},
								];
								resolve();
							};
						}),
					waitForIdle: async () => {},
				};
			},
		});

		const resultPromise = tool.execute("dispatch-call-1", {
			label: "explore the repo",
			name: "explorer",
			systemPrompt: "Explore the codebase.",
			task: "Find where the entrypoint is.",
		});

		// The grace window elapses before the fake worker ever resolves its prompt.
		const result = (await resultPromise) as {
			content: Array<{ type: string; text?: string }>;
			details: SubAgentToolDetails;
		};
		const text = result.content[0]?.text ?? "";
		// spec 041: the run gets its own short id, never the dispatching tool call's id ("dispatch-call-1").
		const runId = result.details.runId;
		expect(runId).toMatch(/^run_[a-z0-9]{6}$/);
		expect(text).toContain(`[Dispatched] runId=${runId}`);
		expect(result.details.dispatched).toBe(true);
		expect(dispatched).toHaveLength(0); // not settled yet — nothing to announce

		const run = getSubAgentRunManager("dm_123").get(runId);
		expect(run?.status).toBe("running");

		// The run keeps executing in the background; let it finish now.
		expect(releasePrompt).toBeDefined();
		releasePrompt?.();

		// Settlement is pure promise-chaining (no timers), so a few microtask ticks are enough.
		for (let i = 0; i < 50 && dispatched.length === 0; i++) {
			await sleep(5);
		}

		expect(dispatched).toHaveLength(1);
		expect(dispatched[0]?.dispatchId).toBe(`subagent:dm_123:${runId}:done`);
		expect(dispatched[0]?.text).toContain(`[SUBAGENT:${runId}]`);
		expect(getSubAgentRunManager("dm_123").get(runId)?.status).toBe("completed");
	});
});
