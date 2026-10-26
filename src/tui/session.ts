/**
 * One terminal conversation as a Web API client (spec 061, D25): a WebSocket carrying
 * `response.create` and `response.steer`, the events drawn by `render.ts`, and — while idle — a
 * poll of the conversation's items so what the server says on its own (a finished background job,
 * a task report) shows up.
 *
 * Ctrl-C and `/stop` close the connection, which the API defines as cancelling what it was
 * running; a fresh one is opened for the next message. This file knows the shapes of the
 * connection and the items API only through `SessionLink`, so tests drive it with a fake.
 */
import { formatFollowupQueued, formatNoRunningTurn, formatSteerQueued, slashCommandName } from "../commands/catalog.js";
import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";
import { bold, dim } from "./colors.js";
import { interpret } from "./commands.js";
import type { Frontend } from "./frontend.js";
import { type DeliveryTraits, EventRenderer, type StreamEvent } from "./render.js";

/** How often an idle terminal asks the server for items it did not start. */
export const TUI_POLL_INTERVAL_MS = 3000;

const CONTROL_STREAM = "control";

export interface Connection {
	send(event: Record<string, unknown>): void;
	close(): void;
}

export interface ConversationItem {
	id: string;
	type: string;
	role?: string;
	phase?: string;
	content?: Array<{ type?: string; text?: string }>;
}

/** Everything the session needs from the server. */
export interface SessionLink {
	conversationId: string;
	/** Open a connection; `onEvent` gets every server event, `onClose` fires when it ends. */
	connect(onEvent: (event: StreamEvent & Record<string, unknown>) => void, onClose: () => void): Connection;
	/** Items after `after` (all of them when absent), oldest first. */
	listItems(after: string | undefined): Promise<ConversationItem[]>;
}

export interface SessionOptions {
	link: SessionLink;
	frontend: Frontend;
	traits: DeliveryTraits;
	/** Shown in the status line and welcome banner. */
	label: string;
	/** What the server said while the conversation was being set up (e.g. `/desk bind`'s reply). */
	notices?: string[];
	pollIntervalMs?: number;
}

export class TuiSession {
	private readonly renderer: EventRenderer;
	private connection: Connection | undefined;
	/**
	 * Which connection the callbacks belong to. Closing a connection is asynchronous, so a stale
	 * connection's last events and its `close` can arrive after a new one is already running.
	 */
	private connectionId = 0;
	/** Items the stream already showed, so the items poll does not show them a second time. */
	private readonly shown = new Set<string>();
	/** Creates sent but not yet announced by the server. */
	private unacked = 0;
	/** Responses running now. */
	private active = 0;
	/** Steers the server accepted whose successor response has not been announced yet. */
	private awaitingSuccessors = 0;
	private readonly followups: string[] = [];
	private cursor: string | undefined;
	private polling = false;
	private generation = 0;
	private exitArmed = false;
	private exiting = false;
	private timer: NodeJS.Timeout | undefined;
	private exitResolve!: () => void;
	private readonly exited = new Promise<void>((resolve) => {
		this.exitResolve = resolve;
	});

	constructor(private readonly options: SessionOptions) {
		this.renderer = new EventRenderer(options.frontend, options.traits);
	}

	get busy(): boolean {
		return this.unacked > 0 || this.active > 0 || this.awaitingSuccessors > 0;
	}

	/** Interactive mode: wire input, run an optional first prompt, resolve on exit. */
	async startInteractive(initialPrompt?: string): Promise<void> {
		const { frontend, label } = this.options;
		this.cursor = await this.lastItemId();
		frontend.start({
			onSubmit: (text) => this.submit(text),
			onInterrupt: () => this.interrupt(),
			onEof: () => this.exit(),
		});
		frontend.showBanner(
			[`${bold("pipiclaw")} ${dim("· 终端对话")}`, dim(label), dim("输入消息开始；/help 查看命令。")].join("\n"),
		);
		for (const notice of this.options.notices ?? []) frontend.showFinal(notice);
		this.updateStatus();
		const poll = this.options.pollIntervalMs ?? TUI_POLL_INTERVAL_MS;
		this.timer = setInterval(() => void this.pollItems(), poll);
		this.timer.unref?.();
		if (initialPrompt?.trim()) this.submit(initialPrompt);
		return this.exited;
	}

	submit(text: string): void {
		if (this.exiting) return;
		// Any submitted line disarms a pending "press Ctrl-C again to exit".
		this.exitArmed = false;
		const intent = interpret(text);
		switch (intent.kind) {
			case "noop":
				if (intent.hint) this.options.frontend.showNotice(intent.hint);
				return;
			case "exit":
				this.exit();
				return;
			case "stop":
				if (this.busy) this.stop();
				else this.options.frontend.showNotice(formatNoRunningTurn("stop"));
				return;
			case "followup":
				if (this.busy) {
					this.followups.push(intent.text);
					this.options.frontend.showNotice(formatFollowupQueued());
				} else {
					this.create(intent.text);
				}
				return;
			case "steer":
				if (this.busy) this.steer(intent.text);
				else this.create(intent.text);
				return;
			case "send":
				// While a turn runs, a message steers it; a command goes to the server, which says
				// whether it may run now.
				if (this.busy && slashCommandName(intent.text) === null) this.steer(intent.text);
				else this.create(intent.text);
				return;
		}
	}

	// ---- sending ---------------------------------------------------------------------------

	private ensureConnection(): Connection {
		if (!this.connection) {
			const id = ++this.connectionId;
			this.connection = this.options.link.connect(
				(event) => {
					if (id === this.connectionId) this.onEvent(event);
				},
				() => {
					if (id === this.connectionId) this.onClose();
				},
			);
		}
		return this.connection;
	}

