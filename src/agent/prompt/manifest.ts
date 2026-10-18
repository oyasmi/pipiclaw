/**
 * Prompt manifest and the `/context` report (spec 025 §9, spec 026 §10.9).
 *
 * Zero LLM cost: everything here is computed from the last build plus counters
 * the runner already keeps. Tool JSON schemas are reported alongside the system
 * prompt because they are billed the same way and are often the larger half.
 *
 * Skills are reported here, never budgeted: pi renders `<available_skills>` and
 * owns the same list that backs `/skill:name`, so `estimateSkillsPromptChars` lives
 * next to the report — not in the builder's budget path (spec 026 §9, §10.9).
 */

import { capReply } from "../../commands/reply-limits.js";
import { estimateTokens } from "../../shared/format.js";
import { countPromptUnits } from "../../shared/prompt-units.js";
import { RUNTIME_PROMPT_TARGET_UNITS, sha256 } from "./builder.js";
import type { LoadedPromptResource, PromptBuildResult, ResolvedPromptSection } from "./types.js";

/** The design ceiling for everything Pipiclaw auto-appends to a turn (spec 026 §5.3). */
export const AUTOMATIC_TURN_CONTEXT_BUDGET_UNITS = 3_000;

/**
 * Soft budget for the tool JSON schemas, in the same units as the prompt sections.
 *
 * Tool schemas are the larger half of the fixed per-turn cost and were the only part of it with
 * no budget at all: the runtime-authored prompt is capped at 700 units while the schemas beside it
 * run several thousand. They sit in the provider's cache prefix, so the steady-state price is low —
 * but every `rebuildSessionTools` (a workspace skill write, `/reload`, any resource reload) swaps
 * that prefix and pays for all of it again.
 *
 * There is no hard cap on purpose. A schema cannot be auto-trimmed the way a prompt section can:
 * the fix is always a human deciding which tool says less, or which tool should not be registered.
 * So this is a warning line in the log and in `/context`, not an enforcement point. It is set just
 * above the current set (≈2.8k units for 15 tools) — one more heavyweight tool crosses it, which
 * is exactly when someone should be looking.
 */
export const TOOL_SCHEMA_TARGET_UNITS = 3_000;

export interface ToolSchemaMeasurement {
	chars: number;
	units: number;
}

/** The operator wording for "the tool set is over budget", for the rebuild log (`/context` says it in Chinese). */
export function toolSchemaBudgetWarning(measurement: ToolSchemaMeasurement): string {
	return `tool JSON schemas are ${measurement.units} units (${measurement.chars} chars), over the ${TOOL_SCHEMA_TARGET_UNITS} unit target. Shorten a tool description, move detail into a playbook, or unregister a tool; \`/context detail\` lists the set.`;
}

/**
 * What the tool set costs on top of the system prompt. Counts what the provider is actually sent
 * per tool — name, description and the JSON schema — the same way `/context` has always reported it.
 */
export function measureToolSchemas(
	tools: Array<{ name: string; description: string; parameters?: unknown }>,
): ToolSchemaMeasurement {
	let chars = 0;
	let units = 0;
	for (const tool of tools) {
		const text = `${tool.name}${tool.description}${JSON.stringify(tool.parameters ?? {})}`;
		chars += text.length;
		units += countPromptUnits(text);
	}
	return { chars, units };
}

export interface PromptTurnContextStats {
	durableMemoryChars: number;
	durableMemoryUnits: number;
	taskDigestChars: number;
	taskDigestUnits: number;
	channelCapsuleUnits: number;
	userMessageChars: number;
}

export interface PromptContextReportInput {
	build: PromptBuildResult;
	/** What the provider actually received: our prompt + pi's skills/date/cwd tail + the boundary footer. */
	finalPrompt?: string;
	skills: Array<{ name: string; description: string }>;
	toolNames: string[];
	toolSchemas: ToolSchemaMeasurement;
	/** Resolved SOUL.md / AGENTS.md, for the independent body-budget lines. */
	soul?: LoadedPromptResource;
	agents?: LoadedPromptResource;
	lastTurn?: PromptTurnContextStats;
	detail: boolean;
}

export interface PromptSectionManifestEntry {
	id: string;
	source: string;
	authority: string;
	cacheClass: string;
	rawChars: number;
	injectedChars: number;
	rawUnits: number;
	injectedUnits: number;
	truncated: boolean;
	sha256: string;
}

export interface PromptManifest {
	fingerprint: string;
	totalChars: number;
	totalUnits: number;
	runtimeAuthoredUnits: number;
	estimatedTokens: number;
	sections: PromptSectionManifestEntry[];
	diagnostics: PromptBuildResult["diagnostics"];
	/** Present when the fully assembled prompt (including pi's tail) was captured. */
	finalPromptSha256?: string;
	finalPromptChars?: number;
}

/**
 * What pi's `<available_skills>` block will cost, close enough to report on:
 * name, description and location inside a five-line XML wrapper, plus the preamble.
 * This is observation only — Pipiclaw never trims skills (spec 026 §9).
 */
export function estimateSkillsPromptChars(skills: Array<{ name: string; description: string }>): number {
	if (!skills || skills.length === 0) return 0;
	const SKILL_WRAPPER_CHARS = 90;
	const PREAMBLE_CHARS = 290;
	return (
		PREAMBLE_CHARS +
		skills.reduce((sum, skill) => sum + skill.name.length + skill.description.length + SKILL_WRAPPER_CHARS, 0)
	);
}

