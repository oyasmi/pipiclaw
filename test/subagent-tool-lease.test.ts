import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getBuiltinModel as getModel } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import type { Executor } from "../src/executor.js";
import { createSubAgentTool } from "../src/subagents/tool.js";
import { acquireWorkspaceLease, releaseWorkspaceLease } from "../src/subagents/workspace-lease.js";
import { useTempDirs } from "./helpers/fixtures.js";

/** Spec 040, D10.1: internal write runs now take the same workspace lease external runs will. */

const model = getModel("openai", "gpt-4o-mini")!;
const createTempWorkspace = useTempDirs("pipiclaw-subagent-lease-");
const fakeExecutor: Executor = {
	async exec() {
		return { stdout: "", stderr: "", code: 0 };
	},
};

class FakeWorker {
	public readonly state: { messages: AgentMessage[]; tools: AgentTool<any>[] } = { messages: [], tools: [] };
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
		for (const listener of this.listeners) listener(event);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
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
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function makeTool(workspaceDir: string, channelDir: string) {
	return createSubAgentTool({
		executor: fakeExecutor,
		getCurrentModel: () => model,
		getAvailableModels: () => [model],
		resolveApiKey: async () => "test-key",
		workspaceDir,
		workingDirectory: workspaceDir,
		channelDir,
		runtimeContext: { workspaceDir, channelId: "dm_lease" },
		createWorker: () =>
			new FakeWorker((_input, worker) => {
				const message = createAssistantMessage("Done.");
				worker.state.messages = [message];
				worker.emit({ type: "message_end", message });
			}),
	});
}

describe("subagent tool: workspace write lease (spec 040, D10.1)", () => {
	it("rejects a write-mutating internal delegation when another run already holds the directory", async () => {
		const workspaceDir = createTempWorkspace();
		const channelDir = join(workspaceDir, "dm_lease");
		mkdirSync(channelDir, { recursive: true });

		const held = acquireWorkspaceLease({
			runId: "other-run",
			channelId: "dm_other",
			workingDirectory: workspaceDir,
		});
		expect(held.ok).toBe(true);

		try {
			const tool = makeTool(workspaceDir, channelDir);
			await expect(
				tool.execute("lease-call-1", {
					label: "edit files",
					name: "writer",
					systemPrompt: "Edit things.",
					tools: ["read", "edit"],
					task: "Change a file.",
				}),
			).rejects.toThrow(/other-run/);
		} finally {
			releaseWorkspaceLease(held.ok ? held.leaseKey : undefined);
		}
	});

	it("does not block a read-only delegation from the same directory", async () => {
		const workspaceDir = createTempWorkspace();
		const channelDir = join(workspaceDir, "dm_lease");
		mkdirSync(channelDir, { recursive: true });

		const held = acquireWorkspaceLease({
			runId: "other-run",
			channelId: "dm_other",
			workingDirectory: workspaceDir,
		});
		expect(held.ok).toBe(true);

		try {
			const tool = makeTool(workspaceDir, channelDir);
			const result = await tool.execute("lease-call-2", {
				label: "read files",
				name: "reader",
				systemPrompt: "Read things.",
				tools: ["read"],
				task: "Look at a file.",
			});
			expect(result.details.failed).toBe(false);
		} finally {
			releaseWorkspaceLease(held.ok ? held.leaseKey : undefined);
		}
	});

	it("releases its own lease once the run settles, so the directory becomes available again", async () => {
		const workspaceDir = createTempWorkspace();
		const channelDir = join(workspaceDir, "dm_lease");
		mkdirSync(channelDir, { recursive: true });

		const tool = makeTool(workspaceDir, channelDir);
		const result = await tool.execute("lease-call-3", {
			label: "edit files",
			name: "writer",
			systemPrompt: "Edit things.",
			tools: ["read", "edit"],
			task: "Change a file.",
		});
		expect(result.details.failed).toBe(false);

		// The lease is gone: a fresh write acquire on the same directory now succeeds.
		const after = acquireWorkspaceLease({ runId: "next-run", channelId: "dm_lease", workingDirectory: workspaceDir });
		expect(after.ok).toBe(true);
		releaseWorkspaceLease(after.ok ? after.leaseKey : undefined);
	});
});

describe("subagent tool: purpose=verify guards against external roles that cannot honestly verify (spec 040, D9)", () => {
	async function makeExternalTool(role: string) {
		const workspaceDir = createTempWorkspace();
		const channelDir = join(workspaceDir, "dm_lease");
		mkdirSync(channelDir, { recursive: true });
		mkdirSync(join(channelDir, "tasks"), { recursive: true });
		const { writeFileSync } = await import("node:fs");
		writeFileSync(join(channelDir, "tasks", "ship.md"), "---\nstatus: open\n---\n# Ship\n\n## DoD\n- checks pass\n");
		const subAgentsDir = join(workspaceDir, "sub-agents");
		mkdirSync(subAgentsDir, { recursive: true });
		writeFileSync(join(subAgentsDir, "builder.md"), role, "utf-8");

		const { discoverSubAgents } = await import("../src/subagents/discovery.js");
		return createSubAgentTool({
			executor: fakeExecutor,
			getCurrentModel: () => model,
			getAvailableModels: () => [model],
			resolveApiKey: async () => "test-key",
			workspaceDir,
			channelDir,
			getSubAgentDiscovery: () => discoverSubAgents(workspaceDir, [model]),
			runtimeContext: { workspaceDir, channelId: "dm_lease" },
		});
	}

	it("rejects purpose=verify for a role that declares mutates: write", async () => {
		const tool = await makeExternalTool(`---
name: builder
description: external builder
runtime: external
harness: claude-code
command: claude --dangerously-skip-permissions
mutates: write
---

Build things.
`);
		await expect(
			tool.execute("ext-verify-1", {
				label: "verify",
				agent: "builder",
				task: "Check it.",
				purpose: "verify",
				taskId: "ship",
			}),
		).rejects.toThrow(/mutates: write/);
	});

	it("rejects purpose=verify for an exec-harness role even when it declares mutates: read", async () => {
		const tool = await makeExternalTool(`---
name: builder
description: external checker
runtime: external
harness: exec
command: "true"
mutates: read
---

Check things.
`);
		await expect(
			tool.execute("ext-verify-2", {
				label: "verify",
				agent: "builder",
				task: "Check it.",
				purpose: "verify",
				taskId: "ship",
			}),
		).rejects.toThrow(/exec harness/);
	});
});
