/**
 * Scheduled-event shapes: the on-disk definition, history records and the injected callbacks.
 * Types only, shared by validation, parsing and the watcher without forming an import cycle.
 */
import type { ChannelEvent } from "../channel/channel-event.js";
import type { TaskCreateInput } from "../tasks/contract-input.js";

export interface EventAction {
	type: "bash";
	command: string;
	timeout?: number; // event definition uses milliseconds; converted to Executor seconds
}

/**
 * What an event delivers when it fires: a chat `text`, or a `task` template that spawns a fresh
 * task instance (spec 052, D2). Exactly one is present — `parseScheduledEventContent` enforces it.
 */
export interface EventPayload {
	text?: string;
	task?: TaskCreateInput;
}

export interface OneShotEvent extends EventPayload {
	type: "one-shot";
	channelId: string;
	at: string; // local time (host timezone if no offset given), e.g. 2026-07-27T07:30:00+08:00
	preAction?: EventAction;
}

export interface PeriodicEvent extends EventPayload {
	type: "periodic";
	channelId: string;
	schedule: string; // cron syntax, always interpreted in the host timezone
	preAction?: EventAction;
}

export type ScheduledEvent = OneShotEvent | PeriodicEvent;

export type EventHistoryAction =
	| "loaded"
	| "scheduled"
	| "triggered"
	| "skipped"
	| "enqueued"
	| "queue_full"
	| "deleted"
	| "invalid"
	| "pre_action_started"
	| "pre_action_passed"
	| "pre_action_blocked"
	| "pre_action_failed"
	| "cancelled";

export type EventHistoryResult = "ok" | "error" | "skipped";

export interface EventHistoryRecord {
	ts: string;
	eventName: string;
	eventPath: string;
	eventType: ScheduledEvent["type"] | "unknown";
	channelId?: string;
	action: EventHistoryAction;
	result: EventHistoryResult;
	reason?: string;
	schedule?: string;
	at?: string;
	nextRunAt?: string;
	textPreview?: string;
	preAction?: {
		type: "bash";
		command: string;
		timeoutMs: number;
		exitCode?: number | null;
		durationMs?: number;
	};
	queue?: {
		accepted: boolean;
	};
}

/** One occurrence of a template event asking for a task instance (spec 052, D2). */
export interface SpawnTaskRequest {
	/** The event's name (filename without `.json`); becomes the instance's `origin`. */
	eventName: string;
	channelId: string;
	template: TaskCreateInput;
	/** The moment this occurrence was due — deterministic per occurrence, so a replay maps to the same instance. */
	occurrence: Date;
}

export type SpawnTaskResult =
	/** A new instance was created. */
	| { outcome: "spawned"; id: string }
	/** This occurrence's instance already exists: an idempotent replay. */
	| { outcome: "exists"; id: string }
	/** Another instance of the same event is still running; the user was told. */
	| { outcome: "skipped"; id: string };

export interface EventsWatcherOptions {
	historyPath?: string;
	/**
	 * Creates the task instance a template event asks for. Injected by the runtime so the events
	 * subsystem never reads or writes task files (spec 052, INV-8).
	 */
	spawnTask?: (request: SpawnTaskRequest) => Promise<SpawnTaskResult>;
	/** Persist synthetic work before it enters the in-memory channel queue. */
	dispatch?: (event: ChannelEvent) => boolean | Promise<boolean>;
}
