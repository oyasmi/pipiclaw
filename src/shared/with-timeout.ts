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
