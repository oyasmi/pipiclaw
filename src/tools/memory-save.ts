import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { MemoryCandidateStore } from "../memory/candidates.js";
import { type ChannelMemoryQueue, getDefaultChannelMemoryQueue } from "../memory/channel-maintenance-queue.js";
import { applyChannelMemoryOps, getChannelMemoryPath } from "../memory/files.js";

const memorySaveSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're saving and why (shown to user)" }),
	content: Type.String({
		description:
			"The durable fact to remember, as a single self-contained, keyword-rich sentence. Write it so future keyword search can find it.",
	}),
	kind: Type.Optional(
		Type.String({
			description:
				'What kind of durable memory this is: "preference", "fact", "decision", "constraint", or "open-loop".',
		}),
	),
});

export interface MemorySaveToolOptions {
	channelId: string;
	channelDir: string;
	memoryCandidateStore: MemoryCandidateStore;
	channelMemoryQueue?: ChannelMemoryQueue;
}

export function createMemorySaveTool(options: MemorySaveToolOptions): AgentTool<typeof memorySaveSchema> {
	const queue = options.channelMemoryQueue ?? getDefaultChannelMemoryQueue();
	return {
		name: "memory_save",
		label: "memory_save",
		description:
			"Save a durable fact to this channel's long-term MEMORY.md immediately. Use when the user explicitly asks you to remember something (a preference, decision, constraint, or long-running commitment), so it survives restarts and future sessions. Do not use for transient task state — that is captured automatically.",
		parameters: memorySaveSchema,
		execute: async (_toolCallId: string, { content, kind }: { label: string; content: string; kind?: string }) => {
			const trimmed = content.trim();
			if (!trimmed) {
				return {
					content: [{ type: "text", text: "No content provided; nothing was saved." }],
					details: { kind: "memory_save", saved: false },
				};
			}

			// Serialize through the shared channel memory queue so this never races with
			// background consolidation/maintenance on the same channel's files.
			const result = await queue.run(options.channelId, () =>
				applyChannelMemoryOps(options.channelDir, [{ op: "add", content: trimmed }]),
			);
			// Make the new memory recallable within this same turn.
			options.memoryCandidateStore.invalidate(getChannelMemoryPath(options.channelDir));

			return {
				content: [{ type: "text", text: `Saved to channel memory${kind ? ` (${kind})` : ""}.` }],
				details: { kind: "memory_save", saved: result.added > 0 },
			};
		},
	};
}
