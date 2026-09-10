import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { UsageKind, UsageLedgerEntry, UsageTokens } from "../../src/usage/ledger.js";
import { fallbackCostUsd } from "./util.js";

export interface ResourceAccount {
	entries: number;
	tokens: UsageTokens;
	knownCostUsd: number;
	unknownCostEntries: number;
	unknownTokenEntries: number;
	standardizedCostUnits: number;
}
export interface ResourceUsage {
	source: "product-ledger";
	complete: boolean;
	byKind: Record<UsageKind, ResourceAccount>;
	agentCostUsd: number | null;
	standardizedCostUnits: number;
}
const account = (): ResourceAccount => ({
	entries: 0,
	tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	knownCostUsd: 0,
	unknownCostEntries: 0,
	unknownTokenEntries: 0,
	standardizedCostUnits: 0,
});

/** Read each ledger row once; an incomplete final write is unavailable evidence, not zero usage. */
export function readResourceLedger(homeDir: string): { entries: UsageLedgerEntry[]; complete: boolean } {
	const dir = join(homeDir, "state", "usage");
	if (!existsSync(dir)) return { entries: [], complete: true };
	const entries: UsageLedgerEntry[] = [];
	let complete = true;
	for (const name of readdirSync(dir)
		.filter((file) => /^usage-.*\.jsonl$/.test(file))
		.sort()) {
		for (const line of readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean)) {
			try {
				const row = JSON.parse(line) as UsageLedgerEntry;
				if (
					!["turn", "subagent", "sidecar"].includes(row.kind) ||
					!row.usage ||
					!row.cost ||
					![row.usage, row.cost].every((value) =>
						["input", "output", "cacheRead", "cacheWrite", "total"].every((key) => {
							const number = value[key as keyof UsageTokens];
							return typeof number === "number" && Number.isFinite(number) && number >= 0;
						}),
					)
				) {
					complete = false;
					continue;
				}
				entries.push(row);
			} catch {
				complete = false;
			}
		}
	}
	return { entries, complete };
}

/** Never add observer usage to the ledger: turns already contain that spend. */
export function summarizeResources(entries: UsageLedgerEntry[], complete = true): ResourceUsage {
	const byKind: ResourceUsage["byKind"] = { turn: account(), subagent: account(), sidecar: account() };
	const runs = new Set<string>();
	for (const entry of entries) {
		if (entry.kind === "subagent" && entry.runId) {
			if (runs.has(entry.runId)) continue;
			runs.add(entry.runId);
		}
		const bucket = byKind[entry.kind];
		bucket.entries++;
		if (entry.usageKnown === false) bucket.unknownTokenEntries++;
		else
			for (const key of Object.keys(bucket.tokens) as Array<keyof UsageTokens>)
				bucket.tokens[key] += entry.usage[key] ?? 0;
		if (entry.costKnown === false || (entry.costKnown !== true && entry.cost.total === 0))
			bucket.unknownCostEntries++;
		else bucket.knownCostUsd += entry.cost.total;
		bucket.standardizedCostUnits += fallbackCostUsd(entry.usage);
	}
	const accounts = Object.values(byKind);
	return {
		source: "product-ledger",
		complete,
		byKind,
		agentCostUsd:
			complete && accounts.every((value) => !value.unknownCostEntries)
				? accounts.reduce((sum, value) => sum + value.knownCostUsd, 0)
				: null,
		standardizedCostUnits: accounts.reduce((sum, value) => sum + value.standardizedCostUnits, 0),
	};
}
