/** Two-sided Wilson score interval for a binomial proportion. */
export function wilsonInterval(
	successes: number,
	samples: number,
	z = 1.959963984540054,
): [number, number] | undefined {
	if (
		!Number.isInteger(successes) ||
		!Number.isInteger(samples) ||
		samples <= 0 ||
		successes < 0 ||
		successes > samples
	)
		return;
	const proportion = successes / samples;
	const z2 = z * z;
	const denominator = 1 + z2 / samples;
	const center = (proportion + z2 / (2 * samples)) / denominator;
	const margin = (z * Math.sqrt((proportion * (1 - proportion) + z2 / (4 * samples)) / samples)) / denominator;
	return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

export function formatWilson(successes: number, samples: number): string {
	const interval = wilsonInterval(successes, samples);
	return interval ? `${(interval[0] * 100).toFixed(0)}–${(interval[1] * 100).toFixed(0)}%` : "N/A";
}
