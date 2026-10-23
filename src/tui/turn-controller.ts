/**
 * The TUI run-state machine: one channel, one user, turns serialized while still
 * accepting steer / follow-up / stop mid-turn, two-stage Ctrl-C, and graceful
 * shutdown with a memory flush.
 *
 * Collaborators (runner, frontend, store) are injected so the machine can be
 * unit-tested with fakes and a fake clock. `app.ts` builds the real ones.
 */

import { forceEndStuckTurnAfterStop } from "../agent/stop-watchdog.js";
import type { AgentRunner } from "../agent/types.js";
import { createFreshActiveSession } from "../channel/active-session-store.js";
import type { ChannelStore } from "../channel/store.js";
import {
	formatBusyHint,
	formatFollowupQueued,
	formatNewSessionReply,
	formatNoRunningTurn,
	formatSteerQueued,
	formatUnknownCommandMessage,
	isSessionCommandName,
	slashCommandName,
} from "../commands/catalog.js";
import * as log from "../log.js";
import { formatLocalTime } from "../shared/local-time.js";
import { errorMessage } from "../shared/text-utils.js";
import { bold, dim } from "./colors.js";
import { type DispatchDeps, dispatch } from "./commands.js";
import type { Frontend } from "./frontend.js";
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
	renderHelp: (args?: string) => string;
	runReport: DispatchDeps["runReport"];
	/** The app owns the runner cache; replacement preserves its conversation/session reference. */
	replaceRunner: () => AgentRunner;
}

export class TurnController {
	private readonly deps: TurnControllerDeps;
	private readonly dispatchDeps: DispatchDeps;

	private currentTurn: Promise<void> = Promise.resolve();
	private readonly followups: string[] = [];
	private submitChain: Promise<void> = Promise.resolve();
	private resetChain: Promise<void> = Promise.resolve();
	private exitArmed = false;
	private exiting = false;
	private stopping: AgentRunner | undefined;
	private exitResolve!: () => void;
	private readonly exitPromise = new Promise<void>((resolve) => {
		this.exitResolve = resolve;
	});

	constructor(deps: TurnControllerDeps) {
		this.deps = deps;
		this.dispatchDeps = { renderHelp: deps.renderHelp, runReport: deps.runReport };
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

	submit(text: string): void {
		if (["stop", "new", "exit", "quit"].includes(slashCommandName(text) ?? "")) {
			void this.processSubmit(text).catch((error: unknown) => {
				this.deps.frontend.showNotice(`操作失败：${errorMessage(error)}`);
			});
			return;
		}
		this.submitChain = this.submitChain
			.then(() => this.processSubmit(text))
			.catch((err) => {
				log.logWarn("tui.submit.failed", "Submit failed", {
					channelId: this.deps.channelId,
					reason: errorMessage(err),
				});
			});
	}

	private async processSubmit(text: string): Promise<void> {
		if (this.exiting) return;
		if (!["new", "stop", "exit", "quit"].includes(slashCommandName(text) ?? "")) await this.resetChain;
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
				if (this.deps.runner.isBusy()) {
					this.stopTurn();
				} else {
					this.deps.frontend.showNotice(formatNoRunningTurn("stop"));
				}
				return;
			case "followup":
				this.applyFollowup(outcome.text);
				return;
			case "steer":
				await this.applyText(outcome.text);
				return;
			case "run": {
				if (slashCommandName(outcome.text) === "new") {
					await this.newSession();
					return;
				}
				// Reject an unknown slash command rather than steering/running its raw
				// text. Session commands, skills, and prompt templates pass through.
				const name = outcome.text.trim().startsWith("/") ? slashCommandName(outcome.text) : null;
				if (name && !this.deps.runner.isKnownSlashCommand(outcome.text)) {
					this.deps.frontend.showFinal(formatUnknownCommandMessage(name));
					return;
				}
				// Session commands (`/model`, `/compact`, …) run inside the SDK command extension
				// and need the idle session layer — mid-turn they must be rejected outright, not
				// steered into the running turn as literal text (review 2026-08-24 §1.6; matches
				// the DingTalk busy refusal in dingtalk.ts).
				if (name && isSessionCommandName(name) && this.deps.runner.isBusy()) {
					this.deps.frontend.showFinal(formatBusyHint());
					return;
				}
				await this.applyText(outcome.text);
				return;
			}
		}
	}

	/** A plain message or /steer: steer the in-flight turn, else start a fresh one. */
	private async applyText(text: string): Promise<void> {
		const runner = this.deps.runner;
		if (runner.isBusy()) {
			if (this.deps.runner.interruptCompaction()) {
				this.followups.push(text);
				return;
			}
			try {
				await runner.queueSteer(text, this.deps.userName);
				if (this.deps.runner !== runner) return;
				this.deps.frontend.showNotice(formatSteerQueued(false));
				return;
			} catch {
				if (this.deps.runner !== runner) return;
				// The busy window closed between dispatch and here; run it fresh.
			}
		}
		this.beginTurn(text);
	}

	private applyFollowup(text: string): void {
		if (this.deps.runner.isBusy()) {
			this.followups.push(text);
			this.deps.frontend.showNotice(formatFollowupQueued());
			return;
		}
		this.beginTurn(text);
	}

