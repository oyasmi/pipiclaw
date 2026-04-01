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
