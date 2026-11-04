import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import * as log from "../../log.js";

/** Trace actual adapter entry separately from the SDK's preparation events, without tool data. */
export function withExecutionTrace<P extends TSchema, D>(
	tool: AgentTool<P, D>,
	context: () => Record<string, unknown>,
): AgentTool<P, D> {
	return {
		...tool,
		execute: async (...args) => {
			const startedAt = Date.now();
			const fields = { ...context(), toolCallId: args[0], tool: tool.name };
			log.logEvent("debug", "agent.tool.execute_started", "Tool execution started", { fields });
			let failed = true;
			try {
				const result = await tool.execute(...args);
				failed = result.isError === true;
				return result;
			} finally {
				log.logEvent("debug", "agent.tool.execute_finished", "Tool execution finished", {
					fields: { ...fields, elapsedMs: Date.now() - startedAt, failed },
				});
			}
		},
	};
}
