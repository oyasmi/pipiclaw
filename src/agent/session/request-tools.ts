import type { AgentTool } from "@earendil-works/pi-agent-core";
import { RecoverableToolError } from "../../shared/recoverable-error.js";

/** A request has no durable delivery address for tasks, events, or detached runs. */
export function requestTools(tools: AgentTool[]): AgentTool[] {
	return tools
		.filter(
			(tool) =>
				!["task_create", "event_manage", "subagent", "subagent_inline", "subagent_run", "job"].includes(tool.name),
		)
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
