export class SessionResourceGate {
	private activePromptCount = 0;
	private refreshPending = false;
	private reloadChain: Promise<void> = Promise.resolve();

	constructor(private readonly reloadSessionResources: () => Promise<void>) {}

	async runPrompt<T>(operation: () => Promise<T>): Promise<T> {
		await this.reloadChain;
		this.activePromptCount++;
		try {
			return await operation();
		} finally {
			this.activePromptCount--;
			await this.flushPendingRefresh();
		}
	}

	async requestRefresh(): Promise<void> {
		this.refreshPending = true;
		if (this.activePromptCount > 0) {
			return;
		}
		await this.flushPendingRefresh();
	}

	private async flushPendingRefresh(): Promise<void> {
		if (!this.refreshPending || this.activePromptCount > 0) {
			return;
		}

		this.refreshPending = false;
		const runReload = async (): Promise<void> => {
			if (this.activePromptCount > 0) {
				this.refreshPending = true;
				return;
			}
			await this.reloadSessionResources();
		};

		this.reloadChain = this.reloadChain.then(runReload, runReload);
		await this.reloadChain;

		if (this.refreshPending && this.activePromptCount === 0) {
			await this.flushPendingRefresh();
		}
	}
}
