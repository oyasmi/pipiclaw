import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { isRecord } from "../shared/type-guards.js";

/**
 * The `details` contract for tool results, and the recoverable-rejection mechanism
 * built on it.
 *
 * `details` is the structured, non-model-facing channel of a tool result: the model reads
 * `content`, the runtime reads `details`. Before this contract existed each tool invented its
 * own shape, several emitted no `kind` at all (bash did on the async path but not the sync
 * one), and nothing bound emitters to consumers — so the discriminator drifted freely.
 *
 * The discriminator is therefore no longer written by hand. `withToolDetails` stamps it from
 * the registry's tool name at the point the tool set is built, which makes every result
 * conform by construction: a tool cannot forget it, and it cannot disagree with the name the
 * tool is registered under.
 */

export { RecoverableToolError } from "../shared/recoverable-error.js";

/**
 * Every tool that can appear in a tool set. Equal to the registry's tool names plus
 * `subagent`, which is registered separately (see the note on TOOL_REGISTRY).
 */
export type ToolDetailsKind =
	| "read"
	| "bash"
	| "edit"
	| "grep"
	| "glob"
	| "write"
	| "web_search"
	| "web_fetch"
	| "send_media"
	| "session_search"
	| "memory_save"
	| "memory_search"
	| "memory_forget"
	| "skill"
	| "event_manage"
	| "task_list"
	| "task_create"
	| "task_update"
	| "task_close"
	| "task_verify"
	| "job"
	| "subagent"
	| "subagent_inline"
	| "subagent_list"
	| "subagent_run";

/** The fields every tool result's `details` carries. Tool-specific fields extend this. */
export interface ToolDetails {
	/** Which tool produced this result. Stamped by `withToolDetails`; never written by hand. */
	kind: ToolDetailsKind;
	/**
	 * Set when the call was rejected for a reason the model can resolve on its own (see
	 * `RecoverableToolError`). Transports use it to keep the retry out of the user's face.
	 */
	recoverable?: true;
}

/** Read the `details` off a tool result, if it carries a conforming one. */
export function toolResultDetails(result: unknown): ToolDetails | null {
	if (!isRecord(result) || !("details" in result)) {
		return null;
	}
	const details = result.details;
	return isRecord(details) && typeof details.kind === "string" ? (details as unknown as ToolDetails) : null;
}

/** True when the result is a rejection the model can resolve on its own. */
export function isRecoverableRejection(result: unknown): boolean {
	return toolResultDetails(result)?.recoverable === true;
}

/**
 * True when a tool result is the SDK's own argument-validation failure (spec 047, D4.2).
 *
 * pi validates tool arguments against the schema *before* `execute` runs (`agent-loop.js`'s
 * `validateToolArguments` → `createErrorToolResult`), so this rejection never passes through
 * `withToolDetails`: it carries no `details.kind`, and its text begins with a fixed prefix.
 * A schema-invalid call is by definition something the model can fix by re-issuing correct
 * arguments — the same class as a `RecoverableToolError` — so the runtime treats it as a
 * recoverable rejection rather than a user-visible tool error.
 *
 * This is a deliberate coupling to a string the SDK emits; `test/tool-error-contract.test.ts`
 * drives a real schema-invalid call through the SDK and asserts this still matches, so a
 * wording change upstream fails loudly there rather than silently regressing progress-card
 * behavior.
 */
export function isArgumentValidationFailure(result: unknown, isError: boolean): boolean {
	if (!isError || toolResultDetails(result) !== null || !isRecord(result)) {
		return false;
	}
	const text = Array.isArray(result.content)
		? result.content.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("")
		: "";
	return text.startsWith('Validation failed for tool "');
}

/**
 * Bind a tool to the contract: stamp `kind` on every result it returns, and convert a
 * `RecoverableToolError` into a normal result the model can read and act on.
 *
 * Applied once in `buildToolSet`, so every registered tool is covered without each one
 * having to remember. `kind` is stamped last and unconditionally: the name a tool is
 * registered under is the authoritative discriminator.
 */
export function withToolDetails(tool: AgentTool<any>, kind: ToolDetailsKind): AgentTool<any> {
	return {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate) => {
			try {
				const result = (await tool.execute(toolCallId, params, signal, onUpdate)) as AgentToolResult<unknown>;
				return {
					...result,
					details: { ...(isRecord(result.details) ? result.details : {}), kind },
				};
			} catch (error) {
				if (error instanceof RecoverableToolError) {
					// Returned, not rethrown: a rejection is an outcome, not a fault. The `Rejected:`
					// prefix keeps the model from reading a non-error result as success.
					return {
						content: [{ type: "text", text: `Rejected: ${error.message}` }],
						details: { kind, recoverable: true },
					};
				}
				throw error;
			}
		},
	};
}
