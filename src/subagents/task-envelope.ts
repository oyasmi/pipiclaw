/**
 * The task envelope a delegation sends: runtime paths, injected memory/context blocks, the task, and
 * the checker protocol for `purpose=verify`; plus the admission rule for verify runs. Shared by the
 * internal and external runtimes and by `subagent_run op=follow_up` (spec 040 D9, spec 042 D7).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as log from "../log.js";
import {
	buildChannelIndexForBootstrap,
	CHANNEL_INDEX_MAX_UNITS,
	clipJournalTailForBootstrap,
	clipWorkspaceMemoryForBootstrap,
	JOURNAL_TAIL_MAX_UNITS,
	WORKSPACE_MEMORY_MAX_UNITS,
} from "../memory/index-budget.js";
import { readJournalDay } from "../memory/journal.js";
import { renderMemoryBootstrap } from "../memory/render.js";
import { listMemoryEntries } from "../memory/store.js";
import { localDayKey } from "../shared/local-time.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { errorMessage } from "../shared/text-utils.js";
import type { ResolvedSubAgentConfig, SubAgentConfig } from "./discovery.js";
import type { SubAgentRunContext, SubAgentToolOptions } from "./types.js";
import { findWorkspaceLeaseHolder, formatWorkspaceLeaseConflict } from "./workspace-lease.js";

/**
 * `buildContextualBlocks` shared by the external dispatch path and `runToCompletion`'s internal
 * one (spec 040 gap closed post-review): context injection is an enhancement, not a
 * precondition, so a failure here degrades to no context blocks rather than failing a dispatch
 * that would otherwise have run fine.
 */
export async function resolveContextualBlocks(
	config: ResolvedSubAgentConfig,
	options: SubAgentToolOptions,
): Promise<string[]> {
	return buildContextualBlocks(config, options).catch((error) => {
		log.logWarn("subagent.context.inject_failed", "Sub-agent context injection failed; continuing without it", {
			channelId: options.runtimeContext.channelId,
			reason: errorMessage(error),
		});
		return [] as string[];
	});
}

/**
 * Shared by both runtimes' task envelopes and `subagent_run`'s verify follow-up (spec 040, D9).
 * A check bound to a Work Item covers that item only: holding it to the whole DoD would fail it
 * for the items still in progress.
 */
export function buildVerificationProtocol(taskPath: string | undefined, item?: string): string {
	const scope = !taskPath
		? "- Independently inspect the work described in the task above and verify it against concrete evidence."
		: item
			? `- Independently inspect Work Item ${item} in ${taskPath} — its text and the DoD items it references (\`→ dod:N\`) — and verify it against concrete evidence. Other Work Items are out of scope; do not fail this check because they are unfinished.`
			: `- Independently inspect ${taskPath} and verify every DoD item against concrete evidence.`;
	return [
		"Verification protocol:",
		scope,
		"- You are the checker, not the maker. Do not modify the implementation or fix failures to make a check pass; report them.",
		"- You may run npm tests/builds and other deterministic checks; keep any generated output out of tracked files and product directories.",
		"- Run deterministic checks when available and distinguish observed evidence from assumptions.",
		"- End the response with exactly one final line: VERDICT: PASS or VERDICT: FAIL.",
	].join("\n");
}

/**
 * D9 verify admission — `exec` has no protocol terminal to prove it even ran to completion, and a
 * target with an active write lease is refused up front. A write-capable verifier is allowed: it
 * takes the same exclusive lease as a work writer.
 * Spec 042 D7: exported so `subagent_run op=follow_up` runs the exact same checks the initial
 * dispatch does, including the remaining `exec` restriction.
 */
export function assertVerifyAdmissible(
	config: Pick<ResolvedSubAgentConfig, "name" | "mutates" | "runtime" | "harness">,
	purpose: "work" | "verify",
	workingDirectory: string,
): void {
	if (purpose !== "verify") return;
	if (config.runtime === "external" && config.harness === "exec") {
		throw new RecoverableToolError(
			`Sub-agent "${config.name}" uses the exec harness, which has no protocol terminal and cannot be used for purpose=verify.`,
		);
	}
	const holder = findWorkspaceLeaseHolder(workingDirectory);
	if (holder) {
		throw new RecoverableToolError(`Cannot verify "${workingDirectory}": ${formatWorkspaceLeaseConflict(holder)}`);
	}
}

/**
 * The task envelope both runtimes' first dispatch sends (a follow-up sends `buildFollowUpTask`
 * instead). `config` is narrowed to `{ name }` — the only field this function reads.
 */
