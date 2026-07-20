import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { handleSessionEvent, type SessionEventHandlerContext } from "../src/agent/session-events.js";
import { createEmptyRunState, type RunQueue, type RunState } from "../src/agent/types.js";
import { createMemoryCandidateStore } from "../src/memory/candidates.js";
import type { ChannelContext } from "../src/runtime/channel-context.js";
import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";
import { RecoverableToolError } from "../src/shared/recoverable-error.js";
import { DEFAULT_TOOLS_CONFIG } from "../src/tools/config.js";
import { buildToolSet, type ToolBuildContext } from "../src/tools/registry.js";
import { isRecoverableRejection, toolResultDetails, withToolDetails } from "../src/tools/tool-details.js";

function registryContext(): ToolBuildContext {
	return {
		executor: { exec: async () => ({ stdout: "", stderr: "", code: 1 }) },
		securityConfig: DEFAULT_SECURITY_CONFIG,
		securityContext: { workspaceDir: "/tmp/ws", cwd: "/tmp/ws" },
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
	it("stamps the registered kind onto a result that carries none", async () => {
		const result = await run(async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }));

		expect(toolResultDetails(result)).toEqual({ kind: "task_manage" });
	});

	it("preserves tool-specific detail fields while stamping kind", async () => {
		const result = await run(async () => ({
			content: [{ type: "text", text: "ok" }],
			details: { op: "list", count: 3 },
		}));

		expect(result.details).toEqual({ op: "list", count: 3, kind: "task_manage" });
	});

	it("makes the registered name authoritative over a kind the tool set itself", async () => {
		// Guards the drift this contract exists to prevent: a hand-written kind can no longer
		// disagree with the name the tool is registered under.
		const result = await run(async () => ({
			content: [{ type: "text", text: "ok" }],
			details: { kind: "something_stale" },
		}));

		expect(toolResultDetails(result)?.kind).toBe("task_manage");
	});

	it("keeps other result fields (terminate, addedToolNames) intact", async () => {
		const result = await run(async () => ({
			content: [{ type: "text", text: "ok" }],
			details: undefined,
			terminate: true,
		}));

		expect(result.terminate).toBe(true);
	});

	it("reads no details off a malformed or absent result", () => {
		expect(toolResultDetails(null)).toBeNull();
		expect(toolResultDetails({ content: [] })).toBeNull();
		expect(toolResultDetails({ details: "not-an-object" })).toBeNull();
		expect(toolResultDetails({ details: { noKind: true } })).toBeNull();
	});
});

describe("recoverable rejection", () => {
	it("returns a RecoverableToolError as a normal result the model can read", async () => {
		const result = await run(async () => {
			throw new RecoverableToolError('action "create" requires an id.');
		});

		expect(result.content[0]).toEqual({ type: "text", text: 'Rejected: action "create" requires an id.' });
		expect(isRecoverableRejection(result)).toBe(true);
		expect(toolResultDetails(result)?.kind).toBe("task_manage");
	});

	it("still throws a genuine failure, so the user keeps seeing it", async () => {
		await expect(
			run(async () => {
				throw new Error("Command blocked [network]");
			}),
		).rejects.toThrow("Command blocked [network]");
	});

	it("does not mark ordinary results as rejections", async () => {
		const result = await run(async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }));

		expect(isRecoverableRejection(result)).toBe(false);
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

	it("still shows an error bubble for a real tool failure", async () => {
		const respond = vi.fn(async (_text: string, _final?: boolean) => {});
		const ctx = createContext(respond);

		await endEvent(
			ctx,
			{ content: [{ type: "text", text: "Command blocked [network]" }], details: { kind: "bash" } },
			true,
		);

		expect(respond).toHaveBeenCalledTimes(1);
		expect(String(respond.mock.calls[0][0])).toContain("Command blocked");
	});

	it("still shows an error bubble for a gate only the user can clear", async () => {
		// An approval gate is thrown as a plain Error, so it arrives with isError and must
		// remain visible: the user is the one who has to run /tasks approve.
		const respond = vi.fn(async (_text: string, _final?: boolean) => {});
		const ctx = createContext(respond);

		await endEvent(
			ctx,
			{
				content: [{ type: "text", text: 'Task "x" requires explicit external-action approval' }],
				details: { kind: "task_manage" },
			},
			true,
		);

		expect(respond).toHaveBeenCalledTimes(1);
		expect(String(respond.mock.calls[0][0])).toContain("external-action approval");
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
});
