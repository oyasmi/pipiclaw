/** Revision check and registration are synchronous, so a completion cannot fall between them. */
export class CompletionSignal {
	revision = 0;
	private readonly waiters = new Set<() => void>();
	private stopped = false;

	publish(): void {
		this.revision++;
		for (const wake of [...this.waiters]) wake();
	}

	stop(): void {
		this.stopped = true;
		this.publish();
	}

	wait(revision: number, ms: number, signal?: AbortSignal): Promise<void> {
		if (this.stopped || this.revision !== revision || signal?.aborted) return Promise.resolve();
		return new Promise((resolve) => {
			const wake = () => {
				clearTimeout(timer);
				this.waiters.delete(wake);
				signal?.removeEventListener("abort", wake);
				resolve();
			};
			const timer = setTimeout(wake, ms);
			this.waiters.add(wake);
			signal?.addEventListener("abort", wake, { once: true });
		});
	}
}
