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
			/(?:^|[;&|]\s*)node\s+verify\.mjs\b/.test(fields.command ?? "") &&
			fields.digestVerify === expectedVerify &&
			finalConfig !== undefined &&
			fields.digestConfig === finalConfig
		);
	});
	return bound;
}
