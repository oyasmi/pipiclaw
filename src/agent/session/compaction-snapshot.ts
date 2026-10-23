/** Immutable prefix provenance and safe cuts over the SDK's public canonical projection. */
import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AgentSession,
	buildSessionProjection,
	type CompactionResult,
	convertToLlm,
	type FileOperations,
	type SessionBeforeCompactEvent,
	type SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "../../shared/format.js";
import { isRecord } from "../../shared/type-guards.js";
import { getPreventiveCompactionDecision } from "../turn/context-budget.js";

export interface CompactionSnapshot {
	session: AgentSession;
	manager: SessionManager;
	sessionId: string;
	modelKey: string;
	prefixHash: string;
	baseCompactionId?: string;
	throughEntryId: string;
	entries: SessionEntry[];
	preparation: SessionBeforeCompactEvent["preparation"];
}

function hash(entries: SessionEntry[]): string {
	return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function modelKey(session: AgentSession): string {
	const model = session.model;
	return JSON.stringify(model && [model.provider, model.id, model.api, model.baseUrl, model.contextWindow]);
}

export function estimateContext(messages: AgentMessage[]): number {
	return estimateTokens(JSON.stringify(convertToLlm(messages)));
}

/** Usage already includes system/tools. Fall back to the complete projection when SDK usage is unknown. */
export function compactionBudget(session: AgentSession, incoming = 0) {
	const usage = session.getContextUsage();
	const window = Math.min(session.model?.contextWindow ?? 0, usage?.contextWindow ?? Number.POSITIVE_INFINITY);
	const reserve = session.settingsManager.getCompactionSettings(session.model).reserveTokens;
	const hard = Math.max(0, window - reserve - 4096);
	const decision = getPreventiveCompactionDecision(
		usage?.tokens ?? estimateContext(session.messages),
		incoming,
		hard,
		0.7,
	);
	return {
		window,
		hard,
		soft: decision.thresholdTokens,
		projected: decision.projectedTokens ?? 0,
	};
}

/** Only cut where all preceding tool calls have results. A tool batch is indivisible. */
export function captureCompaction(session: AgentSession): CompactionSnapshot | undefined {
	const entries = structuredClone(session.sessionManager.getBranch());
	const projection = buildSessionProjection(entries).entries;
	const previous = projection.find((entry) => entry.sourceEntry.type === "compaction" && entry.messages.length > 0);
	const start = previous ? projection.indexOf(previous) + 1 : 0;
	const settings = session.settingsManager.getCompactionSettings(session.model);
	const safe: number[] = [];
	const pending = new Set<string>();
	for (let index = start; index < projection.length; index++) {
		const messages = projection[index]!.messages;
		if (pending.size === 0 && messages.some((message) => message.role === "user" || message.role === "assistant"))
			safe.push(index);
		for (const message of messages) {
			if (message.role === "assistant") {
				for (const part of message.content) if (part.type === "toolCall") pending.add(part.id);
			} else if (message.role === "toolResult") {
				if (!pending.delete(message.toolCallId)) return;
			}
		}
	}
	if (pending.size > 0) return;
	let kept = 0;
	let desired = start;
	for (let index = projection.length - 1; index >= start; index--) {
		kept += estimateContext(projection[index]!.messages);
		if (kept >= settings.keepRecentTokens) {
			desired = index;
			break;
		}
	}
	const eligible = safe.filter((index) => index > start);
	// An oversized final tool result has no cut after it. Retain its entire batch instead.
	const cut = eligible.find((index) => index >= desired) ?? eligible.at(-1);
	if (cut === undefined) return;
	const firstKeptEntryId = projection[cut]!.sourceEntry.id;
	const messages = projection
		.slice(start, cut)
		.flatMap((entry) => entry.messages.filter((message) => message.role !== "system"));
	if (!messages.length) return;
	const fileOps: FileOperations = { read: new Set(), written: new Set(), edited: new Set() };
	const record = (name: string, args: unknown) => {
		if (!isRecord(args) || typeof args.path !== "string") return;
		if (name === "read") fileOps.read.add(args.path);
		if (name === "write") fileOps.written.add(args.path);
		if (name === "edit") fileOps.edited.add(args.path);
	};
	for (const message of messages) {
		if (message.role === "assistant")
			for (const part of message.content) if (part.type === "toolCall") record(part.name, part.arguments);
		if (message.role === "toolResult")
			for (const call of message.nestedCalls?.calls ?? []) record(call.name, call.arguments);
	}
	return {
		session,
		manager: session.sessionManager,
		sessionId: session.sessionManager.getSessionId(),
		modelKey: modelKey(session),
		prefixHash: hash(entries),
		baseCompactionId: previous?.sourceEntry.id,
		throughEntryId: projection[cut - 1]!.sourceEntry.id,
		entries,
		preparation: {
			firstKeptEntryId,
			messagesToSummarize: messages,
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: session.getContextUsage()?.tokens ?? estimateContext(session.messages),
			previousSummary: previous?.sourceEntry.type === "compaction" ? previous.sourceEntry.summary : undefined,
			fileOps,
			settings,
		},
	};
}

export function snapshotInvalidation(snapshot: CompactionSnapshot, session: AgentSession): string | undefined {
	if (
		session !== snapshot.session ||
		session.sessionManager !== snapshot.manager ||
		session.sessionManager.getSessionId() !== snapshot.sessionId
	)
		return "session-changed";
	if (modelKey(session) !== snapshot.modelKey) return "model-changed";
	const branch = session.sessionManager.getBranch();
	if (
		branch.length < snapshot.entries.length ||
		hash(branch.slice(0, snapshot.entries.length)) !== snapshot.prefixHash
	)
		return "prefix-changed";
	if (
		branch
			.slice(snapshot.entries.length)
			.some((entry) => ["context_edit", "compaction", "branch_summary", "model_change"].includes(entry.type))
	)
		return "history-changed";
}

/** Preview using the same SDK projection/persistence protocol as the real commit. No live mutation. */
export function compactionGain(
	snapshot: CompactionSnapshot,
	result: CompactionResult,
): { before: number; after: number; accepted: boolean } {
	const session = snapshot.session;
	const header = session.sessionManager.getHeader();
	if (!header) throw new Error("Session header missing. Use /new to recover.");
	const preview = SessionManager.inMemory(session.sessionManager.getCwd(), undefined, [
		header,
		...session.sessionManager.getBranch(),
	]);
	preview.appendCompaction(
		result.summary,
		result.firstKeptEntryId,
		result.tokensBefore,
		result.details,
		true,
		result.usage,
	);
	const before = estimateContext(session.sessionManager.buildSessionProjection().messages);
	const after = estimateContext(preview.buildSessionProjection().messages);
	const budget = compactionBudget(session);
	return {
		before,
		after,
		accepted: before - after >= Math.min(8192, budget.window * 0.04) && after <= before * 0.9 && after < budget.soft,
	};
}
