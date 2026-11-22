import type { EvalPool } from "./pool.js";

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
	) {
		this.spentTokens = alreadySpent;
		this.started = now();
	}

	blockReason(): string | undefined {
		if (this.budget.maxElapsedMs !== undefined && this.now() - this.started >= this.budget.maxElapsedMs)
			return "elapsed";
		if (this.budget.maxTokens === undefined) return;
		if (this.unknown) return "unknown-usage";
		if (this.spentTokens >= this.budget.maxTokens) return "tokens";
		return;
	}

	/** `undefined` means the usage cannot be estimated. Ledger delay should call this only after the slot settles. */
	record(tokens: number | undefined): void {
		if (tokens === undefined || !Number.isFinite(tokens)) {
			if (this.budget.maxTokens !== undefined && (this.budget.unknownUsage ?? "stop") === "stop")
				this.unknown = true;
			return;
		}
		this.spentTokens += tokens;
	}

	snapshot(): { spentTokens: number; unknown: boolean; elapsedMs: number } {
		return { spentTokens: this.spentTokens, unknown: this.unknown, elapsedMs: this.now() - this.started };
	}
}

/**
 * Tokens that count toward the run cap. A stopped trial with a ledger still has a known total.
 * Unknown is only a model call that produced no ledger entry.
 */
export function chargeableTokens(modelCalls: boolean, ledgerEntries: number, tokens: number): number | undefined {
	if (!modelCalls && ledgerEntries === 0) return 0;
	if (ledgerEntries > 0 && Number.isFinite(tokens)) return tokens;
	return undefined;
}

/** Acquire a pool slot, then decide. In-flight work keeps its slot until it records usage and releases. */
export async function beginTrial(
	pool: EvalPool,
	admission: Admission,
): Promise<{ release: () => void; skip?: string }> {
	const release = await pool.acquire();
	return { release, skip: admission.blockReason() };
}
