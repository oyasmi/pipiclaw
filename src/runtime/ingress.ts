/**
 * The runtime's inbound pipeline (spec 061, D5/D6) — the one place that decides what a message
 * *means*. A transport authorizes and normalizes, then calls `receive`; from there binding,
 * commands, busy handling, queueing, cancellation and steering are all decided here, the same for
 * every transport. It also takes the synthetic wakes (`enqueueEvent`) that durable dispatch and
 * the event watchers hand in.
 */
import type { AgentRunner } from "../agent/types.js";
import type { ChannelEvent, ChannelEventSink, HumanEvent, WakeEvent } from "../channel/channel-event.js";
import type { InboundMessage, Ingress, IngressResult, SteerResult, StopOutcome } from "../channel/ingress.js";
import type { Transport } from "../channel/transport.js";
import {
	formatBusyHint,
	parseBuiltInCommand,
	type RuntimeCommandName,
	renderBuiltInHelp,
	slashCommandName,
} from "../commands/catalog.js";
import { DEFAULT_DESK } from "../desk/paths.js";
import * as log from "../log.js";
import { ChannelQueue } from "./channel-queue.js";
import { admitsSyntheticEvent, resolvedDesk } from "./desk-runtime.js";
import { resolveInboundAttachments } from "./inbound-images.js";
import { createBusyHandlers } from "./ingress-busy.js";
import { createCommandHandlers } from "./ingress-commands.js";
import type { IngressDeps } from "./ingress-deps.js";
import { createEventTurnRunner, isSyntheticEvent } from "./turn-run.js";

/** Pending turns a channel may hold when its transport sends plain messages one turn each (`whenBusy: "queue"`). */
export const MAX_QUEUED_TURNS_PER_CHANNEL = 8;
// Bounds the turns queued for a channel whose busy messages steer or follow up (user messages and
// follow-up requeues). Without a limit, a flooded busy channel grows this queue without bound —
// each item still runs a full serialized turn, so an unbounded queue means unbounded backlog time
// and unbounded memory, not just a slow channel.
const USER_MESSAGE_QUEUE_LIMIT = 20;
const EVENT_QUEUE_LIMIT = 5;

export interface IngressService extends Ingress, ChannelEventSink {
	/** Stop taking work: every channel queue drops what it has not started. */
	stop(): void;
	/** Test seam (spec 048): no message is being handed over and no channel queue has work. */
	isIdle(): boolean;
	isRunning(channelId: string): boolean;
	/** The stateless report commands, for the e2e harness and the TUI. */
	runRuntimeCommand(event: ChannelEvent, name: RuntimeCommandName, args: string): Promise<string>;
	/** Run one turn for `event` now, bypassing the queue (test seam). */
	handleEvent(event: ChannelEvent): Promise<void>;
	/** Route a human message whose attachments are already settled, as `receive` would (test seam). */
	routeEvent(event: HumanEvent): Promise<IngressResult>;
	/** Reserve the turn for `event` the way the queue does just before it runs (test seam). */
	reserveEvent(event: ChannelEvent): void;
}

