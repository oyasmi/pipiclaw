import { join } from "node:path";
import { loadBindings, writeBindings } from "../../src/desk/bindings.js";
import { allocateConversation, createDeskRecord } from "../../src/desk/registry.js";

/**
 * The one desk every eval trial runs in (spec 058): `desk-eval`, bound to the DM channel `dingtalk:dm:eval`,
 * whose conversation is the desk's first DM conversation.
 */
export const EVAL_DESK = "eval";
export const EVAL_CHANNEL_ID = "dingtalk:dm:eval";

export function evalDeskDir(workspaceDir: string): string {
	return join(workspaceDir, `desk-${EVAL_DESK}`);
}

export function evalConversationDir(workspaceDir: string): string {
	return join(evalDeskDir(workspaceDir), "conversations", "dm-1");
}

/** What `/desk new eval` + `/desk bind eval` in `dingtalk:dm:eval` leave on disk. Idempotent. */
export async function prepareEvalDesk(workspaceDir: string): Promise<void> {
	const now = new Date();
	createDeskRecord(workspaceDir, EVAL_DESK, now);
	await allocateConversation(workspaceDir, EVAL_DESK, EVAL_CHANNEL_ID, "dm", now);
	const bindings = await loadBindings(workspaceDir);
	if (bindings.bindings[EVAL_CHANNEL_ID]?.desk === EVAL_DESK) return;
	bindings.bindings[EVAL_CHANNEL_ID] = { desk: EVAL_DESK, boundAt: now.toISOString() };
	await writeBindings(workspaceDir, bindings);
}
