/**
 * The single source of truth for which tools a sub-agent role may request.
 *
 * This is a leaf module with no imports so both ends can read it without pulling in a cycle:
 * `registry.ts` filters the sub-agent tool set through it, and
 * `subagents/discovery.ts` validates a role file's `tools:` list against it. They used to be two
 * hand-maintained lists and had already drifted (`glob` was build-available but validation-rejected).
 * A test checks that every allowed name has a registered implementation.
 */
export const SUBAGENT_TOOL_NAMES = [
	"read",
	"grep",
	"glob",
	"bash",
	"edit",
	"write",
	"web_search",
	"web_fetch",
] as const;

export type SubAgentToolName = (typeof SUBAGENT_TOOL_NAMES)[number];

/**
 * The tools a request-scoped generation (a Web API request with no `conversation`) is given. It has
 * no channel to deliver to once the request ends, so nothing that outlives it — a task, an event,
 * a delegation, a background job, a change to a task's waiting condition — is offered. An
 * allowlist, so a tool added later stays out until someone decides it belongs here.
 */
export const REQUEST_SCOPED_TOOL_NAMES = [
	"read",
	"grep",
	"glob",
	"bash",
	"edit",
	"write",
	"web_search",
	"web_fetch",
	"skill",
	"memory_search",
	"memory_save",
	"memory_forget",
	"session_search",
	"task_list",
] as const;
