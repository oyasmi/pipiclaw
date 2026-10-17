import { join } from "node:path";
import type { ConversationKind } from "./types.js";

/**
 * Every path segment under `workspace/dots/` comes from a dot name, a conversation name or a
 * fixed file name — never from a channel id (spec 058, INV-3). Both names are validated here,
 * so a path built through these helpers cannot escape its parent.
 */
export const DOTS_DIRNAME = "dots";
export const DOT_RECORD_FILENAME = "dot.json";
const BINDINGS_FILENAME = "bindings.json";
const LOCKS_DIRNAME = ".locks";
const CONVERSATIONS_DIRNAME = "conversations";

const DOT_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const CONVERSATION_NAME_PATTERN = /^(dm|group|tui)-([1-9][0-9]*)$/;

export function isDotName(value: string): boolean {
	return DOT_NAME_PATTERN.test(value);
}

/** What a user typed, as a candidate dot name: trimmed and lower-cased (validity is checked separately). */
export function normalizeDotName(value: string): string {
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

export function getDotsDir(workspaceDir: string): string {
	return join(workspaceDir, DOTS_DIRNAME);
}

export function getBindingsPath(workspaceDir: string): string {
	return join(getDotsDir(workspaceDir), BINDINGS_FILENAME);
}

export function getDotDir(workspaceDir: string, dot: string): string {
	if (!isDotName(dot)) throw new Error(`Invalid dot name: ${dot}`);
	return join(getDotsDir(workspaceDir), dot);
}

export function getConversationsDir(dotDir: string): string {
	return join(dotDir, CONVERSATIONS_DIRNAME);
}

export function getConversationDir(dotDir: string, conversation: string): string {
	if (!isConversationName(conversation)) throw new Error(`Invalid conversation name: ${conversation}`);
	return join(getConversationsDir(dotDir), conversation);
}

/** `dots/<dot>/.locks/<name>` — the cross-process short locks of D6 (`memory.lock`, `dot-json.lock`, …). */
export function getDotLockPath(dotDir: string, lockName: string): string {
	return join(dotDir, LOCKS_DIRNAME, lockName);
}
