/**
 * Structured system-prompt model (spec 025).
 *
 * The prompt is a list of sections with metadata — not an ad-hoc string array.
 * Every section declares where it comes from, how authoritative it is, how
 * stable it is across turns (cache class), which modes/tools it applies to, and
 * what happens when it exceeds its budget. The builder turns definitions into a
 * final text plus a manifest that can be inspected (`/context`), tested and
 * fingerprinted.
 */

import type { RuntimePlaybookMetadata } from "../../playbooks/catalog.js";

/** Which agent loop the prompt is being built for. Phase 1–3 only build "normal". */
export type PromptMode = "normal" | "task-driver" | "event" | "subagent" | "maintenance";

/**
 * How much authority a section's content carries.
 * - `runtime-hard`: boundaries workspace content may not redefine (still enforced by guards/state machines, not by prose).
 * - `runtime-fact`: mechanism facts of this Pipiclaw version.
 * - `workspace-instruction`: user/team policy (SOUL, AGENTS).
 * - `catalog`: entry points for progressive disclosure (tools, playbooks, sub-agents).
 * - `data`: reference material with no instruction authority.
 */
export type PromptAuthority = "runtime-hard" | "runtime-fact" | "workspace-instruction" | "catalog" | "data";

/** How often a section's bytes are expected to change — the prompt-cache contract. */
export type PromptCacheClass = "runtime-stable" | "workspace-versioned" | "session-stable" | "turn-dynamic";

/**
 * What to do when a section exceeds `maxChars`.
 * `error` is for runtime-authored text: overflowing it is a development error, not a user problem.
 */
export type PromptOverflowPolicy = "error" | "truncate-head-tail" | "truncate-items" | "omit";

/**
 * A registered tool, as the prompt builder sees it. There is no per-tool prose here and no
 * section renders this list: spec 026 §3.2 removed `## Available Tools` because the model
 * already receives each tool's name, description and schema with every request. The list is
 * kept because the builder still needs it to decide whether a mechanism is reachable —
 * gating sections (`requiresAllTools`), filtering playbooks, and reporting via `/context`.
 */
export interface ToolDescriptor {
	name: string;
	description: string;
}

export interface SubAgentSummary {
	name: string;
	description: string;
}

/** A workspace file (SOUL.md / AGENTS.md) resolved for injection. */
export interface LoadedPromptResource {
	path: string;
	content: string;
	/** True when the file still holds the bootstrap template: it carries no user intent, so it is not injected. */
	isDefaultTemplate: boolean;
	/** Prompt units in the original file body (before any clipping). */
	rawUnits: number;
	/** Prompt units in the injected body (equals rawUnits unless the file overflowed its budget). */
	injectedUnits: number;
	/** The unit budget this body was measured against — reported by `/context`. */
	budgetUnits: number;
	/** True when the body exceeded its independent unit/char budget and was head/tail clipped. */
	truncated: boolean;
}

export interface PromptBuildContext {
	mode: PromptMode;
	/** Bash working directory. Not the channel directory: channel facts are turn-dynamic and never enter the system prompt. */
	cwd: string;
	workspaceDir: string;
	tools: ToolDescriptor[];
	soul?: LoadedPromptResource;
	agents?: LoadedPromptResource;
	playbooks: RuntimePlaybookMetadata[];
	subAgents: SubAgentSummary[];
	/** Skills are rendered by pi (they drive `/skill:name` too); recorded here for the manifest only. */
	skills?: Array<{ name: string; description: string }>;
}

export interface PromptSectionDefinition {
	id: string;
	/** Sort key. Unique across sections; see the reserved ranges in sections.ts. */
	order: number;
	/** Code identifier or real file path. */
	source: string;
	authority: PromptAuthority;
	cacheClass: PromptCacheClass;
	/** Modes this section applies to. Omitted = all modes. */
	modes?: PromptMode[];
	/**
	 * Section is dropped unless *every* listed tool is registered — all-of. A section
	 * describes one mechanism, so a missing tool means the mechanism is unreachable.
	 * (Playbooks gate the other way: see `requiresAnyTool` in playbooks/catalog.ts.)
	 */
	requiresAllTools?: string[];
	maxChars: number;
	overflow: PromptOverflowPolicy;
	render(context: PromptBuildContext): string | undefined;
}

export interface ResolvedPromptSection {
	id: string;
	order: number;
	source: string;
	authority: PromptAuthority;
	cacheClass: PromptCacheClass;
	content: string;
	rawChars: number;
	injectedChars: number;
	rawUnits: number;
	injectedUnits: number;
	truncated: boolean;
	sha256: string;
}

export type PromptDiagnosticLevel = "info" | "warning" | "error";

export interface PromptDiagnostic {
	level: PromptDiagnosticLevel;
	sectionId: string;
	message: string;
}

export interface PromptBuildResult {
	/** The system prompt Pipiclaw owns. pi appends skills + date + cwd; the boundary footer is appended last. */
	text: string;
	/** Short final footer, injected after pi's tail so late workspace content cannot end the prompt. */
	footer: string;
	sections: ResolvedPromptSection[];
	diagnostics: PromptDiagnostic[];
	totalChars: number;
	/** Prompt units across every section Pipiclaw assembles (runtime + workspace catalogs + SOUL/AGENTS). */
	totalUnits: number;
	/** Prompt units in the sections Pipiclaw authors and must keep tight; excludes SOUL/AGENTS, sub-agents and skills. */
	runtimeAuthoredUnits: number;
	estimatedTokens: number;
	fingerprint: string;
}
