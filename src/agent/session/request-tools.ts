import type { AgentTool } from "@earendil-works/pi-agent-core";
import { RecoverableToolError } from "../../shared/recoverable-error.js";
import { REQUEST_SCOPED_TOOL_NAMES } from "../../tools/contract/names.js";

const OFFERED: ReadonlySet<string> = new Set(REQUEST_SCOPED_TOOL_NAMES);

/** A request has no durable delivery address for tasks, events, or detached runs. */
export function requestTools(tools: AgentTool[]): AgentTool[] {
	return tools
		.filter((tool) => OFFERED.has(tool.name))
		.map((tool) => {
			if (tool.name !== "bash") return tool;
			return {
				...tool,
				execute: async (...args: Parameters<typeof tool.execute>) => {
					if ((args[1] as Record<string, unknown>).async === true)
						throw new RecoverableToolError(
							"This request has no persistent conversation for background delivery. Run bash in the foreground, or ask the client to use `conversation`.",
						);
					return tool.execute(...args);
				},
			};
		});
}
