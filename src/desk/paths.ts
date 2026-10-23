import { join } from "node:path";
import type { ConversationKind } from "./types.js";

/**
 * Every path segment under `workspace/desk-<name>/` comes from a desk name, a conversation name or a
 * fixed file name — never from a channel id (spec 058, INV-3). Both names are validated here,
 * so a path built through these helpers cannot escape its parent.
 */
export const DESK_DIR_PREFIX = "desk-";
export const DEFAULT_DESK = "default";
export const DESK_RECORD_FILENAME = "desk.json";
const BINDINGS_FILENAME = "desk-bindings.json";
const LOCKS_DIRNAME = ".locks";
const CONVERSATIONS_DIRNAME = "conversations";

const DESK_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const CONVERSATION_NAME_PATTERN = /^(dm|group|tui)-([1-9][0-9]*)$/;

export function isDeskName(value: string): boolean {
	return DESK_NAME_PATTERN.test(value);
}

/** What a user typed, as a candidate desk name: trimmed and lower-cased (validity is checked separately). */
export function normalizeDeskName(value: string): string {
	return value.trim().toLowerCase();
}

export function isConversationName(value: string): boolean {
	return CONVERSATION_NAME_PATTERN.test(value);
}

/** `group-3` → `{ kind: "group", index: 3 }`; `undefined` for anything else. */
export function parseConversationName(value: string): { kind: ConversationKind; index: number } | undefined {
	const match = CONVERSATION_NAME_PATTERN.exec(value);
	if (!match) return undefined;
	return { kind: match[1] as ConversationKind, index: Number(match[2]) };
}

export function getBindingsPath(workspaceDir: string): string {
	return join(workspaceDir, BINDINGS_FILENAME);
}

export function getDeskDir(workspaceDir: string, desk: string): string {
	if (!isDeskName(desk)) throw new Error(`Invalid desk name: ${desk}`);
	return join(workspaceDir, `${DESK_DIR_PREFIX}${desk}`);
}

export function getConversationsDir(deskDir: string): string {
	return join(deskDir, CONVERSATIONS_DIRNAME);
}

export function getConversationDir(deskDir: string, conversation: string): string {
	if (!isConversationName(conversation)) throw new Error(`Invalid conversation name: ${conversation}`);
	return join(getConversationsDir(deskDir), conversation);
}

/** `desk-<desk>/.locks/<name>` — the cross-process short locks of D6 (`memory.lock`, `desk-json.lock`, …). */
export function getDeskLockPath(deskDir: string, lockName: string): string {
	return join(deskDir, LOCKS_DIRNAME, lockName);
}
