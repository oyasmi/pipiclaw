import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import * as log from "../log.js";
import { type ChannelMemoryQueue, getDefaultChannelMemoryQueue } from "../memory/channel-maintenance-queue.js";
import { appendMemoryReviewLog } from "../memory/review-log.js";
import { findNearDuplicateEntries, searchMemory } from "../memory/search.js";
import { containsSecret } from "../memory/secret-redaction.js";
import {
	applyMemoryOps,
	isValidMemoryName,
	listMemoryEntries,
	type MemoryType,
	readMemoryEntry,
} from "../memory/store.js";
import { hashMemoryContent } from "../memory/tombstones.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { errorMessage } from "../shared/text-utils.js";

/**
 * Spec 050, D3: three tools, semantics narrowed. All three act only on the channel `memory/`
 * directory; workspace MEMORY.md is read-only to tools (D11).
 */

const MEMORY_TYPES: MemoryType[] = ["user", "feedback", "project", "reference"];

const memorySaveSchema = Type.Object({
	content: Type.String({
		description: "The durable fact as one self-contained line. Becomes the memory's description and index entry.",
	}),
	name: Type.Optional(
		Type.String({
			description: "Short kebab-case handle, e.g. `deploy-window-thursday`. Auto-generated if omitted.",
		}),
	),
	type: Type.Optional(
		Type.Union(
			MEMORY_TYPES.map((t) => Type.Literal(t)),
			{
				description:
					"user (who the user is), feedback (how to work / lessons), project (facts, decisions, constraints), reference (pointers). Default: project.",
			},
		),
	),
	details: Type.Optional(
		Type.String({ description: "Optional long form, shown only when the file is opened with `read`." }),
	),
	replaces: Type.Optional(
		Type.String({
			description:
				'Only after this tool reported a similar entry: the `name` of the entry to replace, or "none" to keep both.',
		}),
	),
});

const memorySearchSchema = Type.Object({
	query: Type.String({
		description: "What to look for across this channel's memory, journal, and workspace MEMORY.md.",
	}),
});

const memoryForgetSchema = Type.Object({
	name: Type.String({
		description: "The exact `name` of the memory to remove (see the memory index or memory_search).",
	}),
});

export interface MemoryManageToolOptions {
	channelId: string;
	channelDir: string;
	workspaceDir: string;
	channelMemoryQueue?: ChannelMemoryQueue;
}

function textResult(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}

async function readWorkspaceMemory(workspaceDir: string): Promise<string> {
	try {
		return await readFile(join(workspaceDir, "MEMORY.md"), "utf-8");
	} catch {
		return "";
	}
}

interface MemoryToolClosures {
	save: (args: {
		content: string;
		name?: string;
		type?: MemoryType;
		details?: string;
		replaces?: string;
	}) => Promise<ReturnType<typeof textResult>>;
	search: (args: { query: string }) => Promise<ReturnType<typeof textResult>>;
	forget: (args: { name: string }) => Promise<ReturnType<typeof textResult>>;
}

