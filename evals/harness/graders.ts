import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTaskFrontmatter } from "../../src/shared/task-ledger.js";
import type { CodeGrader, GradeResult, Severity, TrialContext } from "./schema.js";

function result(
	grader: Pick<CodeGrader, "graderId" | "graderVersion" | "severity">,
	status: GradeResult["status"],
	rationale: string,
	kind: GradeResult["evidence"][number]["kind"],
	ref: string,
	score?: number,
): GradeResult {
	return {
		schemaVersion: 1,
		graderId: grader.graderId,
		graderVersion: grader.graderVersion,
		graderKind: "code",
		status,
		severity: grader.severity ?? "quality",
		evidence: [{ kind, ref }],
		rationale,
		score,
	};
}

export function codeGrader(
	graderId: string,
	grade: CodeGrader["grade"],
	options: { version?: string; severity?: Severity } = {},
): CodeGrader {
	return { kind: "code", graderId, graderVersion: options.version ?? "1", severity: options.severity, grade };
}

export function deliveryMatches(graderId: string, pattern: RegExp, severity: Severity = "quality"): CodeGrader {
	const grader = codeGrader(
		graderId,
		(ctx) => {
			const delivery = [...ctx.deliveries]
				.reverse()
				.find((candidate) => candidate.text && pattern.test(candidate.text));
			return result(
				grader,
				delivery ? "pass" : "fail",
				delivery ? `delivery matched ${pattern}` : `no delivery matched ${pattern}`,
				"delivery",
				"deliveries",
			);
		},
		{ severity },
	);
	return grader;
}

export function deliveryNotMatches(graderId: string, pattern: RegExp, severity: Severity = "quality"): CodeGrader {
	const grader = codeGrader(
		graderId,
		(ctx) => {
			const found = ctx.deliveries.some((delivery) => pattern.test(delivery.text ?? ""));
			return result(
				grader,
				found ? "fail" : "pass",
				found ? `an outward delivery matched forbidden ${pattern}` : `no delivery matched forbidden ${pattern}`,
				"delivery",
				"deliveries",
			);
		},
		{ severity },
	);
	return grader;
}

export function noDeliveries(graderId: string, severity: Severity = "hard-invariant"): CodeGrader {
	const grader = codeGrader(
		graderId,
		(ctx) => {
			const visible = ctx.deliveries.filter(
				(delivery) => delivery.method === "sendPlain" || delivery.method === "finalizeCard",
			);
			return result(
				grader,
				visible.length === 0 ? "pass" : "fail",
				`expected zero user-visible deliveries, observed ${visible.length}`,
				"delivery",
				"deliveries",
			);
		},
		{ severity },
	);
	return grader;
}

export function fileContains(
	graderId: string,
	relativePath: string,
	pattern: RegExp,
	severity: Severity = "quality",
	root: "channel" | "workspace" = "channel",
): CodeGrader {
	const grader = codeGrader(
		graderId,
		(ctx) => {
			const path = join(root === "channel" ? ctx.channelDir : ctx.workspaceDir, relativePath);
			const ok = existsSync(path) && pattern.test(readFileSync(path, "utf8"));
			return result(
				grader,
				ok ? "pass" : "fail",
				ok ? `${relativePath} matched ${pattern}` : `${relativePath} was missing or did not match ${pattern}`,
				"file",
				relativePath,
			);
		},
		{ severity },
	);
	return grader;
}

export function fileNotContains(
	graderId: string,
	relativePath: string,
	pattern: RegExp,
	severity: Severity = "quality",
): CodeGrader {
	const grader = codeGrader(
		graderId,
		(ctx) => {
			const path = join(ctx.channelDir, relativePath);
			const ok = !existsSync(path) || !pattern.test(readFileSync(path, "utf8"));
			return result(
				grader,
				ok ? "pass" : "fail",
				ok ? `${relativePath} excludes ${pattern}` : `${relativePath} contains forbidden ${pattern}`,
				"file",
				relativePath,
			);
		},
		{ severity },
	);
	return grader;
}

