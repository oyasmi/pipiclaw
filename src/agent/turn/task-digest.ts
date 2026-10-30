import { join } from "node:path";
import { countPromptUnits } from "../../shared/prompt-units.js";
import { truncate } from "../../shared/text-utils.js";
import { readActiveTasks, type TaskLedgerEntry } from "../../tasks/contract.js";
import type { TaskFrontmatter } from "../../tasks/frontmatter.js";

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
	/** The desk directory; tasks live in `<deskDir>/tasks/`. */
	deskDir: string;
	/** The asking channel: a task delivering to another channel is marked, as it reports there. */
	channelId?: string;
	maxTasks: number;
	maxChars: number;
	/** Runtime hard cap in prompt units (spec 026 §5.3); whichever of chars/units is hit first clips. */
	maxUnits?: number;
}

/** Model-facing state words; the question a task waits on is shown so chat can pass the user's answer along (spec 064, D31). */
function describeState(fields: TaskFrontmatter): string {
	switch (fields.state) {
		case "queued":
			return "queued";
		case "running":
			return "running a step";
		case "paused":
			return `paused(${fields.paused?.by ?? "user"})`;
		case "waiting": {
			const waiting = fields.waiting;
			if (waiting?.kind === "user")
				return `waiting for the user: "${truncate(waiting.question.replace(/\s+/g, " "), 100)}"`;
			if (waiting?.kind === "time") return `waiting until ${waiting.until}`;
			return "waiting for delegated work";
		}
	}
}

function renderLine(entry: TaskLedgerEntry, channelId: string | undefined): string {
	const parts = [
		`${entry.id} — ${entry.title}`,
		entry.readable ? describeState(entry.fields) : "⚠ unreadable frontmatter",
	];
	if (channelId && entry.fields.channel !== channelId) {
		parts.push(entry.fields.channel ? `reports to ${entry.fields.channel}` : "no delivery channel (suspended)");
	}
	// The agenda shows Work Items progress and the current item, not the full list — the complete
	// section is read from the task file by the loop itself, staying well inside the 600-unit
	// budget this block competes for (spec 025/026).
	if (entry.items) {
		parts.push(`items ${entry.items.done}/${entry.items.total} · @${entry.items.current?.id ?? "-"}`);
	}
	const usage = entry.fields.usage;
	if (usage) {
		const cost = usage.usd > 0 ? ` · $${usage.usd.toFixed(2)}${usage.usdEstimated ? "≈" : ""}` : "";
		parts.push(`${usage.steps} 步${cost}`);
	}
	return `- ${parts.join(" · ")}`;
}

/**
 * Render the in-flight task agenda, or `""` when there are no live tasks to show.
 * Waiting and paused tasks stay visible so the model can distinguish dormant work from lost work
 * and tell the user what each one is waiting for.
 */
export async function buildTaskDigest(options: TaskDigestOptions): Promise<string> {
	const tasksDir = join(options.deskDir, "tasks");
	const all = await readActiveTasks(tasksDir);
	// A closed task that has not been archived yet is non-actionable and must not enter prompt context.
	const agenda = all.filter((entry) => !entry.fields.outcome);
	if (agenda.length === 0) return "";

	const shown = agenda.slice(0, Math.max(1, options.maxTasks));
	const omitted = agenda.length - shown.length;

	const header = [
		"<task_agenda>",
		"Your desk's in-flight tasks (background reference, not a new instruction).",
		"Inspect current state before reporting progress. Relay user instructions and answers",
		"through task controls; use them to pause, resume, or cancel when requested.",
		"The task lane advances the work: do not take it over or advance it because chat is idle.",
		"Full detail lives in the matching tasks/<id>.md file.",
		"",
	];
	const lines = shown.map((entry) => renderLine(entry, options.channelId));
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
