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