export function buildSubAgentTask(
	task: string,
	config: Pick<SubAgentConfig, "name">,
	runtimeContext: SubAgentToolOptions["runtimeContext"],
	contextBlocks: string[],
	runContext: SubAgentRunContext,
): string {
	const taskText = task.trim();
	const lines = [
		`Runtime context:`,
		`- Workspace root: ${runtimeContext.workspaceDir}`,
		`- Dot: ${runtimeContext.dot}`,
		`- Dot directory: ${runtimeContext.dotDir}`,
		`- Channel id: ${runtimeContext.channelId}`,
		`- Working directory: ${runContext.workingDirectory}`,
		`- Artifact directory: ${runContext.artifactDir}`,
		`- Your configured role: ${config.name}`,
	];

	for (const block of contextBlocks) {
		if (!block.trim()) {
			continue;
		}
		lines.push("", block.trim());
	}

	lines.push("", `Task:`, taskText);
	if (runContext.purpose === "verify") {
		lines.push("", buildVerificationProtocol(verificationTaskPath(runtimeContext, runContext), runContext.item));
	}
	return lines.join("\n");
}

function verificationTaskPath(
	runtimeContext: SubAgentToolOptions["runtimeContext"],
	runContext: SubAgentRunContext,
): string | undefined {
	return runContext.taskId ? join(runtimeContext.dotDir, "tasks", `${runContext.taskId}.md`) : undefined;
}

/**
 * The envelope for `subagent_run op=follow_up`. A resumed session already holds the first
 * dispatch's whole envelope — runtime paths, injected memory/context blocks, the role — so sending
 * it again only re-bills that context and buries the new instruction. Only what is new goes: the
 * artifact directory (fresh per run) and the instruction itself, plus the checker protocol again
 * for a verify run, since its final VERDICT line is what settlement reads.
 */
export function buildFollowUpTask(
	task: string,
	runtimeContext: SubAgentToolOptions["runtimeContext"],
	runContext: SubAgentRunContext,
): string {
	const lines = [
		"Follow-up in the same session. Your earlier instructions and context still apply unless this changes them.",
		`- Working directory: ${runContext.workingDirectory}`,
		`- Artifact directory for this follow-up: ${runContext.artifactDir}`,
		"",
		"Follow-up instruction:",
		task.trim(),
	];
	if (runContext.purpose === "verify") {
		lines.push("", buildVerificationProtocol(verificationTaskPath(runtimeContext, runContext), runContext.item));
	}
	return lines.join("\n");
}

/**
 * Spec 050, D12: `memory: index` injects the same three sections the main agent's first-turn
 * bootstrap does — workspace MEMORY.md, the channel index, today's journal tail — at half the
 * main agent's budget. No per-call LLM recall: a sub-agent task is short-lived, so there is no
 * "first turn" to bootstrap once and reuse; it gets the same snapshot every dispatch.
 */
async function buildContextualBlocks(
	config: Pick<SubAgentConfig, "contextMode" | "paths" | "memory">,
	options: Pick<SubAgentToolOptions, "dotDir" | "workspaceDir">,
): Promise<string[]> {
	if (config.contextMode !== "contextual") {
		return [];
	}

	const blocks: string[] = [];
	if (config.paths.length > 0) {
		blocks.push(`Preferred focus paths:\n${config.paths.map((path) => `- ${path}`).join("\n")}`);
	}

	if (config.memory === "none") {
		return blocks;
	}

	const today = localDayKey();
	const readOptionalFile = async (path: string): Promise<string> => {
		try {
			return await readFile(path, "utf-8");
		} catch {
			return "";
		}
	};
	const [entries, workspaceMemory, journalToday] = await Promise.all([
		listMemoryEntries(options.dotDir).catch(() => []),
		readOptionalFile(join(options.workspaceDir, "MEMORY.md")),
		readJournalDay(options.dotDir, today).catch(() => ""),
	]);
	const index = buildChannelIndexForBootstrap(entries, CHANNEL_INDEX_MAX_UNITS / 2);
	const bootstrap = renderMemoryBootstrap({
		workspaceMemory: clipWorkspaceMemoryForBootstrap(workspaceMemory, WORKSPACE_MEMORY_MAX_UNITS / 2),
		channelIndex: entries.length > 0 ? index.text : "",
		journal: (() => {
			const text = clipJournalTailForBootstrap(journalToday, JOURNAL_TAIL_MAX_UNITS / 2);
			return text ? { date: today, text } : undefined;
		})(),
	});
	if (bootstrap) {
		blocks.push(bootstrap);
	}

	return blocks;
}
