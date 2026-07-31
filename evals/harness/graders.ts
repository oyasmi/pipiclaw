import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTaskFrontmatter } from "../../src/tasks/ledger.js";
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

/**
 * Matches only the final textual delivery.
 *
 * Multi-turn recall/correction cases must not pass because the assistant echoed the expected
 * value when it was first supplied. `deliveryMatches` intentionally searches every delivery;
 * use this helper when the last answer is the behavior under test.
 */
export function lastDeliveryMatches(graderId: string, pattern: RegExp, severity: Severity = "quality"): CodeGrader {
	const grader = codeGrader(
		graderId,
		(ctx) => {
			const delivery = [...ctx.deliveries].reverse().find((candidate) => candidate.text?.trim());
			const matched = delivery?.text ? pattern.test(delivery.text) : false;
			return result(
				grader,
				matched ? "pass" : "fail",
				matched
					? `final delivery matched ${pattern}`
					: `final delivery did not match ${pattern}: ${delivery?.text ?? "(none)"}`,
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

export function lastDeliveryNotMatches(graderId: string, pattern: RegExp, severity: Severity = "quality"): CodeGrader {
	const grader = codeGrader(
		graderId,
		(ctx) => {
			const delivery = [...ctx.deliveries].reverse().find((candidate) => candidate.text?.trim());
			const found = delivery?.text ? pattern.test(delivery.text) : false;
			return result(
				grader,
				found ? "fail" : "pass",
				found ? `final delivery matched forbidden ${pattern}` : `final delivery excluded forbidden ${pattern}`,
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
				(delivery) =>
					delivery.method === "sendPlain" || delivery.method === "finalizeCard" || delivery.method === "sendMedia",
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

/** Counts calls to one tool, optionally restricted to calls whose whitelisted field matches. */
export function toolCallCount(
	graderId: string,
	tool: string,
	expected: number,
	field?: [string, RegExp],
	severity: Severity = "quality",
): CodeGrader {
	const grader = codeGrader(
		graderId,
		(ctx) => {
			const actual = ctx.trace.filter(
				(event) =>
					event.kind === "tool-call" &&
					event.tool === tool &&
					(!field || field[1].test(event.fields?.[field[0]] ?? "")),
			).length;
			return result(
				grader,
				actual === expected ? "pass" : "fail",
				`expected ${expected} ${tool} call(s)${field ? ` with ${field[0]} matching ${field[1]}` : ""}, observed ${actual}`,
				"trace",
				"trace.jsonl",
			);
		},
		{ severity },
	);
	return grader;
}

/**
 * Fails when a tool call was rejected.
 *
 * The recoverable-error path is a *recovery* mechanism: after a dropped argument the model retries
 * and the end state ends up identical, so a file assertion alone cannot tell a clean call from a
 * failed-then-repaired one. This is the grader that can.
 */
export function noFailedToolResult(graderId: string, tool: string, severity: Severity = "quality"): CodeGrader {
	const grader = codeGrader(
		graderId,
		(ctx) => {
			const failures = ctx.trace.filter(
				(event) => event.kind === "tool-result" && event.tool === tool && event.ok === false,
			);
			return result(
				grader,
				failures.length === 0 ? "pass" : "fail",
				failures.length === 0
					? `no rejected ${tool} call`
					: `${failures.length} rejected ${tool} call(s): ${failures.map((event) => event.fields?.detail ?? "").join(" | ")}`,
				"trace",
				"trace.jsonl",
			);
		},
		{ severity },
	);
	return grader;
}

/** Passes when a whitelisted argument of a tool call still carries its tail sentinel. */
export function toolArgumentIntact(
	graderId: string,
	tool: string,
	field: string,
	sentinel: RegExp,
	severity: Severity = "quality",
): CodeGrader {
	const grader = codeGrader(
		graderId,
		(ctx) => {
			const calls = ctx.trace.filter((event) => event.kind === "tool-call" && event.tool === tool);
			const intact = calls.find((event) => sentinel.test(event.fields?.[field] ?? ""));
			return result(
				grader,
				intact ? "pass" : "fail",
				intact
					? `a ${tool} call carried ${field} through to its tail sentinel`
					: `no ${tool} call carried ${field} intact (${calls.length} call(s); lengths ${calls.map((event) => event.fields?.[`${field}Chars`] ?? "?").join(", ") || "none"})`,
				"trace",
				"trace.jsonl",
			);
		},
		{ severity },
	);
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

/** Honest "I don't know" phrasing, in the languages this deployment actually sees. */
const ABSTAIN_PATTERN = /不知道|不确定|没有.{0,6}(记录|信息)|no (matching )?record|not sure|don't know|no information/i;

/**
 * Scores a tail of N question turns against N (expected, distractor) pairs.
 *
 * A single trial that must answer 10 independent questions correctly to "pass" is not a
 * measurement, it is a coin flip stacked ten times — one grader failure fails the whole trial
 * (`evals/harness/run.ts`), so a naive per-question grader set would demand 10/10 every run.
 * This grader instead reports recall and precision as continuous figures and gates on thresholds,
 * and — this is the point of the split — treats an honest "I don't know" as a recall miss but
 * *not* a precision miss. Conflating the two would hide the exact failure mode the L1/L5 findings
 * describe: a system tuned conservative enough to refuse is indistinguishable, on a naive
 * right/wrong count, from one that confidently answers with the superseded value.
 */
export function recallQuiz(
	graderId: string,
	questions: Array<{ expected: RegExp; distractor: RegExp }>,
	options: { minRecall?: number; minPrecision?: number; severity?: Severity } = {},
): CodeGrader {
	const minRecall = options.minRecall ?? 0.7;
	const minPrecision = options.minPrecision ?? 0.9;
	const grader = codeGrader(
		graderId,
		(ctx) => {
			const userSteps = ctx.trace.filter((event) => event.kind === "step" && event.fields?.kind === "user");
			const tail = userSteps.slice(-questions.length);
			if (tail.length < questions.length) {
				return result(
					grader,
					"error",
					`expected ${questions.length} question turns, observed ${tail.length}; fix the case script`,
					"trace",
					"trace.jsonl",
				);
			}
			let hit = 0;
			let wrong = 0;
			let abstain = 0;
			const lines: string[] = [];
			questions.forEach((question, index) => {
				const startTs = Date.parse(tail[index]!.ts);
				const endTs = index + 1 < tail.length ? Date.parse(tail[index + 1]!.ts) : Number.POSITIVE_INFINITY;
				const inWindow = ctx.deliveries.filter(
					(candidate) => candidate.ts >= startTs && candidate.ts < endTs && candidate.text?.trim(),
				);
				const text = inWindow.at(-1)?.text?.trim() ?? "";
				if (question.expected.test(text)) {
					hit++;
					lines.push(`Q${index + 1}: hit`);
				} else if (ABSTAIN_PATTERN.test(text)) {
					abstain++;
					lines.push(`Q${index + 1}: abstain`);
				} else {
					wrong++;
					lines.push(
						`Q${index + 1}: wrong${question.distractor.test(text) ? " (distractor)" : ""} — ${text.slice(0, 80) || "(no delivery)"}`,
					);
				}
			});
			const recall = hit / questions.length;
			const precision = hit + wrong > 0 ? hit / (hit + wrong) : 1;
			const pass = recall >= minRecall && precision >= minPrecision;
			return result(
				grader,
				pass ? "pass" : "fail",
				`recall=${recall.toFixed(2)} (need ${minRecall}) precision=${precision.toFixed(2)} (need ${minPrecision}); hit=${hit} wrong=${wrong} abstain=${abstain}. ${lines.join(" | ")}`,
				"delivery",
				"deliveries",
				recall,
			);
		},
		{ severity: options.severity },
	);
	return grader;
}

/** Ensures a runtime-only step did not unexpectedly emit a user-visible message. */
export function noDeliveriesAfterStep(graderId: string, stepKind: string, severity: Severity = "quality"): CodeGrader {
	const grader = codeGrader(
		graderId,
		(ctx) => {
			const step = [...ctx.trace]
				.reverse()
				.find((event) => event.kind === "step" && event.fields?.kind === stepKind);
			if (!step) return result(grader, "fail", `step ${stepKind} was not observed`, "trace", "trace.jsonl");
			const stepAt = Date.parse(step.ts);
			const visible = ctx.deliveries.filter(
				(delivery) =>
					delivery.ts > stepAt &&
					(delivery.method === "sendPlain" ||
						delivery.method === "finalizeCard" ||
						delivery.method === "sendMedia"),
			);
			return result(
				grader,
				visible.length === 0 ? "pass" : "fail",
				`expected no delivery after ${stepKind}, observed ${visible.length}`,
				"delivery",
				"deliveries",
			);
		},
		{ severity },
	);
	return grader;
}
