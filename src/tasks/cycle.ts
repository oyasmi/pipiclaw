import { formatLocalTime } from "../shared/local-time.js";
import type { TaskCycle } from "./frontmatter.js";
import { findTaskSectionBounds, resetTaskPlanForCycle } from "./ledger.js";

/**
 * Cycle boundaries (spec 051, §3.2).
 *
 * A cycle is the unit of work a task session's context is scoped to: opened when a one-shot task
 * is created or a recurring task's schedule fires, closed when the loop reports `done`. v3 marked
 * boundaries by shuffling `## Current Cycle` into `## History` inside the task file; v4 keeps the
 * per-cycle record in `<id>.jsonl` and leaves exactly one paragraph — `## 上次结果` — in the
 * contract, overwritten each time.
 */
export const LAST_RESULT_SECTION_NAMES = ["上次结果", "Last Result"] as const;
const LAST_RESULT_HEADING = "## 上次结果";

/** Cap for the one historical paragraph the contract carries; the rest lives in the log (INV-6). */
export const MAX_LAST_RESULT_CHARS = 1_200;

/**
 * A stable cycle id for a runtime-opened cycle: `c-YYYY-MM-DD`, disambiguated with `-N` when the
 * same task opens more than one cycle on the same local day.
 */
export function nextCycleId(previousCycleId: string | undefined, occurrence: Date = new Date()): string {
	const base = `c-${occurrence.getFullYear()}-${String(occurrence.getMonth() + 1).padStart(2, "0")}-${String(occurrence.getDate()).padStart(2, "0")}`;
	if (!previousCycleId || !previousCycleId.startsWith(base)) return base;
	const suffix = previousCycleId.slice(base.length + 1);
	const previousCount = suffix ? Number.parseInt(suffix, 10) : 1;
	const nextCount = Number.isFinite(previousCount) && previousCount >= 1 ? previousCount + 1 : 2;
	return `${base}-${nextCount}`;
}

/** Fresh counters for a newly opened cycle. */
export function createCycle(id: string, now: Date = new Date()): TaskCycle {
	return { id, startedAt: formatLocalTime(now), steps: 0, rounds: 0, usd: 0, usdEstimated: false, expired: 0 };
}

/**
 * Body transformation for opening a cycle. Only recurring tasks reset their Plan: for a one-shot
 * task the Plan is the single run's agenda and unchecking it would erase real progress, while for
 * a recurring task the same steps genuinely start over each occurrence.
 */
export function openCycleBody(body: string, recurring: boolean): string {
	return recurring ? resetTaskPlanForCycle(body) : body;
}

/**
 * Upsert `## 上次结果` — the contract's single, overwritten historical paragraph. Over-long text
 * is clipped with a pointer to `task_log`, because the contract has a hard size budget and the
 * complete record is already durable in the loop log.
 */
export function writeLastResult(body: string, text: string): string {
	const clipped =
		text.length > MAX_LAST_RESULT_CHARS
			? `${text.slice(0, MAX_LAST_RESULT_CHARS).trimEnd()}…（完整记录见 task_log）`
			: text;
	const lines = body.split("\n");
	const bounds = findTaskSectionBounds(lines, LAST_RESULT_SECTION_NAMES);
	const block = [LAST_RESULT_HEADING, "", clipped, ""];
	if (bounds) {
		lines.splice(bounds.headingIndex, bounds.end - bounds.headingIndex, ...block);
		return lines.join("\n");
	}
	return `${body.replace(/\n+$/, "")}\n\n${block.join("\n")}`;
}

/** Remove `## 上次结果` entirely. The full record is always still in the loop log. */
export function stripLastResult(body: string): string {
	const lines = body.split("\n");
	const bounds = findTaskSectionBounds(lines, LAST_RESULT_SECTION_NAMES);
	if (!bounds) return body;
	lines.splice(bounds.headingIndex, bounds.end - bounds.headingIndex);
	return lines
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trimEnd();
}

/** The rendered `## 上次结果` text, if any — used by `/tasks show` and the step brief. */
export function readLastResult(body: string): string | undefined {
	const lines = body.split("\n");
	const bounds = findTaskSectionBounds(lines, LAST_RESULT_SECTION_NAMES);
	if (!bounds) return undefined;
	const text = lines
		.slice(bounds.headingIndex + 1, bounds.end)
		.join("\n")
		.trim();
	return text || undefined;
}

/** Compose the `## 上次结果` paragraph from a cycle close. */
export function renderCloseSummary(input: {
	cycleId: string;
	outcome: "done" | "cancelled";
	summary: string;
	evidence?: string;
	residualRisk?: string;
	steps: number;
	rounds: number;
	usd: number;
	usdEstimated: boolean;
}): string {
	const cost = `$${input.usd.toFixed(2)}${input.usdEstimated ? "（含估算）" : ""}`;
	return [
		`- ${input.cycleId} ${input.outcome === "done" ? "完成" : "取消"}：${input.summary}`,
		input.evidence ? `- 证据：${input.evidence}` : undefined,
		input.residualRisk ? `- 剩余风险：${input.residualRisk}` : undefined,
		`- 用量：${input.steps} 步 / ${input.rounds} 轮 / ${cost}`,
	]
		.filter(Boolean)
		.join("\n");
}
