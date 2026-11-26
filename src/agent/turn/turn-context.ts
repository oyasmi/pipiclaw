/**
 * The dynamic context that rides a turn rather than the system prompt (so the channels of a desk
 * share one cached prompt prefix): the desk capsule, the task agenda digest, and the first-turn
 * memory bootstrap.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TASK_DIGEST_SETTINGS } from "../../config/settings.js";
import type { DeskConversation } from "../../desk/types.js";
import {
	buildJournalBlocksForBootstrap,
	buildMemoryIndexForBootstrap,
	clipWorkspaceMemoryForBootstrap,
} from "../../memory/index-budget.js";
import { readRecentJournalForBootstrap } from "../../memory/journal.js";
import { renderMemoryBootstrap } from "../../memory/render.js";
import { listMemoryEntries } from "../../memory/store.js";
import { localDayKey } from "../../shared/local-time.js";
import { buildTaskDigest, TASK_AGENDA_MAX_UNITS } from "./task-digest.js";

/**
 * The per-turn desk capsule (spec 058, D16): which desk this is, where its directory is, and which
 * channel this conversation comes from. Only the current desk and channel — never the desk's other
 * bindings. The memory/task/event tools are already bound to the desk, so the model only needs
 * the directory when it wants to read a file directly.
 */
export function renderDeskTurnContext(
	conversation: DeskConversation,
	/** How the channel is named to the user (`Transport.describe`), when it has a name. */
	channelLabel: string | undefined,
	workspaceDir: string,
): string {
	return [
		"<runtime_turn_context>",
		`Workspace: ${workspaceDir}`,
		`Desk: ${conversation.desk} (${conversation.deskDir})`,
		`Cwd: ${conversation.cwd}`,
		`Channel: ${conversation.channelId}${channelLabel ? ` (${channelLabel})` : ""}`,
		"</runtime_turn_context>",
	].join("\n");
}

/** Gated by the same master autonomy switch as the task_* tools and the task lane. */
export function buildTaskDigestForTurn(deskDir: string, channelId: string): Promise<string> {
	return buildTaskDigest({
		deskDir,
		channelId,
		maxTasks: TASK_DIGEST_SETTINGS.maxTasks,
		maxChars: TASK_DIGEST_SETTINGS.maxChars,
		maxUnits: TASK_AGENDA_MAX_UNITS,
	});
}

/**
 * Spec 050, D1: assemble `<memory_bootstrap>` for the first turn of a session — workspace
 * MEMORY.md (whole H2 sections, budgeted) + the desk memory index (full, or budget-tiered) +
 * today's journal tail.
 */
export async function buildFirstTurnMemoryBootstrap(deskDir: string, workspaceDir: string): Promise<string> {
	const readOptionalFile = async (path: string): Promise<string> => {
		try {
			return await readFile(path, "utf-8");
		} catch {
			return "";
		}
	};

	const today = localDayKey();
	const [entries, workspaceMemory, recentJournal] = await Promise.all([
		listMemoryEntries(deskDir).catch(() => []),
		readOptionalFile(join(workspaceDir, "MEMORY.md")),
		readRecentJournalForBootstrap(deskDir, today).catch(
			(): Awaited<ReturnType<typeof readRecentJournalForBootstrap>> => ({ todayText: "" }),
		),
	]);

	const index = buildMemoryIndexForBootstrap(entries);
	const journal = buildJournalBlocksForBootstrap({
		todayDate: today,
		todayText: recentJournal.todayText,
		previous: recentJournal.previous,
	});
	return renderMemoryBootstrap({
		workspaceMemory: clipWorkspaceMemoryForBootstrap(workspaceMemory),
		memoryIndex: entries.length > 0 ? index.text : "",
		journal: journal.length > 0 ? journal : undefined,
	});
}
