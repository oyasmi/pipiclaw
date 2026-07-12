/**
 * Prompt manifest and the `/context` report (spec 025 §9).
 *
 * Zero LLM cost: everything here is computed from the last build plus counters
 * the runner already keeps. Tool JSON schemas are reported alongside the system
 * prompt because they are billed the same way and are often the larger half.
 */

import { estimateTokens, sha256 } from "./builder.js";
import type { PromptBuildResult, ResolvedPromptSection } from "./types.js";

export interface PromptTurnContextStats {
	durableMemoryChars: number;
	taskDigestChars: number;
	recalledMemoryChars: number;
	userMessageChars: number;
}

export interface PromptContextReportInput {
	build: PromptBuildResult;
	/** What the provider actually received: our prompt + pi's skills/date/cwd tail + the boundary footer. */
	finalPrompt?: string;
	skills: Array<{ name: string; description: string }>;
	toolNames: string[];
	toolSchemaChars: number;
	lastTurn?: PromptTurnContextStats;
	detail: boolean;
}

export interface PromptSectionManifestEntry {
	id: string;
	order: number;
	source: string;
	authority: string;
	cacheClass: string;
	rawChars: number;
	injectedChars: number;
	truncated: boolean;
	sha256: string;
}

export interface PromptManifest {
	fingerprint: string;
	totalChars: number;
	estimatedTokens: number;
	sections: PromptSectionManifestEntry[];
	diagnostics: PromptBuildResult["diagnostics"];
	/** Present when the fully assembled prompt (including pi's tail) was captured. */
	finalPromptSha256?: string;
	finalPromptChars?: number;
}

/** Section metadata without any section body — safe to write next to a channel. */
export function buildPromptManifest(build: PromptBuildResult, finalPrompt?: string): PromptManifest {
	return {
		fingerprint: build.fingerprint,
		totalChars: build.totalChars,
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

function pad(text: string, width: number): string {
	return text.length >= width ? text : text + " ".repeat(width - text.length);
}

export function renderContextReport(input: PromptContextReportInput): string {
	const { build, finalPrompt, detail } = input;
	const lines: string[] = ["# Context Report", ""];

	lines.push(
		`System prompt (Pipiclaw-owned): ${formatNumber(build.totalChars)} chars, ~${formatNumber(build.estimatedTokens)} tokens`,
	);
	if (finalPrompt) {
		lines.push(
			`Sent to the model (incl. skills, date, cwd): ${formatNumber(finalPrompt.length)} chars, ~${formatNumber(estimateTokens(finalPrompt))} tokens`,
		);
	}
	lines.push(`Fingerprint: sha256:${build.fingerprint.slice(0, 16)}`);
	lines.push("");

	const width = Math.max(...build.sections.map((section) => section.id.length), 12) + 2;
	for (const section of build.sections) {
		const flags: string[] = [section.cacheClass];
		if (section.truncated) flags.push(`truncated from ${formatNumber(section.rawChars)}`);
		lines.push(
			`- ${pad(section.id, width)}${formatNumber(section.injectedChars).padStart(7)} chars  ${flags.join(", ")}`,
		);
	}

	lines.push("");
	lines.push(
		`Tools: ${input.toolNames.length} registered; JSON schemas ≈ ${formatNumber(input.toolSchemaChars)} chars (billed on top of the system prompt)`,
	);
	lines.push(`Skills: ${input.skills.length} visible (rendered by pi after the sections above)`);

	if (input.lastTurn) {
		const turn = input.lastTurn;
		lines.push("");
		lines.push("Last turn context (per-turn, not cached):");
		lines.push(`- durable memory bootstrap: ${formatNumber(turn.durableMemoryChars)} chars`);
		lines.push(`- recalled memory: ${formatNumber(turn.recalledMemoryChars)} chars`);
		lines.push(`- task digest: ${formatNumber(turn.taskDigestChars)} chars`);
		lines.push(`- user message: ${formatNumber(turn.userMessageChars)} chars`);
	}

	if (build.diagnostics.length > 0) {
		lines.push("");
		lines.push("Diagnostics:");
		for (const diagnostic of build.diagnostics) {
			lines.push(`- [${diagnostic.level}] ${diagnostic.sectionId}: ${diagnostic.message}`);
		}
	}

	if (detail) {
		lines.push("");
		lines.push("Detail:");
		for (const section of build.sections) {
			lines.push(
				`- ${section.id} (order ${section.order}, ${section.authority}) ← ${section.source} · sha256:${section.sha256.slice(0, 12)}`,
			);
		}
		if (input.toolNames.length > 0) {
			lines.push(`- tools: ${input.toolNames.join(", ")}`);
		}
		if (input.skills.length > 0) {
			lines.push(`- skills: ${input.skills.map((skill) => skill.name).join(", ")}`);
		}
	} else {
		lines.push("");
		lines.push("Run `/context detail` for per-section sources, hashes, and the tool/skill inventory.");
	}

	return lines.join("\n");
}
