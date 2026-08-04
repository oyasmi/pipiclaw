import { isRecord } from "../shared/type-guards.js";

/**
 * Per-channel tally of externally visible effects (spec 031, D7).
 *
 * The task governor has to answer "did that wake accomplish anything?". It used to answer by
 * diffing the task file's own metadata — including the model-written progress note — which made
 * the check both bypassable and unfair: a model that appended a note every wake looked productive
 * forever, while a model that changed code without writing a note looked stalled and got disabled.
 *
 * Effects are counted here instead, and only for things that change the world outside the task
 * ledger: writes, outbound media, sub-agent runs, background job launches, and a user-visible
 * reply. Self-report tools (`task_manage`, `memory_manage`) and read-only tools deliberately do
 * not count — a claim of progress is not evidence of it.
 *
 * The tally lives in process memory, exactly like the driver's futile counter it feeds; a restart
 * resets both, which costs at most one extra round of patience before the governor intervenes.
 *
 * Two tallies are kept: one per channel (raw, the measurement point) and one per task, credited
 * a turn at a time by the runtime. The governor reads the second — see `noteTaskEffects`.
 */

const counts = new Map<string, number>();
const taskCounts = new Map<string, number>();

/** Tools whose successful completion is, by itself, a visible change to the world. */
const EFFECT_TOOLS = new Set(["write", "edit", "send_media", "subagent"]);

export function noteChannelEffect(channelId: string): void {
	counts.set(channelId, (counts.get(channelId) ?? 0) + 1);
}

export function channelEffectCount(channelId: string): number {
	return counts.get(channelId) ?? 0;
}

function taskKey(channelId: string, taskId: string): string {
	return `${channelId}\0${taskId}`;
}

/**
 * Credit one task-driver turn's effects to that task.
 *
 * The channel tally above answers "how much has happened here", which is the wrong question for
 * the governor: it also counts the user's small talk, so every task in a busy channel looked like
 * it had just made progress (continue at once, futile counter reset) while a genuinely spinning
 * task hid behind its neighbours. The caller measures one turn as a delta of the channel tally —
 * turns are serialized per channel — and credits it to the task that turn was dispatched for.
 */
export function noteTaskEffects(channelId: string, taskId: string, delta: number): void {
	if (delta <= 0) return;
	const key = taskKey(channelId, taskId);
	taskCounts.set(key, (taskCounts.get(key) ?? 0) + delta);
}

/** Effects produced by this task's own driver turns so far (spec 031, D7). */
export function taskEffectCount(channelId: string, taskId: string): number {
	return taskCounts.get(taskKey(channelId, taskId)) ?? 0;
}

/** Test seam: drop all tallies. */
export function resetChannelEffects(): void {
	counts.clear();
	taskCounts.clear();
}

/**
 * Whether a completed tool call counts as an effect.
 *
 * `bash` is the awkward case: the same tool runs `ls` and `rm -rf`, and the runtime cannot tell
 * them apart. It used to count only a background launch, which produced the wrong answer for the
 * single most important shape this runtime has — a turn that synchronously drives an external
 * coding agent, then records what came back. That turn changes no file the runtime can see and
 * usually ends `[SILENT]`, so it scored zero effects and, after three of them, got its task disabled
 * by the governor: the hardest-working wake was the one most likely to be judged idle.
 *
 * A synchronous command that exited 0 and returned output therefore counts too. That is
 * bypassable — `echo x` qualifies — but the alternative was a false negative on real work, and the
 * counter never was the stop-loss: `budget.maxAttempts` bounds a task no matter how productive it
 * claims to look. What "futile" now means is the honest thing: a wake that executed nothing at all.
 */
export function isEffectfulTool(toolName: string, details: unknown): boolean {
	if (toolName === "bash") {
		if (!isRecord(details)) return false;
		if (details.async !== undefined) return true;
		return details.exitCode === 0 && details.producedOutput === true;
	}
	return EFFECT_TOOLS.has(toolName);
}
