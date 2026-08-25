import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { handleSessionEvent, type SessionEventHandlerContext } from "../src/agent/session-events.js";
import { createEmptyRunState, type RunQueue, type RunState } from "../src/agent/types.js";
import { createFileStore } from "../src/file-store.js";
import { createMemoryCandidateStore } from "../src/memory/candidates.js";
import type { ChannelContext } from "../src/runtime/channel-context.js";
import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";
import { RecoverableToolError } from "../src/shared/recoverable-error.js";
import { createSubAgentTool } from "../src/subagents/tool.js";
import { DEFAULT_TOOLS_CONFIG } from "../src/tools/config.js";
import { buildToolSet, type ToolBuildContext } from "../src/tools/registry.js";
import { isRecoverableRejection, toolResultDetails, withToolDetails } from "../src/tools/tool-details.js";

function registryContext(): ToolBuildContext {
	return {
		executor: { exec: async () => ({ stdout: "", stderr: "", code: 1 }) },
		fileStore: createFileStore(),
		securityConfig: DEFAULT_SECURITY_CONFIG,
		securityContext: { agentWorkspaceDir: "/tmp/ws", projectRoot: "/tmp/ws" },
		channelId: "dm_1",
		channelDir: "/tmp/ws/dm_1",
		workspaceDir: "/tmp/ws",
		webConfig: { ...DEFAULT_TOOLS_CONFIG.tools.web, enable: true },
		toolsConfig: DEFAULT_TOOLS_CONFIG,
		getCurrentModel: () => ({}) as never,
		getAvailableModels: () => [],
		resolveApiKey: async () => "key",
		getSessionSearchSettings: () => ({}) as never,
		memoryCandidateStore: createMemoryCandidateStore(),
	};
}

import type { UsageLedger } from "../src/usage/ledger.js";

const schema = Type.Object({ label: Type.String() });

function tool(execute: AgentTool<typeof schema>["execute"]): AgentTool<typeof schema> {
	return { name: "probe", label: "probe", description: "probe", parameters: schema, execute };
}

async function run(inner: AgentTool<typeof schema>["execute"]) {
	return withToolDetails(tool(inner), "task_manage").execute("call-1", { label: "l" });
}

describe("details contract", () => {
	it("stamps the registered kind onto every result shape it wraps", async () => {
		const unstamped = await run(async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }));
		expect(toolResultDetails(unstamped)).toEqual({ kind: "task_manage" });

		const withFields = await run(async () => ({
			content: [{ type: "text", text: "ok" }],
			details: { op: "list", count: 3 },
		}));
		expect(withFields.details).toEqual({ op: "list", count: 3, kind: "task_manage" });

		// Guards the drift this contract exists to prevent: a hand-written kind can no longer
		// disagree with the name the tool is registered under.
		const staleKind = await run(async () => ({
			content: [{ type: "text", text: "ok" }],
			details: { kind: "something_stale" },
		}));
		expect(toolResultDetails(staleKind)?.kind).toBe("task_manage");
	});

	it("reads no details off a malformed or absent result", () => {
		expect(toolResultDetails(null)).toBeNull();
		expect(toolResultDetails({ content: [] })).toBeNull();
		expect(toolResultDetails({ details: "not-an-object" })).toBeNull();
		expect(toolResultDetails({ details: { noKind: true } })).toBeNull();
	});
});

describe("recoverable rejection", () => {
	it("returns a RecoverableToolError as a normal result the model can read, without mislabeling ordinary results", async () => {
		const rejected = await run(async () => {
			throw new RecoverableToolError('action "create" requires an id.');
		});

		expect(rejected.content[0]).toEqual({ type: "text", text: 'Rejected: action "create" requires an id.' });
		expect(isRecoverableRejection(rejected)).toBe(true);
		expect(toolResultDetails(rejected)?.kind).toBe("task_manage");

		const ordinary = await run(async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }));
		expect(isRecoverableRejection(ordinary)).toBe(false);
	});

	it("still throws a genuine failure, so the user keeps seeing it", async () => {
		await expect(
			run(async () => {
				throw new Error("Command blocked [network]");
			}),
		).rejects.toThrow("Command blocked [network]");
	});
});

function createQueue(): RunQueue {
	return {
		enqueue: async (fn) => {
			await fn();
		},
	};
}

function createContext(respond: ReturnType<typeof vi.fn>): ChannelContext {
	return {
		message: { text: "", rawText: "", user: "u", userName: "U", channel: "dm_1", ts: "1" },
		respond,
		respondPlain: vi.fn(async () => true),
		replaceMessage: vi.fn(async () => {}),
		respondInThread: vi.fn(async () => {}),
		setTyping: vi.fn(async () => {}),
		setWorking: vi.fn(async () => {}),
		deleteMessage: vi.fn(async () => {}),
		primeCard: vi.fn(),
		flush: vi.fn(async () => {}),
		close: vi.fn(async () => {}),
		progressStyle: "full",
		finalDelivery: "plain",
	} as unknown as ChannelContext;
}

