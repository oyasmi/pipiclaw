/**
 * Workspace resources that enter the system prompt: SOUL.md and AGENTS.md.
 *
 * Pipiclaw reads and wraps them itself (pi's own `agentsFiles` path is disabled)
 * so that their order, budget and framing are ours. Budgets are applied to the
 * file body here — not to the rendered section — so a truncated file can never
 * cut its own closing tag.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as log from "../../log.js";
import { DEFAULT_AGENTS, DEFAULT_SOUL, isDefaultWorkspaceTemplate } from "../../runtime/workspace-templates.js";
import { clipText } from "../../shared/text-utils.js";
import type { LoadedPromptResource, PromptDiagnostic } from "./types.js";

export const SOUL_BUDGET_CHARS = 5_000;
export const AGENTS_BUDGET_CHARS = 8_000;

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

function loadResource(
	path: string,
	template: string,
	budget: number,
	sectionId: string,
	overflowAdvice: string,
	diagnostics: PromptDiagnostic[],
): LoadedPromptResource | undefined {
	const content = readWorkspaceFile(path);
	if (!content) {
		return undefined;
	}
	if (isDefaultWorkspaceTemplate(content, template)) {
		diagnostics.push({
			level: "info",
			sectionId,
			message: `${path} still holds the bootstrap template; not injected.`,
		});
		return { path, content, isDefaultTemplate: true };
	}
	if (content.length <= budget) {
		return { path, content, isDefaultTemplate: false };
	}

	diagnostics.push({
		level: "warning",
		sectionId,
		message: `${path} is ${content.length} chars; injected ${budget}. ${overflowAdvice}`,
	});
	const clipped = clipText(content, budget, {
		headRatio: 0.6,
		omitHint: `\n\n[... truncated: injected ${budget} of ${content.length} characters. ${overflowAdvice} ...]\n\n`,
	});
	return { path, content: clipped, isDefaultTemplate: false };
}

/** Read SOUL.md and AGENTS.md from the workspace root, budgeted and template-aware. */
export function loadWorkspacePromptResources(workspaceDir: string): WorkspacePromptResources {
	const diagnostics: PromptDiagnostic[] = [];
	const soul = loadResource(
		join(workspaceDir, "SOUL.md"),
		DEFAULT_SOUL,
		SOUL_BUDGET_CHARS,
		"workspace.soul",
		"Run /context detail, and keep SOUL.md to identity and voice.",
		diagnostics,
	);
	const agents = loadResource(
		join(workspaceDir, "AGENTS.md"),
		DEFAULT_AGENTS,
		AGENTS_BUDGET_CHARS,
		"workspace.agents",
		"Run /context detail, and move task-specific procedures into workspace skills so they load on demand.",
		diagnostics,
	);
	return { soul, agents, diagnostics };
}
