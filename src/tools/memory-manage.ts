import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import * as log from "../log.js";
import type { MemoryCandidateStore } from "../memory/candidates.js";
import { type ChannelMemoryQueue, getDefaultChannelMemoryQueue } from "../memory/channel-maintenance-queue.js";
import { applyChannelMemoryOps, getChannelMemoryPath, parseChannelMemoryEntries } from "../memory/files.js";
import { recallRelevantMemory } from "../memory/recall.js";
import { appendMemoryReviewLog } from "../memory/review-log.js";
import { containsSecret } from "../memory/secret-redaction.js";
import { hashMemoryContent } from "../memory/tombstones.js";
import { readOptionalTextFile } from "../shared/fs-utils.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { errorMessage } from "../shared/text-utils.js";

/**
 * Spec 047, P4: the old single `memory_manage` routed three fully disjoint payloads through an
 * `op` enum. Splitting into one tool per payload shape drops the `op` routing prose and the
 * "Required for save:" prefixes, and lets each op's one required field be schema-required
 * instead of `Type.Optional` + a hand-rolled `rejectMissingArgument`. The streamed-argument
 * truncation that `rejectMissingArgument` guarded against (M-write-03) is now caught by the SDK
 * validator before `execute`; spec 047 D4.2 makes that rejection surface as a recoverable
 * rejection rather than a user-visible error.
 */

const memorySaveSchema = Type.Object({
	content: Type.String({
		description:
			"The durable fact as a single self-contained, keyword-rich sentence on one line, written so future keyword search can find it.",
	}),
	supersedes: Type.Optional(
		Type.String({
			description:
				"Only after this tool reported a similar existing entry: the entry id being replaced, " +
				'or "none" to keep both.',
		}),
	),
});

const memorySearchSchema = Type.Object({
	query: Type.String({ description: "What to look for in this channel's stored memory." }),
});

