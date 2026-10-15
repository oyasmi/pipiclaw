import { hash } from "./util.js";

/** All experimental randomness comes from the frozen slot seed, never wall time or run id. */
export function trialSeed(caseId: string, trial: number): string {
	return hash(`${caseId}:${trial}`);
}

export function fixtureInteger(seed: string | undefined, label: string, min: number, max: number): number {
	const number = Number.parseInt(hash(`${seed ?? "control"}:${label}`).slice(0, 8), 16);
	return min + (number % (max - min + 1));
}

export function fixtureToken(seed: string | undefined, prefix: string): string {
	return `${prefix}-${fixtureInteger(seed, prefix, 100, 999)}`;
}
