/** Independent bounded pools for agent execution and judge calls. */
export class EvalPool {
	private active = 0;
	private readonly waiting: Array<() => void> = [];
	constructor(private readonly limit: number) {
		if (!Number.isInteger(limit) || limit < 1)
			throw new Error("Pool limit must be a positive integer; fix the eval concurrency setting.");
	}
	async acquire(): Promise<() => void> {
		if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
		else this.active++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = this.waiting.shift();
			if (next) next();
			else this.active--;
		};
	}
}
