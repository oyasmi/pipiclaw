import type { Static } from "typebox";
import type { TaskControl } from "../../tasks/control.js";
import type { taskCloseSchema, taskCreateSchema, taskUpdateSchema, taskVerifySchema } from "./schema.js";

export interface TaskManageResult {
	action: "create" | "update" | "close" | "verify" | "list";
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
 * Five request types, derived from the five schemas the model actually sees (spec 046, D3.3) —
 * the spec 036 D8 "derive from schema" discipline, doubled: each action's required fields are now
 * non-optional in the type, not merely documented as "required for X" in a shared schema's prose.
 *
 * `status`/`outcome` stay plain strings where the underlying schema uses a literal union: they are
 * validated in code against the transition table so a legacy or closing value gets a fixable error
 * naming the right tool, rather than a bare schema rejection.
 */
export type TaskCreateRequest = Omit<Static<typeof taskCreateSchema>, "status"> & { status?: string };
export type TaskUpdateRequest = Omit<Static<typeof taskUpdateSchema>, "status"> & { status?: string };
export type TaskCloseRequest = Static<typeof taskCloseSchema>;
export type TaskVerifyRequest = Static<typeof taskVerifySchema>;

export interface TaskManageToolOptions {
	workspaceDir: string;
	channelDir: string;
	channelId: string;
	/** Project checkout whose artifact state an independent verifier binds to. */
	workingDirectory?: string;
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
