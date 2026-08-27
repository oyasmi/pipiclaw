import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveActiveSessionFile } from "../runtime/active-session-store.js";

/**
 * Repairs a session branch left with a declared-but-unfulfilled tool call by a process that
 * exited between the assistant's tool call and the tool result being recorded (spec 043, D8-D16).
 *
 * The only thing this module does is make the branch structurally legal again (every declared
 * tool call has a result) and honest about what happened (a runtime-authored, clearly-labeled
 * message, never something dressed up as a real model or tool response). It never executes a
 * tool, never calls a model, and never repeats a side effect — see D9/P6 for why that boundary is
 * load-bearing, not just caution.
 */

const SYNTHETIC_TOOL_RESULT_HEADER =
	"Error: Pipiclaw restarted before a durable result was recorded for this tool call.\n" +
	"The operation may or may not have taken effect. Inspect the current target state before retrying; " +
	"do not repeat the operation blindly.";

const SYNTHETIC_ABORTED_ASSISTANT_TEXT =
	"Error: Pipiclaw restarted before a response was generated. Re-send the request if it is still needed.";

function toolGuidance(toolName: string): string {
	if (toolName === "subagent" || toolName === "subagent_list" || toolName === "subagent_run") {
		return "先用 `subagent_list` / `subagent_run op=show` 查询这次委派是否已经作为一个 durable run 存在。";
	}
	if (toolName === "job" || toolName === "bash") {
		return "若这是一次异步操作（后台 job 或已启动的进程），先用 job `list` / `poll` 查记录，再决定是否需要重跑。";
	}
	if (toolName === "write" || toolName === "edit") {
		return "用 read / grep / git status 检查目标文件的当前内容，再决定是否需要重新执行。";
	}
	if (toolName === "send_media") {
		return "查询目标系统或向用户确认对方是否已经收到，不要自动再发一次。";
	}
	return "检查目标状态后再决定是否需要重试，不要盲目重复这次调用。";
}

interface DeclaredToolCall {
	id: string;
	name: string;
	/** Index into the branch's message-entry sequence (source order), used to detect anomalies. */
	entryIndex: number;
}

export type RepairPlan =
	| { kind: "none" }
	| { kind: "append-aborted-assistant" }
	| { kind: "append-tool-results"; calls: DeclaredToolCall[] }
	| { kind: "blocked"; reason: string };

function messageEntriesOf(branch: SessionEntry[]): Array<SessionEntry & { type: "message" }> {
	return branch.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message");
}

/**
 * Pure D11 planner: declared − fulfilled → the one repair action to take, or `blocked` when the
 * branch's shape doesn't match a plain crash window (P7: an undecidable shape stops the channel,
 * it never guesses).
 */
export function planTurnRecovery(branch: SessionEntry[]): RepairPlan {
	const entries = messageEntriesOf(branch);
	if (entries.length === 0) {
		return { kind: "none" };
	}

	const declared: DeclaredToolCall[] = [];
	const fulfilled = new Set<string>();
	for (let i = 0; i < entries.length; i++) {
		const message = entries[i].message;
		if (message.role === "assistant") {
			for (const item of message.content) {
				if (item.type === "toolCall") {
					declared.push({ id: item.id, name: item.name, entryIndex: i });
				}
			}
		} else if (message.role === "toolResult") {
			if (fulfilled.has(message.toolCallId)) {
				return { kind: "blocked", reason: `Duplicate tool result recorded for tool call ${message.toolCallId}.` };
			}
			fulfilled.add(message.toolCallId);
		}
	}

	const missing = declared.filter((call) => !fulfilled.has(call.id));
	if (missing.length > 0) {
		const firstMissingIndex = missing[0].entryIndex;
		// Sibling calls declared by the *same* assistant message as the first missing one are
		// expected to show up as results in any order (parallel tool calls) — only a message that
		// isn't one of them signals a genuine anomaly, not the ordinary interleaving of results.
		const siblingIds = new Set(
			declared.filter((call) => call.entryIndex === firstMissingIndex).map((call) => call.id),
		);
		for (let i = firstMissingIndex + 1; i < entries.length; i++) {
			const message = entries[i].message;
			const isExpectedResult = message.role === "toolResult" && siblingIds.has(message.toolCallId);
			if (!isExpectedResult) {
				return {
					kind: "blocked",
					reason:
						"A message unrelated to the missing tool result(s) appears after them; this is not a plain " +
						"crash window and cannot be safely repaired automatically.",
				};
			}
		}
		return { kind: "append-tool-results", calls: missing };
	}

	const last = entries[entries.length - 1].message;
	if (last.role === "user") {
		return { kind: "append-aborted-assistant" };
	}
	return { kind: "none" };
}

