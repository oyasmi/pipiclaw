export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export function createEmptyUsageTotals(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/**
 * The minimal shape `addUsage` needs — both the SDK's own `Usage` (`totalTokens` required, no
 * `total`) and this codebase's looser event-message usage shapes (`total` and/or `totalTokens`,
 * both optional) satisfy it structurally, so one accumulator serves every usage-tallying site
 * (assistant turns, sub-agent runs, internal delegation workers) instead of each hand-rolling the
 * same ten-field sum.
 */
export interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total?: number;
	totalTokens?: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export function addUsage(target: UsageTotals, usage: UsageLike): void {
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.total += usage.total ?? usage.totalTokens ?? usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	target.cost.input += usage.cost.input;
	target.cost.output += usage.cost.output;
	target.cost.cacheRead += usage.cost.cacheRead;
	target.cost.cacheWrite += usage.cost.cacheWrite;
	target.cost.total += usage.cost.total;
}
