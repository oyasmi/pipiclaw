import type { Static } from "typebox";
import type { DeskJobManager } from "../../jobs/manager.js";
import type { SubAgentRunManager } from "../../subagents/runs.js";
import type { TaskControl, TaskSessionContext } from "../../tasks/control.js";
import type {
	taskAskSchema,
	taskCloseSchema,
	taskCreateSchema,
	taskLogSchema,
	taskMessageSchema,
	taskPauseSchema,
	taskReportSchema,
	taskResumeSchema,
	taskWaitSchema,
} from "./schema.js";

export interface TaskManageResult {
	action: "create" | "close" | "list" | "log" | "message" | "pause" | "resume" | "report" | "ask" | "wait";
	id?: string;
	path?: string;
	state?: string;
	archived?: boolean;
	tasks?: Array<{
		id: string;
		title: string;
		state: string;
		/** What a waiting task waits for: the open question, the moment, or the in-flight work. */
		waiting?: string;
		frozen?: boolean;
		/** The delivery channel; a task delivering elsewhere reports to that channel, not this chat. */
		channel?: string;
		deliversHere: boolean;
		steps?: number;
		usd?: number;
		items?: string;
		/** The step in progress and what the model is doing in it. */
		activity?: string;
		inFlight?: string[];
	}>;
	/** Rendered log lines, for `task_log`. */
	entries?: string[];
	/** Refs of delegations and jobs cancelled together with the task. */
	cancelled?: string[];
	notice: string;
}

/**
 * One request type per schema the model actually sees (spec 046, D3.3): each tool's required
 * fields are non-optional in the type rather than documented as "required for X" in shared prose.
 */
export type TaskCreateRequest = Static<typeof taskCreateSchema>;
export type TaskCloseRequest = Static<typeof taskCloseSchema>;
export type TaskLogRequest = Static<typeof taskLogSchema>;
export type TaskMessageRequest = Static<typeof taskMessageSchema>;
export type TaskPauseRequest = Static<typeof taskPauseSchema>;
export type TaskResumeRequest = Static<typeof taskResumeSchema>;
export type TaskReportRequest = Static<typeof taskReportSchema>;
export type TaskAskRequest = Static<typeof taskAskSchema>;
export type TaskWaitRequest = Static<typeof taskWaitSchema>;

export interface TaskManageToolOptions {
	jobManager: DeskJobManager;
	runManager: SubAgentRunManager;
	desk: string;
	deskDir: string;
	/** The current turn's channel: a task created here delivers to it (spec 058, D13). */
	channelId: string;
	/** Chat only: the lane's control port. Absent where no lane runs (a request-scoped session). */
	control?: TaskControl;
	/** Present only inside a task session (spec 064, D18/D21). */
	session?: TaskSessionContext;
}
