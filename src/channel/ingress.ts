/**
 * The channel plane's inbound contract (spec 061, D5): the one place a transport hands a message
 * to the runtime. Authorization has already happened by the time a transport calls it.
 */

export interface InboundMessage {
	channelId: string;
	user: string;
	userName?: string;
	/** The group title or the peer's nickname, for the channel index; absent when there is none. */
	channelName?: string;
	/** The user's text; each attachment sits where its `[图片N]` / `[文件N]` marker is. */
	text: string;
	/** Raw attachment bytes. A transport downloads or decodes and checks size; persisting is the runtime's job. */
	attachments?: InboundAttachment[];
	/** The transport's correlation reference; replies to this message carry it back (`PushMessage.ref`). */
	ref?: string;
	ts: string;
	/**
	 * The desks this sender may use; absent means any (an allow-listed DingTalk user, the local
	 * socket). The first entry is the sender's default desk: an unbound channel is bound to it.
	 */
	allowedDesks?: readonly string[];
	context?: import("./turn-context.js").TurnContext;
	/** Runtime-derived execution desk for a saved response continuation. */
	desk?: string;
}

/** `index` is the N of the `[图片N]` / `[文件N]` marker the attachment belongs to. */
export type InboundAttachment =
	| { kind: "image"; index: number; data: Buffer }
	| { kind: "file"; index: number; data: Buffer; fileName: string };

export type IngressResult =
	/** A turn for this message starts now. */
	| { kind: "started" }
	/** It runs after the current turn, as a turn of its own. */
	| { kind: "queued" }
	/** A command or a steer was handled; the reply (if any) went out through `push` with the message's `ref`. */
	| { kind: "replied" }
	| { kind: "rejected"; reason: IngressRejection };

export type IngressRejection =
	| { code: "control_command"; command: "stop" | "steer" | "followup" }
	| { code: "desk_not_allowed"; desk: string }
	| { code: "queue_full" }
	| { code: "request_capacity" }
	| { code: "shutting_down" };

export type SteerResult =
	| { kind: "accepted" }
	| { kind: "rejected"; code: "response_not_active" | "too_many_pending_steers" | "invalid_input" };

/**
 * What `/stop` actually did. Stopping a task step also pauses that task, which the user has to be
 * told: a paused task is not picked up again until `/tasks resume`, so silence would read as "the
 * turn was interrupted" while the whole task has in fact gone quiet.
 */
export interface StopOutcome {
	pausedTaskId?: string;
}

export interface Ingress {
	receive(message: InboundMessage): Promise<IngressResult>;
	/** Isolated generation: no channel binding, transcript archive, or automatic reflection. */
	execute?(message: InboundMessage): Promise<IngressResult>;
	/** Inject `message` into the turn running on `channelId`. */
	steer(channelId: string, message: InboundMessage): Promise<SteerResult>;
	/** The same as `/stop`: the running turn ends and everything queued behind it is dropped. */
	cancel(channelId: string): Promise<StopOutcome>;
	/**
	 * Stop the turn running on `channelId` only if it answers the message that carried `ref`;
	 * whether it did. What is queued behind it, and anything another sender is waiting for, stays.
	 */
	cancelTurn(channelId: string, ref: string): Promise<boolean>;
	/** Drop a message that has not started; whether one with this `ref` was found. */
	dropQueued(channelId: string, ref: string): boolean;
	/**
	 * The transport ended this channel for good (a deleted Web API conversation): nothing more is
	 * kept for it — no binding, no runner, no background scans. `busy` while a turn runs or waits.
	 */
	closeChannel(channelId: string): Promise<"closed" | "busy">;
}