function handlerContext(ctx: ChannelContext, runState: RunState): SessionEventHandlerContext {
	return {
		ctx,
		logCtx: { channelId: "dm_1", userName: "U" },
		queue: createQueue(),
		pendingTools: new Map(),
		store: null,
		runState,
		memoryLifecycle: { noteToolCall() {}, noteCompletedAssistantTurn() {} } as never,
		ledger: { record: () => {}, summarize: () => ({}) } as unknown as UsageLedger,
	};
}

async function endEvent(ctx: ChannelContext, result: unknown, isError: boolean) {
	await handleSessionEvent(
		{ type: "tool_execution_end", toolCallId: "c1", toolName: "task_manage", result, isError },
		handlerContext(ctx, createEmptyRunState()),
	);
}

describe("rejections stay out of the user's chat", () => {
	it("shows no error bubble for a rejection the model can fix itself", async () => {
		const respond = vi.fn(async (_text: string, _final?: boolean) => {});
		const ctx = createContext(respond);

		await endEvent(
			ctx,
			{
				content: [{ type: "text", text: "Rejected: requires an id." }],
				details: { kind: "task_manage", recoverable: true },
			},
			false,
		);

		expect(respond).not.toHaveBeenCalled();
	});

	it("still shows an error bubble for a real tool failure or a user-only scope decision", async () => {
		const respond = vi.fn(async (_text: string, _final?: boolean) => {});
		const failureCtx = createContext(respond);

		await endEvent(
			failureCtx,
			{ content: [{ type: "text", text: "Command blocked [network]" }], details: { kind: "bash" } },
			true,
		);

		expect(respond).toHaveBeenCalledTimes(1);
		expect(String(respond.mock.calls[0][0])).toContain("Command blocked");

		// A user-only scope decision is thrown as a plain Error, so it arrives with isError and
		// must remain visible instead of being treated as model-fixable tool validation.
		const scopeCtx = createContext(vi.fn(async (_text: string, _final?: boolean) => {}));
		await endEvent(
			scopeCtx,
			{
				content: [{ type: "text", text: 'Task "x" requires a user decision outside its current scope' }],
				details: { kind: "task_manage" },
			},
			true,
		);

		expect(scopeCtx.respond).toHaveBeenCalledTimes(1);
		expect(String((scopeCtx.respond as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain(
			"user decision outside its current scope",
		);
	});
});

describe("registry wiring", () => {
	it("delivers a real task_manage validation failure as a rejection, not a thrown error", async () => {
		// End-to-end through buildToolSet: the same call used to reach the user as a red
		// error bubble mid-turn; it must now come back as data the model can act on.
		const tools = buildToolSet(registryContext());
		const taskManage = tools.find((entry) => entry.name === "task_manage");
		if (!taskManage) throw new Error("task_manage not registered");

		const result = await taskManage.execute("c1", { label: "create", action: "create" });

		expect(isRecoverableRejection(result)).toBe(true);
		expect(JSON.stringify(result.content[0])).toContain("requires an id");
	});

	it("stamps every registry tool's results with its registered name", async () => {
		const tools = buildToolSet(registryContext());
		const grep = tools.find((entry) => entry.name === "grep");
		if (!grep) throw new Error("grep not registered");

		const result = await grep.execute("c1", { label: "search", pattern: "x", path: "/tmp/ws" });

		expect(toolResultDetails(result)?.kind).toBe("grep");
	});

	it("delivers a real subagent admission rejection (unknown role) as a rejection, not a thrown error (P1-5)", async () => {
		// `subagent` is wired the same way as every registry tool (tools/index.ts), just outside
		// buildToolSet to avoid an import cycle — wire it identically here.
		const tool = withToolDetails(
			createSubAgentTool({
				executor: { exec: async () => ({ stdout: "", stderr: "", code: 0 }) },
				fileStore: createFileStore(),
				getCurrentModel: () => ({}) as never,
				getAvailableModels: () => [],
				resolveApiKey: async () => "key",
				workspaceDir: "/tmp/ws",
				channelDir: "/tmp/ws/dm_1",
				runtimeContext: { workspaceDir: "/tmp/ws", channelId: "dm_1" },
			}),
			"subagent",
		);

		const result = await tool.execute("c1", { label: "delegate", agent: "no-such-role", task: "do the thing" });

		expect(isRecoverableRejection(result)).toBe(true);
		expect(JSON.stringify(result.content[0])).toContain("Unknown sub-agent");
	});
});
