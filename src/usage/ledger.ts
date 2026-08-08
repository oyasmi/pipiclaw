import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import * as log from "../log.js";
import { USAGE_STATE_DIR } from "../paths.js";
import { createJsonlAppender, type JsonlAppender } from "../shared/jsonl-appender.js";
import { formatLocalTime, parseLocalTime } from "../shared/local-time.js";

export type UsageKind = "turn" | "subagent" | "sidecar";

export interface UsageTokens {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface UsageCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface UsageLedgerEntry {
	ts: string;
	channelId: string;
	kind: UsageKind;
	model: string;
	label?: string;
	/** Joins sidecar cost to the memory source window and review-log outcome. */
	correlationId?: string;
	/** Idempotency key for a delegation run's usage entry (spec 040, D7); absent for turn/sidecar kinds. */
	runId?: string;
	usage: UsageTokens;
	cost: UsageCost;
	/** False only when the harness cannot report tokens at all (external `exec`). Display as "unknown", not 0. */
	usageKnown?: boolean;
	/** False when the harness omits a cost field (external `codex-cli`/`exec`). Display as "unknown", not 0. */
	costKnown?: boolean;
}

export interface UsageSummary {
	totalCost: number;
	/** Tokens behind `totalCost`; the only signal there is when a model reports no pricing. */
	totalTokens: number;
	entryCount: number;
	byKind: Record<string, number>;
	byModel: Record<string, number>;
	byChannel: Record<string, number>;
	/** Entries with `usageKnown === false` (e.g. the `exec` harness never reports tokens at all).
	 *  Their `usage.total` is always 0 and never contributes to `totalTokens` — display this count
	 *  rather than let those runs silently read as "0 tokens used". */
	unknownUsageCount: number;
	/** Entries with `costKnown === false` (e.g. `codex-cli`/`exec`, which report no cost field).
	 *  Their `cost.total` is always 0 and never contributes to `totalCost` — same rationale. */
	unknownCostCount: number;
}

export interface UsageSummaryQuery {
	since: Date;
	until?: Date;
	channelId?: string;
}

export const UNTRACKED_CHANNEL_ID = "(untracked)";

function monthKey(date: Date): string {
	return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthKeysBetween(since: Date, until: Date): string[] {
	const keys: string[] = [];
	const cursor = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), 1));
	const end = new Date(Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), 1));
	while (cursor <= end) {
		keys.push(monthKey(cursor));
		cursor.setUTCMonth(cursor.getUTCMonth() + 1);
	}
	return keys;
}

export interface UsageLedger {
	record(entry: Omit<UsageLedgerEntry, "ts">): void;
	summarize(query: UsageSummaryQuery): Promise<UsageSummary>;
	flush?(): Promise<void>;
	close?(): Promise<void>;
}

export interface CreateUsageLedgerOptions {
	baseDir?: string;
}

