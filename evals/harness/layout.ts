import { join } from "node:path";
import { allocateConversation, createDot, loadBindings, writeBindings } from "../../src/dot/registry.js";

/**
 * The one dot every eval trial runs in (spec 058): `dots/eval`, bound to the DM channel `dm_eval`,
 * whose conversation is the dot's first DM conversation.
 */
export const EVAL_DOT = "eval";
export const EVAL_CHANNEL_ID = "dm_eval";

export function evalDotDir(workspaceDir: string): string {
	return join(workspaceDir, "dots", EVAL_DOT);
}

export function evalConversationDir(workspaceDir: string): string {
	return join(evalDotDir(workspaceDir), "conversations", "dm-1");
}

/** What `/dot new eval` + `/dot bind eval` in `dm_eval` leave on disk. Idempotent. */
export async function prepareEvalDot(workspaceDir: string): Promise<void> {
	const now = new Date();
	await createDot(workspaceDir, EVAL_DOT, now);
	await allocateConversation(workspaceDir, EVAL_DOT, EVAL_CHANNEL_ID, "dm", now);
	const bindings = await loadBindings(workspaceDir);
	if (bindings.bindings[EVAL_CHANNEL_ID]?.dot === EVAL_DOT) return;
	bindings.bindings[EVAL_CHANNEL_ID] = { dot: EVAL_DOT, boundAt: now.toISOString() };
	await writeBindings(workspaceDir, bindings);
}
