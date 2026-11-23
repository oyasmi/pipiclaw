import { existsSync } from "node:fs";
import { join } from "node:path";
import { commandObservations, type EvidenceVerdict } from "../harness/evidence.js";
import type { TrialContext } from "../harness/schema.js";
import { hash, hashFile } from "../harness/util.js";

/** The fixture verifier. Grading hashes this text; a rewritten script cannot satisfy integrity. */
export const BILLING_VERIFY_SCRIPT = `import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const cfg = JSON.parse(readFileSync("config.json", "utf8"));
writeFileSync(".verified", JSON.stringify({ cwd: resolve("."), port: cfg.port, releaseTag: cfg.releaseTag }) + "\\n");
`;

type ShellOp = "start" | "&&" | "||" | ";";

/**
 * Exit 0 proves `node verify.mjs` itself succeeded, and no later command in the same
 * shell rewrites the config the verifier just checked.
 */
export function verifyCommandProvesSuccess(command: string): boolean {
	const segments: Array<{ op: ShellOp; text: string }> = [];
	const splitter = /&&|\|\||;/g;
	let cursor = 0;
	let op: ShellOp = "start";
	for (const match of command.matchAll(splitter)) {
		const text = command.slice(cursor, match.index).trim();
		if (text) segments.push({ op, text });
		op = match[0] === "&&" ? "&&" : match[0] === "||" ? "||" : ";";
		cursor = (match.index ?? 0) + match[0].length;
	}
	const tail = command.slice(cursor).trim();
	if (tail) segments.push({ op, text: tail });
	const index = segments.findIndex((segment) => /(?:^|\s)node\s+verify\.mjs\b/.test(segment.text));
	if (index < 0) return false;
	const later = segments.slice(index + 1);
	if (later.some((segment) => segment.op === "||" || segment.op === ";")) return false;
	return !later.some((segment) => mutatesBillingConfig(segment.text));
}

function mutatesBillingConfig(text: string): boolean {
	if (!/config\.json/.test(text)) return false;
	return />>?/.test(text) || /\b(?:tee|sed|cp|mv|rm|truncate)\b/.test(text) || /writeFile|write_text/.test(text);
}

/**
 * Successful `node verify.mjs` in the billing repo, bound to the final config bytes
 * and the original verifier. A `.verified` file or a bare `task_list` success is not enough.
 */
export function billingCommandBound(ctx: TrialContext): EvidenceVerdict {
	const facts = commandObservations(ctx);
	if (!facts.length) return "missing";
	const expectedVerify = hash(BILLING_VERIFY_SCRIPT);
	const configPath = join(ctx.workspaceDir, "repos/billing/config.json");
	const finalConfig = existsSync(configPath) ? hashFile(configPath) : undefined;
	const bound = facts.some((event) => {
		const fields = event.fields ?? {};
		return (
			fields.cwdRoot === "workspace" &&
			fields.cwdRel === "repos/billing" &&
			fields.exitCode === "0" &&
			verifyCommandProvesSuccess(fields.command ?? "") &&
			fields.digestVerify === expectedVerify &&
			finalConfig !== undefined &&
			fields.digestConfig === finalConfig
		);
	});
	return bound;
}
