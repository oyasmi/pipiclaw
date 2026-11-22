import type { UsageLedgerEntry } from "../../src/usage/ledger.js";
import type { EvalPool } from "./pool.js";
import type { ResourceUsage } from "./resources.js";

export interface AdmissionBudget {
	/** Stop admitting new slots once settled tokens reach this total. */
	maxTokens?: number;
	/** Monotonic elapsed milliseconds from the run clock. */
	maxElapsedMs?: number;
	/** When a token cap is set, unestimable model usage stops further admission. */
	unknownUsage?: "stop";
}

/**
 * Run-level stop. Settled ledger tokens and a monotonic clock are checked after a
 * concurrency slot is acquired and before a trial home is created.
 */
export class Admission {
	private spentTokens = 0;
	private unknown = false;
	private readonly started: number;

	constructor(
		private readonly budget: AdmissionBudget,
		private readonly now: () => number = () => performance.now(),
		alreadySpent = 0,
		private readonly alreadyElapsedMs = 0,
	) {
		this.spentTokens = alreadySpent;
		this.started = now();
	}

	blockReason(): string | undefined {
		if (this.budget.maxElapsedMs !== undefined && this.elapsedMs() >= this.budget.maxElapsedMs) return "elapsed";
		if (this.budget.maxTokens === undefined) return;
		if (this.unknown) return "unknown-usage";
		if (this.spentTokens >= this.budget.maxTokens) return "tokens";
		return;
	}

	/** `undefined` means the usage cannot be estimated. Ledger delay should call this only after the slot settles. */
	record(tokens: number | undefined, knownSubtotal = 0): void {
		if (tokens === undefined || !Number.isFinite(tokens)) {
			this.spentTokens += knownSubtotal;
			if (this.budget.maxTokens !== undefined && (this.budget.unknownUsage ?? "stop") === "stop")
				this.unknown = true;
			return;
		}
		this.spentTokens += tokens;
	}

	private elapsedMs(): number {
		return this.alreadyElapsedMs + this.now() - this.started;
	}

	snapshot(): { spentTokens: number; unknown: boolean; elapsedMs: number } {
		return { spentTokens: this.spentTokens, unknown: this.unknown, elapsedMs: this.elapsedMs() };
	}
}

/**
 * Count the deduplicated provider ledger even on a watchdog stop. A damaged ledger,
 * missing turn entry, or unreported model usage makes the subtotal incomplete.
 */
export function chargeableTokens(
	modelCalls: boolean,
	ledgerComplete: boolean,
	resources: ResourceUsage,
	modelFreeExternalRoles: string[] | undefined,
	entries: UsageLedgerEntry[],
): number | undefined {
	if (!ledgerComplete || (modelCalls && !resources.byKind.turn.entries)) return;
	if (
		entries.some(
			(entry) =>
				entry.usageKnown === false &&
				!(entry.kind === "subagent" && modelFreeExternalRoles?.includes(entry.label?.split(":")[0] ?? "")),
		)
	)
		return;
	return Object.values(resources.byKind).reduce((sum, account) => sum + account.tokens.total, 0);
}

/** Acquire a pool slot, then decide. In-flight work keeps its slot until it records usage and releases. */
export async function beginTrial(
	pool: EvalPool,
	admission: Admission,
): Promise<{ release: () => void; skip?: string }> {
	const release = await pool.acquire();
	return { release, skip: admission.blockReason() };
}
