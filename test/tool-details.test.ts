import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { handleSessionEvent, type SessionEventHandlerContext } from "../src/agent/session/session-events.js";
import { TurnOutput } from "../src/agent/turn/turn-output.js";
import { createEmptyRunState, type RunQueue, type RunState } from "../src/agent/types.js";
import type { TurnEvent } from "../src/channel/channel-context.js";
import { DEFAULT_TOOLS_CONFIG } from "../src/config/tools.js";
import { createFileStore } from "../src/file-store.js";
import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";
import { RecoverableToolError } from "../src/shared/recoverable-error.js";
import { isRecoverableRejection, toolResultDetails, withToolDetails } from "../src/tools/contract/details.js";
import { buildToolSet, type ToolBuildContext } from "../src/tools/registry.js";
import { createSubAgentTool } from "../src/tools/subagent.js";
import { testManagers } from "./helpers/background-runtime.js";

function registryContext(): ToolBuildContext {
	return {
		executor: { exec: async () => ({ stdout: "", stderr: "", code: 1 }) },
		fileStore: createFileStore(),
		securityConfig: DEFAULT_SECURITY_CONFIG,
		securityContext: { agentWorkspaceDir: "/tmp/ws", cwd: "/tmp/ws" },
		channelId: "dingtalk:dm:1",
		desk: "news",
		deskDir: "/tmp/ws/dingtalk:dm:1",
		workspaceDir: "/tmp/ws",
		webConfig: { ...DEFAULT_TOOLS_CONFIG.tools.web, enable: true },
		toolsConfig: DEFAULT_TOOLS_CONFIG,
		getCurrentModel: () => ({}) as never,
		getAvailableModels: () => [],
		resolveApiKey: async () => "key",
		getSessionSearchSettings: () => ({}) as never,
	};
}

import type { UsageLedger } from "../src/usage/ledger.js";

const schema = Type.Object({ label: Type.String() });

function tool(execute: AgentTool<typeof schema>["execute"]): AgentTool<typeof schema> {
	return { name: "probe", label: "probe", description: "probe", parameters: schema, execute };
}

async function run(inner: AgentTool<typeof schema>["execute"]) {
	return withToolDetails(tool(inner), "task_pause").execute("call-1", { label: "l" });
}

