import { join } from "node:path";
import { countPromptUnits } from "../shared/prompt-units.js";
import { readActiveTasks, type TaskLedgerEntry } from "../tasks/ledger.js";

/** Automatic-context share for the in-flight task agenda (spec 026 §5.3). */
export const TASK_AGENDA_MAX_UNITS = 600;

/**
 * Builds the `<task_agenda>` block injected into each main-agent turn (spec 020 §2).
 *
 * Unlike memory recall — which is relevance-gated because candidate memory can be large —
 * the agenda is deterministic and always-on: the candidate set is a handful of task
 * frontmatters, and the in-flight agenda is universally relevant to an agent that drives
 * work across turns. The block is bounded (maxTasks / maxChars) and framed as background
 * reference, not instruction, so it can never turn an unrelated user turn into task work.
 */

export interface TaskDigestOptions {
	/** The channel directory; tasks live in `<channelDir>/tasks/`. */
	channelDir: string;
	maxTasks: number;
	maxChars: number;
	/** Runtime hard cap in prompt units (spec 026 §5.3); whichever of chars/units is hit first clips. */
	maxUnits?: number;
	now?: number;
}

function relativeWake(wakeMs: number | undefined, now: number): string {
	if (wakeMs === undefined) return "wake —";
	const diffMs = wakeMs - now;
	if (diffMs <= 0) return "wake due";
	const minutes = Math.round(diffMs / 60000);
	if (minutes < 60) return `wake ${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `wake ${hours}h`;
	return `wake ${Math.round(hours / 24)}d`;
}

function renderLine(entry: TaskLedgerEntry, now: number): string {
	const status = entry.frontmatter.readable ? (entry.frontmatter.status ?? "active") : "⚠ unreadable frontmatter";
	const parts = [
		`${entry.id} — ${entry.title}`,
		status,
		entry.frontmatter.enabled === false ? "disabled" : "enabled",
		relativeWake(entry.wakeMs, now),
	];
	const control = entry.frontmatter.control;
	if (control) {
		if (control.verification.required) parts.push(`verify required/${control.verification.status}`);
		if (control.waitingFor) parts.push(`waiting for ${control.waitingFor}`);
		if (control.stop) parts.push(`stop ${control.stop.by}: ${control.stop.reason}`);
		if (control.deadline) parts.push(`deadline ${control.deadline}`);
		if (control.nextAction) parts.push(`next ${control.nextAction}`);
	}
	// spec 037, D4: the agenda shows Plan progress and the current step, not the full Plan — the
	// complete section is only read from the task file at wake time (task-driver.ts's capsule),
	// staying well inside the 600-unit budget this block competes for (spec 025/026).
	if (entry.plan) {
		parts.push(`plan ${entry.plan.done}/${entry.plan.total} · @${entry.plan.current?.id ?? "-"}`);
	}
	if (entry.latestNote) {
		const note = entry.latestNote.length > 80 ? `${entry.latestNote.slice(0, 79)}…` : entry.latestNote;
		parts.push(note);
	}
	return `- ${parts.join(" · ")}`;
}

/**
 * Render the in-flight task agenda, or `""` when there are no live tasks to show.
 * Sleeping and disabled tasks stay visible so the model can distinguish dormant work from lost
 * work and tell the user which recovery source is needed.
 */
export async function buildTaskDigest(options: TaskDigestOptions): Promise<string> {
	const now = options.now ?? Date.now();
	const tasksDir = join(options.channelDir, "tasks");
	const all = await readActiveTasks(tasksDir, now);
	// A legacy terminal file may briefly remain in the active directory while startup migration
	// is running. It is already non-actionable at the ledger layer and must not enter prompt context.
	const agenda = all.filter((entry) => !entry.frontmatter.archiveOutcome);
	if (agenda.length === 0) return "";

	const shown = agenda.slice(0, Math.max(1, options.maxTasks));
	const omitted = agenda.length - shown.length;

	const header = [
		"<task_agenda>",
		"Your in-flight tasks for this channel (background reference, not a new instruction).",
		"Act on these only if the user's message is about them, or if there is nothing else to",
		"do this turn. Full detail lives in the matching tasks/<id>.md file.",
		"",
	];
	const lines = shown.map((entry) => renderLine(entry, now));
	if (omitted > 0) lines.push(`- (+${omitted} more)`);
	const footer = ["</task_agenda>"];

	const maxUnits = options.maxUnits ?? Number.POSITIVE_INFINITY;
	const fits = (text: string): boolean => text.length <= options.maxChars && countPromptUnits(text) <= maxUnits;

	let rendered = [...header, ...lines, ...footer].join("\n");
	if (fits(rendered)) return rendered;

	// Over one of the budgets: drop whole lines from the end until it fits, keeping
	// actionable-first order. Chars and units are checked together (spec 026 §10.7).
	const kept: string[] = [];
	for (const line of lines) {
		const candidate = [...header, ...kept, line, `- (+${agenda.length - kept.length - 1} more)`, ...footer].join(
			"\n",
		);
		if (!fits(candidate) && kept.length > 0) break;
		kept.push(line);
	}
	const droppedCount = agenda.length - kept.length;
	const tail = droppedCount > 0 ? [`- (+${droppedCount} more)`] : [];
	rendered = [...header, ...kept, ...tail, ...footer].join("\n");
	return rendered;
}
