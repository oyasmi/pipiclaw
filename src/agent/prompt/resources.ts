/**
 * Workspace resources that enter the system prompt: SOUL.md and AGENTS.md.
 *
 * Pipiclaw reads and wraps them itself (pi's own `agentsFiles` path is disabled)
 * so that their order, budget and framing are ours. Budgets are applied to the
 * file body here — not to the rendered section — so a truncated file can never
 * cut its own closing tag.
 *
 * SOUL and AGENTS are high-value user instructions (spec 026 §2.2, §8). Each has
 * its own generous unit + character budget and never competes with the other, with
 * the runtime catalog, or with skills for space; only a genuinely oversized file is
 * head/tail clipped.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as log from "../../log.js";
import { DEFAULT_AGENTS, DEFAULT_SOUL, isDefaultWorkspaceTemplate } from "../../runtime/workspace-templates.js";
import { clipTextByPromptUnits, countPromptUnits } from "../../shared/prompt-units.js";
import type { LoadedPromptResource, PromptDiagnostic } from "./types.js";

/** SOUL.md is identity and voice: normally short, so a tight independent budget (spec 026 §5.2). */
export const SOUL_BUDGET_UNITS = 3_000;
export const SOUL_BUDGET_CHARS = 24_000;
/** AGENTS.md carries team procedure and is allowed to be larger (spec 026 §5.2). */
export const AGENTS_BUDGET_UNITS = 6_000;
export const AGENTS_BUDGET_CHARS = 48_000;

export interface WorkspacePromptResources {
	soul?: LoadedPromptResource;
	agents?: LoadedPromptResource;
	diagnostics: PromptDiagnostic[];
}

function readWorkspaceFile(path: string): string {
	if (!existsSync(path)) {
		return "";
	}
	try {
		return readFileSync(path, "utf-8").replace(/\r/g, "").trim();
	} catch (error) {
		log.logWarning(`Failed to read ${path}`, String(error));
		return "";
	}
}

interface ResourceBudget {
	units: number;
	chars: number;
}

function loadResource(
	path: string,
	template: string,
	budget: ResourceBudget,
	sectionId: string,
	overflowAdvice: string,
	diagnostics: PromptDiagnostic[],
): LoadedPromptResource | undefined {
	const content = readWorkspaceFile(path);
	if (!content) {
		return undefined;
	}
	const rawUnits = countPromptUnits(content);
	if (isDefaultWorkspaceTemplate(content, template)) {
		diagnostics.push({
			level: "info",
			sectionId,
			message: `${path} still holds the bootstrap template; not injected.`,
		});
		return {
			path,
			content,
			isDefaultTemplate: true,
			rawUnits,
			injectedUnits: rawUnits,
			budgetUnits: budget.units,
			truncated: false,
		};
	}
	if (rawUnits <= budget.units && content.length <= budget.chars) {
		return {
			path,
			content,
			isDefaultTemplate: false,
			rawUnits,
			injectedUnits: rawUnits,
			budgetUnits: budget.units,
			truncated: false,
		};
	}

	// Diagnose in units (the stable budget) but note whichever limit was hit.
	const limit =
		rawUnits > budget.units
			? `${rawUnits} prompt units; injected ${budget.units}`
			: `${content.length} chars; injected ${budget.chars}`;
	diagnostics.push({
		level: "warning",
		sectionId,
		message: `${path} is unusually large: ${limit}. ${overflowAdvice}`,
	});
	const clipped = clipTextByPromptUnits(content, budget.units, {
		headRatio: 0.6,
		maxChars: budget.chars,
		marker: `\n\n[... truncated: kept ${budget.units} of ${rawUnits} prompt units. ${overflowAdvice} ...]\n\n`,
	});
	return {
		path,
		content: clipped.text,
		isDefaultTemplate: false,
		rawUnits,
		injectedUnits: clipped.injectedUnits,
		budgetUnits: budget.units,
		truncated: clipped.truncated,
	};
}

/** Read SOUL.md and AGENTS.md from the workspace root, budgeted and template-aware. */
export function loadWorkspacePromptResources(workspaceDir: string): WorkspacePromptResources {
	const diagnostics: PromptDiagnostic[] = [];
	const soul = loadResource(
		join(workspaceDir, "SOUL.md"),
		DEFAULT_SOUL,
		{ units: SOUL_BUDGET_UNITS, chars: SOUL_BUDGET_CHARS },
		"workspace.soul",
		"Run /context detail, and keep SOUL.md to identity and voice.",
		diagnostics,
	);
	const agents = loadResource(
		join(workspaceDir, "AGENTS.md"),
		DEFAULT_AGENTS,
		{ units: AGENTS_BUDGET_UNITS, chars: AGENTS_BUDGET_CHARS },
		"workspace.agents",
		"Run /context detail. Keep global rules in AGENTS.md and move conditional procedures into workspace skills; pi will keep managing all skills.",
		diagnostics,
	);
	return { soul, agents, diagnostics };
}
