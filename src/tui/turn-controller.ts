/**
 * The TUI run-state machine: one channel, one user, turns serialized while still
 * accepting steer / follow-up / stop mid-turn, two-stage Ctrl-C, and graceful
 * shutdown with a memory flush.
 *
 * Collaborators (runner, frontend, store) are injected so the machine can be
 * unit-tested with fakes and a fake clock. `app.ts` builds the real ones.
 */

import { formatUnknownCommandMessage, slashCommandName } from "../agent/commands.js";
import { renderStatus } from "../agent/status-render.js";
import type { AgentRunner } from "../agent/types.js";
import * as log from "../log.js";
import type { ChannelStore } from "../runtime/store.js";
import { errorMessage } from "../shared/text-utils.js";
import { bold, dim } from "./colors.js";
import { type DispatchDeps, dispatch } from "./commands.js";
import type { Frontend } from "./renderer.js";
import { createTerminalContext, type DeliveryTraits, type TurnInput } from "./terminal-context.js";

const SHUTDOWN_ABORT_WAIT_MS = 5000;
// Cap the exit-time memory flush so a slow/stuck LLM consolidation can't trap
// the user in a non-responsive process. Memory may be partially saved on timeout.
const SHUTDOWN_FLUSH_WAIT_MS = 20_000;

export interface TurnControllerDeps {
	runner: AgentRunner;
	frontend: Frontend;
	store: ChannelStore;
	traits: DeliveryTraits;
	channelId: string;
	userName: string;
	/** Info commands that do not depend on run state. */
	renderHelp: () => string;
	renderUsage: (args: string) => string;
	runEvents: (args: string) => Promise<string>;
	runTasks: (args: string) => Promise<string>;
	/** Static bits the status renderer needs alongside the live run state. */
	statusInfo: { version: string; startedAt: number };
	/** Injectable clock for deterministic Ctrl-C timing in tests. */
	now?: () => number;
}

export class TurnController {
	private readonly deps: TurnControllerDeps;
	private readonly now: () => number;
	private readonly dispatchDeps: DispatchDeps;

	private running = false;
	private currentTaskText: string | undefined;
	private currentTurn: Promise<void> = Promise.resolve();
	private readonly followups: string[] = [];
	private submitChain: Promise<void> = Promise.resolve();
	private exitArmed = false;
	private exiting = false;
	private exitResolve!: () => void;
	private readonly exitPromise = new Promise<void>((resolve) => {
		this.exitResolve = resolve;
	});

	constructor(deps: TurnControllerDeps) {
		this.deps = deps;
		this.now = deps.now ?? Date.now;
		this.dispatchDeps = {
			renderHelp: deps.renderHelp,
			renderUsage: deps.renderUsage,
			runEvents: deps.runEvents,
			runTasks: deps.runTasks,
			renderStatus: () =>
				renderStatus({
					state: { running: this.running, currentTaskText: this.currentTaskText, runner: this.deps.runner },
					version: deps.statusInfo.version,
					uptimeMs: this.now() - deps.statusInfo.startedAt,
				}),
		};
	}

	/** Interactive mode: wire input, run an optional first prompt, resolve on exit. */
	startInteractive(initialPrompt?: string): Promise<void> {
		this.deps.frontend.start({
			onSubmit: (text) => this.submit(text),
			onInterrupt: () => this.handleInterrupt(),
			onEof: () => this.requestExit(),
		});
		this.deps.frontend.showBanner(this.buildWelcome());
		this.updateStatus();
		if (initialPrompt?.trim()) this.submit(initialPrompt);
		return this.exitPromise;
	}

	/**
	 * One-shot mode: run a single prompt (if any) then shut down.
	 *
	 * Routed through the same `dispatch()` as interactive input so built-in
	 * slash commands (`/tasks`, `/events`, `/status`, ...) resolve zero-LLM here
	 * too, instead of falling through to the model as a plain message.
	 */
	async runOnce(prompt?: string): Promise<void> {
		const trimmed = prompt?.trim();
		if (trimmed) {
			await this.processSubmit(trimmed);
			await this.currentTurn;
		}
		await this.shutdown();
	}

