import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";

/**
 * Serializes session-resource reloads against prompts.
 *
 * A refresh requested mid-prompt is deferred, then started once the prompt
 * settles — but deliberately *not* awaited by that prompt. A reload reloads
 * settings, skills, sub-agents and the SDK session; `/new` in particular defers
 * a full reload into the prompt's epilogue, and awaiting it there kept the turn
 * (and the channel's busy state) open for as long as the slowest step took. The
 * next prompt still waits on `reloadChain`, so no turn ever runs against
 * half-reloaded resources.
 */
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
			// Detached: `flushPendingRefresh` has already published the new
			// `reloadChain` by the time it first yields, so the next `runPrompt`
			// orders behind this reload without this turn waiting for it.
			void this.flushPendingRefresh();
		}
	}

	/**
	 * Request a reload. Resolves once the reload has run when the gate is idle;
	 * during a prompt it only records the request — the prompt's epilogue starts it.
	 */
	async requestRefresh(): Promise<void> {
		this.refreshPending = true;
		if (this.activePromptCount > 0) {
			return;
		}
		await this.flushPendingRefresh();
	}

	/** Await any reload currently in flight (shutdown/tests). Never rejects. */
	async whenSettled(): Promise<void> {
		await this.reloadChain;
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
			try {
				await this.reloadSessionResources();
			} catch (error) {
				// The chain is awaited by the next prompt and by detached callers, so a
				// failed reload must never reject it: log and carry the previous resources.
				log.logWarning("Session resource reload failed", errorMessage(error));
			}
		};

		this.reloadChain = this.reloadChain.then(runReload, runReload);
		await this.reloadChain;

		if (this.refreshPending && this.activePromptCount === 0) {
			await this.flushPendingRefresh();
		}
	}
}