	private beginTurn(text: string): void {
		if (this.deps.runner.isBusy() || this.exiting) return;
		// Capture this generation: late cleanup must not touch its replacement.
		const runner = this.deps.runner;
		runner.beginTurn(text);
		this.deps.frontend.setBusy(true);
		this.updateStatus();

		this.currentTurn = (async () => {
			const input = this.makeTurnInput(text);
			await this.archiveIncoming(input);
			if (this.deps.runner !== runner) return;
			const ctx = createTerminalContext(input, this.deps.frontend, this.deps.store, this.deps.traits);
			try {
				await runner.run(ctx, this.deps.store);
			} catch (err) {
				this.deps.frontend.showNotice(`处理失败：${errorMessage(err)}`);
			} finally {
				await ctx.close();
				runner.endTurn();
				if (this.deps.runner === runner) {
					this.deps.frontend.setBusy(false);
					this.updateStatus();
				}
			}
		})();

		// The turn is over whether it settled or its finally threw (e.g. a frontend
		// method failing); drain either way and never leak an unhandled rejection.
		void this.currentTurn.then(
			() => {
				if (this.deps.runner === runner) this.drainFollowups();
			},
			(err) => {
				log.logWarn("tui.turn.finalizer_failed", "Turn finalizer failed", {
					channelId: this.deps.channelId,
					reason: errorMessage(err),
				});
				runner.endTurn();
				if (this.deps.runner === runner) this.drainFollowups();
			},
		);
	}

	private drainFollowups(): void {
		if (this.exiting || this.deps.runner.isBusy()) return;
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
				date: formatLocalTime(),
				ts: input.ts,
				user: input.user,
				userName: input.userName,
				text: input.text,
				isBot: false,
			});
		} catch (err) {
			log.logWarn("channel.archive.write_failed", "User message archive failed", {
				channelId: this.deps.channelId,
				reason: errorMessage(err),
			});
		}
	}

	private handleInterrupt(): void {
		if (this.deps.runner.isBusy()) {
			this.stopTurn();
			return;
		}
		// Idle: first Ctrl-C arms the exit prompt, the next one exits (no time
		// window — armed until the user submits something). Mirrors the Node REPL.
		if (this.exitArmed) {
			this.requestExit();
			return;
		}
		this.exitArmed = true;
		this.deps.frontend.showNotice("再按一次 Ctrl-C 退出。");
	}

	private stopTurn(): void {
		const runner = this.deps.runner;
		runner.requestStop();
		this.followups.length = 0;
		void runner.abort().catch(() => undefined);
		this.deps.frontend.showNotice("正在停止…");
		if (this.stopping === runner) return;
		this.stopping = runner;
		void forceEndStuckTurnAfterStop({
			channelId: this.deps.channelId,
			runner,
			isCurrent: () => this.deps.runner === runner,
			recover: () => {
				runner.retireForRecovery();
				this.deps.runner = this.deps.replaceRunner();
				this.currentTurn = Promise.resolve();
				this.submitChain = Promise.resolve();
				this.deps.frontend.setBusy(false);
				this.updateStatus();
			},
			notify: async (text) => this.deps.frontend.showNotice(text),
		})
			.catch((error: unknown) => {
				log.logWarn("tui.turn.recovery_failed", "Turn recovery failed", { reason: errorMessage(error) });
			})
			.finally(() => {
				if (this.stopping === runner) this.stopping = undefined;
			});
	}

	private async newSession(): Promise<void> {
		const reset = this.resetChain.then(() => this.commitNewSession());
		this.resetChain = reset.catch(() => undefined);
		await reset;
	}

	private async commitNewSession(): Promise<void> {
		const runner = this.deps.runner;
		const conversation = runner.conversation;
		const result = await createFreshActiveSession(conversation.conversationDir, conversation.cwd);
		runner.retireForNewSession();
		this.followups.length = 0;
		this.deps.runner = this.deps.replaceRunner();
		this.currentTurn = Promise.resolve();
		this.submitChain = Promise.resolve();
		this.deps.frontend.setBusy(false);
		this.deps.frontend.showFinal(formatNewSessionReply(result.sessionId));
		this.updateStatus();
	}

	private requestExit(): void {
		// shutdown() restores the terminal in a finally, so a rejection here means only
		// the memory-flush bookkeeping failed — log it rather than leak an unhandled
		// rejection that could abort the process before exitResolve runs.
		this.shutdown().catch((err) => {
			log.logWarn("tui.shutdown.failed", "Shutdown failed", {
				channelId: this.deps.channelId,
				reason: errorMessage(err),
			});
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
		return [`${bold("pipiclaw")} ${dim("· 终端对话")}`, dim(meta), dim("输入消息开始；/help 查看命令。")].join("\n");
	}

	/** One word per state; `idle` and `ready` used to name the same one. */
	private runStateLabel(): string {
		return this.deps.runner.isBusy() ? "运行中" : "空闲";
	}

	private updateStatus(): void {
		try {
			const snapshot = this.deps.runner.getStatusSnapshot();
			let line = snapshot.model;
			if (snapshot.contextTokens !== undefined && snapshot.contextWindow > 0) {
				line += ` · 上下文 ${((snapshot.contextTokens / snapshot.contextWindow) * 100).toFixed(0)}%`;
			}
			line += ` · ${this.runStateLabel()}`;
			this.deps.frontend.setStatus(`${this.deps.channelId} · ${line}`);
		} catch {
			this.deps.frontend.setStatus(`${this.deps.channelId} · ${this.runStateLabel()}`);
		}
	}

	private async shutdown(): Promise<void> {
		if (this.exiting) return;
		this.exiting = true;

		if (this.deps.runner.isBusy()) {
			this.deps.runner.requestStop();
			void this.deps.runner.abort().catch(() => {});
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
			process.stderr.write("正在保存会话记忆…\n");

			await Promise.race([
				this.deps.runner.flushMemoryForShutdown().catch((err) => {
					log.logWarn("memory.flush.failed", "Memory flush on exit failed", {
						channelId: this.deps.channelId,
						reason: errorMessage(err),
					});
				}),
				new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_FLUSH_WAIT_MS)),
			]);
		} finally {
			this.exitResolve();
		}
	}
}
