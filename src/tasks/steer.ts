import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { formatLocalTime } from "../shared/local-time.js";
import { normalizeTaskId } from "./contract.js";
import { withTaskMutation } from "./mutation-lock.js";

/**
 * Out-of-band guidance for a running task loop (spec 051, D11) — `/tasks steer` and `/tasks reply`.
 *
 * Kept as one small file per task rather than a frontmatter field or a log record: it is a
 * *pending instruction*, not durable task state, so it must not enter the contract (which the
 * loop injects whole and which has a hard size budget) and must be consumed exactly once. The
 * next step reads it, deletes it, and puts the text at the top of its own brief; nothing is left
 * behind for a later step to act on twice.
 *
 * Each read-modify-write runs under the task's mutation lock: a TUI's `/tasks steer` appending
 * while the daemon's step consumes would otherwise lose the appended line.
 */
function steerDir(dotDir: string): string {
	return join(dotDir, "tasks", ".steer");
}

function steerPath(dotDir: string, id: string): string {
	return join(steerDir(dotDir), `${normalizeTaskId(id)}.md`);
}

/** Queue guidance for the task's next step. Repeated calls append, so nothing is silently lost. */
export async function queueTaskSteer(dotDir: string, id: string, text: string, label = "用户指示"): Promise<void> {
	const trimmed = text.trim();
	if (!trimmed) return;
	await withTaskMutation(dotDir, id, async () => {
		await mkdir(steerDir(dotDir), { recursive: true });
		const path = steerPath(dotDir, id);
		const existing = existsSync(path) ? `${await readFile(path, "utf-8")}\n` : "";
		await writeFileAtomically(path, `${existing}- [${formatLocalTime()}] ${label}：${trimmed}\n`);
	});
}

/** Read and clear the pending guidance. Returns `undefined` when there is none. */
export async function consumeTaskSteer(dotDir: string, id: string): Promise<string | undefined> {
	return consumeOnce(dotDir, id, steerPath(dotDir, id));
}

async function consumeOnce(dotDir: string, id: string, path: string): Promise<string | undefined> {
	if (!existsSync(path)) return undefined;
	return withTaskMutation(dotDir, id, async () => {
		try {
			const text = (await readFile(path, "utf-8")).trim();
			await rm(path, { force: true });
			return text || undefined;
		} catch {
			return undefined;
		}
	});
}

/** Whether guidance is waiting, without consuming it (for `/tasks show`). */
export function hasTaskSteer(dotDir: string, id: string): boolean {
	return existsSync(steerPath(dotDir, id));
}

/**
 * The other direction: what a step asked the runtime to tell the user (`task_step_end`'s
 * `notify`). Held in a file rather than returned inline because the tool result never reaches the
 * transport — the runtime reads and clears this after the step ends, and delivers it once.
 */
function noticePath(dotDir: string, id: string): string {
	return join(steerDir(dotDir), `${normalizeTaskId(id)}.out.md`);
}

export async function queueTaskNotice(dotDir: string, id: string, text: string): Promise<void> {
	const trimmed = text.trim();
	if (!trimmed) return;
	await withTaskMutation(dotDir, id, async () => {
		await mkdir(steerDir(dotDir), { recursive: true });
		const path = noticePath(dotDir, id);
		const existing = existsSync(path) ? `${await readFile(path, "utf-8")}\n\n` : "";
		await writeFileAtomically(path, `${existing}${trimmed}`);
	});
}

export async function consumeTaskNotice(dotDir: string, id: string): Promise<string | undefined> {
	return consumeOnce(dotDir, id, noticePath(dotDir, id));
}
