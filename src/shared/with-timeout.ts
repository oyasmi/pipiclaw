/**
 * Bound an await that has no timeout of its own.
 *
 * The promise is *not* cancelled — nothing here can cancel an in-flight fetch or
 * an SDK call — the caller is merely released so a stalled dependency cannot hold
 * a turn (and with it the channel's busy state) open indefinitely. Callers decide
 * what "released" means: most log a warning and continue with the previous state.
 */
export class OperationTimeoutError extends Error {
	readonly operation: string;
	readonly timeoutMs: number;

	constructor(operation: string, timeoutMs: number) {
		super(`${operation} timed out after ${timeoutMs}ms`);
		this.name = "OperationTimeoutError";
		this.operation = operation;
		this.timeoutMs = timeoutMs;
	}
}

/** A delay that never keeps the process alive on its own — every background-loop backoff and
 * budget wait in the codebase wants this, not a bare `setTimeout` promise. An aborted `signal`
 * ends the wait early (it still resolves; callers re-check whatever aborted it). */
export function sleepUnref(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		timer.unref?.();
		signal?.addEventListener("abort", done, { once: true });
	});
}

export async function withTimeout<T>(operation: string, timeoutMs: number, run: () => Promise<T>): Promise<T> {
	if (!(timeoutMs > 0)) {
		return run();
	}
	let timer: NodeJS.Timeout | undefined;
	const guard = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new OperationTimeoutError(operation, timeoutMs)), timeoutMs);
		// A pending guard must never keep the process alive on its own.
		timer.unref?.();
	});
	try {
		// The abandoned promise keeps running; a rejection after the race is
		// swallowed here so it never surfaces as an unhandled rejection.
		const pending = run();
		pending.catch(() => undefined);
		return await Promise.race([pending, guard]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** Release a caller even when a dependency ignores abort. Check the signal again before committing side effects. */
export async function withAbortSignal<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
	signal.throwIfAborted();
	let abort: () => void = () => {};
	const cancelled = new Promise<never>((_, reject) => {
		abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
	});
	try {
		return await Promise.race([
			Promise.resolve().then(() => {
				signal.throwIfAborted();
				return run();
			}),
			cancelled,
		]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}