function buildMemoryClosures(options: MemoryManageToolOptions): MemoryToolClosures {
	const queue = options.channelMemoryQueue ?? getDefaultChannelMemoryQueue();

	async function save(args: {
		content: string;
		name?: string;
		type?: MemoryType;
		details?: string;
		replaces?: string;
	}) {
		const content = args.content.trim();
		if (!content) {
			throw new RecoverableToolError("memory_save requires a non-empty content; nothing was saved.");
		}
		if (containsSecret(content) || (args.details && containsSecret(args.details))) {
			return textResult(
				"This looks like a credential or secret, so it was not saved. Store the secret in an approved secret manager and remember only its location.",
				{ saved: false, blockedReason: "secret" },
			);
		}
		if (args.name && !isValidMemoryName(args.name)) {
			throw new RecoverableToolError(
				`"${args.name}" is not a valid memory name. Use lowercase letters, digits, and hyphens only (e.g. deploy-window-thursday).`,
			);
		}

		const entries = await listMemoryEntries(options.channelDir);
		if (!args.replaces) {
			const similar = findNearDuplicateEntries(content, entries);
			if (similar.length > 0) {
				throw new RecoverableToolError(
					`Nothing was saved yet. This channel already stores ${similar.length} similar entr${similar.length === 1 ? "y" : "ies"}:\n` +
						similar.map((entry) => `- ${entry.name}: ${entry.description}`).join("\n") +
						'\nRe-issue the save with "replaces" set to the name this replaces, or to "none" if both facts are true at once.',
				);
			}
		}

		const replaces = args.replaces && args.replaces !== "none" ? args.replaces : undefined;
		const result = await queue.run(options.channelId, () =>
			applyMemoryOps(options.channelDir, [
				replaces
					? {
							op: "update",
							name: replaces,
							description: content,
							type: args.type,
							details: args.details,
							expires: null,
						}
					: {
							op: "add",
							description: content,
							source: "user",
							name: args.name,
							type: args.type ?? "project",
							details: args.details,
						},
			]),
		);

		if (replaces && result.updated.length === 0 && result.missingTarget > 0) {
			throw new RecoverableToolError(
				`No memory named "${replaces}" exists in this channel. Check the name, or omit "replaces" to save a new entry.`,
			);
		}
		await appendMemoryReviewLog(options.channelDir, {
			timestamp: new Date().toISOString(),
			channelId: options.channelId,
			reason: "memory-save",
			actions: [{ op: replaces ? "update" : "add", name: replaces ?? result.added[0] }],
		}).catch(() => {});
		const savedName = replaces ?? result.added[0];
		return textResult(
			replaces ? `Replaced channel memory \`${savedName}\`.` : `Saved to channel memory as \`${savedName}\`.`,
			{ saved: result.added.length > 0 || result.updated.length > 0, name: savedName },
		);
	}

	async function search({ query }: { query: string }) {
		const trimmed = query.trim();
		if (!trimmed) {
			throw new RecoverableToolError("memory_search requires a non-empty query.");
		}
		const [entries, workspaceMemory] = await Promise.all([
			listMemoryEntries(options.channelDir),
			readWorkspaceMemory(options.workspaceDir),
		]);
		const hits = searchMemory({ query: trimmed, entries, workspaceMemory });
		if (hits.length === 0) {
			return textResult(
				`No stored memory matched "${trimmed}". Try a broader query, or the fact may not be saved yet.`,
				{
					resultCount: 0,
				},
			);
		}
		const rendered = hits
			.map((hit) => {
				const where =
					hit.kind === "memory"
						? `memory/${hit.label}`
						: hit.kind === "journal"
							? `journal ${hit.date}`
							: `workspace MEMORY.md › ${hit.label}`;
				return `- [${where}] ${hit.line}`;
			})
			.join("\n");
		return textResult(`Found ${hits.length} match${hits.length === 1 ? "" : "es"}:\n\n${rendered}`, {
			resultCount: hits.length,
		});
	}

	async function forget({ name }: { name: string }) {
		const trimmed = name.trim();
		if (!trimmed) {
			throw new RecoverableToolError("memory_forget requires a non-empty name.");
		}
		const entry = await readMemoryEntry(options.channelDir, trimmed);
		if (!entry) {
			return textResult(`No memory named "${trimmed}" exists in this channel; nothing was removed.`, {
				forgotten: false,
			});
		}
		await queue.run(options.channelId, () =>
			applyMemoryOps(options.channelDir, [{ op: "delete", name: trimmed, reason: "user forget" }]),
		);
		await appendMemoryReviewLog(options.channelDir, {
			timestamp: new Date().toISOString(),
			channelId: options.channelId,
			reason: "memory-forget",
			actions: [{ op: "forget", name: trimmed, contentHash: hashMemoryContent(entry.description) }],
		}).catch((error) => {
			log.logWarning(`Failed to append memory review log for channel ${options.channelId}`, errorMessage(error));
		});
		return textResult(
			`Removed \`${trimmed}\` from channel memory. Its content is tombstoned against automatic replay; if the fact is stated again later it may be re-learned. Journal and session history are unchanged.`,
			{ forgotten: true, name: trimmed },
		);
	}

	return { save, search, forget };
}

export function createMemorySaveTool(options: MemoryManageToolOptions): AgentTool<typeof memorySaveSchema> {
	const { save } = buildMemoryClosures(options);
	return {
		name: "memory_save",
		label: "memory_save",
		description:
			"Save a durable fact into this channel's memory when the user asks you to remember it. Not for transient task state — " +
			"put in-progress work in the journal or a task instead.",
		parameters: memorySaveSchema,
		execute: async (_toolCallId: string, args) => save(args),
	};
}

export function createMemorySearchTool(options: MemoryManageToolOptions): AgentTool<typeof memorySearchSchema> {
	const { search } = buildMemoryClosures(options);
	return {
		name: "memory_search",
		label: "memory_search",
		description:
			"Search this channel's stored memory, journal, and the workspace MEMORY.md on demand. The memory index is only " +
			"injected at the start of a session, so use this when you suspect something was recorded since.",
		parameters: memorySearchSchema,
		execute: async (_toolCallId: string, args) => search(args),
	};
}

export function createMemoryForgetTool(options: MemoryManageToolOptions): AgentTool<typeof memoryForgetSchema> {
	const { forget } = buildMemoryClosures(options);
	return {
		name: "memory_forget",
		label: "memory_forget",
		description: "Forget a stored memory entry by name. Tombstones its content against automatic replay.",
		parameters: memoryForgetSchema,
		execute: async (_toolCallId: string, args) => forget(args),
	};
}
