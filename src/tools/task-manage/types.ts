import type { Static } from "typebox";
import type {
	taskCloseSchema,
	taskCreateSchema,
	taskLogSchema,
	taskStepEndSchema,
	taskUpdateSchema,
} from "./schema.js";

export interface TaskManageResult {
	action: "create" | "update" | "close" | "list" | "log" | "step_end";
	id?: string;
	path?: string;
	state?: string;
	archived?: boolean;
	deletedEvents?: string[];
	tasks?: Array<{
		id: string;
		title: string;
		state: string;
		paused: boolean;
		ticket?: string;
		cycle?: string;
		steps?: number;
		rounds?: number;
	}>;
	/** Rendered log lines, for `task_log`. */
	entries?: string[];
	notice: string;
}

/**
 * One request type per schema the model actually sees (spec 046, D3.3): each action's required
 * fields are non-optional in the type rather than documented as "required for X" in shared prose.
 */
export type TaskCreateRequest = Static<typeof taskCreateSchema>;
export type TaskUpdateRequest = Static<typeof taskUpdateSchema>;
export type TaskCloseRequest = Static<typeof taskCloseSchema>;
export type TaskLogRequest = Static<typeof taskLogSchema>;
export type TaskStepEndRequest = Static<typeof taskStepEndSchema>;

export interface TaskManageToolOptions {
	workspaceDir: string;
	channelDir: string;
	channelId: string;
	/** Project checkout whose artifact state an independent verifier binds to. */
	workingDirectory?: string;
	/** Present only inside a task session: which task's loop this tool set belongs to. */
	taskId?: string;
	/** Present only inside a task session: the cycle the current step belongs to. */
	cycleId?: string;
	/** Tools this step has completed so far; feeds the loop log's idle-step evidence (D6). */
	getToolsUsed?: () => string[];
}
