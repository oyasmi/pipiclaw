import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import { type AssistantMessage, getModel } from "@mariozechner/pi-ai";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import type { Executor } from "../src/sandbox.js";
import { ChannelStore } from "../src/store.js";
import { discoverSubAgents, getSubAgentsDir, resolveSubAgentConfig } from "../src/sub-agents.js";
import { createSubAgentTool } from "../src/tools/subagent.js";

const model = getModel("openai", "gpt-4o-mini")!;

const fakeExecutor: Executor = {
	async exec() {
		return { stdout: "", stderr: "", code: 0 };
	},
	getWorkspacePath(hostPath: string) {
		return hostPath;
	},
};

const usage = {
	input: 10,
	output: 6,
	cacheRead: 2,
	cacheWrite: 1,
	totalTokens: 19,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
};

class FakeWorker {
	public readonly state: { messages: AgentMessage[] } = { messages: [] };
	private readonly listeners = new Set<(event: AgentEvent) => void>();

	constructor(private readonly onPrompt: (input: string, worker: FakeWorker) => Promise<void> | void) {}

	subscribe(listener: (event: AgentEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	abort(): void {}

	async prompt(input: string): Promise<void> {
		await this.onPrompt(input, this);
	}

	async waitForIdle(): Promise<void> {}

	emit(event: AgentEvent): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}
}

function createAssistantMessage(
	text: string,
	options: { stopReason?: AssistantMessage["stopReason"]; errorMessage?: string } = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: options.stopReason ?? "stop",
		errorMessage: options.errorMessage,
		timestamp: Date.now(),
	};
}

const tempDirs: string[] = [];

function createTempWorkspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "pipiclaw-subagent-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("sub-agent discovery", () => {
	it("ignores predefined prompts that exceed the length limit", () => {
		const workspaceDir = createTempWorkspace();
		const subAgentsDir = getSubAgentsDir(workspaceDir);
		mkdirSync(subAgentsDir, { recursive: true });

		writeFileSync(
			join(subAgentsDir, "reviewer.md"),
			`---
name: reviewer
description: review code
---

${"x".repeat(16001)}`,
			"utf-8",
		);

		const discovery = discoverSubAgents(workspaceDir, [model]);
		expect(discovery.agents).toHaveLength(0);
		expect(discovery.warnings[0]).toContain("exceeds 16000 characters");
	});

	it("accepts YAML frontmatter arrays and numeric values", () => {
		const workspaceDir = createTempWorkspace();
		const subAgentsDir = getSubAgentsDir(workspaceDir);
		mkdirSync(subAgentsDir, { recursive: true });

		writeFileSync(
			join(subAgentsDir, "reviewer.md"),
			`---
name: reviewer
description: review code
tools:
  - read
  - bash
maxTurns: 7
maxToolCalls: 9
maxWallTimeSec: 60
bashTimeoutSec: 30
---

Review files carefully.`,
			"utf-8",
		);

		const discovery = discoverSubAgents(workspaceDir, [model]);
		expect(discovery.warnings).toEqual([]);
		expect(discovery.agents).toHaveLength(1);
		expect(discovery.agents[0]).toMatchObject({
			name: "reviewer",
			description: "review code",
			tools: ["read", "bash"],
			maxTurns: 7,
			maxToolCalls: 9,
			maxWallTimeSec: 60,
			bashTimeoutSec: 30,
			contextMode: "isolated",
			memory: "none",
			paths: [],
		});
	});

	it("parses contextual sub-agent frontmatter and inline overrides", () => {
		const workspaceDir = createTempWorkspace();
		const subAgentsDir = getSubAgentsDir(workspaceDir);
		mkdirSync(subAgentsDir, { recursive: true });

		writeFileSync(
			join(subAgentsDir, "reviewer.md"),
			`---
name: reviewer
description: review code
contextMode: contextual
memory: session
paths:
  - src/core.ts
  - test/core.test.ts
---

Review files carefully.`,
			"utf-8",
		);

		const discovery = discoverSubAgents(workspaceDir, [model]);
		expect(discovery.warnings).toEqual([]);
		expect(discovery.agents[0]).toMatchObject({
			contextMode: "contextual",
			memory: "session",
			paths: ["src/core.ts", "test/core.test.ts"],
		});

		const resolved = resolveSubAgentConfig([model], model, discovery.agents, {
			agent: "reviewer",
			memory: "relevant",
			paths: ["src/extra.ts"],
		});
		expect(resolved.error).toBeUndefined();
		expect(resolved.config).toMatchObject({
			contextMode: "contextual",
			memory: "relevant",
			paths: ["src/extra.ts"],
		});
	});

	it("resolves current model by default and rejects overly long inline prompts", () => {
		const resolved = resolveSubAgentConfig([model], model, [], {
			name: "inline-reviewer",
			systemPrompt: "Review files",
			contextMode: "contextual",
		});
		expect(resolved.error).toBeUndefined();
		expect(resolved.config?.model).toBe(model);
		expect(resolved.config?.modelRef).toBe("openai/gpt-4o-mini");
		expect(resolved.config?.contextMode).toBe("contextual");
		expect(resolved.config?.memory).toBe("relevant");

		const tooLong = resolveSubAgentConfig([model], model, [], {
			systemPrompt: "x".repeat(16001),
		});
		expect(tooLong.error).toContain("Inline sub-agent systemPrompt exceeds 16000 characters");
	});
});

