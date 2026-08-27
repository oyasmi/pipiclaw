import { formatDuration } from "../shared/duration.js";
import type { RunRecord } from "./runs.js";

/**
 * Shared display primitives for delegation runs (spec 041), used by both the model-facing
 * `subagent_list`/`subagent_run` tools and the human-facing `/subagents` runtime command. Only the pieces that
 * are genuinely language/audience-neutral live here — duration math, the harness label, and the
 * cost guard — not full line templates, since the two surfaces render in different languages.
 */

export { formatDuration };

export function elapsedMs(record: RunRecord, now = Date.now()): number {
	return (record.finishedAt ?? now) - record.startedAt;
}

/** Spec 042 D1: a restart-reconciled run's duration is an estimate (from the artifact file's mtime
 *  or a wall-clock fallback), not a measured process lifetime — prefix it so a reader does not
 *  mistake it for a precise figure. */
export function formatRunDuration(record: RunRecord, now = Date.now()): string {
	const text = formatDuration(elapsedMs(record, now));
	return record.durationEstimated ? `≈${text}` : text;
}

export function harnessLabel(record: RunRecord): string {
	return record.harness ? `${record.runtime}/${record.harness}` : record.runtime;
}

/** `undefined` when cost genuinely is not known (e.g. `codex-cli`, `exec`) — never displayed as $0. */
export function formatCost(record: RunRecord): string | undefined {
	if (!record.costKnown) return undefined;
	return `$${record.usage.cost.total.toFixed(2)}`;
}