const memoryForgetSchema = Type.Object({
	target: Type.String({
		description:
			"Text identifying the stored entry to remove. Must match exactly one entry; use memory_search first to confirm the wording.",
	}),
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

/**
 * Above this recall score, an existing entry is similar enough that saving alongside it — rather
 * than superseding it — risks two contradictory durable facts competing at recall time. Set high
 * on purpose: a false positive interrupts every plain save, a false negative just means the old
 * conflict-resolution instruction ("say 'forget the old one'") still applies. Starts at the same
 * value `recall.ts` uses to gate its own model rerank (`HIGH_CONFIDENCE_SCORE`) — a score that
 * strong elsewhere in the pipeline is a reasonable place to start being strict here too.
 */
const SAVE_CONFLICT_SCORE = 8;

function textResult(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}

interface MemoryToolClosures {
	save: (args: { content: string; supersedes?: string }) => Promise<ReturnType<typeof textResult>>;
	search: (args: { query: string }) => Promise<ReturnType<typeof textResult>>;
	forget: (args: { target: string }) => Promise<ReturnType<typeof textResult>>;
}

function buildMemoryClosures(options: MemoryManageToolOptions): MemoryToolClosures {
	const queue = options.channelMemoryQueue ?? getDefaultChannelMemoryQueue();

	async function save({ content, supersedes }: { content: string; supersedes?: string }) {
		const trimmed = content.trim();
		if (!trimmed) {
			throw new RecoverableToolError("memory_save requires a non-empty content; nothing was saved.");
		}
		if (containsSecret(trimmed)) {
			return textResult(
				"This content looks like a credential or secret, so it was not saved. Store the secret in an approved secret manager and remember only its location.",
				{ op: "save", saved: false, blockedReason: "secret" },
			);
		}
		if (!supersedes) {
			// Reuse the recall scoring pipeline (already the point-query path for `search`) as a
			// deterministic, no-cost conflict check before writing a second fact that might
			// contradict one already stored.
			const model = options.getCurrentModel();
			const { items } = await recallRelevantMemory({
				query: trimmed,
				channelId: options.channelId,
				workspaceDir: options.workspaceDir,
				channelDir: options.channelDir,
				allowedSources: ["channel-memory"],
				maxCandidates: 3,
				maxInjected: 3,
				maxChars: 1200,
				rerankWithModel: false,
				model,
				resolveApiKey: options.resolveApiKey,
				candidateStore: options.memoryCandidateStore,
			});
			const similar = items.filter((item) => item.entryId && item.score >= SAVE_CONFLICT_SCORE);
			if (similar.length > 0) {
				throw new RecoverableToolError(
					`Nothing was saved yet. This channel already stores ${similar.length} similar entr${similar.length === 1 ? "y" : "ies"}:\n` +
						similar.map((item) => `- ${item.entryId}: ${item.content}`).join("\n") +
						'\nRe-issue the save with "supersedes" set to the entry id this replaces, or to "none" if both facts are true at the same time.',
				);
			}
		}
		// The model no longer classifies explicit saves (spec 047, P2): background consolidation
		// (`extraction.ts`) still writes real kinds; a model save is recorded as `fact`.
		const metadata = {
			kind: "fact" as const,
			sourceType: "user" as const,
			probationUntil: null,
		};
		// Serialize through the shared channel memory queue so this never races with background
		// consolidation/maintenance on the same channel's files.
		const result = await queue.run(options.channelId, () =>
			applyChannelMemoryOps(options.channelDir, [
				supersedes && supersedes !== "none"
					? { op: "supersede", targetId: supersedes, content: trimmed, metadata }
					: // A user explicitly saying "remember this" is never probationary, and restating a
						// fact the runtime had already put on probation promotes it (spec 037, D7).
						{ op: "add", content: trimmed, metadata },
			]),
		);
		options.memoryCandidateStore.invalidate(getChannelMemoryPath(options.channelDir));
		const message =
			result.added > 0 || result.superseded > 0
				? "Saved to channel memory."
				: "That memory is already present; no duplicate was added.";
		return textResult(message, {
			op: "save",
			saved: result.added > 0 || result.superseded > 0 || result.skippedDuplicate > 0,
		});
	}

	async function search({ query }: { query: string }) {
		const trimmed = query.trim();
		if (!trimmed) {
			throw new RecoverableToolError("memory_search requires a non-empty query.");
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
			model,
			resolveApiKey: options.resolveApiKey,
			candidateStore: options.memoryCandidateStore,
		});
		if (items.length === 0) {
			return textResult(
				`No stored memory matched "${trimmed}". Try a broader query, or the fact may not be saved yet.`,
				{ op: "search", resultCount: 0 },
			);
		}
		const rendered = items
			.map((item, index) => `${index + 1}. [${item.source}/${item.title}] ${item.content}`)
			.join("\n");
		return textResult(`Found ${items.length} stored memory entr${items.length === 1 ? "y" : "ies"}:\n\n${rendered}`, {
			op: "search",
			resultCount: items.length,
		});
	}

	async function forget({ target }: { target: string }) {
		const trimmed = target.trim();
		if (!trimmed) {
			throw new RecoverableToolError("memory_forget requires a non-empty target.");
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
				op: "forget",
				forgotten: false,
			});
		}
		if (matches.length > 1) {
			// Never guess which entry to delete; make the model disambiguate.
			const candidates = matches.map((entry, index) => `${index + 1}. ${entry.content}`).join("\n");
			throw new RecoverableToolError(
				`"${trimmed}" matched ${matches.length} entries; be more specific so only one is removed:\n${candidates}`,
			);
		}
		const removed = matches[0];
		await queue.run(options.channelId, () =>
			applyChannelMemoryOps(options.channelDir, [{ op: "forget", targetId: removed.id, reason: "user forget" }]),
		);
		options.memoryCandidateStore.invalidate(memoryPath);
		// Audit by id/hash only. Copying the forgotten text into the review log would
		// create a second active disclosure surface for the very content being removed.
		await appendMemoryReviewLog(options.channelDir, {
			timestamp: new Date().toISOString(),
			channelId: options.channelId,
			reason: "user-forget",
			actions: [{ op: "forget", entryId: removed.id, contentHash: hashMemoryContent(removed.content) }],
		}).catch((error) => {
			log.logWarning(`Failed to append memory review log for channel ${options.channelId}`, errorMessage(error));
		});
		return textResult(
			"Removed the entry from active channel memory. Its exact content and source transcript window are tombstoned against automatic replay; if the fact is stated again later, it may be learned as new. Original session history and retention backups are unchanged.",
			{ op: "forget", forgotten: true, entryId: removed.id },
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
			"Save a durable fact into this channel's MEMORY.md when the user asks you to remember it. Prefer this over editing " +
			"MEMORY.md directly. Not for transient task state.",
		parameters: memorySaveSchema,
		execute: async (_toolCallId: string, args: { content: string; supersedes?: string }) => save(args),
	};
}

export function createMemorySearchTool(options: MemoryManageToolOptions): AgentTool<typeof memorySearchSchema> {
	const { search } = buildMemoryClosures(options);
	return {
		name: "memory_search",
		label: "memory_search",
		description: "Search this channel's stored durable memory on demand mid-task.",
		parameters: memorySearchSchema,
		execute: async (_toolCallId: string, args: { query: string }) => search(args),
	};
}

export function createMemoryForgetTool(options: MemoryManageToolOptions): AgentTool<typeof memoryForgetSchema> {
	const { forget } = buildMemoryClosures(options);
	return {
		name: "memory_forget",
		label: "memory_forget",
		description:
			"Forget a stored memory entry the user explicitly asked you to drop. Tombstones it against automatic replay.",
		parameters: memoryForgetSchema,
		execute: async (_toolCallId: string, args: { target: string }) => forget(args),
	};
}
