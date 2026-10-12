/**
 * The synchronous wait window of a delegation call (spec 040 D2): one shared per-turn deadline, and
 * a watcher for the turn's abort signal. Used by the internal run; kept apart because the window is
 * a property of the dispatching turn, not of one run.
 */

/**
 * D2's grace window is per turn, not per call. The SDK runs a whole tool batch sequentially as
 * soon as one call in it is sequential (`bash`, `edit`, `write`), so "a worktree, then three
 * delegations" in one message used to block the channel for three back-to-back grace windows.
 * Every call in one agent run shares that run's AbortSignal, which is what keys the deadline:
 * the first delegation of a turn starts the clock, later ones get only what is left of it.
 */
const turnGraceDeadlines = new WeakMap<AbortSignal, number>();

export function graceDeadlineFor(signal: AbortSignal | undefined, graceMs: number, now: number): number {
	if (!signal) return now + graceMs;
	let deadline = turnGraceDeadlines.get(signal);
	if (deadline === undefined) {
		deadline = now + graceMs;
		turnGraceDeadlines.set(signal, deadline);
	}
	return deadline;
}

/** Resolves once `signal` aborts (never rejects; pending forever without one). `dispose` drops
 *  the listener, since a turn's signal outlives every call that raced against it. */
export function watchAbort(signal: AbortSignal | undefined): { aborted: Promise<"aborted">; dispose(): void } {
	let dispose = () => {};
	const aborted = new Promise<"aborted">((resolve) => {
		if (!signal) return;
		if (signal.aborted) {
			resolve("aborted");
			return;
		}
		const onAbort = () => resolve("aborted");
		signal.addEventListener("abort", onAbort, { once: true });
		dispose = () => signal.removeEventListener("abort", onAbort);
	});
	return { aborted, dispose };
}

/**
 * Longest a dispatching tool call waits for its run to settle before returning a "still running"
 * placeholder instead of the result (D2). A code constant, not a settings key, per CLAUDE.md's
 * rule for numeric thresholds.
 */
export const SYNC_GRACE_MS = 120_000;

/**
 * Effective sync grace window. A test-only env override (`PIPICLAW_TEST_SUBAGENT_SYNC_GRACE_MS`)
 * lets the deterministic e2e layer exercise the detached-settlement + completion-wake path
 * (spec 048 A14/A15/A16) without a multi-minute wait; production always uses `SYNC_GRACE_MS`.
 */
export function resolveSyncGraceMs(override?: number): number {
	if (override !== undefined) return override;
	const env = Number(process.env.PIPICLAW_TEST_SUBAGENT_SYNC_GRACE_MS);
	return Number.isFinite(env) && env > 0 ? env : SYNC_GRACE_MS;
}
