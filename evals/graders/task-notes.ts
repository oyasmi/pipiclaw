import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeGrader } from "../harness/schema.js";
import { observesFile } from "./observations.js";

/** Observable evidence owns correctness; linguistic quality can be an optional advisory. */
export function noteObservedEvidence(): CodeGrader {
	return {
		graderId: "note-observed-evidence",
		graderVersion: "1",
		grade: (ctx) => {
			const file = join(ctx.dotDir, "evidence.txt");
			const logs = [
				join(ctx.dotDir, "tasks/evidence-note.jsonl"),
				join(ctx.dotDir, "tasks/archive/evidence-note.jsonl"),
			];
			const notes = logs
				.filter(existsSync)
				.flatMap((path) =>
					readFileSync(path, "utf8")
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line) as { kind?: string; note?: string }),
				)
				.filter((entry) => entry.kind === "step");
			const ok =
				existsSync(file) &&
				readFileSync(file, "utf8").trim() === "EVIDENCE-42" &&
				observesFile(ctx, "evidence.txt", /EVIDENCE-42/) &&
				notes.some((entry) => entry.note?.includes("EVIDENCE-42"));
			return {
				schemaVersion: 1,
				graderId: "note-observed-evidence",
				graderVersion: "1",
				status: ok ? "pass" : "fail",
				severity: "quality",
				evidence: [
					{ kind: "file", ref: "evidence.txt" },
					{ kind: "file", ref: "tasks/archive/evidence-note.jsonl" },
					{ kind: "trace", ref: "trace.jsonl" },
				],
				rationale:
					"The saved step must cite a value that exists in the artifact and was actually observed by a successful read; intent and token echoes are insufficient.",
			};
		},
	};
}