/** Section metadata without any section body — safe to write next to a channel. */
export function buildPromptManifest(build: PromptBuildResult, finalPrompt?: string): PromptManifest {
	return {
		fingerprint: build.fingerprint,
		totalChars: build.totalChars,
		totalUnits: build.totalUnits,
		runtimeAuthoredUnits: build.runtimeAuthoredUnits,
		estimatedTokens: build.estimatedTokens,
		sections: build.sections.map(
			({ content: _content, ...entry }: ResolvedPromptSection): PromptSectionManifestEntry => entry,
		),
		diagnostics: build.diagnostics,
		finalPromptSha256: finalPrompt ? sha256(finalPrompt) : undefined,
		finalPromptChars: finalPrompt?.length,
	};
}

function formatNumber(value: number): string {
	return value.toLocaleString("en-US");
}

function renderWorkspaceResource(label: string, resource: LoadedPromptResource | undefined): string | undefined {
	if (!resource || resource.isDefaultTemplate) return undefined;
	const state = resource.truncated ? "，已截断" : "";
	return `${label} ${formatNumber(resource.injectedUnits)} / ${formatNumber(resource.budgetUnits)} 单位${state}`;
}

/**
 * `/context` (spec 053, D9): the default view is a summary a user can read on a phone; `detail`
 * adds the per-section sources and the tool/skill inventory, still under the reply budget.
 * "单位" is the prompt-unit measure the budgets are written in (`countPromptUnits`).
 */
export function renderContextReport(input: PromptContextReportInput): string {
	const { build, finalPrompt, detail } = input;
	const lines: string[] = ["**上下文**", ""];

	lines.push(
		`- 系统提示词（Pipiclaw 部分）：${formatNumber(build.totalUnits)} 单位，约 ${formatNumber(build.estimatedTokens)} tokens；其中运行时自带 ${formatNumber(build.runtimeAuthoredUnits)} / 目标 ${formatNumber(RUNTIME_PROMPT_TARGET_UNITS)} 单位`,
	);
	if (finalPrompt) {
		// The string the provider actually caches: our sections + pi's skills/date/cwd tail +
		// the boundary footer. It is the fingerprint that matters for cache hits — the build
		// fingerprint only covers the part Pipiclaw owns, and stays stable across a date rollover
		// that does invalidate the provider's cached prefix.
		lines.push(
			`- 实际发送（含 skills、日期、工作目录）：${formatNumber(finalPrompt.length)} 字，约 ${formatNumber(estimateTokens(finalPrompt))} tokens，指纹 \`${sha256(finalPrompt).slice(0, 16)}\``,
		);
	}
	const overToolBudget = input.toolSchemas.units > TOOL_SCHEMA_TARGET_UNITS;
	lines.push(
		`- 工具定义：${input.toolNames.length} 个，${formatNumber(input.toolSchemas.units)} / 目标 ${formatNumber(TOOL_SCHEMA_TARGET_UNITS)} 单位${overToolBudget ? "（超出目标）" : ""}，在系统提示词之外另计`,
	);
	lines.push(
		`- Skills：${input.skills.length} 个可见，约 ${formatNumber(estimateSkillsPromptChars(input.skills))} 字（由 pi 渲染，不计入 Pipiclaw 预算）`,
	);
	const resources = [
		renderWorkspaceResource("SOUL.md", input.soul),
		renderWorkspaceResource("AGENTS.md", input.agents),
	]
		.filter(Boolean)
		.join("；");
	if (resources) lines.push(`- 工作区文件（独立预算）：${resources}`);

	if (input.lastTurn) {
		const turn = input.lastTurn;
		const automaticUnits = turn.channelCapsuleUnits + turn.taskDigestUnits + turn.durableMemoryUnits;
		lines.push(
			`- 上一回合自动附加：${formatNumber(automaticUnits)} / ${formatNumber(AUTOMATIC_TURN_CONTEXT_BUDGET_UNITS)} 单位（频道信息 ${formatNumber(turn.channelCapsuleUnits)}，任务清单 ${formatNumber(turn.taskDigestUnits)}，记忆 ${formatNumber(turn.durableMemoryUnits)}，记忆只在首个回合附加）；用户消息 ${formatNumber(turn.userMessageChars)} 字`,
		);
	}

	for (const diagnostic of build.diagnostics) {
		lines.push(`- ⚠️ ${diagnostic.sectionId}：${diagnostic.message}`);
	}
	if (overToolBudget) {
		lines.push(
			"- ⚠️ 工具定义超出目标：缩短某个工具的说明、把细节移到 playbook，或停用一个工具；`/context detail` 列出全部工具",
		);
	}

	if (!detail) {
		lines.push("", "用 `/context detail` 查看各分段的来源与工具、skill 清单。");
		return lines.join("\n");
	}

	lines.push("", "**分段**");
	for (const section of build.sections) {
		const truncated = section.truncated ? `，已截断（原 ${formatNumber(section.rawUnits)} 单位）` : "";
		lines.push(
			`- ${section.id}：${formatNumber(section.injectedUnits)} 单位，${formatNumber(section.injectedChars)} 字，${section.cacheClass}${truncated}；来源 ${section.source}（${section.authority}）`,
		);
	}
	if (input.toolNames.length > 0) lines.push("", `**工具**：${input.toolNames.join("、")}`);
	if (input.skills.length > 0) lines.push("", `**Skills**：${input.skills.map((skill) => skill.name).join("、")}`);
	return capReply(lines.join("\n"), {
		nextStepHint:
			"用 `/context` 只看汇总；完整提示词需部署者在服务器上设 `PIPICLAW_DEBUG=1`，之后查看该频道会话目录（`conversations/<会话区>/`）里的 `last_prompt.json`",
	}).text;
}
