import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as log from "../log.js";
import { USAGE_STATE_DIR } from "../paths.js";
import { createJsonlAppender, type JsonlAppender } from "../shared/jsonl-appender.js";

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
	usage: UsageTokens;
	cost: UsageCost;
}

export interface UsageSummary {
	totalCost: number;
	entryCount: number;
	byKind: Record<string, number>;
	byModel: Record<string, number>;
	byChannel: Record<string, number>;
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
	summarize(query: UsageSummaryQuery): UsageSummary;
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

	return {
		record(entry: Omit<UsageLedgerEntry, "ts">): void {
			// No API billing (local models) → no ledger noise.
			if (!(entry.cost.total > 0)) return;
			if (!entry.channelId) {
				log.logWarning("Usage ledger entry missing channelId; recording as untracked", `kind=${entry.kind}`);
			}
			const full: UsageLedgerEntry = {
				ts: new Date().toISOString(),
				...entry,
				channelId: entry.channelId || UNTRACKED_CHANNEL_ID,
			};
			appender.tryAppend(full);
		},

		flush: () => appender.flush(),
		close: () => appender.close(),

		summarize(query: UsageSummaryQuery): UsageSummary {
			const until = query.until ?? new Date();
			const sinceMs = query.since.getTime();
			const untilMs = until.getTime();
			const summary: UsageSummary = {
				totalCost: 0,
				entryCount: 0,
				byKind: {},
				byModel: {},
				byChannel: {},
			};

			for (const key of monthKeysBetween(query.since, until)) {
				const path = join(baseDir, `usage-${key}.jsonl`);
				if (!existsSync(path)) continue;
				let content: string;
				try {
					content = readFileSync(path, "utf-8");
				} catch {
					continue;
				}
				for (const line of content.split("\n")) {
					if (!line) continue;
					let entry: UsageLedgerEntry;
					try {
						entry = JSON.parse(line) as UsageLedgerEntry;
					} catch {
						continue; // tolerate a torn trailing line
					}
					const tsMs = Date.parse(entry.ts);
					if (Number.isNaN(tsMs) || tsMs < sinceMs || tsMs > untilMs) continue;
					if (query.channelId && entry.channelId !== query.channelId) continue;
					const cost = entry.cost?.total ?? 0;
					summary.totalCost += cost;
					summary.entryCount += 1;
					summary.byKind[entry.kind] = (summary.byKind[entry.kind] ?? 0) + cost;
					summary.byModel[entry.model] = (summary.byModel[entry.model] ?? 0) + cost;
					summary.byChannel[entry.channelId] = (summary.byChannel[entry.channelId] ?? 0) + cost;
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
