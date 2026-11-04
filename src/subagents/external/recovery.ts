/** Scheduling only: the manager remains the owner of reconciliation and settlement. */
export class AdoptedRunObserver {
	private readonly entries = new Map<string, { due: number; checking: boolean }>();
	private timer?: ReturnType<typeof setTimeout>;
	private stopped = false;

	constructor(
		private readonly current: (id: string) => { status: string; deadlineAt?: number } | undefined,
		private readonly check: (id: string) => Promise<void>,
		private readonly failed: (id: string, error: unknown) => void,
		private readonly intervalMs = 10_000,
	) {}

	add(id: string): void {
		if (this.stopped || this.entries.has(id)) return;
		this.entries.set(id, { due: this.next(id), checking: false });
		this.schedule();
	}

	remove(id: string): void {
		this.entries.delete(id);
		this.schedule();
	}

	stop(): void {
		this.stopped = true;
		clearTimeout(this.timer);
		this.timer = undefined;
		this.entries.clear();
	}

	private next(id: string): number {
		const now = Date.now();
		const deadline = this.current(id)?.deadlineAt;
		// An expired deadline is checked each cycle, without a busy loop on unknown identity.
		return deadline && deadline > now ? Math.min(now + this.intervalMs, deadline) : now + this.intervalMs;
	}

	private schedule(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		if (this.stopped) return;
		const pending = [...this.entries.values()].filter((entry) => !entry.checking);
		if (!pending.length) return;
		this.timer = setTimeout(
			() => this.tick(),
			Math.max(0, Math.min(...pending.map((entry) => entry.due)) - Date.now()),
		);
		this.timer.unref?.();
	}

	private tick(): void {
		if (this.stopped) return;
		for (const [id, entry] of this.entries) {
			if (entry.checking || entry.due > Date.now()) continue;
			if (this.current(id)?.status !== "running") {
				this.entries.delete(id);
				continue;
			}
			entry.checking = true;
			void this.check(id)
				.catch((error) => this.failed(id, error))
				.finally(() => {
					if (this.stopped || this.entries.get(id) !== entry) return;
					if (this.current(id)?.status !== "running") this.entries.delete(id);
					else {
						entry.checking = false;
						entry.due = this.next(id);
					}
					this.schedule();
				});
		}
		this.schedule();
	}
}
