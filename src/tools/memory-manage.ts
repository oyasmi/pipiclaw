import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { MemoryCandidateStore } from "../memory/candidates.js";
import { type ChannelMemoryQueue, getDefaultChannelMemoryQueue } from "../memory/channel-maintenance-queue.js";
import { applyChannelMemoryOps, getChannelMemoryPath, parseChannelMemoryEntries } from "../memory/files.js";
import { recallRelevantMemory } from "../memory/recall.js";
import { readOptionalTextFile } from "../shared/fs-utils.js";

const memoryManageSchema = Type.Object({
	label: Type.String({ description: "Brief description of the memory change (shown to user)" }),
	op: Type.Union([Type.Literal("save"), Type.Literal("search"), Type.Literal("forget")], {
		description:
			'"save" a durable fact, "search" this channel\'s stored memory on demand, or "forget" a stored entry the user asked you to drop.',
	}),
	content: Type.Optional(
		Type.String({
			description:
				"For save: the durable fact as a single self-contained, keyword-rich sentence, written so future keyword search can find it.",
		}),
	),
	query: Type.Optional(Type.String({ description: "For search: what to look for in stored memory." })),
	target: Type.Optional(
		Type.String({
			description:
				"For forget: text identifying the stored entry to remove. Must match exactly one entry; use search first to confirm the wording.",
		}),
	),
	kind: Type.Optional(
		Type.Union(
			[
				Type.Literal("preference"),
				Type.Literal("fact"),
				Type.Literal("decision"),
				Type.Literal("constraint"),
				Type.Literal("open-loop"),
			],
			{ description: "For save: what kind of durable memory this is." },
		),
	),
});

export interface MemoryManageToolOptions {
	channelId: string;
	channelDir: string;
	workspaceDir: string;
	memoryCandidateStore: MemoryCandidateStore;
	getCurrentModel: () => Model<Api>;
	resolveApiKey: (model: Model<Api>) => Promise<string>;
	channelMemoryQueue?: ChannelMemoryQueue;
}

interface MemoryManageArgs {
	label: string;
	op: "save" | "search" | "forget";
	content?: string;
	query?: string;
	target?: string;
	kind?: string;
}

function textResult(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}

export function createMemoryManageTool(options: MemoryManageToolOptions): AgentTool<typeof memoryManageSchema> {
	const queue = options.channelMemoryQueue ?? getDefaultChannelMemoryQueue();

	async function save(content: string | undefined, kind: string | undefined) {
		const trimmed = (content ?? "").trim();
		if (!trimmed) {
			return textResult("No content provided; nothing was saved.", {
				kind: "memory_manage",
				op: "save",
				saved: false,
			});
		}
		// Serialize through the shared channel memory queue so this never races with background
		// consolidation/maintenance on the same channel's files.
		const result = await queue.run(options.channelId, () =>
			applyChannelMemoryOps(options.channelDir, [{ op: "add", content: trimmed }]),
		);
		options.memoryCandidateStore.invalidate(getChannelMemoryPath(options.channelDir));
		return textResult(`Saved to channel memory${kind ? ` (${kind})` : ""}.`, {
			kind: "memory_manage",
			op: "save",
			saved: result.added > 0,
		});
	}

	async function search(query: string | undefined) {
		const trimmed = (query ?? "").trim();
		if (!trimmed) {
			return textResult("Provide a query to search stored memory.", {
				kind: "memory_manage",
				op: "search",
				resultCount: 0,
			});
		}
		// Reuse the recall scoring pipeline (single source of scoring truth) but scoped to the
		// distilled durable files and with model rerank off, so this stays a cheap deterministic
		// point-query distinct from the passive per-turn recall injection.
		const model = options.getCurrentModel();
		const { items } = await recallRelevantMemory({
			query: trimmed,
			channelId: options.channelId,
			workspaceDir: options.workspaceDir,
			channelDir: options.channelDir,
			allowedSources: ["channel-memory", "channel-history"],
			maxCandidates: 8,
			maxInjected: 8,
			maxChars: 4000,
			rerankWithModel: false,
			autoRerank: false,
			model,
			resolveApiKey: options.resolveApiKey,
			candidateStore: options.memoryCandidateStore,
		});
		if (items.length === 0) {
			return textResult(
				`No stored memory matched "${trimmed}". Try a broader query, or the fact may not be saved yet.`,
				{ kind: "memory_manage", op: "search", resultCount: 0 },
			);
		}
		const rendered = items
			.map((item, index) => `${index + 1}. [${item.source}/${item.title}] ${item.content}`)
			.join("\n");
		return textResult(`Found ${items.length} stored memory entr${items.length === 1 ? "y" : "ies"}:\n\n${rendered}`, {
			kind: "memory_manage",
			op: "search",
			resultCount: items.length,
		});
	}

	async function forget(target: string | undefined) {
		const trimmed = (target ?? "").trim();
		if (!trimmed) {
			return textResult("Provide the text of the entry to forget.", {
				kind: "memory_manage",
				op: "forget",
				forgotten: false,
			});
		}
		const memoryPath = getChannelMemoryPath(options.channelDir);
		const existing = await readOptionalTextFile(memoryPath);
		const entries = parseChannelMemoryEntries(existing);
		const needle = trimmed.toLowerCase();
		const matches = entries.filter(
			(entry) => entry.content === trimmed || entry.content.toLowerCase().includes(needle),
		);
		if (matches.length === 0) {
			return textResult(`No stored memory entry matched "${trimmed}"; nothing was removed.`, {
				kind: "memory_manage",
				op: "forget",
				forgotten: false,
			});
		}
		if (matches.length > 1) {
			// Never guess which entry to delete; make the model disambiguate.
			const candidates = matches.map((entry, index) => `${index + 1}. ${entry.content}`).join("\n");
			throw new Error(
				`"${trimmed}" matched ${matches.length} entries; be more specific so only one is removed:\n${candidates}`,
			);
		}
		await queue.run(options.channelId, () =>
			applyChannelMemoryOps(options.channelDir, [
				{ op: "invalidate", targetId: matches[0].id, reason: "user forget" },
			]),
		);
		options.memoryCandidateStore.invalidate(memoryPath);
		return textResult(`Forgot: ${matches[0].content}`, { kind: "memory_manage", op: "forget", forgotten: true });
	}

	return {
		name: "memory_manage",
		label: "memory_manage",
		description:
			"Manage this channel's durable MEMORY.md: save a durable fact the user asks you to remember, search stored " +
			"memory on demand mid-task, or forget an entry the user asks you to drop. Prefer this over editing MEMORY.md " +
			"directly — it serializes with background consolidation and keeps memory recallable. Not for transient task state.",
		parameters: memoryManageSchema,
		execute: async (_toolCallId: string, args: MemoryManageArgs) => {
			switch (args.op) {
				case "save":
					return save(args.content, args.kind);
				case "search":
					return search(args.query);
				case "forget":
					return forget(args.target);
				default:
					throw new Error('Unsupported memory op. Use "save", "search", or "forget".');
			}
		},
	};
}
