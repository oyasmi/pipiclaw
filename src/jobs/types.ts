import type { WakeEvent } from "../channel/channel-event.js";
import type { FileStore } from "../file-store.js";

export interface JobStartOptions {
	scopeRef?: import("../channel/delivery-scope.js").DeliveryScopeRef;
	/** The channel the job was started from: its completion wake goes back there (spec 058, D7). */
	channelId: string;
	signal?: AbortSignal;
	notify?: boolean;
	/** The task whose step starts the job (spec 064, INV-8): its completion is recorded there instead of waking `channelId`. */
	taskId?: string;
}

export interface JobManagerOptions {
	/** Directory for this desk's persisted job records. Omit to run without persistence. */
	stateDir?: string;
	/** Is a job's channel still bound to this desk (spec 058, D7)? Omitted (TUI, tests): always. */
	isBoundTo?: (channelId: string, desk: string) => boolean;
	/** Delivers the completion wake. Omit to disable waking (sub-agent and test paths). */
	dispatch?: (event: WakeEvent) => boolean | Promise<boolean>;
	/** A task-bound job settled and its record is in the task's log; the lane recomputes from it (spec 064, D19). */
	onTaskInput?: (desk: string, taskId: string) => void;
	sweepIntervalMs?: number;
	/** File-content port for reading a job's spill file (spec 044, D8). Defaults to `createFileStore()`. */
	fileStore?: FileStore;
	/** Directory the full-output spill (and its `.exit`/`.ready`/`.meta` siblings) is written to.
	 * Defaults to the OS temp dir; the runtime passes `<deskDir>/logs` so the model can read it. */
	spillDir?: string;
}
