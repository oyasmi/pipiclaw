/**
 * The dynamic context that rides a turn rather than the system prompt (so the channels of a dot
 * share one cached prompt prefix): the dot capsule, the task agenda digest, and the first-turn
 * memory bootstrap.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { formatChannelLabel } from "../../channel/channel-id.js";
import { TASK_DIGEST_SETTINGS } from "../../config/settings.js";
import type { DotConversation } from "../../dot/types.js";
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
 * The per-turn dot capsule (spec 058, D16): which dot this is, where its directory is, and which
 * channel this conversation comes from. Only the current dot and channel — never the dot's other
 * bindings. The memory/task/event tools are already bound to the dot, so the model only needs
 * the directory when it wants to read a file directly.
 */
export function renderDotTurnContext(conversation: DotConversation, channelName: string | undefined): string {
	return [
		"<runtime_turn_context>",
		`Dot: ${conversation.dot} — directory ${conversation.dotDir} (your working directory).`,
		`This conversation: ${channelName ? `${formatChannelLabel(conversation.channelId, channelName)} ` : ""}(channel ${conversation.channelId}).`,
		"The dot's `MEMORY.md` index, `memory/`, `journal/`, `tasks/` and `events/` live in the dot directory. Prefer the context supplied with this turn and the dot-bound tools; read those files directly only when you need detail they did not provide.",
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
