import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { formatLocalTime } from "../shared/local-time.js";
import { normalizeTaskId } from "./ledger.js";

/**
 * Out-of-band guidance for a running task loop (spec 051, D11) — `/tasks steer` and `/tasks reply`.
 *
 * Kept as one small file per task rather than a frontmatter field or a log record: it is a
 * *pending instruction*, not durable task state, so it must not enter the contract (which the
 * loop injects whole and which has a hard size budget) and must be consumed exactly once. The
 * next step reads it, deletes it, and puts the text at the top of its own brief; nothing is left
 * behind for a later step to act on twice.
 */
function steerDir(channelDir: string): string {
	return join(channelDir, "tasks", ".steer");
}

function steerPath(channelDir: string, id: string): string {
	return join(steerDir(channelDir), `${normalizeTaskId(id)}.md`);
}

/** Queue guidance for the task's next step. Repeated calls append, so nothing is silently lost. */
export async function queueTaskSteer(channelDir: string, id: string, text: string, label = "用户指示"): Promise<void> {
	const trimmed = text.trim();
	if (!trimmed) return;
	await mkdir(steerDir(channelDir), { recursive: true });
	const path = steerPath(channelDir, id);
	const existing = existsSync(path) ? `${await readFile(path, "utf-8")}\n` : "";
	await writeFileAtomically(path, `${existing}- [${formatLocalTime()}] ${label}：${trimmed}\n`);
}

/** Read and clear the pending guidance. Returns `undefined` when there is none. */
export async function consumeTaskSteer(channelDir: string, id: string): Promise<string | undefined> {
	const path = steerPath(channelDir, id);
	if (!existsSync(path)) return undefined;
	try {
		const text = (await readFile(path, "utf-8")).trim();
		await rm(path, { force: true });
		return text || undefined;
	} catch {
		return undefined;
	}
}

/** Whether guidance is waiting, without consuming it (for `/tasks show`). */
export function hasTaskSteer(channelDir: string, id: string): boolean {
	return existsSync(steerPath(channelDir, id));
}

/**
 * The other direction: what a step asked the runtime to tell the user (`task_step_end`'s
 * `notify`). Held in a file rather than returned inline because the tool result never reaches the
 * transport — the runtime reads and clears this after the step ends, and delivers it once.
 */
function noticePath(channelDir: string, id: string): string {
	return join(steerDir(channelDir), `${normalizeTaskId(id)}.out.md`);
}

export async function queueTaskNotice(channelDir: string, id: string, text: string): Promise<void> {
	const trimmed = text.trim();
	if (!trimmed) return;
	await mkdir(steerDir(channelDir), { recursive: true });
	const path = noticePath(channelDir, id);
	const existing = existsSync(path) ? `${await readFile(path, "utf-8")}\n\n` : "";
	await writeFileAtomically(path, `${existing}${trimmed}`);
}

export async function consumeTaskNotice(channelDir: string, id: string): Promise<string | undefined> {
	const path = noticePath(channelDir, id);
	if (!existsSync(path)) return undefined;
	try {
		const text = (await readFile(path, "utf-8")).trim();
		await rm(path, { force: true });
		return text || undefined;
	} catch {
		return undefined;
	}
}
