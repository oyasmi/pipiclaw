import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { ContextMessage, ContextPart } from "../../channel/turn-context.js";

/** Snapshot actual context, including full tool observations, without copying runtime policy. */
export function snapshotContext(messages: AgentMessage[]): ContextMessage[] {
	return convertToLlm(messages).flatMap((message): ContextMessage[] => {
		if (message.role === "system") {
			const role = (message as typeof message & { contextRole?: string }).contextRole;
			if (role !== "system" && role !== "developer") return [];
			const content =
				typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
			return [{ role, content }];
		}
		if (message.role === "user") {
			return [
				{
					role: "user",
					content:
						typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content,
				},
			];
		}
		if (message.role === "toolResult") {
			return [
				{
					role: "assistant",
					phase: "commentary",
					content: [
						{
							type: "text",
							text: JSON.stringify({
								historical_tool: message.toolName,
								result: message.content,
								isError: message.isError,
							}),
						},
					],
				},
			];
		}
		const content: ContextPart[] = message.content.flatMap((part): ContextPart[] => {
			if (part.type === "text") return [{ type: "text", text: part.text }];
			if (part.type === "thinking") return part.thinking ? [{ type: "text", text: part.thinking }] : [];
			if (part.type === "toolCall")
				return [{ type: "text", text: JSON.stringify({ historical_tool: part.name, arguments: part.arguments }) }];
			return [];
		});
		const explicit = (message as typeof message & { phase?: ContextMessage["phase"] }).phase;
		const phase = explicit ?? (message.stopReason === "toolUse" ? "commentary" : "final_answer");
		return content.length ? [{ role: "assistant", content, phase }] : [];
	});
}