describe("details contract", () => {
	it("stamps the registered kind onto every result shape it wraps", async () => {
		const unstamped = await run(async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }));
		expect(toolResultDetails(unstamped)).toEqual({ kind: "task_pause" });

		const withFields = await run(async () => ({
			content: [{ type: "text", text: "ok" }],
			details: { op: "list", count: 3 },
		}));
		expect(withFields.details).toEqual({ op: "list", count: 3, kind: "task_pause" });

		// Guards the drift this contract exists to prevent: a hand-written kind can no longer
		// disagree with the name the tool is registered under.
		const staleKind = await run(async () => ({
			content: [{ type: "text", text: "ok" }],
			details: { kind: "something_stale" },
		}));
		expect(toolResultDetails(staleKind)?.kind).toBe("task_pause");
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
		expect(toolResultDetails(rejected)?.kind).toBe("task_pause");

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

/** A turn output that records the events the handler emits. */
function createOutput(): { ctx: TurnOutput; events: TurnEvent[] } {
	const events: TurnEvent[] = [];
	const ctx = new TurnOutput({ emit: (event) => events.push(event), finish: async () => {} }, "dingtalk:dm:1");
	return { ctx, events };
}

/** The failure line the user would see for each finished tool call. */
function failureLines(events: TurnEvent[]): Array<string | undefined> {
	return events.flatMap((event) => (event.type === "tool.end" ? [event.failure] : []));
}

function handlerContext(ctx: TurnOutput, runState: RunState): SessionEventHandlerContext {
	return {
		ctx,
		logCtx: { channelId: "dingtalk:dm:1", userName: "U" },
		queue: createQueue(),
		pendingTools: new Map(),
		store: null,
		runState,
		memoryLifecycle: { noteToolCall() {}, noteCompletedAssistantTurn() {} } as never,
		ledger: { record: () => {}, summarize: () => ({}) } as unknown as UsageLedger,
	};
}

async function endEvent(ctx: TurnOutput, result: unknown, isError: boolean) {
	await handleSessionEvent(
		{ type: "tool_execution_end", toolCallId: "c1", toolName: "task_pause", result, isError },
		handlerContext(ctx, createEmptyRunState()),
	);
}

describe("rejections stay out of the user's chat", () => {
	it("shows no error bubble for a rejection the model can fix itself", async () => {
		const { ctx, events } = createOutput();

		await endEvent(
			ctx,
			{
				content: [{ type: "text", text: "Rejected: requires an id." }],
				details: { kind: "task_pause", recoverable: true },
			},
			false,
		);

		expect(failureLines(events)).toEqual([undefined]);
	});

	it("still shows an error bubble for a real tool failure or a user-only scope decision", async () => {
		const failure = createOutput();

		await endEvent(
			failure.ctx,
			{ content: [{ type: "text", text: "Command blocked [network]" }], details: { kind: "bash" } },
			true,
		);

		expect(failureLines(failure.events)).toHaveLength(1);
		expect(failureLines(failure.events)[0]).toContain("Command blocked");

		// A user-only scope decision is thrown as a plain Error, so it arrives with isError and
		// must remain visible instead of being treated as model-fixable tool validation.
		const scope = createOutput();
		await endEvent(
			scope.ctx,
			{
				content: [{ type: "text", text: 'Task "x" requires a user decision outside its current scope' }],
				details: { kind: "task_pause" },
			},
			true,
		);

		expect(failureLines(scope.events)).toHaveLength(1);
		expect(failureLines(scope.events)[0]).toContain("user decision outside its current scope");
	});
});

describe("registry wiring", () => {
	// Spec 053 D5.2: a guard refusal used to reach the card as the model's English text
	// ("Path blocked [...] Resolved path: ..."). The model must keep that exact text and the error
	// flag; the chat gets a line rendered from the refusal's structured form instead.
	it("shows a guard refusal from its structured form while the model keeps the original text", async () => {
		const tools = buildToolSet({ ...testManagers(), ...registryContext() });
		const write = tools.find((entry) => entry.name === "write");
		if (!write) throw new Error("write not registered");

		const error = await write.execute("guard-1", { label: "w", path: "/etc/pipiclaw-probe", content: "x" }).then(
			() => undefined,
			(thrown: unknown) => thrown as Error,
		);
		// Still thrown (so the SDK marks the result isError), with the model-facing text unchanged.
		expect(error?.message).toMatch(/^Path blocked \[[a-z-]+\]\nReason: /);

		const { ctx, events } = createOutput();
		await handleSessionEvent(
			{
				type: "tool_execution_end",
				toolCallId: "guard-1",
				toolName: "write",
				// What the SDK's createErrorToolResult builds from a thrown error: message only, empty details.
				result: { content: [{ type: "text", text: error?.message }], details: {} },
				isError: true,
			},
			handlerContext(ctx, createEmptyRunState()),
		);
		expect(failureLines(events)).toHaveLength(1);
		const line = String(failureLines(events)[0]);
		expect(line).toContain("/etc/pipiclaw-probe");
		expect(line).not.toMatch(/blocked|Resolved path|Reason:/);
		expect(line.split("\n")).toHaveLength(1);
	});

	it("delivers a real task_create validation failure as a rejection, not a thrown error", async () => {
		// End-to-end through buildToolSet: the same call used to reach the user as a red
		// error bubble mid-turn; it must now come back as data the model can act on.
		const tools = buildToolSet({ ...testManagers(), ...registryContext() });
		const taskCreate = tools.find((entry) => entry.name === "task_create");
		if (!taskCreate) throw new Error("task_create not registered");

		const result = await taskCreate.execute("c1", {
			label: "create",
			id: "probe-task",
			title: "Probe",
			goal: "Prove the rejection path",
			dod: "just prose, not a checklist",
		});

		expect(isRecoverableRejection(result)).toBe(true);
		expect(toolResultDetails(result)?.kind).toBe("task_create");
		expect(JSON.stringify(result.content[0])).toContain("DoD has no checklist items");
	});

	it("delivers a real subagent admission rejection (unknown role) as a rejection, not a thrown error (P1-5)", async () => {
		// `subagent` is wired the same way as every registry tool (tools/index.ts), just outside
		// buildToolSet to avoid an import cycle — wire it identically here.
		const tool = withToolDetails(
			createSubAgentTool({
				...testManagers("dingtalk:dm:1"),
				executor: { exec: async () => ({ stdout: "", stderr: "", code: 0 }) },
				fileStore: createFileStore(),
				getCurrentModel: () => ({}) as never,
				getAvailableModels: () => [],
				resolveApiKey: async () => "key",
				workspaceDir: "/tmp/ws",
				deskDir: "/tmp/ws/dingtalk:dm:1",
				runtimeContext: {
					workspaceDir: "/tmp/ws",
					desk: "news",
					deskDir: "/tmp/ws/dingtalk:dm:1",
					channelId: "dingtalk:dm:1",
				},
			}),
			"subagent",
		);

		const result = await tool.execute("c1", { label: "delegate", agent: "no-such-role", task: "do the thing" });

		expect(isRecoverableRejection(result)).toBe(true);
		expect(JSON.stringify(result.content[0])).toContain("Unknown sub-agent");
	});
});
