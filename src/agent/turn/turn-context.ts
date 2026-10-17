/**
 * The dynamic context that rides a turn rather than the system prompt (so every channel in a
 * workspace shares one cached prompt prefix): the channel capsule, the task agenda digest, and the
 * first-turn memory bootstrap.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TASK_DIGEST_SETTINGS } from "../../config/settings.js";
import {
	buildChannelIndexForBootstrap,
	clipJournalTailForBootstrap,
	clipWorkspaceMemoryForBootstrap,
} from "../../memory/index-budget.js";
import { readJournalDay } from "../../memory/journal.js";
import { renderMemoryBootstrap } from "../../memory/render.js";
import { listMemoryEntries } from "../../memory/store.js";
import { localDayKey } from "../../shared/local-time.js";
import { buildTaskDigest, TASK_AGENDA_MAX_UNITS } from "./task-digest.js";

/**
 * The per-turn channel capsule. It replaces the channel paths that used to sit in
 * the system prompt: memory/task/event tools are already bound to this channel, so
 * the model only needs the directory when it wants to read a file directly.
 */
export function renderChannelTurnContext(dotDir: string): string {
	return [
		"<runtime_turn_context>",
		`Channel directory: ${dotDir}`,
		"The channel `MEMORY.md` index, `memory/`, `journal/` and `tasks/` live there. Prefer the context supplied with this turn and the channel-bound tools; read those files directly only when you need detail they did not provide.",
		"</runtime_turn_context>",
	].join("\n");
}

/** Gated by the same master autonomy switch as the task_* tools and the TaskDriver. */
export function buildTaskDigestForTurn(dotDir: string): Promise<string> {
	return buildTaskDigest({
		dotDir,
		maxTasks: TASK_DIGEST_SETTINGS.maxTasks,
		maxChars: TASK_DIGEST_SETTINGS.maxChars,
		maxUnits: TASK_AGENDA_MAX_UNITS,
	});
}

/**
 * Spec 050, D1: assemble `<memory_bootstrap>` for the first turn of a session — workspace
 * MEMORY.md (whole H2 sections, budgeted) + the channel index (full, or budget-tiered) +
 * today's journal tail.
 */
export async function buildFirstTurnMemoryBootstrap(dotDir: string, workspaceDir: string): Promise<string> {
	const readOptionalFile = async (path: string): Promise<string> => {
		try {
			return await readFile(path, "utf-8");
		} catch {
			return "";
		}
	};

	const today = localDayKey();
	const [entries, workspaceMemory, journalToday] = await Promise.all([
		listMemoryEntries(dotDir).catch(() => []),
		readOptionalFile(join(workspaceDir, "MEMORY.md")),
		readJournalDay(dotDir, today).catch(() => ""),
	]);

	const index = buildChannelIndexForBootstrap(entries);
	const journalTail = clipJournalTailForBootstrap(journalToday);
	return renderMemoryBootstrap({
		workspaceMemory: clipWorkspaceMemoryForBootstrap(workspaceMemory),
		channelIndex: entries.length > 0 ? index.text : "",
		journal: journalTail ? { date: today, text: journalTail } : undefined,
	});
}