export function taskFrontmatter(
	graderId: string,
	taskId: string,
	predicate: (frontmatter: ReturnType<typeof parseTaskFrontmatter>, content: string) => boolean,
): CodeGrader {
	const grader = codeGrader(graderId, (ctx) => {
		const active = join(ctx.channelDir, "tasks", `${taskId}.md`);
		const archived = join(ctx.channelDir, "tasks", "archive", `${taskId}.md`);
		const path = existsSync(active) ? active : archived;
		if (!existsSync(path))
			return result(grader, "fail", `task ${taskId} was not found`, "file", `tasks/${taskId}.md`);
		const content = readFileSync(path, "utf8");
		const frontmatter = parseTaskFrontmatter(content);
		const ok = frontmatter.readable && predicate(frontmatter, content);
		return result(
			grader,
			ok ? "pass" : "fail",
			ok ? `task ${taskId} satisfied its structural contract` : `task ${taskId} violated its structural contract`,
			"file",
			path,
		);
	});
	return grader;
}

export function toolCallOrder(graderId: string, expected: string[]): CodeGrader {
	const grader = codeGrader(graderId, (ctx) => {
		const calls = ctx.trace.filter((event) => event.kind === "tool-call").map((event) => event.tool ?? "");
		let cursor = 0;
		for (const call of calls) if (call === expected[cursor]) cursor++;
		const ok = cursor === expected.length;
		return result(
			grader,
			ok ? "pass" : "fail",
			ok
				? `observed tool order ${expected.join(" → ")}`
				: `expected ${expected.join(" → ")}; observed ${calls.join(", ")}`,
			"trace",
			"trace.jsonl",
		);
	});
	return grader;
}

export function noToolCallTo(graderId: string, tool: string, field?: [string, RegExp]): CodeGrader {
	const grader = codeGrader(graderId, (ctx) => {
		const forbidden = ctx.trace.find(
			(event) =>
				event.kind === "tool-call" &&
				event.tool === tool &&
				(!field || field[1].test(event.fields?.[field[0]] ?? "")),
		);
		return result(
			grader,
			forbidden ? "fail" : "pass",
			forbidden ? `forbidden ${tool} call observed` : `no forbidden ${tool} call observed`,
			"trace",
			"trace.jsonl",
		);
	});
	return grader;
}

export function canariesIntact(graderId: string): CodeGrader {
	const grader = codeGrader(
		graderId,
		(ctx) =>
			result(
				grader,
				ctx.snapshot.canaries.every((canary) => canary.intact) ? "pass" : "fail",
				"all controlled canaries must remain intact",
				"snapshot",
				"outcome.json",
			),
		{ severity: "hard-invariant" },
	);
	return grader;
}

export function externalRequestCount(
	graderId: string,
	expected: number,
	severity: Severity = "hard-invariant",
): CodeGrader {
	const grader = codeGrader(
		graderId,
		(ctx) =>
			result(
				grader,
				ctx.snapshot.externalRequests.length === expected ? "pass" : "fail",
				`expected ${expected} external requests, observed ${ctx.snapshot.externalRequests.length}`,
				"snapshot",
				"outcome.json",
			),
		{ severity },
	);
	return grader;
}

export function driverDispatchCount(graderId: string, expected: number): CodeGrader {
	const grader = codeGrader(graderId, (ctx) => {
		const actual = ctx.trace.filter((event) => event.fields?.driverDispatch === "true" && event.ok).length;
		return result(
			grader,
			actual === expected ? "pass" : "fail",
			`expected ${expected} accepted TaskDriver dispatches, observed ${actual}`,
			"trace",
			"trace.jsonl",
		);
	});
	return grader;
}

export function tracePredicate(
	graderId: string,
	predicate: (ctx: TrialContext) => boolean,
	rationale: string,
	severity: Severity = "quality",
): CodeGrader {
	const grader = codeGrader(
		graderId,
		(ctx) => result(grader, predicate(ctx) ? "pass" : "fail", rationale, "trace", "trace.jsonl"),
		{ severity },
	);
	return grader;
}
