import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeGrader } from "../harness/schema.js";

/** The fixture supplies independently checkable facts; prose judgments remain advisory. */
export function researchDecision(): CodeGrader {
	return {
		graderId: "research-decision",
		graderVersion: "1",
		grade: (ctx) => {
			const path = join(ctx.deskDir, "operator-decision.json");
			let ok = false;
			try {
				const value = existsSync(path)
					? (JSON.parse(readFileSync(path, "utf8")) as {
							currentSource?: string;
							supersededSource?: string;
							primaryTransport?: string;
							memoryLayers?: string[];
							incident?: { id?: string; dispatch?: boolean; blockers?: string[] };
						})
					: undefined;
				ok =
					value?.currentSource === "runtime.md" &&
					value.supersededSource === "legacy.md" &&
					value.primaryTransport?.toLowerCase() === "dingtalk" &&
					Array.isArray(value.memoryLayers) &&
					value.memoryLayers.length === 2 &&
					value.memoryLayers.includes("daily-journal") &&
					value.memoryLayers.includes("durable-facts") &&
					value.incident?.id === "RC-17" &&
					value.incident.dispatch === false &&
					Array.isArray(value.incident.blockers) &&
					value.incident.blockers.length === 2 &&
					value.incident.blockers.includes("attempt-budget") &&
					value.incident.blockers.includes("deadline");
			} catch {
				/* Malformed/missing requested structured output is a failed completion. */
			}
			return {
				schemaVersion: 1,
				graderId: "research-decision",
				graderVersion: "1",
				status: ok ? "pass" : "fail",
				severity: "quality",
				evidence: [{ kind: "file", ref: "operator-decision.json" }],
				rationale:
					"The operator decision must identify authoritative and superseded sources, separate journal from facts, and refuse RC-17 for both exhausted budget and expired deadline.",
			};
		},
	};
}
