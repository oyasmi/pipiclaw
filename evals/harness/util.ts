import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";

export function hash(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

export function hashFile(path: string): string {
	return existsSync(path) ? hash(readFileSync(path)) : "missing";
}

export function tree(
	root: string,
	ignored = new Set(["auth.json", "context.jsonl", "log.jsonl"]),
): Array<{ path: string; hash: string }> {
	const output: Array<{ path: string; hash: string }> = [];
	const visit = (dir: string): void => {
		for (const name of readdirSync(dir).sort()) {
			const absolute = join(dir, name);
			const rel = relative(root, absolute);
			if (ignored.has(name)) continue;
			const stat = lstatSync(absolute);
			if (stat.isSymbolicLink()) output.push({ path: rel, hash: hash(`symlink:${readlinkSync(absolute)}`) });
			else if (stat.isDirectory()) visit(absolute);
			else if (stat.isFile()) output.push({ path: rel, hash: hashFile(absolute) });
		}
	};
	if (existsSync(root)) visit(root);
	return output.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Unit of account for providers that omit pricing metadata.
 *
 * Most self-hosted and Chinese-gateway models return usage without a price (the product side
 * already models this: `hasKnownModelPricing` in `src/models/utils.ts`, `usage.costKnown` in
 * `src/tasks/control.ts`). The harness used to copy that missing price through as `0`, so every
 * report printed `$0.0000` — which reads as "free" rather than "unknown", left `maxCostUsd`
 * unenforceable, and made the cost column of `eval:diff` a constant zero.
 *
 * These Sonnet-class list rates (USD per million tokens) are therefore a **stable ruler for
 * comparing runs**, not a claim about the operator's invoice. Every trial priced this way is
 * marked `costBasis: "fallback"` so no report can silently pass it off as a real amount.
 */
export const FALLBACK_TOKEN_RATES_USD_PER_MTOK = {
	input: 3,
	output: 15,
	cacheRead: 0.3,
	cacheWrite: 3.75,
} as const;

export type CostBasis = "provider" | "fallback";

export function fallbackCostUsd(tokens: {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}): number {
	const rates = FALLBACK_TOKEN_RATES_USD_PER_MTOK;
	return (
		(tokens.input * rates.input +
			tokens.output * rates.output +
			tokens.cacheRead * rates.cacheRead +
			tokens.cacheWrite * rates.cacheWrite) /
		1_000_000
	);
}

export function parseRatio(value: string): { passed: number; total: number } {
	const match = /^(\d+)\/(\d+)$/.exec(value);
	if (!match) throw new Error(`Invalid minPass '${value}'; use N/N.`);
	const passed = Number(match[1]);
	const total = Number(match[2]);
	if (total < 1 || passed > total) throw new Error(`Invalid minPass '${value}'; require 0 <= N <= total.`);
	return { passed, total };
}

export function median(values: number[]): number {
	if (!values.length) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

const CREDENTIAL =
	/(sk-[A-Za-z0-9_-]{12,}|api[_-]?key\s*[:=]\s*["']?\S{12,}|"key"\s*:\s*"\S{12,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/i;

export function credentialMatches(root: string): string[] {
	const matches: string[] = [];
	const visit = (dir: string): void => {
		for (const name of readdirSync(dir)) {
			if (name === "auth.json") continue;
			const item = join(dir, name);
			const stat = lstatSync(item);
			if (stat.isSymbolicLink()) continue;
			if (stat.isDirectory()) visit(item);
			else if (stat.isFile() && stat.size <= 5_000_000) {
				const content = readFileSync(item, "utf8");
				if (CREDENTIAL.test(content)) matches.push(relative(root, item));
			}
		}
	};
	if (existsSync(root)) visit(root);
	return matches.sort();
}

export function containsCredential(root: string): boolean {
	return credentialMatches(root).length > 0;
}
