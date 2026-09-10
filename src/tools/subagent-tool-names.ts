/**
 * The single source of truth for which tools a sub-agent role may request.
 *
 * This is a leaf module with no imports so both ends can read it without pulling in a cycle:
 * `registry.ts` stamps `availableToSubagents` from it when building the sub-agent tool set, and
 * `subagents/discovery.ts` validates a role file's `tools:` list against it. They used to be two
 * hand-maintained lists and had already drifted (`glob` was build-available but validation-rejected).
 * A test asserts the two ends still agree.
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