	/** Test/observability hook. */
	isRunning(): boolean {
		return this.running;
	}

	submit(text: string): void {
		this.submitChain = this.submitChain
			.then(() => this.processSubmit(text))
			.catch((err) => {
				log.logWarning(`[${this.deps.channelId}] TUI submit failed`, errorMessage(err));
			});
	}

	private async processSubmit(text: string): Promise<void> {
		if (this.exiting) return;
		// Any submitted line disarms a pending "press Ctrl-C again to exit".
		this.exitArmed = false;
		const outcome = await dispatch(text, this.dispatchDeps);
		switch (outcome.kind) {
			case "noop":
				if (outcome.text) this.deps.frontend.showNotice(outcome.text);
				return;
			case "reply":
				this.deps.frontend.showFinal(outcome.text);
				return;
			case "exit":
				this.requestExit();
				return;
			case "stop":
				if (this.running) {
					void this.deps.runner.abort();
					this.deps.frontend.showNotice("Stopping…");
				} else {
					this.deps.frontend.showNotice("Nothing is running.");
				}
				return;
			case "followup":
				this.applyFollowup(outcome.text);
				return;
			case "steer":
				await this.applyText(outcome.text);
				return;
			case "run":
				// Reject an unknown slash command rather than steering/running its raw
				// text. Session commands, skills, and prompt templates pass through.
				if (outcome.text.trim().startsWith("/") && !this.deps.runner.isKnownSlashCommand(outcome.text)) {
					this.deps.frontend.showFinal(formatUnknownCommandMessage(slashCommandName(outcome.text) ?? ""));
					return;
				}
				await this.applyText(outcome.text);
				return;
		}
	}

	/** A plain message or /steer: steer the in-flight turn, else start a fresh one. */
	private async applyText(text: string): Promise<void> {
		if (this.running) {
			try {
				await this.deps.runner.queueSteer(text, this.deps.userName);
				this.deps.frontend.showNotice("Queued as steer.");
				return;
			} catch {
				// The busy window closed between dispatch and here; run it fresh.
			}
		}
		this.beginTurn(text);
	}

	private applyFollowup(text: string): void {
		if (this.running) {
			this.followups.push(text);
			this.deps.frontend.showNotice("Queued as follow-up.");
			return;
		}
		this.beginTurn(text);
	}

	private beginTurn(text: string): void {
		if (this.running || this.exiting) return;
		this.running = true;
		this.currentTaskText = text;
		this.deps.frontend.setBusy(true);
		this.updateStatus();

		this.currentTurn = (async () => {
			const input = this.makeTurnInput(text);
			await this.archiveIncoming(input);
			const ctx = createTerminalContext(input, this.deps.frontend, this.deps.store, this.deps.traits);
			try {
				await this.deps.runner.run(ctx, this.deps.store);
			} catch (err) {
				this.deps.frontend.showNotice(`Run failed: ${errorMessage(err)}`);
			} finally {
				await ctx.close();
				this.running = false;
				this.currentTaskText = undefined;
				this.deps.frontend.setBusy(false);
				this.updateStatus();
			}
		})();

		// The turn is over whether it settled or its finally threw (e.g. a frontend
		// method failing); drain either way and never leak an unhandled rejection.
		void this.currentTurn.then(
			() => this.drainFollowups(),
			(err) => {
				log.logWarning(`[${this.deps.channelId}] TUI turn finalizer failed`, errorMessage(err));
				this.running = false;
				this.drainFollowups();
			},
		);
	}

	private drainFollowups(): void {
		if (this.exiting || this.running) return;
		const next = this.followups.shift();
		if (next !== undefined) this.beginTurn(next);
	}

