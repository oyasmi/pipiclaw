import { isRecord } from "../shared/type-guards.js";

/**
 * Per-channel tally of externally visible effects (spec 031, D7).
 *
 * The task governor has to answer "did that wake accomplish anything?". It used to answer by
 * diffing the task file's own metadata — including the model-written progress note — which made
 * the check both bypassable and unfair: a model that appended a note every wake looked productive
 * forever, while a model that changed code without writing a note looked stalled and got paused.
 *
 * Effects are counted here instead, and only for things that change the world outside the task
 * ledger: writes, outbound media, sub-agent runs, background job launches, and a user-visible
 * reply. Self-report tools (`task_manage`, `memory_manage`) and read-only tools deliberately do
 * not count — a claim of progress is not evidence of it.
 *
 * The tally lives in process memory, exactly like the driver's futile counter it feeds; a restart
 * resets both, which costs at most one extra round of patience before the governor intervenes.
 */

const counts = new Map<string, number>();

/** Tools whose successful completion is, by itself, a visible change to the world. */
const EFFECT_TOOLS = new Set(["write", "edit", "send_media", "subagent"]);

export function noteChannelEffect(channelId: string): void {
	counts.set(channelId, (counts.get(channelId) ?? 0) + 1);
}

export function channelEffectCount(channelId: string): number {
	return counts.get(channelId) ?? 0;
}

/** Test seam: drop all tallies. */
export function resetChannelEffects(): void {
	counts.clear();
}

/**
 * Whether a completed tool call counts as an effect. `bash` is the awkward case — the same tool
 * runs `ls` and `rm -rf`, and the runtime cannot tell them apart — so only a background launch
 * (which leaves a job behind) counts. Erring toward "no effect" means a genuinely idle loop is
 * still caught; erring the other way would let any wake claim progress by running `true`.
 */
export function isEffectfulTool(toolName: string, details: unknown): boolean {
	if (toolName === "bash") {
		return isRecord(details) && details.async !== undefined;
	}
	return EFFECT_TOOLS.has(toolName);
}
