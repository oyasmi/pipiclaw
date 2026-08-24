import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import * as log from "../log.js";
import type { MemoryCandidateStore } from "../memory/candidates.js";
import { type ChannelMemoryQueue, getDefaultChannelMemoryQueue } from "../memory/channel-maintenance-queue.js";
import { applyChannelMemoryOps, getChannelMemoryPath, parseChannelMemoryEntries } from "../memory/files.js";
import type { MemoryEntryKind } from "../memory/metadata.js";
import { recallRelevantMemory } from "../memory/recall.js";
import { appendMemoryReviewLog } from "../memory/review-log.js";
import { containsSecret } from "../memory/secret-redaction.js";
import { hashMemoryContent } from "../memory/tombstones.js";
import { readOptionalTextFile } from "../shared/fs-utils.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { errorMessage } from "../shared/text-utils.js";

const memoryManageSchema = Type.Object({
	label: Type.String({ description: "Brief description of the memory change (shown to user)" }),
	op: Type.Union([Type.Literal("save"), Type.Literal("search"), Type.Literal("forget")], {
		description:
			'"save" a durable fact, "search" this channel\'s stored memory on demand, or "forget" a stored entry the user asked you to drop.',
	}),
	content: Type.Optional(
		Type.String({
			description:
				"Required for save: the durable fact as a single self-contained, keyword-rich sentence on one line, written so future keyword search can find it. A save without it is rejected and stores nothing.",
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
				Type.Literal("lesson"),
			],
			{ description: "For save: what kind of durable memory this is." },
		),
	),
	supersedes: Type.Optional(
		Type.String({
			description:
				"For save, only after this tool reported a similar existing entry: the entry id being replaced, " +
				'or "none" to keep both.',
		}),
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
	supersedes?: string;
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

function normalizeMemoryKind(kind: string | undefined): MemoryEntryKind {
	return kind === "preference" ||
		kind === "decision" ||
		kind === "constraint" ||
		kind === "open-loop" ||
		kind === "lesson"
		? kind
		: "fact";
}

function textResult(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}

/**
 * Reject a call whose op-specific payload never arrived.
 *
 * These arguments are `Type.Optional` because each one belongs to exactly one op, so the
 * schema cannot express "required for save, absent for search" — which means the SDK
 * validator lets a payload-less call straight through. Two failure modes reach here and both
 * used to end in a calm `textResult` that read like a completed no-op:
 *
 *   1. The model genuinely omitted the argument.
 *   2. The argument was *lost in transit*. Streamed tool-call arguments are accumulated as
 *      text and parsed leniently (`parseStreamingJson`): if the provider truncates or
 *      malforms the tail of the JSON — the common shape with OpenAI-compatible Chinese
 *      providers on long non-ASCII values — the trailing key is silently dropped and the
 *      call still executes. The assistant message is then persisted with the *parsed*
 *      arguments, so on the next turn the model reads back its own call with `content`
 *      already missing, copies it, and loops forever.
 *
 * A soft result makes (2) unrecoverable, so reject loudly instead: a `RecoverableToolError`
 * surfaces to the model as an error it must fix rather than a saved memory, names the keys
 * that actually arrived so a dropped argument is visible rather than inferred, and tells the
 * model not to replay the previous call. The warning log is the operator-side evidence —
 * `agent.tool.started` carries the raw args but only at debug level.
 */
function rejectMissingArgument(op: string, parameter: string, args: MemoryManageArgs): never {
	const received = Object.entries(args)
		.filter(([, value]) => value !== undefined && value !== "")
		.map(([key]) => key);
	log.logWarning(
		`memory_manage ${op} called without "${parameter}"`,
		`received arguments: ${received.join(", ") || "(none)"}`,
	);
	throw new RecoverableToolError(
		`memory_manage op="${op}" requires a non-empty "${parameter}", but the call arrived with only: ${
			received.join(", ") || "(no arguments)"
		}. Nothing was ${op === "forget" ? "removed" : op === "save" ? "saved" : "searched"}. Do not repeat the previous ` +
			`call as written — if an earlier call in this conversation is also missing "${parameter}", it was dropped in ` +
			`transit, so re-issue it with "${parameter}" set explicitly and keep the value short and on one line.`,
	);
}

export function createMemoryManageTool(options: MemoryManageToolOptions): AgentTool<typeof memoryManageSchema> {
	const queue = options.channelMemoryQueue ?? getDefaultChannelMemoryQueue();

	async function save(args: MemoryManageArgs) {
		const { content, kind, supersedes } = args;
		const trimmed = (content ?? "").trim();
		if (!trimmed) {
			rejectMissingArgument("save", "content", args);
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
		const metadata = {
			kind: normalizeMemoryKind(kind),
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
				? `Saved to channel memory${kind ? ` (${kind})` : ""}.`
				: "That memory is already present; no duplicate was added.";
		return textResult(message, {
			op: "save",
			saved: result.added > 0 || result.superseded > 0 || result.skippedDuplicate > 0,
		});
	}

	async function search(args: MemoryManageArgs) {
		const trimmed = (args.query ?? "").trim();
		if (!trimmed) {
			rejectMissingArgument("search", "query", args);
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

	async function forget(args: MemoryManageArgs) {
		const trimmed = (args.target ?? "").trim();
		if (!trimmed) {
			rejectMissingArgument("forget", "target", args);
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
					return save(args);
				case "search":
					return search(args);
				case "forget":
					return forget(args);
				default:
					throw new RecoverableToolError('Unsupported memory op. Use "save", "search", or "forget".');
			}
		},
	};
}
