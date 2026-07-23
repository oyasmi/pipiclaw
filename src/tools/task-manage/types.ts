import type { TaskControl, TaskControlPatch } from "../../tasks/control.js";

export type TaskManageAction =
	| "create"
	| "progress"
	| "candidate"
	| "set"
	| "verify"
	| "done"
	| "skip"
	| "cancel"
	| "list";

export interface TaskManageResult {
	action: TaskManageAction;
	id?: string;
	path?: string;
	status?: string;
	archived?: boolean;
	deletedEvents?: string[];
	tasks?: Array<{
		id: string;
		title: string;
		status: string;
		wake?: string;
		actionable: boolean;
		control?: TaskControl;
	}>;
	notice: string;
}

export interface TaskManageRequest {
	action: TaskManageAction;
	id?: string;
	title?: string;
	goal?: string;
	dod?: string;
	manual?: string;
	status?: string;
	wake?: string;
	schedule?: string;
	recurrence?: string;
	note?: string;
	verificationPlan?: string;
	control?: TaskControlPatch;
	verifierRunId?: string;
	summary?: string;
	evidence?: string;
	residualRisk?: string;
	reason?: string;
}

export interface TaskManageToolOptions {
	workspaceDir: string;
	channelDir: string;
	channelId: string;
	/** Project checkout whose artifact state an independent verifier binds to. */
	workingDirectory?: string;
	/** Whether the current main model has usable price metadata for maxCostUsd. */
	costTrackingAvailable?: boolean;
}

export interface TaskFields {
	status: string;
	wake?: string;
	schedule?: string;
	recurrence?: string;
	control?: TaskControl;
}