	private create(text: string): void {
		this.generation++;
		this.unacked++;
		this.ensureConnection().send({
			type: "response.create",
			model: "pipiclaw",
			conversation: this.options.link.conversationId,
			input: text,
			// The connection runs the requests of one stream in order, so a command typed while a turn
			// runs gets its own stream: the server decides whether it may run now, without waiting.
			...(slashCommandName(text) !== null ? { stream_id: CONTROL_STREAM } : {}),
		});
		this.afterStateChange();
	}

	private lastSteerTarget: string | undefined;

	private steer(text: string): void {
		const target = this.lastSteerTarget;
		if (!target) {
			// The running response has not been announced yet: it cannot be steered, so wait for it.
			this.followups.push(text);
			this.options.frontend.showNotice(formatFollowupQueued());
			return;
		}
		this.ensureConnection().send({ type: "response.steer", previous_response_id: target, input: text });
	}

	private stop(): void {
		const connection = this.connection;
		this.connection = undefined;
		this.connectionId++;
		this.resetCounters();
		this.followups.length = 0;
		connection?.close();
		this.options.frontend.showNotice("已停止。");
		this.afterStateChange();
	}

	private resetCounters(): void {
		this.unacked = 0;
		this.active = 0;
		this.awaitingSuccessors = 0;
		this.lastSteerTarget = undefined;
	}

	// ---- events ----------------------------------------------------------------------------

	private onEvent(event: StreamEvent & Record<string, unknown>): void {
		this.renderer.handle(event);
		if (event.type === "response.output_item.done" && event.item?.id) this.shown.add(event.item.id);
		switch (event.type) {
			case "response.created": {
				const id = (event.response as { id?: string } | undefined)?.id;
				if (this.awaitingSuccessors > 0) this.awaitingSuccessors--;
				else if (this.unacked > 0) this.unacked--;
				this.active++;
				this.lastSteerTarget = id;
				break;
			}
			case "response.steer.accepted":
				this.awaitingSuccessors++;
				this.options.frontend.showNotice(formatSteerQueued(false));
				break;
			case "response.steer.failed":
				this.options.frontend.showNotice(
					`${(event.error as { message?: string } | undefined)?.message ?? "无法插入这条消息。"}`,
				);
				break;
			case "response.completed":
			case "response.failed":
			case "response.incomplete":
				if (this.active > 0) this.active--;
				if ((event.response as { id?: string } | undefined)?.id === this.lastSteerTarget) {
					this.lastSteerTarget = undefined;
				}
				break;
			case "error":
				// A create the server refused was never announced.
				if (this.unacked > 0) this.unacked--;
				break;
		}
		this.afterStateChange();
	}

	private onClose(): void {
		// The server ended the connection (or it dropped): whatever was running is over.
		this.connection = undefined;
		if (this.busy) this.options.frontend.showNotice("连接已断开。");
		this.resetCounters();
		this.afterStateChange();
	}

	private afterStateChange(): void {
		const { frontend } = this.options;
		frontend.setBusy(this.busy);
		this.updateStatus();
		if (!this.busy && !this.exiting) {
			const next = this.followups.shift();
			if (next !== undefined) {
				this.create(next);
				return;
			}
			void this.pollItems();
		}
	}

	// ---- items the server produced on its own ----------------------------------------------

	private async lastItemId(): Promise<string | undefined> {
		try {
			return (await this.options.link.listItems(undefined)).at(-1)?.id;
		} catch (error) {
			log.logWarn("tui.items.failed", "Could not read the conversation's items", { reason: errorMessage(error) });
			return undefined;
		}
	}

	private async pollItems(): Promise<void> {
		if (this.polling || this.busy || this.exiting) return;
		this.polling = true;
		const generation = this.generation;
		try {
			const items = await this.options.link.listItems(this.cursor);
			// A message sent meanwhile owns whatever arrived: it is shown by its own stream.
			if (generation !== this.generation || this.busy) return;
			for (const item of items) {
				this.cursor = item.id;
				// What this terminal's own responses said was drawn by their streams.
				if (this.shown.delete(item.id)) continue;
				if (item.type === "message" && item.role === "assistant" && item.phase !== "commentary") {
					const text = (item.content ?? []).map((part) => part.text ?? "").join("");
					if (text.trim()) this.options.frontend.showFinal(text);
				}
			}
		} catch (error) {
			log.logWarn("tui.poll.failed", "Polling the conversation failed", { reason: errorMessage(error) });
		} finally {
			this.polling = false;
		}
	}

	// ---- Ctrl-C and exit -------------------------------------------------------------------

	private interrupt(): void {
		if (this.busy) {
			this.stop();
			return;
		}
		// Idle: the first Ctrl-C arms the exit prompt, the next one exits (no time window — armed
		// until something is submitted). Mirrors the Node REPL.
		if (this.exitArmed) {
			this.exit();
			return;
		}
		this.exitArmed = true;
		this.options.frontend.showNotice("再按一次 Ctrl-C 退出。");
	}

	exit(): void {
		if (this.exiting) return;
		this.exiting = true;
		if (this.timer) clearInterval(this.timer);
		const connection = this.connection;
		this.connection = undefined;
		this.connectionId++;
		connection?.close();
		this.options.frontend.stop();
		this.exitResolve();
	}

	private updateStatus(): void {
		this.options.frontend.setStatus(`${this.options.label} · ${this.busy ? "运行中" : "空闲"}`);
	}
}
