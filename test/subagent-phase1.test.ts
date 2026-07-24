import { execFileSync } from "node:child_process";
import type { AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { getBuiltinModel as getModel } from "@earendil-works/pi-ai/providers/all";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { createExecutor, type Executor } from "../src/executor.js";
import { renderTaskDocument } from "../src/shared/task-ledger.js";
import {
	discoverSubAgents,
	getSubAgentsDir,
	resolveSubAgentConfig,
	SUB_AGENT_EFFORT_PRESETS,
	type SubAgentConfig,
} from "../src/subagents/discovery.js";
import { createSubAgentTool } from "../src/subagents/tool.js";
import { applyTaskControlPatch, createDefaultTaskControl } from "../src/tasks/control.js";
import { readVerificationAttestation } from "../src/tasks/verification.js";
import { useTempDirs } from "./helpers/fixtures.js";

const model = getModel("openai", "gpt-4o-mini")!;
const altModel = getModel("openai", "gpt-4o")!;

const fakeExecutor: Executor = {
	async exec() {
		return { stdout: "", stderr: "", code: 0 };
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
	public readonly state: { messages: AgentMessage[]; tools: AgentTool<any>[] } = { messages: [], tools: [] };
	private readonly listeners = new Set<(event: AgentEvent) => void>();
	/** Test hook: lets a test simulate a worker that only settles once aborted. */
	public onAbort?: () => void;

	constructor(private readonly onPrompt: (input: string, worker: FakeWorker) => Promise<void> | void) {}

	subscribe(listener: (event: AgentEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	abort(): void {
		this.onAbort?.();
	}

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

const createTempWorkspace = useTempDirs("pipiclaw-subagent-");

/** A predefined agent carrying the stock defaults; override only what a test is about. */
function makeSubAgentConfig(overrides: Partial<SubAgentConfig> = {}): SubAgentConfig {
	return {
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
		...overrides,
	};
}

function makeDiscovery(workspaceDir: string, agents: SubAgentConfig[]) {
	return () => ({ directory: join(workspaceDir, "sub-agents"), warnings: [], agents });
}

/** A committed git repo plus a governed `ship` task, the minimum for worktree isolation. */
function createWorktreeFixture(): { workspaceDir: string; repoDir: string; channelDir: string } {
	const workspaceDir = createTempWorkspace();
	const repoDir = join(workspaceDir, "repo");
	const channelDir = join(workspaceDir, "dm_123");
	mkdirSync(repoDir, { recursive: true });
	mkdirSync(join(channelDir, "tasks"), { recursive: true });
	writeFileSync(
		join(channelDir, "tasks", "ship.md"),
		renderTaskDocument({ status: "open", control: createDefaultTaskControl() }, "# Ship\n"),
	);
	execFileSync("git", ["-C", repoDir, "init", "-q"]);
	execFileSync("git", ["-C", repoDir, "config", "user.email", "test@example.com"]);
	execFileSync("git", ["-C", repoDir, "config", "user.name", "Test"]);
	writeFileSync(join(repoDir, "README.md"), "base\n");
	execFileSync("git", ["-C", repoDir, "add", "README.md"]);
	execFileSync("git", ["-C", repoDir, "commit", "-qm", "base"]);
	return { workspaceDir, repoDir, channelDir };
}

function recordWorktreeOnTask(channelDir: string, worktreePath: string): void {
	writeFileSync(
		join(channelDir, "tasks", "ship.md"),
		renderTaskDocument(
			{ status: "open", control: applyTaskControlPatch(createDefaultTaskControl(), { worktreePath }) },
			"# Ship\n",
		),
	);
}

function createWorktreeTool(workspaceDir: string, repoDir: string, channelDir: string) {
	return createSubAgentTool({
		executor: createExecutor(),
		workingDirectory: repoDir,
		getCurrentModel: () => model,
		getAvailableModels: () => [model],
		resolveApiKey: async () => "test-key",
		workspaceDir,
		channelDir,
		runtimeContext: { workspaceDir, channelId: "dm_123" },
		createWorker: () =>
			new FakeWorker((_input, worker) => {
				const message = createAssistantMessage("Implementation complete.");
				worker.state.messages = [message];
				worker.emit({ type: "message_end", message });
			}),
	});
}

const worktreeParams = {
	label: "isolated implementation",
	name: "implementer",
	systemPrompt: "Implement the requested change.",
	task: "Implement in the isolated checkout.",
	taskId: "ship",
	isolation: "worktree" as const,
};

describe("sub-agent discovery", () => {
	it("loads every production example with the expected routing and resource settings", () => {
		const workspaceDir = createTempWorkspace();
		const subAgentsDir = getSubAgentsDir(workspaceDir);
		mkdirSync(subAgentsDir, { recursive: true });

		for (const name of ["explorer", "researcher", "reviewer", "verifier", "git-committer"]) {
			const example = readFileSync(join(process.cwd(), "examples", "sub-agents", `${name}.md`), "utf-8");
			writeFileSync(join(subAgentsDir, `${name}.md`), example, "utf-8");
		}

		const discovery = discoverSubAgents(workspaceDir, [model]);
		expect(discovery.warnings).toEqual([]);
		expect(discovery.agents).toHaveLength(5);
		expect(
			Object.fromEntries(
				discovery.agents.map((agent) => [
					agent.name,
					{
						thinkingLevel: agent.thinkingLevel,
						contextMode: agent.contextMode,
						memory: agent.memory,
						maxTurns: agent.maxTurns,
						maxToolCalls: agent.maxToolCalls,
						maxWallTimeSec: agent.maxWallTimeSec,
						bashTimeoutSec: agent.bashTimeoutSec,
					},
				]),
			),
		).toEqual({
			explorer: {
				thinkingLevel: "low",
				contextMode: "isolated",
				memory: "none",
				maxTurns: 12,
				maxToolCalls: 30,
				maxWallTimeSec: 180,
				bashTimeoutSec: 60,
			},
			researcher: {
				thinkingLevel: "medium",
				contextMode: "isolated",
				memory: "none",
				maxTurns: 16,
				maxToolCalls: 32,
				maxWallTimeSec: 240,
				bashTimeoutSec: 120,
			},
			reviewer: {
				thinkingLevel: "medium",
				contextMode: "contextual",
				memory: "relevant",
				maxTurns: 20,
				maxToolCalls: 40,
				maxWallTimeSec: 300,
				bashTimeoutSec: 120,
			},
			verifier: {
				thinkingLevel: "medium",
				contextMode: "isolated",
				memory: "none",
				maxTurns: 24,
				maxToolCalls: 48,
				maxWallTimeSec: 300,
				bashTimeoutSec: 120,
			},
			"git-committer": {
				thinkingLevel: "medium",
				contextMode: "isolated",
				memory: "none",
				maxTurns: 18,
				maxToolCalls: 40,
				maxWallTimeSec: 240,
				bashTimeoutSec: 120,
			},
		});

		for (const agent of discovery.agents) {
			expect(agent.description).toContain("使用");
			expect(agent.systemPrompt).toMatch(/[\u3400-\u9fff]/u);
		}
		expect(discovery.agents.find((agent) => agent.name === "verifier")?.description).toContain(
			"purpose=verify 与 taskId",
		);
		expect(discovery.agents.find((agent) => agent.name === "reviewer")?.description).toContain(
			"不要用于实现修复或按 DoD 做最终验收",
		);
		expect(discovery.agents.find((agent) => agent.name === "git-committer")?.description).toContain("默认不 push");
	});

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
		expect(discovery.agents.filter((agent) => agent.source === "predefined")).toHaveLength(0);
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
		const predefined = discovery.agents.filter((agent) => agent.source === "predefined");
		expect(predefined).toHaveLength(1);
		expect(predefined[0]).toMatchObject({
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
			context: "relevant",
			paths: ["src/extra.ts"],
		});
		expect(resolved.error).toBeUndefined();
		expect(resolved.config).toMatchObject({
			contextMode: "contextual",
			memory: "relevant",
			paths: ["src/extra.ts"],
		});
	});

	it("maps each context choice onto the frontmatter contextMode/memory pair", () => {
		const cases = [
			{ context: "none", contextMode: "isolated", memory: "none" },
			{ context: "session", contextMode: "contextual", memory: "session" },
			{ context: "relevant", contextMode: "contextual", memory: "relevant" },
		] as const;
		for (const { context, contextMode, memory } of cases) {
			const resolved = resolveSubAgentConfig([model], model, [], {
				systemPrompt: "Work",
				context,
			});
			expect(resolved.config).toMatchObject({ contextMode, memory });
		}

		// An unset context leaves a predefined agent's frontmatter pair untouched.
		const inherited = resolveSubAgentConfig(
			[model],
			model,
			[makeSubAgentConfig({ contextMode: "contextual", memory: "session" })],
			{ agent: "reviewer" },
		);
		expect(inherited.config).toMatchObject({ contextMode: "contextual", memory: "session" });

		expect(
			resolveSubAgentConfig([model], model, [], { systemPrompt: "Work", context: "everything" }).error,
		).toContain('Unknown context "everything"');
	});

	it("applies effort presets as whole tuples, overriding frontmatter budgets", () => {
		const budgeted = makeSubAgentConfig({ maxTurns: 5, maxToolCalls: 6, maxWallTimeSec: 7, bashTimeoutSec: 8 });

		// No effort: the frontmatter numbers survive untouched.
		expect(resolveSubAgentConfig([model], model, [budgeted], { agent: "reviewer" }).config).toMatchObject({
			maxTurns: 5,
			maxToolCalls: 6,
			maxWallTimeSec: 7,
			bashTimeoutSec: 8,
		});

		// An explicit effort replaces every budget field, not just the ones it happens to differ on.
		expect(
			resolveSubAgentConfig([model], model, [budgeted], { agent: "reviewer", effort: "quick" }).config,
		).toMatchObject(SUB_AGENT_EFFORT_PRESETS.quick);
		expect(
			resolveSubAgentConfig([model], model, [budgeted], { agent: "reviewer", effort: "deep" }).config,
		).toMatchObject(SUB_AGENT_EFFORT_PRESETS.deep);

		// standard is byte-identical to the built-in defaults an unconfigured inline agent gets.
		const inlineDefault = resolveSubAgentConfig([model], model, [], { systemPrompt: "Work" }).config;
		expect(inlineDefault).toMatchObject(SUB_AGENT_EFFORT_PRESETS.standard);

		expect(resolveSubAgentConfig([model], model, [], { systemPrompt: "Work", effort: "extreme" }).error).toContain(
			'Unknown effort "extreme"',
		);
	});

	it("lets a sub-agent request grep, which the tool registry already exposes to sub-agents", () => {
		const resolved = resolveSubAgentConfig([model], model, [], {
			systemPrompt: "Search the repo",
			tools: ["read", "grep"],
		});
		expect(resolved.error).toBeUndefined();
		expect(resolved.config?.tools).toEqual(["read", "grep"]);
	});

	it("resolves current model by default and rejects overly long inline prompts", () => {
		const resolved = resolveSubAgentConfig([model], model, [], {
			name: "inline-reviewer",
			systemPrompt: "Review files",
			context: "relevant",
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

	it("resolves the sub-agent model in priority order: invocation > frontmatter > settings default > parent", () => {
		const availableModels = [model, altModel];

		// No invocation model, no frontmatter model, no settings default: falls back to the parent's model.
		const parentFallback = resolveSubAgentConfig(availableModels, model, [], {
			name: "worker",
			systemPrompt: "Do the work",
		});
		expect(parentFallback.config?.model).toBe(model);

		// settings.subagentModel wins over the parent when nothing more specific is set.
		const settingsDefault = resolveSubAgentConfig(
			availableModels,
			model,
			[],
			{ name: "worker", systemPrompt: "Do the work" },
			"openai/gpt-4o",
		);
		expect(settingsDefault.config?.model).toBe(altModel);

		// A predefined agent's frontmatter model wins over the settings default.
		const withFrontmatterModel = makeSubAgentConfig();
		const frontmatterWins = resolveSubAgentConfig(
			availableModels,
			altModel,
			[withFrontmatterModel],
			{ agent: "reviewer" },
			"openai/gpt-4o",
		);
		expect(frontmatterWins.config?.model).toBe(model);

		// The invocation's own `model` param wins over everything else.
		const invocationWins = resolveSubAgentConfig(
			availableModels,
			model,
			[withFrontmatterModel],
			{ agent: "reviewer", model: "openai/gpt-4o" },
			"openai/gpt-4o",
		);
		expect(invocationWins.config?.model).toBe(altModel);

		// A settings default that doesn't resolve is a clear error, not a silent fallback.
		const badDefault = resolveSubAgentConfig(
			availableModels,
			model,
			[],
			{ name: "worker", systemPrompt: "Do the work" },
			"openai/does-not-exist",
		);
		expect(badDefault.error).toContain("was not found among available models");
	});

	it("defaults thinkingLevel by purpose and lets frontmatter/overrides win", () => {
		const workAgent = resolveSubAgentConfig([model], model, [], {
			name: "worker",
			systemPrompt: "Do the work",
		});
		expect(workAgent.config?.thinkingLevel).toBe("off");

		const verifyAgent = resolveSubAgentConfig([model], model, [], {
			name: "checker",
			systemPrompt: "Check the work",
			purpose: "verify",
		});
		expect(verifyAgent.config?.thinkingLevel).toBe("medium");

		const overridden = resolveSubAgentConfig([model], model, [], {
			name: "checker",
			systemPrompt: "Check the work",
			purpose: "verify",
			thinkingLevel: "high",
		});
		expect(overridden.config?.thinkingLevel).toBe("high");

		const workspaceDir = createTempWorkspace();
		const subAgentsDir = getSubAgentsDir(workspaceDir);
		mkdirSync(subAgentsDir, { recursive: true });
		writeFileSync(
			join(subAgentsDir, "checker.md"),
			`---\nname: checker\ndescription: verify\nthinkingLevel: low\n---\n\nVerify the DoD.`,
			"utf-8",
		);
		const discovery = discoverSubAgents(workspaceDir, [model]);
		expect(discovery.agents[0]?.thinkingLevel).toBe("low");
		const resolvedFromFrontmatter = resolveSubAgentConfig([model], model, discovery.agents, {
			agent: "checker",
			purpose: "verify",
		});
		expect(resolvedFromFrontmatter.config?.thinkingLevel).toBe("low");
	});

	it("returns no named agents when the workspace directory is empty", () => {
		const workspaceDir = createTempWorkspace();
		const discovery = discoverSubAgents(workspaceDir, [model]);
		expect(discovery.agents).toEqual([]);
		expect(discovery.warnings).toEqual([]);
	});

	it("discovers only the workspace file and keeps its configured source", () => {
		const workspaceDir = createTempWorkspace();
		const subAgentsDir = getSubAgentsDir(workspaceDir);
		mkdirSync(subAgentsDir, { recursive: true });
		writeFileSync(
			join(subAgentsDir, "explorer.md"),
			`---\nname: explorer\ndescription: custom explorer\n---\n\nCustom exploration behavior.`,
			"utf-8",
		);

		const discovery = discoverSubAgents(workspaceDir, [model]);
		const explorers = discovery.agents.filter((agent) => agent.name === "explorer");
		expect(explorers).toHaveLength(1);
		expect(explorers[0]).toMatchObject({ source: "predefined", description: "custom explorer" });
		expect(discovery.warnings).toEqual([]);
	});
});

describe("sub-agent tool", () => {
	it("creates a durable read-only verifier attestation", async () => {
		const workspaceDir = createTempWorkspace();
		const channelDir = join(workspaceDir, "dm_123");
		mkdirSync(join(channelDir, "tasks"), { recursive: true });
		writeFileSync(join(channelDir, "tasks", "ship.md"), "---\nstatus: open\n---\n# Ship\n\n## DoD\n- checks pass\n");
		let delegatedTask = "";
		const tool = createSubAgentTool({
			executor: fakeExecutor,
			getCurrentModel: () => model,
			getAvailableModels: () => [model],
			resolveApiKey: async () => "test-key",
			workspaceDir,
			channelDir,
			runtimeContext: { workspaceDir, channelId: "dm_123" },
			createWorker: () =>
				new FakeWorker((input, worker) => {
					delegatedTask = input;
					const message = createAssistantMessage("All DoD checks passed.\nVERDICT: PASS");
					worker.state.messages = [message];
					worker.emit({ type: "message_end", message });
				}),
		});

		const result = await tool.execute("verify-call-1", {
			label: "verify ship",
			name: "independent-verifier",
			systemPrompt: "Verify evidence independently.",
			tools: ["read", "bash"],
			task: "Run the acceptance plan.",
			purpose: "verify",
			taskId: "ship",
		});
		expect(result.details).toMatchObject({
			runId: "verify-call-1",
			purpose: "verify",
			taskId: "ship",
			verificationVerdict: "pass",
		});
		expect(delegatedTask).toContain(join(channelDir, "tasks", "ship.md"));
		expect(delegatedTask).toContain("VERDICT: PASS or VERDICT: FAIL");
		await expect(readVerificationAttestation(channelDir, "verify-call-1")).resolves.toMatchObject({
			taskId: "ship",
			verdict: "pass",
			workspaceChanged: false,
		});
	});

	it("runs implementation in a task-owned git worktree", async () => {
		const workspaceDir = createTempWorkspace();
		const repoDir = join(workspaceDir, "repo");
		const channelDir = join(workspaceDir, "dm_123");
		mkdirSync(repoDir, { recursive: true });
		mkdirSync(join(channelDir, "tasks"), { recursive: true });
		writeFileSync(
			join(channelDir, "tasks", "ship.md"),
			renderTaskDocument({ status: "open", control: createDefaultTaskControl() }, "# Ship\n"),
		);
		execFileSync("git", ["-C", repoDir, "init", "-q"]);
		execFileSync("git", ["-C", repoDir, "config", "user.email", "test@example.com"]);
		execFileSync("git", ["-C", repoDir, "config", "user.name", "Test"]);
		writeFileSync(join(repoDir, "README.md"), "base\n");
		execFileSync("git", ["-C", repoDir, "add", "README.md"]);
		execFileSync("git", ["-C", repoDir, "commit", "-qm", "base"]);
		let delegatedTask = "";
		const tool = createSubAgentTool({
			executor: createExecutor(),
			workingDirectory: repoDir,
			getCurrentModel: () => model,
			getAvailableModels: () => [model],
			resolveApiKey: async () => "test-key",
			workspaceDir,
			channelDir,
			runtimeContext: { workspaceDir, channelId: "dm_123" },
			createWorker: () =>
				new FakeWorker((input, worker) => {
					delegatedTask = input;
					const message = createAssistantMessage("Implementation complete.");
					worker.state.messages = [message];
					worker.emit({ type: "message_end", message });
				}),
		});

		const result = await tool.execute("worktree-call-1", {
			label: "isolated implementation",
			name: "implementer",
			systemPrompt: "Implement the requested change.",
			tools: ["read", "bash", "write", "edit"],
			task: "Implement in the isolated checkout.",
			taskId: "ship",
			isolation: "worktree",
		});
		expect(result.details.isolation).toBe("worktree");
		expect(result.details.worktreeBranch).toMatch(/^pipiclaw-task\/ship\//);
		expect(result.details.worktreePath && existsSync(result.details.worktreePath)).toBe(true);
		expect(delegatedTask).toContain("Filesystem isolation: dedicated git worktree");
		expect(delegatedTask).toContain(result.details.worktreePath);
		const task = readFileSync(join(channelDir, "tasks", "ship.md"), "utf-8");
		expect(task).toContain(`"worktree":{"path":"${result.details.worktreePath}"`);
		expect(task).toContain(result.details.worktreeBranch);
	});

	it("reuses the worktree recorded on the task instead of creating a rival one", async () => {
		const { workspaceDir, repoDir, channelDir } = createWorktreeFixture();
		const tool = createWorktreeTool(workspaceDir, repoDir, channelDir);

		const first = await tool.execute("worktree-reuse-1", worktreeParams);
		const second = await tool.execute("worktree-reuse-2", worktreeParams);

		expect(second.details.worktreePath).toBe(first.details.worktreePath);
		expect(second.details.worktreeBranch).toBe(first.details.worktreeBranch);
		const listed = execFileSync("git", ["-C", repoDir, "worktree", "list"], { encoding: "utf-8" });
		expect(listed.split("\n").filter((line) => line.includes("pipiclaw-task/ship"))).toHaveLength(1);
	});

	it("creates a fresh worktree when the recorded path no longer exists on disk", async () => {
		const { workspaceDir, repoDir, channelDir } = createWorktreeFixture();
		recordWorktreeOnTask(channelDir, join(channelDir, "tasks", "worktrees", "ship", "gone"));
		const tool = createWorktreeTool(workspaceDir, repoDir, channelDir);

		const result = await tool.execute("worktree-stale-1", worktreeParams);

		expect(result.details.worktreePath).not.toContain("gone");
		expect(result.details.worktreePath && existsSync(result.details.worktreePath)).toBe(true);
	});

	it("refuses to delegate when the task records a worktree outside the channel worktrees dir", async () => {
		const { workspaceDir, repoDir, channelDir } = createWorktreeFixture();
		recordWorktreeOnTask(channelDir, repoDir);
		const tool = createWorktreeTool(workspaceDir, repoDir, channelDir);

		await expect(tool.execute("worktree-escape-1", worktreeParams)).rejects.toThrow(
			/records a worktree outside .*Clear it with task_manage/s,
		);
	});

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
			getSubAgentDiscovery: makeDiscovery(workspaceDir, [makeSubAgentConfig()]),
			runtimeContext: {
				workspaceDir: "/workspace/root",
				channelId: "dm_123",
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
		expect(delegatedTask).toContain("Filesystem isolation: shared with parent");
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
			getSubAgentDiscovery: makeDiscovery(workspaceDir, [
				makeSubAgentConfig({
					contextMode: "contextual",
					memory: "relevant",
					paths: ["src/core.ts", "test/core.test.ts"],
				}),
			]),
			runtimeContext: {
				workspaceDir: "/workspace/root",
				channelId: "dm_123",
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
		expect(delegatedTask).toContain(
			"Earlier review found missing regression coverage around src/core.ts fallback behavior.",
		);
	});

	it("uses settings.subagentModel when neither the invocation nor a predefined agent names a model (D5)", async () => {
		const workspaceDir = createTempWorkspace();
		const channelDir = join(workspaceDir, "dm_123");
		mkdirSync(channelDir, { recursive: true });
		let usedModel: Model<Api> | undefined;
		const tool = createSubAgentTool({
			executor: fakeExecutor,
			getCurrentModel: () => model,
			getAvailableModels: () => [model, altModel],
			resolveApiKey: async () => "test-key",
			workspaceDir,
			channelDir,
			runtimeContext: { workspaceDir, channelId: "dm_123" },
			getSubAgentModelReference: () => "openai/gpt-4o",
			createWorker: (config) => {
				usedModel = config.subAgent.model;
				return new FakeWorker((_input, worker) => {
					const message = createAssistantMessage("Done.");
					worker.state.messages = [message];
					worker.emit({ type: "message_end", message });
				});
			},
		});

		await tool.execute("call-3", {
			label: "explore",
			name: "explorer",
			systemPrompt: "Explore the codebase.",
			task: "Find the entrypoint.",
		});

		expect(usedModel).toBe(altModel);
	});
});

describe("sub-agent artifact contract (D4)", () => {
	function makeTool(
		workspaceDir: string,
		channelDir: string,
		respond: (input: string, worker: FakeWorker) => Promise<void> | void,
	) {
		return createSubAgentTool({
			executor: fakeExecutor,
			getCurrentModel: () => model,
			getAvailableModels: () => [model],
			resolveApiKey: async () => "test-key",
			workspaceDir,
			channelDir,
			runtimeContext: { workspaceDir, channelId: "dm_123" },
			createWorker: () => new FakeWorker(respond),
		});
	}

	it("creates the artifact directory and tells the sub-agent where it is", async () => {
		const workspaceDir = createTempWorkspace();
		const channelDir = join(workspaceDir, "dm_123");
		mkdirSync(channelDir, { recursive: true });
		let delegatedTask = "";
		const tool = makeTool(workspaceDir, channelDir, (input, worker) => {
			delegatedTask = input;
			const message = createAssistantMessage("Done.");
			worker.state.messages = [message];
			worker.emit({ type: "message_end", message });
		});

		const result = await tool.execute("artifact-call-1", {
			label: "explore",
			name: "explorer",
			systemPrompt: "Explore the codebase.",
			task: "Find the entrypoint.",
		});

		expect(result.details.artifactDir).toContain(join("subagent-artifacts", "artifact-call-1"));
		expect(existsSync(result.details.artifactDir)).toBe(true);
		expect(delegatedTask).toContain(`Artifact directory: ${result.details.artifactDir}`);
		expect(readFileSync(join(result.details.artifactDir, "output.md"), "utf-8")).toBe("Done.");
		expect(result.details.resultTruncated).toBe(false);
	});

	it("parses the ARTIFACT: marker when returns=artifact", async () => {
		const workspaceDir = createTempWorkspace();
		const channelDir = join(workspaceDir, "dm_123");
		mkdirSync(channelDir, { recursive: true });
		let delegatedTask = "";
		const tool = makeTool(workspaceDir, channelDir, (input, worker) => {
			delegatedTask = input;
			const message = createAssistantMessage("Findings written.\nARTIFACT: findings.md");
			worker.state.messages = [message];
			worker.emit({ type: "message_end", message });
		});

		const result = await tool.execute("artifact-call-2", {
			label: "explore",
			name: "explorer",
			systemPrompt: "Explore the codebase.",
			task: "Find the entrypoint.",
			returns: "artifact",
		});

		expect(delegatedTask).toContain("ARTIFACT: <filename>");
		expect(result.details.artifactPath).toBe(join(result.details.artifactDir, "findings.md"));
	});

	it("downgrades to plain text when returns=artifact but the marker is missing", async () => {
		const workspaceDir = createTempWorkspace();
		const channelDir = join(workspaceDir, "dm_123");
		mkdirSync(channelDir, { recursive: true });
		const tool = makeTool(workspaceDir, channelDir, (_input, worker) => {
			const message = createAssistantMessage("Findings written, but I forgot the marker.");
			worker.state.messages = [message];
			worker.emit({ type: "message_end", message });
		});

		const result = await tool.execute("artifact-call-3", {
			label: "explore",
			name: "explorer",
			systemPrompt: "Explore the codebase.",
			task: "Find the entrypoint.",
			returns: "artifact",
		});

		expect(result.details.artifactPath).toBeUndefined();
		expect(result.content[0] && "text" in result.content[0] ? result.content[0].text : "").toContain(
			"Findings written, but I forgot the marker.",
		);
	});

	it("truncates an over-budget reply but keeps the full text on disk", async () => {
		const workspaceDir = createTempWorkspace();
		const channelDir = join(workspaceDir, "dm_123");
		mkdirSync(channelDir, { recursive: true });
		const longText = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(" ");
		const tool = makeTool(workspaceDir, channelDir, (_input, worker) => {
			const message = createAssistantMessage(longText);
			worker.state.messages = [message];
			worker.emit({ type: "message_end", message });
		});

		const result = await tool.execute("artifact-call-4", {
			label: "explore",
			name: "explorer",
			systemPrompt: "Explore the codebase.",
			task: "Summarize the whole repo.",
		});

		expect(result.details.resultTruncated).toBe(true);
		const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
		expect(text.length).toBeLessThan(longText.length);
		expect(text).toContain(join(result.details.artifactDir, "output.md"));
		expect(readFileSync(join(result.details.artifactDir, "output.md"), "utf-8")).toBe(longText);
	});
});

describe("sub-agent convergence turn (D6)", () => {
	// Budgets are no longer settable per invocation, so the tight budget these tests need
	// comes from frontmatter — which also keeps them covering "exact numbers still work".
	const tightBudgetExplorer = makeSubAgentConfig({
		name: "explorer",
		description: "explore the repo",
		systemPrompt: "Explore the codebase.",
		maxToolCalls: 2,
	});

	it("gives a tool-budget abort one tool-free turn to report its conclusions", async () => {
		const workspaceDir = createTempWorkspace();
		const channelDir = join(workspaceDir, "dm_123");
		mkdirSync(channelDir, { recursive: true });
		let callCount = 0;
		const seenInputs: string[] = [];
		const tool = createSubAgentTool({
			executor: fakeExecutor,
			getCurrentModel: () => model,
			getAvailableModels: () => [model],
			resolveApiKey: async () => "test-key",
			workspaceDir,
			channelDir,
			getSubAgentDiscovery: makeDiscovery(workspaceDir, [tightBudgetExplorer]),
			runtimeContext: { workspaceDir, channelId: "dm_123" },
			createWorker: () =>
				new FakeWorker((input, worker) => {
					callCount++;
					seenInputs.push(input);
					if (callCount === 1) {
						for (let i = 0; i < 3; i++) {
							worker.emit({ type: "tool_execution_start", toolCallId: `t${i}`, toolName: "read", args: {} });
						}
						const message = createAssistantMessage("");
						worker.state.messages = [message];
						worker.emit({ type: "message_end", message });
						return;
					}
					const message = createAssistantMessage(
						"Confirmed: found the entrypoint. Unfinished: did not check error paths. Next: read src/index.ts.",
					);
					worker.state.messages = [...worker.state.messages, message];
					worker.emit({ type: "message_end", message });
				}),
		});

		const result = await tool.execute("converge-call-1", {
			label: "explore",
			agent: "explorer",
			task: "Map the whole repo.",
		});

		expect(callCount).toBe(2);
		expect(seenInputs[1]).toContain("Do not call any more tools.");
		expect(result.details.failed).toBe(true);
		expect(result.details.failureReason).toContain("Tool call budget exceeded");
		const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
		expect(text).toContain("Confirmed: found the entrypoint.");
	});

	it("reverts to the pre-convergence state when the convergence turn itself times out", async () => {
		const workspaceDir = createTempWorkspace();
		const channelDir = join(workspaceDir, "dm_123");
		mkdirSync(channelDir, { recursive: true });
		let callCount = 0;
		const tool = createSubAgentTool({
			executor: fakeExecutor,
			getCurrentModel: () => model,
			getAvailableModels: () => [model],
			resolveApiKey: async () => "test-key",
			workspaceDir,
			channelDir,
			getSubAgentDiscovery: makeDiscovery(workspaceDir, [tightBudgetExplorer]),
			runtimeContext: { workspaceDir, channelId: "dm_123" },
			// Real, tiny wall clock: exercises the actual setTimeout/clearTimeout path without
			// the flakiness of mixing fake timers with the real fs I/O prepareRunContext does.
			convergenceWallClockMs: 20,
			createWorker: () =>
				new FakeWorker((_input, worker) => {
					callCount++;
					if (callCount === 1) {
						for (let i = 0; i < 3; i++) {
							worker.emit({ type: "tool_execution_start", toolCallId: `t${i}`, toolName: "read", args: {} });
						}
						const message = createAssistantMessage("Partial progress note.");
						worker.state.messages = [message];
						worker.emit({ type: "message_end", message });
						return;
					}
					// Simulate a convergence turn that only settles once aborted (i.e. it hangs).
					return new Promise<void>((resolvePrompt) => {
						worker.onAbort = () => resolvePrompt();
					});
				}),
		});

		const result = await tool.execute("converge-call-2", {
			label: "explore",
			agent: "explorer",
			task: "Map the whole repo.",
		});

		expect(callCount).toBe(2);
		const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
		expect(text).toContain("Partial progress note.");
		expect(result.details.failed).toBe(true);
		expect(result.details.failureReason).toContain("Tool call budget exceeded");
	});

	it("does not run a convergence turn when the parent aborts (/stop), even if the budget was also hit", async () => {
		const workspaceDir = createTempWorkspace();
		const channelDir = join(workspaceDir, "dm_123");
		mkdirSync(channelDir, { recursive: true });
		let callCount = 0;
		const controller = new AbortController();
		const tool = createSubAgentTool({
			executor: fakeExecutor,
			getCurrentModel: () => model,
			getAvailableModels: () => [model],
			resolveApiKey: async () => "test-key",
			workspaceDir,
			channelDir,
			getSubAgentDiscovery: makeDiscovery(workspaceDir, [tightBudgetExplorer]),
			runtimeContext: { workspaceDir, channelId: "dm_123" },
			createWorker: () =>
				new FakeWorker((_input, worker) => {
					callCount++;
					for (let i = 0; i < 3; i++) {
						worker.emit({ type: "tool_execution_start", toolCallId: `t${i}`, toolName: "read", args: {} });
					}
					// The user hits /stop in the same tick the budget trips; /stop must win.
					controller.abort();
					const message = createAssistantMessage("");
					worker.state.messages = [message];
					worker.emit({ type: "message_end", message });
				}),
		});

		await expect(
			tool.execute(
				"converge-call-3",
				{
					label: "explore",
					agent: "explorer",
					task: "Map the whole repo.",
				},
				controller.signal,
			),
		).rejects.toThrow("Sub-agent aborted");
		expect(callCount).toBe(1);
	});
});