describe("sub-agent tool", () => {
	it("preserves partial output and injects minimal runtime context", async () => {
		const workspaceDir = createTempWorkspace();
		const channelDir = join(workspaceDir, "dm_123");
		mkdirSync(channelDir, { recursive: true });
		let delegatedTask = "";

		const tool = createSubAgentTool({
			executor: fakeExecutor,
			getCurrentModel: () => model,
			getAvailableModels: () => [model],
			resolveApiKey: async () => "test-key",
			workspaceDir,
			channelDir,
			getSubAgentDiscovery: () => ({
				directory: join(workspaceDir, "sub-agents"),
				warnings: [],
				agents: [
					{
						name: "reviewer",
						description: "review code",
						systemPrompt: "Review the supplied task.",
						tools: ["read", "bash"],
						model,
						modelRef: "openai/gpt-4o-mini",
						maxTurns: 24,
						maxToolCalls: 48,
						maxWallTimeSec: 300,
						bashTimeoutSec: 120,
						contextMode: "isolated",
						memory: "none",
						paths: [],
						source: "predefined",
					},
				],
			}),
			runtimeContext: {
				workspacePath: "/workspace/root",
				channelId: "dm_123",
				sandbox: "host",
			},
			createWorker: () =>
				new FakeWorker(async (input, worker) => {
					delegatedTask = input;
					const assistantMessage = createAssistantMessage("Found two correctness issues.", {
						stopReason: "error",
						errorMessage: "Turn budget exceeded (24)",
					});
					worker.state.messages = [assistantMessage];
					worker.emit({ type: "message_end", message: assistantMessage });
				}),
		});

		const result = await tool.execute("call-1", {
			label: "review current changes",
			agent: "reviewer",
			task: "Inspect the current workspace and summarize the main risks.",
		});

		expect(result.content[0]?.type).toBe("text");
		expect(result.content[0] && "text" in result.content[0] ? result.content[0].text : "").toContain(
			"[Sub-agent reviewer stopped: Turn budget exceeded (24)]",
		);
		expect(result.details.failed).toBe(true);
		expect(result.details.failureReason).toBe("Turn budget exceeded (24)");
		expect(result.details.usage.total).toBe(19);
		expect(delegatedTask).toContain("Workspace root: /workspace/root");
		expect(delegatedTask).toContain("Channel id: dm_123");
		expect(delegatedTask).toContain("Filesystem isolation: none");
		expect(delegatedTask).toContain("Inspect the current workspace and summarize the main risks.");
	});

	it("injects contextual session and recalled memory for contextual sub-agents", async () => {
		const workspaceDir = createTempWorkspace();
		const channelDir = join(workspaceDir, "dm_123");
		mkdirSync(channelDir, { recursive: true });
		writeFileSync(
			join(channelDir, "SESSION.md"),
			`# Session Title

# Current State

Refactoring src/core.ts to stabilize the memory pipeline.

# User Intent

Find regressions before the changes ship.

# Active Files

src/core.ts
test/core.test.ts

# Errors & Corrections

The last refactor broke fallback handling in src/core.ts.

# Next Steps

Review the new control flow and missing tests.
`,
			"utf-8",
		);
		writeFileSync(
			join(channelDir, "MEMORY.md"),
			`# Channel Memory

## Decisions

- Keep the fallback branch in src/core.ts explicit.

## Constraints

- Do not break the current session memory pipeline.
`,
			"utf-8",
		);
		writeFileSync(
			join(channelDir, "HISTORY.md"),
			`# Channel History

## 2026-03-30T12:00:00.000Z

Earlier review found missing regression coverage around src/core.ts fallback behavior.
`,
			"utf-8",
		);

		let delegatedTask = "";
		const tool = createSubAgentTool({
			executor: fakeExecutor,
			getCurrentModel: () => model,
			getAvailableModels: () => [model],
			resolveApiKey: async () => "test-key",
			workspaceDir,
			channelDir,
			getMemoryRecallSettings: () => ({
				enabled: true,
				maxCandidates: 6,
				maxInjected: 2,
				maxChars: 1200,
				rerankWithModel: false,
			}),
			getSubAgentDiscovery: () => ({
				directory: join(workspaceDir, "sub-agents"),
				warnings: [],
				agents: [
					{
						name: "reviewer",
						description: "review code",
						systemPrompt: "Review the supplied task.",
						tools: ["read", "bash"],
						model,
						modelRef: "openai/gpt-4o-mini",
						maxTurns: 24,
						maxToolCalls: 48,
						maxWallTimeSec: 300,
						bashTimeoutSec: 120,
						contextMode: "contextual",
						memory: "relevant",
						paths: ["src/core.ts", "test/core.test.ts"],
						source: "predefined",
					},
				],
			}),
			runtimeContext: {
				workspacePath: "/workspace/root",
				channelId: "dm_123",
				sandbox: "host",
			},
			createWorker: () =>
				new FakeWorker(async (input, worker) => {
					delegatedTask = input;
					const assistantMessage = createAssistantMessage("Looks good.");
					worker.state.messages = [assistantMessage];
					worker.emit({ type: "message_end", message: assistantMessage });
				}),
		});

		await tool.execute("call-2", {
			label: "review memory refactor",
			agent: "reviewer",
			task: "Review src/core.ts for regressions and missing tests.",
		});

		expect(delegatedTask).toContain("Preferred focus paths:");
		expect(delegatedTask).toContain("- src/core.ts");
		expect(delegatedTask).toContain("Relevant session state:");
		expect(delegatedTask).toContain("Current State");
		expect(delegatedTask).toContain("Find regressions before the changes ship.");
		expect(delegatedTask).toContain("Relevant context for this turn:");
		expect(delegatedTask).toContain("Keep the fallback branch in src/core.ts explicit.");
		expect(delegatedTask).toContain("Do not break the current session memory pipeline.");
	});
});

describe("sub-agent run persistence", () => {
	it("writes sub-agent runs to subagent-runs.jsonl", async () => {
		const workspaceDir = createTempWorkspace();
		const store = new ChannelStore({ workingDir: workspaceDir });

		await store.logSubAgentRun("dm_123", {
			date: "2026-03-31T00:00:00.000Z",
			toolCallId: "tool-1",
			label: "review",
			agent: "reviewer",
			source: "predefined",
			model: "openai/gpt-4o-mini",
			tools: ["read", "bash"],
			turns: 2,
			toolCalls: 3,
			durationMs: 1200,
			failed: true,
			failureReason: "Turn budget exceeded (24)",
			output: "Found two issues.",
			outputTruncated: false,
			usage: {
				input: 10,
				output: 6,
				cacheRead: 2,
				cacheWrite: 1,
				total: 19,
				cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
			},
		});

		const logPath = join(workspaceDir, "dm_123", "subagent-runs.jsonl");
		const lines = readFileSync(logPath, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0])).toMatchObject({
			toolCallId: "tool-1",
			agent: "reviewer",
			failed: true,
			output: "Found two issues.",
		});
	});
});
