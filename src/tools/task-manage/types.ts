import type { Static } from "typebox";
import type { TaskControl } from "../../tasks/control.js";
import type { taskManageSchema } from "./schema.js";

export type TaskManageAction = Static<typeof taskManageSchema>["action"];

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
		enabled: boolean;
		wake?: string;
		actionable: boolean;
		control?: TaskControl;
	}>;
	notice: string;
}

/**
 * A `task_manage` call, derived from the schema the model actually sees (spec 036, D8).
 *
 * It used to be a hand-written mirror of `taskManageSchema`, and the two drifted apart in both
 * directions without a single type error: the schema advertised `parent`, `dependsOn` and
 * `verificationMode`, all three silently dropped on write, while the one field that turns on
 * independent acceptance — `verificationRequired` — was read by the implementation and absent
 * from the schema, so no model could ever ask for it. Deriving the request type makes that class
 * of drift a compile error. `label` is the tool's UI affordance, not part of the request.
 *
 * `status` stays a plain string: it is validated in code against the transition table so a legacy
 * or closing legacy value gets a fixable error naming the right action, rather than a
 * bare schema rejection.
 */
export type TaskManageRequest = Omit<Static<typeof taskManageSchema>, "label" | "status"> & {
	status?: string;
};

export interface TaskManageToolOptions {
	workspaceDir: string;
	channelDir: string;
	channelId: string;
	/** Project checkout whose artifact state an independent verifier binds to. */
	workingDirectory?: string;
	/** Durable checker dispatch supplied by the long-lived runtime. */
	dispatchVerification?: (taskId: string) => Promise<boolean>;
}

export interface TaskFields {
	status: string;
	enabled?: boolean;
	wake?: string;
	schedule?: string;
	control?: TaskControl;
	outcome?: "completed" | "cancelled";
	closedAt?: string;
}