export function createUsageLedger(options: CreateUsageLedgerOptions = {}): UsageLedger {
	const baseDir = options.baseDir ?? USAGE_STATE_DIR;
	const fileFor = (date: Date): string => join(baseDir, `usage-${monthKey(date)}.jsonl`);
	const appender: JsonlAppender = createJsonlAppender({ pathFor: fileFor });
	/**
	 * Parsed month files, keyed on path and invalidated by size/mtime.
	 *
	 * One `/usage` report calls `summarize` several times — a global and a per-channel figure for
	 * every window it renders — and each call used to re-read and re-parse the same month file,
	 * synchronously, on the daemon's event loop. The cache collapses those into one parse; the
	 * fingerprint means an appended entry is still picked up on the next report.
	 */
	const monthCache = new Map<string, { mtimeMs: number; size: number; entries: UsageLedgerEntry[] }>();

	const loadMonth = async (path: string): Promise<UsageLedgerEntry[]> => {
		let fingerprint: { mtimeMs: number; size: number };
		try {
			const stats = await stat(path);
			fingerprint = { mtimeMs: stats.mtimeMs, size: stats.size };
		} catch {
			monthCache.delete(path);
			return [];
		}
		const cached = monthCache.get(path);
		if (cached && cached.mtimeMs === fingerprint.mtimeMs && cached.size === fingerprint.size) {
			return cached.entries;
		}

		let content: string;
		try {
			content = await readFile(path, "utf-8");
		} catch {
			return [];
		}
		const entries: UsageLedgerEntry[] = [];
		for (const line of content.split("\n")) {
			if (!line) continue;
			try {
				entries.push(JSON.parse(line) as UsageLedgerEntry);
			} catch {
				// Tolerate a torn trailing line.
			}
		}
		monthCache.set(path, { ...fingerprint, entries });
		return entries;
	};

	return {
		record(entry: Omit<UsageLedgerEntry, "ts">): void {
			// Record anything that consumed tokens, even at zero cost: a local model, or one whose
			// pricing metadata is missing, still has to show up somewhere or `/usage` reports nothing
			// at all and any spend guard built on this ledger fails open. Only a genuinely empty
			// entry (no tokens, no cost, and nothing unknown either) is dropped as noise — an entry
			// with `usageKnown`/`costKnown` false always has zero numeric totals by construction (the
			// harness has nothing to report), so without this exemption every such run would be
			// silently dropped instead of showing up as "unknown" (spec 040, T7).
			const hasKnownSignal = entry.cost.total > 0 || entry.usage.total > 0;
			const hasUnknownSignal = entry.usageKnown === false || entry.costKnown === false;
			if (!hasKnownSignal && !hasUnknownSignal) return;
			if (!entry.channelId) {
				log.logWarning("Usage ledger entry missing channelId; recording as untracked", `kind=${entry.kind}`);
			}
			const full: UsageLedgerEntry = {
				ts: formatLocalTime(),
				...entry,
				channelId: entry.channelId || UNTRACKED_CHANNEL_ID,
			};
			appender.tryAppend(full);
		},

		flush: () => appender.flush(),
		close: () => appender.close(),

		async summarize(query: UsageSummaryQuery): Promise<UsageSummary> {
			const until = query.until ?? new Date();
			const sinceMs = query.since.getTime();
			const untilMs = until.getTime();
			const summary: UsageSummary = {
				totalCost: 0,
				totalTokens: 0,
				entryCount: 0,
				byKind: {},
				byModel: {},
				byChannel: {},
				unknownUsageCount: 0,
				unknownCostCount: 0,
			};

			for (const key of monthKeysBetween(query.since, until)) {
				for (const entry of await loadMonth(join(baseDir, `usage-${key}.jsonl`))) {
					const tsMs = parseLocalTime(entry.ts);
					if (tsMs === undefined || tsMs < sinceMs || tsMs > untilMs) continue;
					if (query.channelId && entry.channelId !== query.channelId) continue;
					const cost = entry.cost?.total ?? 0;
					summary.totalCost += cost;
					summary.totalTokens += entry.usage?.total ?? 0;
					summary.entryCount += 1;
					summary.byKind[entry.kind] = (summary.byKind[entry.kind] ?? 0) + cost;
					summary.byModel[entry.model] = (summary.byModel[entry.model] ?? 0) + cost;
					summary.byChannel[entry.channelId] = (summary.byChannel[entry.channelId] ?? 0) + cost;
					// `undefined` (every entry recorded before this field existed) counts as known —
					// backward compatibility for a ledger that predates this distinction.
					if (entry.usageKnown === false) summary.unknownUsageCount += 1;
					if (entry.costKnown === false) summary.unknownCostCount += 1;
				}
			}

			return summary;
		},
	};
}

let singleton: UsageLedger | null = null;

/** Process-wide ledger (single-process runtime). Tests use createUsageLedger. */
export function getUsageLedger(): UsageLedger {
	if (!singleton) {
		singleton = createUsageLedger();
	}
	return singleton;
}
