import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { serializeConversation } from "@earendil-works/pi-coding-agent";
import { parseJsonObject } from "../shared/llm-json.js";
import { clipText, errorMessage } from "../shared/text-utils.js";
import { isRecord } from "../shared/type-guards.js";
import { manageWorkspaceSkill } from "../tools/skill-manage.js";
import {
	applyChannelMemoryOps,
	type MemoryOp,
	readChannelHistory,
	readChannelMemory,
	readChannelSession,
} from "./files.js";
import { containsSecret } from "./policy.js";
import {
	type MemoryPromotionCandidate,
	type PostTurnReviewResult,
	type SkillPromotionCandidate,
	shouldAutoWriteMemory,
	shouldAutoWriteSkill,
} from "./promotion.js";
import { appendMemoryReviewLog } from "./review-log.js";
import { runRetriedSidecarTask } from "./sidecar-worker.js";
import { sanitizeMessagesForMemory } from "./transcript.js";

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

const POST_TURN_REVIEW_SYSTEM_PROMPT = `You are Pipiclaw's post-turn memory reviewer.

Return strict JSON only:
{
  "memoryOps": [
    {
      "target": "channel-memory",
      "op": "add|supersede|invalidate",
      "targetId": "required for supersede/invalidate",
      "content": "standalone durable memory bullet without '-'",
      "kind": "fact|preference|decision|constraint|open-loop|lesson",
      "confidence": 0.0,
      "necessity": "low|medium|high",
      "reason": "why it should or should not be stored"
    }
  ],
  "skillCandidates": [
    {
      "action": "create|patch|write_file",
      "name": "skill-name",
      "content": "full SKILL.md or supporting file content",
      "filePath": "optional supporting file path",
      "find": "exact patch find text",
      "replace": "exact patch replacement text",
      "confidence": 0.0,
      "necessity": "low|medium|high",
      "reason": "why this procedural memory matters"
    }
  ],
  "discarded": [{"content": "string", "reason": "string"}]
}

Rules:
- Channel MEMORY.md is only for durable facts, durable decisions, user/team preferences, stable constraints, and medium-horizon open loops.
- Do not promote current step-by-step execution state, short-lived debugging observations, completed worklog, or acknowledgement chatter.
- Workspace skills are procedural memory: reusable workflows, checklists, playbooks, templates, or scripts.
- Propose skill writes only when the workflow is clearly reusable across future tasks.
- Use action=create only for new self-contained skills with YAML frontmatter and a non-empty body.
- Skill names must be lowercase kebab-case.
- Be conservative. Empty arrays are correct when nothing should be stored.`;

