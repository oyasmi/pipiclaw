import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { errorMessage } from "../shared/text-utils.js";
import { manageWorkspaceSkill } from "../tools/skill-manage.js";
import { parseMemoryExtractionResult, runMemoryExtraction, toMemoryOp } from "./extraction.js";
import { applyChannelMemoryOps } from "./files.js";
import { containsSecret } from "./policy.js";
import {
	type MemoryPromotionCandidate,
	type PostTurnReviewResult,
	type SkillPromotionCandidate,
	shouldAutoWriteMemory,
	shouldAutoWriteSkill,
} from "./promotion.js";
import { appendMemoryReviewLog } from "./review-log.js";

export interface PostTurnReviewOptions {
	channelId: string;
	channelDir: string;
	workspaceDir: string;
	messages: AgentMessage[];
	model: Model<Api>;
	resolveApiKey: (model: Model<Api>) => Promise<string>;
	timeoutMs: number;
	autoWriteChannelMemory: boolean;
	autoWriteWorkspaceSkills: boolean;
	minMemoryAutoWriteConfidence: number;
	minSkillAutoWriteConfidence: number;
	loadedSkills: Array<{ name: string; description?: string }>;
	emitNotice?: (notice: string) => Promise<void>;
	refreshWorkspaceResources?: () => Promise<void>;
	sourceEntryIds?: string[];
	suppressAutomaticWrites?: boolean;
	correlationId?: string;
}

export interface PostTurnReviewApplyResult {
	actions: unknown[];
	suggestions: unknown[];
	skipped: unknown[];
	notices: string[];
}

export type PostTurnReviewRunResult =
	| { status: "applied" | "empty"; result: PostTurnReviewApplyResult }
	| { status: "failed"; error: string };

const POST_TURN_TRANSCRIPT_MAX_CHARS = 22_000;

/** Re-exported so existing callers and tests keep one parser for the shared schema. */
export const parsePostTurnReviewResult = parseMemoryExtractionResult;

async function runPostTurnReviewWorker(options: PostTurnReviewOptions): Promise<PostTurnReviewResult> {
	return runMemoryExtraction({
		name: "memory-post-turn-review",
		channelId: options.channelId,
		channelDir: options.channelDir,
		messages: options.messages,
		model: options.model,
		resolveApiKey: options.resolveApiKey,
		timeoutMs: options.timeoutMs,
		transcriptMaxChars: POST_TURN_TRANSCRIPT_MAX_CHARS,
		// The growth review is the only path that proposes procedural memory, and the only one
		// that does not summarize into HISTORY.md.
		includeHistoryBlock: false,
		includeSkills: true,
		loadedSkills: options.loadedSkills,
		usageContext: { channelId: options.channelId, correlationId: options.correlationId },
	});
}

async function applyMemoryCandidate(
	options: PostTurnReviewOptions,
	candidate: MemoryPromotionCandidate,
	result: PostTurnReviewApplyResult,
	timestamp: string,
): Promise<void> {
	if (
		options.suppressAutomaticWrites ||
		!options.autoWriteChannelMemory ||
		!shouldAutoWriteMemory(candidate, options.minMemoryAutoWriteConfidence)
	) {
		result.suggestions.push({ type: "memory", candidate });
		return;
	}
	if (candidate.content && containsSecret(candidate.content)) {
		result.skipped.push({ type: "memory", candidate: { ...candidate, content: "[REDACTED]" }, reason: "secret" });
		return;
	}

	const op = toMemoryOp(candidate, {
		sourceEntryIds: options.sourceEntryIds,
		correlationId: options.correlationId,
	});
	const applied = await applyChannelMemoryOps(options.channelDir, [op], timestamp);
	if (applied.blockedByPolicy > 0 || applied.blockedByTombstone > 0) {
		result.skipped.push({ type: "memory", entry: candidate.targetId, reason: "blocked by memory policy" });
		return;
	}
	const action = { target: "MEMORY.md", action: candidate.op, entry: candidate.targetId, reason: candidate.reason };
	result.actions.push(action);
	result.notices.push("已沉淀：更新 channel memory。");
}

async function applySkillCandidate(
	options: PostTurnReviewOptions,
	candidate: SkillPromotionCandidate,
	result: PostTurnReviewApplyResult,
): Promise<void> {
	if (
		options.suppressAutomaticWrites ||
		!options.autoWriteWorkspaceSkills ||
		!shouldAutoWriteSkill(candidate, options.minSkillAutoWriteConfidence)
	) {
		result.suggestions.push({ type: "skill", candidate });
		return;
	}

	try {
		const managed = await manageWorkspaceSkill(
			{ workspaceDir: options.workspaceDir },
			{
				action: candidate.action,
				name: candidate.name,
				content: candidate.content,
				filePath: candidate.filePath,
				find: candidate.find,
				replace: candidate.replace,
			},
		);
		result.actions.push({ target: "workspace-skill", ...managed, reason: candidate.reason });
		result.notices.push(managed.notice);
		if (managed.requiresResourceRefresh && options.refreshWorkspaceResources) {
			await options.refreshWorkspaceResources();
		}
	} catch (error) {
		const message = errorMessage(error);
		result.skipped.push({ type: "skill", candidate, reason: message });
		result.suggestions.push({ type: "skill", candidate, blockedReason: message });
	}
}

export async function applyPostTurnReviewResult(
	options: PostTurnReviewOptions,
	review: PostTurnReviewResult,
): Promise<PostTurnReviewApplyResult> {
	const timestamp = new Date().toISOString();
	const result: PostTurnReviewApplyResult = {
		actions: [],
		suggestions: [],
		skipped: [],
		notices: [],
	};

	for (const candidate of review.memoryOps) {
		await applyMemoryCandidate(options, candidate, result, timestamp);
	}
	for (const candidate of review.skillCandidates) {
		await applySkillCandidate(options, candidate, result);
	}

	for (const discarded of review.discarded) {
		result.skipped.push({ type: "discarded", ...discarded });
	}

	await appendMemoryReviewLog(options.channelDir, {
		timestamp,
		channelId: options.channelId,
		reason: "post-turn",
		correlationId: options.correlationId,
		candidates: [...review.memoryOps, ...review.skillCandidates],
		actions: result.actions,
		suggestions: result.suggestions,
		skipped: result.skipped,
	});

	for (const notice of Array.from(new Set(result.notices))) {
		try {
			await options.emitNotice?.(notice);
		} catch {
			/* best effort */
		}
	}

	return result;
}

export async function runPostTurnReview(options: PostTurnReviewOptions): Promise<PostTurnReviewRunResult> {
	try {
		const review = await runPostTurnReviewWorker(options);
		const result = await applyPostTurnReviewResult(options, review);
		return { status: result.actions.length > 0 ? "applied" : "empty", result };
	} catch (error) {
		const message = errorMessage(error);
		await appendMemoryReviewLog(options.channelDir, {
			timestamp: new Date().toISOString(),
			channelId: options.channelId,
			reason: "post-turn",
			correlationId: options.correlationId,
			error: message,
			skipped: [{ target: "post-turn-review", reason: "failed" }],
		});
		return { status: "failed", error: message };
	}
}
