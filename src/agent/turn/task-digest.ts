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
 * The agenda lets chat match a reply to a pending question and identify other work by id.
 * Task controls provide the authoritative state and complete progress.
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

function deliveryRank(entry: TaskLedgerEntry, channelId: string | undefined): number {
	if (channelId && entry.fields.channel !== channelId) return 2;
	return entry.fields.state === "waiting" && entry.fields.waiting?.kind === "user" ? 0 : 1;
}

function renderLine(entry: TaskLedgerEntry, channelId: string | undefined): string {
	if (!entry.readable) return `- ${entry.id} · unreadable frontmatter`;
	if (deliveryRank(entry, channelId) === 2) {
		return `- ${entry.id} · ${entry.fields.channel ? `reports to ${entry.fields.channel}` : "delivery suspended"}`;
	}
	return `- ${entry.id} — ${truncate(entry.title, 80)} · ${describeState(entry.fields)}`;
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

	agenda.sort((a, b) => deliveryRank(a, options.channelId) - deliveryRank(b, options.channelId));
	const header =
		"<task_agenda>\nBackground reference. Use task_list for current state. Relay matching answers via task_message when available. The task lane advances the work.";
	const render = (kept: string[]): string => {
		const omitted = agenda.length - kept.length;
		const tail = omitted > 0 ? [`- (+${omitted} more)`] : [];
		return [header, ...kept, ...tail, "</task_agenda>"].join("\n");
	};
	const maxUnits = options.maxUnits ?? Number.POSITIVE_INFINITY;
	const fits = (text: string): boolean => text.length <= options.maxChars && countPromptUnits(text) <= maxUnits;
	const kept: string[] = [];
	let rendered = render(kept);
	if (!fits(rendered)) return "";
	for (const entry of agenda.slice(0, options.maxTasks)) {
		const line = renderLine(entry, options.channelId);
		const candidate = render([...kept, line]);
		if (!fits(candidate)) break;
		kept.push(line);
		rendered = candidate;
	}
	return rendered;
}