	private makeTurnInput(text: string): TurnInput {
		return {
			text,
			user: "tui",
			userName: this.deps.userName,
			channel: this.deps.channelId,
			ts: Date.now().toString(),
		};
	}

	private async archiveIncoming(input: TurnInput): Promise<void> {
		try {
			await this.deps.store.logMessage(this.deps.channelId, {
				date: new Date().toISOString(),
				ts: input.ts,
				user: input.user,
				userName: input.userName,
				text: input.text,
				isBot: false,
			});
		} catch (err) {
			log.logWarning(`[${this.deps.channelId}] Failed to archive user message`, errorMessage(err));
		}
	}

	private handleInterrupt(): void {
		if (this.running) {
			void this.deps.runner.abort();
			this.deps.frontend.showNotice("Stopping…");
			return;
		}
		// Idle: first Ctrl-C arms the exit prompt, the next one exits (no time
		// window — armed until the user submits something). Mirrors the Node REPL.
		if (this.exitArmed) {
			this.requestExit();
			return;
		}
		this.exitArmed = true;
		this.deps.frontend.showNotice("Press Ctrl-C again to exit.");
	}

	private requestExit(): void {
		// shutdown() restores the terminal in a finally, so a rejection here means only
		// the memory-flush bookkeeping failed — log it rather than leak an unhandled
		// rejection that could abort the process before exitResolve runs.
		this.shutdown().catch((err) => {
			log.logWarning(`[${this.deps.channelId}] TUI shutdown failed`, errorMessage(err));
			this.exitResolve();
		});
	}

	private buildWelcome(): string {
		let model = "";
		try {
			model = this.deps.runner.getStatusSnapshot().model;
		} catch {
			// Snapshot may be unavailable before the first turn; omit the model.
		}
		const meta = model ? `${this.deps.channelId} · ${model}` : this.deps.channelId;
		return [
			`${bold("pipiclaw")} ${dim("· terminal chat")}`,
			dim(meta),
			dim("Type a message to start. /help for commands."),
		].join("\n");
	}

	private updateStatus(): void {
		try {
			const snapshot = this.deps.runner.getStatusSnapshot();
			let line = snapshot.model;
			if (snapshot.contextTokens !== undefined && snapshot.contextWindow > 0) {
				line += ` · ctx ${((snapshot.contextTokens / snapshot.contextWindow) * 100).toFixed(0)}%`;
			}
			line += this.running ? " · running" : " · idle";
			this.deps.frontend.setStatus(`${this.deps.channelId} · ${line}`);
		} catch {
			this.deps.frontend.setStatus(`${this.deps.channelId} · ${this.running ? "running" : "ready"}`);
		}
	}

	private async shutdown(): Promise<void> {
		if (this.exiting) return;
		this.exiting = true;

		if (this.running) {
			await this.deps.runner.abort().catch(() => {});
			// Never let a rejected turn (e.g. ctx.close() throwing in the turn's finally)
			// escape the race — that would skip frontend.stop() and strand the terminal in
			// raw mode. The turn already logs its own failures.
			await Promise.race([
				this.currentTurn.catch(() => {}),
				new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_ABORT_WAIT_MS)),
			]);
		}

		try {
			// Tear the UI down first so the terminal is restored immediately — the
			// memory flush below can take a moment (LLM consolidation), and a frozen
			// full-screen frame feels like a hang. A short note on stderr explains the
			// pause without polluting stdout (which carries the answer in --print).
			// Guaranteed via finally: a flush failure must not leave the terminal raw.
			this.deps.frontend.stop();
			process.stderr.write("Saving session memory…\n");

			await Promise.race([
				this.deps.runner.flushMemoryForShutdown().catch((err) => {
					log.logWarning(`[${this.deps.channelId}] Failed to flush memory on exit`, errorMessage(err));
				}),
				new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_FLUSH_WAIT_MS)),
			]);
		} finally {
			this.exitResolve();
		}
	}
}
