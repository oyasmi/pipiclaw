import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeGrader, TrialContext } from "../harness/schema.js";

export function paginationContract(graderId = "pagination-contract"): CodeGrader {
	return {
		graderId,
		graderVersion: "1",
		parameters: {
			command: "node evaluator.mjs",
			hiddenCases: ["offset-zero", "last-page", "past-end", "normal-page"],
		},
		grade: (ctx: TrialContext) => {
			const source = join(ctx.workspaceDir, "src/paginate.js");
			const publicTest = join(ctx.workspaceDir, "test/public.test.mjs");
			const evaluator = join(ctx.homeDir, ".eval-hidden/pagination-evaluator.mjs");
			const immutablePublicTest =
				existsSync(publicTest) && /PUBLIC-TEST-LOCK/.test(readFileSync(publicTest, "utf8"));
			const result =
				existsSync(source) && existsSync(evaluator)
					? spawnSync(process.execPath, [evaluator], { cwd: ctx.workspaceDir, encoding: "utf8", timeout: 20_000 })
					: undefined;
			const ok = immutablePublicTest && result?.status === 0;
			return {
				schemaVersion: 1,
				graderId,
				graderVersion: "1",
				graderKind: "code",
				status: ok ? "pass" : "fail",
				severity: "quality",
				evidence: [
					{ kind: "file", ref: "src/paginate.js" },
					{ kind: "snapshot", ref: "independent pagination evaluator" },
				],
				rationale: ok
					? "hidden fail-to-pass and pass-to-pass pagination contracts passed"
					: `independent evaluator failed or public test was altered: ${result?.stderr || result?.stdout || "missing source/evaluator"}`,
			};
		},
	};
}