function normalizeConfidence(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function normalizeNecessity(value: unknown): "low" | "medium" | "high" {
	return value === "high" || value === "medium" || value === "low" ? value : "low";
}

function normalizeMemoryCandidate(value: unknown): MemoryPromotionCandidate | null {
	if (!isRecord(value)) {
		return null;
	}
	if (value.target !== "channel-memory") {
		return null;
	}
	const target = "channel-memory" as const;
	const op = value.op === "supersede" || value.op === "invalidate" ? value.op : "add";
	const targetId = typeof value.targetId === "string" ? value.targetId.trim() : undefined;
	const content = typeof value.content === "string" ? value.content.trim() : undefined;
	const kind =
		value.kind === "preference" ||
		value.kind === "decision" ||
		value.kind === "constraint" ||
		value.kind === "open-loop" ||
		value.kind === "lesson"
			? value.kind
			: "fact";
	if ((op === "invalidate" && !targetId) || (op !== "invalidate" && !content)) {
		return null;
	}
	return {
		target,
		op,
		targetId,
		content,
		kind,
		confidence: normalizeConfidence(value.confidence),
		necessity: normalizeNecessity(value.necessity),
		reason: typeof value.reason === "string" ? value.reason.trim() : "",
	};
}

function normalizeSkillCandidate(value: unknown): SkillPromotionCandidate | null {
	if (!isRecord(value)) {
		return null;
	}
	const action = value.action;
	if (action !== "create" && action !== "patch" && action !== "write_file") {
		return null;
	}
	const name = typeof value.name === "string" ? value.name.trim() : "";
	if (!name) {
		return null;
	}
	return {
		action,
		name,
		content: typeof value.content === "string" ? value.content : undefined,
		filePath: typeof value.filePath === "string" ? value.filePath : undefined,
		find: typeof value.find === "string" ? value.find : undefined,
		replace: typeof value.replace === "string" ? value.replace : undefined,
		confidence: normalizeConfidence(value.confidence),
		necessity: normalizeNecessity(value.necessity),
		reason: typeof value.reason === "string" ? value.reason.trim() : "",
	};
}

export function parsePostTurnReviewResult(value: unknown): PostTurnReviewResult {
	const record = isRecord(value) ? value : {};
	const rawMemoryOps = Array.isArray(record.memoryOps)
		? record.memoryOps
		: Array.isArray(record.memoryCandidates)
			? record.memoryCandidates
			: [];
	const memoryOps =
		rawMemoryOps.length > 0
			? rawMemoryOps.map(normalizeMemoryCandidate).filter((item): item is MemoryPromotionCandidate => !!item)
			: [];
	const skillCandidates = Array.isArray(record.skillCandidates)
		? record.skillCandidates.map(normalizeSkillCandidate).filter((item): item is SkillPromotionCandidate => !!item)
		: [];
	const discarded = Array.isArray(record.discarded)
		? record.discarded
				.filter(isRecord)
				.map((item) => ({
					content: typeof item.content === "string" ? item.content : "",
					reason: typeof item.reason === "string" ? item.reason : "",
				}))
				.filter((item) => item.content.trim() || item.reason.trim())
		: [];
	return { memoryOps, skillCandidates, discarded };
}

async function runPostTurnReviewWorker(options: PostTurnReviewOptions): Promise<PostTurnReviewResult> {
	const [currentSession, currentMemory, currentHistory] = await Promise.all([
		readChannelSession(options.channelDir),
		readChannelMemory(options.channelDir),
		readChannelHistory(options.channelDir),
	]);
	const transcript = clipText(serializeConversation(sanitizeMessagesForMemory(options.messages)), 22_000, {
		headRatio: 0.35,
	});
	const skills = options.loadedSkills
		.map((skill) => `- ${skill.name}${skill.description ? `: ${skill.description}` : ""}`)
		.join("\n");
	const prompt = `Current SESSION.md:
${clipText(currentSession, 6_000, { headRatio: 0.5 }) || "(empty)"}

Current channel MEMORY.md:
${clipText(currentMemory, 6_000, { headRatio: 0.5 }) || "(empty)"}

Current channel HISTORY.md:
${clipText(currentHistory, 2_000, { headRatio: 0.3 }) || "(empty)"}

Loaded workspace skills:
${skills || "(none)"}

Recent transcript:
${transcript || "(empty)"}`;

	const result = await runRetriedSidecarTask({
		name: "memory-post-turn-review",
		model: options.model,
		resolveApiKey: options.resolveApiKey,
		systemPrompt: POST_TURN_REVIEW_SYSTEM_PROMPT,
		prompt,
		timeoutMs: options.timeoutMs,
		usageContext: { channelId: options.channelId, correlationId: options.correlationId },
		parse: (text) => parsePostTurnReviewResult(parseJsonObject(text)),
	});
	return result.output;
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

	const op: MemoryOp =
		candidate.op === "invalidate"
			? { op: "invalidate", targetId: candidate.targetId ?? "", reason: candidate.reason }
			: candidate.op === "supersede"
				? {
						op: "supersede",
						targetId: candidate.targetId ?? "",
						content: candidate.content ?? "",
						sourceEntryIds: options.sourceEntryIds,
						metadata: {
							kind: candidate.kind,
							sourceType: "agent",
							trust: "inferred",
							sourceCorrelationId: options.correlationId,
						},
					}
				: {
						op: "add",
						content: candidate.content ?? "",
						sourceEntryIds: options.sourceEntryIds,
						metadata: {
							kind: candidate.kind,
							sourceType: "agent",
							trust: "inferred",
							sourceCorrelationId: options.correlationId,
						},
					};
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
