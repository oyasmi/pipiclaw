import { readFile } from "node:fs/promises";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	buildSessionContext,
	convertToLlm,
	migrateSessionEntries,
	parseSessionEntries,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { ContextRef } from "../../channel/channel-context.js";
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

/**
 * The context a channel turn ended with, rebuilt from its session file (see `ContextRef`): the
 * same snapshot `snapshotContext` takes of a live session. Read-only — the file is parsed, never
 * opened as a session. `undefined` when the file or the entry is gone.
 */
export async function loadContextAt(ref: ContextRef): Promise<ContextMessage[] | undefined> {
	let content: string;
	try {
		content = await readFile(ref.sessionFile, "utf8");
	} catch {
		return undefined;
	}
	const entries = parseSessionEntries(content);
	migrateSessionEntries(entries);
	const sessionEntries = entries.filter((entry): entry is SessionEntry => entry.type !== "session");
	if (!sessionEntries.some((entry) => entry.id === ref.leafId)) return undefined;
	return snapshotContext(buildSessionContext(sessionEntries, ref.leafId).messages);
}
