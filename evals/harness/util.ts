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