function mostRecentAssistant(branch: SessionEntry[]): AssistantMessage | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message" && entry.message.role === "assistant") {
			return entry.message;
		}
	}
	return undefined;
}

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Fallback identity for the runtime-authored aborted assistant when the branch has no prior
 *  assistant message to copy api/provider/model from (e.g. crash before the first response ever
 *  landed). Never sent to a provider — this is a resolved message, not a request. */
export interface FallbackModelIdentity {
	api: AssistantMessage["api"];
	provider: AssistantMessage["provider"];
	model: string;
}

export type TurnRecoveryOutcome =
	| { kind: "clean" }
	| { kind: "repaired"; appendedToolResults: number; appendedAbortedAssistant: boolean }
	| { kind: "blocked"; reason: string };

/**
 * Runs the D11 plan against `sessionManager`'s current branch and, if a repair is called for,
 * applies it via `appendMessage()` — the only mutation path (D12): never a direct rewrite of the
 * JSONL file, never a tool call, never a model call, never a second delivery attempt.
 */
export function recoverInterruptedTurn(
	sessionManager: SessionManager,
	fallbackModel: FallbackModelIdentity,
): TurnRecoveryOutcome {
	const branch = sessionManager.getBranch();
	const plan = planTurnRecovery(branch);

	if (plan.kind === "blocked") {
		return plan;
	}
	if (plan.kind === "none") {
		return { kind: "clean" };
	}

	if (plan.kind === "append-tool-results") {
		for (const call of plan.calls) {
			sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text: `${SYNTHETIC_TOOL_RESULT_HEADER}\n\n${toolGuidance(call.name)}` }],
				isError: true,
				timestamp: Date.now(),
			});
		}
		return { kind: "repaired", appendedToolResults: plan.calls.length, appendedAbortedAssistant: false };
	}

	// plan.kind === "append-aborted-assistant"
	const recent = mostRecentAssistant(branch);
	const stopReason: StopReason = "aborted";
	sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: SYNTHETIC_ABORTED_ASSISTANT_TEXT }],
		api: recent?.api ?? fallbackModel.api,
		provider: recent?.provider ?? fallbackModel.provider,
		model: recent?.model ?? fallbackModel.model,
		usage: ZERO_USAGE,
		stopReason,
		timestamp: Date.now(),
	});
	return { kind: "repaired", appendedToolResults: 0, appendedAbortedAssistant: true };
}

/** A workspace child directory belongs to a channel iff its name starts with one of these
 *  prefixes — matches `channel-paths.ts`'s `CHANNEL_ID_PATTERN` without needing to reverse its
 *  `/` → `__` escaping, and skips AgentWorkspace resource dirs (skills/, sub-agents/, events/…). */
const CHANNEL_DIR_PREFIXES = ["dm_", "group_"];

export interface WorkspaceRecoveryReport {
	scanned: number;
	repaired: Array<{ channelDir: string; outcome: Extract<TurnRecoveryOutcome, { kind: "repaired" }> }>;
	blocked: Array<{ channelDir: string; reason: string }>;
}

/**
 * Daemon-startup half of D10: scans every channel directory under `workspaceDir` and repairs any
 * interrupted turn found, *before* the daemon accepts traffic (point 1). Each channel gets its own
 * fresh `SessionManager` here — safe because, at this point in startup, no `ChannelRunner` for any
 * of these channels has been constructed yet, so nothing else holds a competing in-memory instance
 * over the same file. `ChannelRunner`'s own constructor (D10 point 2) covers everything this scan
 * cannot: a channel created after this scan ran, and re-running the barrier is idempotent either way.
 */
export async function scanWorkspaceForInterruptedTurns(
	workspaceDir: string,
	fallbackModel: FallbackModelIdentity,
): Promise<WorkspaceRecoveryReport> {
	const report: WorkspaceRecoveryReport = { scanned: 0, repaired: [], blocked: [] };
	let entries: Array<{ name: string; isDirectory(): boolean }>;
	try {
		entries = await readdir(workspaceDir, { withFileTypes: true });
	} catch {
		return report;
	}

	for (const entry of entries) {
		if (!entry.isDirectory() || !CHANNEL_DIR_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) {
			continue;
		}
		const channelDir = join(workspaceDir, entry.name);
		report.scanned++;
		try {
			const activeSessionFile = resolveActiveSessionFile(channelDir);
			const sessionManager = SessionManager.open(join(channelDir, activeSessionFile), channelDir);
			const outcome = recoverInterruptedTurn(sessionManager, fallbackModel);
			if (outcome.kind === "repaired") {
				report.repaired.push({ channelDir, outcome });
			} else if (outcome.kind === "blocked") {
				report.blocked.push({ channelDir, reason: outcome.reason });
			}
		} catch (error) {
			report.blocked.push({ channelDir, reason: error instanceof Error ? error.message : String(error) });
		}
	}
	return report;
}