export function createIngress(deps: IngressDeps): IngressService {
	const { transports, channelRunners, activeTasks, getRunner, resolveChannel, isShuttingDown, channelIndex } = deps;

	const queues = new Map<string, ChannelQueue>();
	let stopped = false;
	let pendingReceives = 0;
	const reservedTurns = new WeakSet<ChannelEvent>();

	const getQueue = (channelId: string): ChannelQueue => {
		let queue = queues.get(channelId);
		if (!queue) {
			queue = new ChannelQueue();
			queues.set(channelId, queue);
		}
		return queue;
	};
	/** Drop what has not started on `channelId`, telling its transport which named messages went. */
	const clearPending = (channelId: string): number => {
		const dropped = queues.get(channelId)?.clearPending();
		if (dropped && dropped.refs.length > 0) transports.forChannel(channelId)?.dropped?.(channelId, dropped.refs);
		return dropped?.count ?? 0;
	};
	/**
	 * Detach all queued work from the previous session generation. The in-flight callback may
	 * still unwind on its old queue object, while subsequent messages get a fresh queue.
	 */
	const resetChannelQueue = (channelId: string): number => {
		const dropped = clearPending(channelId);
		queues.get(channelId)?.stop();
		queues.delete(channelId);
		return dropped;
	};

	const isRunning = (channelId: string): boolean => channelRunners.get(channelId)?.isBusy() ?? false;
	const busy = createBusyHandlers(deps, { clearPending, reset: resetChannelQueue });
	const commands = createCommandHandlers(deps, resetChannelQueue);
	const runEventTurn = createEventTurnRunner({
		options: deps.options,
		transports,
		store: deps.store,
		activeTasks,
		archiveIncomingMessage: deps.archiveIncomingMessage,
		getRunner,
		resolveChannel,
		isCurrentRunner: (runner: AgentRunner) => channelRunners.get(runner.conversation.channelId) === runner,
		reservedTurns,
		isShuttingDown,
		getDurableDispatch: deps.getDurableDispatch,
		getJobs: deps.getJobs,
		getRuns: deps.getRuns,
		getTaskDriver: deps.getTaskDriver,
		runRuntimeCommand: commands.runRuntimeCommand,
	});

	/**
	 * Synchronously reserve an inbound turn before the queued async body yields: busy state shows
	 * up at once. Only a turn admission will accept gets reserved; `runEventTurn` releases it if
	 * it refuses.
	 */
	function reserveEvent(event: ChannelEvent): void {
		const resolution = resolveChannel(event.channelId);
		if (resolution.kind !== "bound") return;
		if (isSyntheticEvent(event) && !admitsSyntheticEvent(resolution, event)) return;
		// `/desk` runs outside any turn: `/desk bind` must see this channel idle (D5 step 1).
		if (!isSyntheticEvent(event) && parseBuiltInCommand(event.text)?.name === "desk") return;
		const runner = getRunner(event.channelId);
		if (!runner) return;
		runner.beginTurn(event.text);
		reservedTurns.add(event);
	}

	/** Queue `event` as a turn of its own. */
	function enqueueTurn(event: ChannelEvent, limit: number, onFull: () => void): IngressResult {
		const queue = getQueue(event.channelId);
		const waiting = !queue.isIdle() || isRunning(event.channelId);
		if (queue.size() >= limit) {
			onFull();
			return { kind: "rejected", reason: { code: "queue_full" } };
		}
		queue.enqueue(
			async () => {
				service.reserveEvent(event);
				await service.handleEvent(event);
			},
			event.source === "human" ? event.ref : undefined,
		);
		return { kind: waiting ? "queued" : "started" };
	}

	function enqueueMessage(event: HumanEvent, transport: Transport, textOverride?: string): IngressResult {
		const queued = textOverride === undefined ? event : { ...event, text: textOverride };
		if (transport.policy.whenBusy === "queue") {
			return enqueueTurn(queued, MAX_QUEUED_TURNS_PER_CHANNEL, () => {
				log.logWarn("ingress.queue.full", "Message rejected: channel queue full", {
					channelId: event.channelId,
					fields: { limit: MAX_QUEUED_TURNS_PER_CHANNEL },
				});
			});
		}
		return enqueueTurn(queued, USER_MESSAGE_QUEUE_LIMIT, () => {
			log.logWarn("ingress.queue.full", "Message discarded: channel queue full", {
				channelId: event.channelId,
				fields: { limit: USER_MESSAGE_QUEUE_LIMIT, preview: queued.text.substring(0, 50) },
			});
			void deps
				.pushTo(event.channelId, {
					text: `⚠️ 消息积压过多（超过 ${USER_MESSAGE_QUEUE_LIMIT} 条待处理），本条消息已丢弃，请稍后重试。`,
				})
				.catch(() => undefined);
		});
	}

	const reply = (event: HumanEvent, text: string, opts?: { title?: string; markdown?: boolean }): Promise<boolean> =>
		deps.pushTo(event.channelId, { text, ...opts, ...(event.ref !== undefined ? { ref: event.ref } : {}) });

	async function replyToCommand(event: HumanEvent, name: RuntimeCommandName, args: string): Promise<void> {
		const response = await commands.runRuntimeCommand(event, name, args);
		const delivered = await reply(event, response, { title: `/${name}`, markdown: true });
		if (!delivered) {
			log.logWarn("delivery.command_reply.failed", "Command reply delivery failed", {
				channelId: event.channelId,
				fields: { command: name, chars: response.length },
			});
		}
	}

	/** A message arrived while the channel is running a turn. */
	async function routeBusy(event: HumanEvent, transport: Transport): Promise<IngressResult> {
		const { channelId } = event;
		const content = event.text;
		const builtIn = parseBuiltInCommand(content);

		// All built-in commands are usable while a turn streams.
		if (builtIn) {
			switch (builtIn.name) {
				case "help":
					await reply(event, renderBuiltInHelp(builtIn.args), { title: "/help", markdown: true });
					return { kind: "replied" };
				case "stop": {
					const outcome = await busy.handleStop(channelId);
					await reply(
						event,
						outcome.pausedTaskId
							? `已停止当前回合。任务 \`${outcome.pausedTaskId}\` 已暂停，用 \`/tasks resume ${outcome.pausedTaskId}\` 继续。`
							: "已停止当前回合。",
						{ title: "/stop", markdown: true },
					);
					return { kind: "replied" };
				}
				case "steer":
				case "followup": {
					const outcome = await busy.handleBusyMessage(
						event,
						builtIn.name === "steer" ? "steer" : "followUp",
						builtIn.args,
					);
					return outcome.kind === "requeue" ? enqueueMessage(event, transport, outcome.text) : { kind: "replied" };
				}
				default:
					// Every remaining name is a stateless report (events/tasks/status/usage/context/
					// subagents/skills), narrowed to RuntimeCommandName by the four cases above. Busy has
					// no retry semantics, so `/context` is answered here like the rest instead of the
					// runner-handled path idle uses for it (see IDLE_RUNTIME_COMMAND_NAMES in turn-run).
					await replyToCommand(event, builtIn.name, builtIn.args);
					return { kind: "replied" };
			}
		}

		// Other session commands (/model, /compact, …) and unknown slash commands cannot run
		// mid-turn: they would need the idle session layer.
		if (content.trim().startsWith("/")) {
			await reply(event, formatBusyHint());
			return { kind: "replied" };
		}

		const { whenBusy } = transport.policy;
		if (whenBusy === "queue") {
			return enqueueMessage(event, transport);
		}
		const outcome = await busy.handleBusyMessage(event, whenBusy, content);
		return outcome.kind === "requeue" ? enqueueMessage(event, transport, outcome.text) : { kind: "replied" };
	}

	/** Route one authorized, bound, attachment-settled human message (D6 steps 3–6). */
	async function route(event: HumanEvent, transport: Transport): Promise<IngressResult> {
		const builtIn = parseBuiltInCommand(event.text);

		// `/new` is an emergency boundary as well as a session command. Route it before busy
		// checking and before the old channel queue, so a wedged compaction/provider request
		// cannot prevent recovery.
		if (slashCommandName(event.text) === "new") {
			await commands.handleNewSession(event);
			return { kind: "replied" };
		}

		if (
			!transport.policy.textControlCommands &&
			builtIn &&
			(builtIn.name === "stop" || builtIn.name === "steer" || builtIn.name === "followup")
		) {
			return { kind: "rejected", reason: { code: "control_command", command: builtIn.name } };
		}

		if (isRunning(event.channelId)) {
			return routeBusy(event, transport);
		}
		return enqueueMessage(event, transport);
	}

	/** D6 steps 1–2 plus attachment settling: everything before a message can be routed. */
	async function admit(message: InboundMessage): Promise<{ event: HumanEvent; transport: Transport } | IngressResult> {
		if (isShuttingDown() || stopped) return { kind: "rejected", reason: { code: "shutting_down" } };
		const transport = transports.forChannel(message.channelId);
		if (!transport) {
			throw new Error(`No transport hosts channel ${message.channelId}`);
		}
		// The one place a real person's message is seen before command/busy routing splits the path,
		// so the channel index counts every human message and no synthetic wake.
		channelIndex.note({ channelId: message.channelId, name: message.channelName, at: Date.now() });
		await deps.ensureBinding(message.channelId, message.allowedDesks?.[0] ?? DEFAULT_DESK);
		const resolution = resolveChannel(message.channelId);
		const desk = resolvedDesk(resolution);
		if (message.allowedDesks && desk !== undefined && !message.allowedDesks.includes(desk)) {
			return { kind: "rejected", reason: { code: "desk_not_allowed", desk } };
		}

		let text = message.text;
		let images: HumanEvent["images"];
		if (message.attachments && message.attachments.length > 0) {
			const settled = await resolveInboundAttachments({
				deskDir: resolution.kind === "bound" ? resolution.conversation.deskDir : undefined,
				channelId: message.channelId,
				text,
				attachments: message.attachments,
			});
			text = settled.text;
			if (settled.images.length > 0) images = settled.images;
		}
		const event: HumanEvent = {
			source: "human",
			channelId: message.channelId,
			ts: message.ts,
			user: message.user,
			userName: message.userName ?? message.user,
			text,
			...(message.channelName ? { channelName: message.channelName } : {}),
			...(images ? { images } : {}),
			...(message.ref !== undefined ? { ref: message.ref } : {}),
		};
		return { event, transport };
	}

	const service: IngressService = {
		async receive(message: InboundMessage): Promise<IngressResult> {
			pendingReceives++;
			try {
				const admitted = await admit(message);
				if ("kind" in admitted) return admitted;
				return await route(admitted.event, admitted.transport);
			} finally {
				pendingReceives--;
			}
		},

		async steer(channelId: string, message: InboundMessage): Promise<SteerResult> {
			pendingReceives++;
			try {
				const admitted = await admit({ ...message, channelId });
				if ("kind" in admitted) return { kind: "rejected", code: "response_not_active" };
				const { event, transport } = admitted;
				if (!event.text.trim() && !event.images) return { kind: "rejected", code: "invalid_input" };
				const outcome = await busy.handleBusyMessage(event, "steer", event.text, true);
				if (outcome.kind === "steered") return { kind: "accepted" };
				if (outcome.kind === "requeue") {
					// The turn ended before the message could join it: it runs next, as a turn of its own.
					const queued = enqueueMessage(event, transport, outcome.text);
					return queued.kind === "rejected"
						? { kind: "rejected", code: "too_many_pending_steers" }
						: { kind: "accepted" };
				}
				return { kind: "rejected", code: "response_not_active" };
			} finally {
				pendingReceives--;
			}
		},

		cancel(channelId: string): Promise<StopOutcome> {
			return busy.handleStop(channelId);
		},

		dropQueued(channelId: string, ref: string): boolean {
			return queues.get(channelId)?.removeByRef(ref) ?? false;
		},

		enqueueEvent(event: WakeEvent): boolean {
			if (stopped) return false;
			const queue = getQueue(event.channelId);
			if (queue.size() >= EVENT_QUEUE_LIMIT) {
				log.logEvent("warn", "runtime.channel_queue.full", "Discarding incoming event", {
					ctx: { channelId: event.channelId, userName: event.producer },
					fields: { messageLength: event.text.length },
				});
				return false;
			}
			log.logEvent("debug", "runtime.channel_queue.enqueued", "Incoming event queued", {
				ctx: { channelId: event.channelId, userName: event.producer },
				fields: { messageLength: event.text.length },
			});
			queue.enqueue(async () => {
				service.reserveEvent(event);
				await service.handleEvent(event);
			});
			return true;
		},

		stop(): void {
			stopped = true;
			for (const queue of queues.values()) {
				queue.stop();
			}
		},

		isIdle(): boolean {
			if (pendingReceives > 0) return false;
			for (const queue of queues.values()) {
				if (!queue.isIdle()) return false;
			}
			return true;
		},

		async routeEvent(event: HumanEvent): Promise<IngressResult> {
			const transport = transports.forChannel(event.channelId);
			if (!transport) throw new Error(`No transport hosts channel ${event.channelId}`);
			await deps.ensureBinding(event.channelId, DEFAULT_DESK);
			return route(event, transport);
		},

		isRunning,
		runRuntimeCommand: commands.runRuntimeCommand,
		handleEvent: runEventTurn,
		reserveEvent,
	};
	return service;
}
