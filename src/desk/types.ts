/**
 * A desk is a named work context of the one Pipiclaw assistant (spec 060): it owns memory, journal, tasks,
 * events and working files. Channels are only addresses, bound to a desk through
 * `desk-bindings.json`; each channel that has talked to a desk gets its own conversation
 * directory inside it.
 */

/** Which family a channel belongs to; decides its conversation directory's `<kind>-<n>` name. */
export type ConversationKind = "dm" | "group" | "tui";

/** One `desk.json` `conversations` entry: where a channel's sessions live inside this desk. */
export interface DeskConversationRecord {
	/** `<kind>-<n>`, fixed at allocation and never renamed. */
	dir: string;
	createdAt: string;
}

/** `desk-<desk>/desk.json`. */
export interface DeskRecord {
	version: 1;
	/** Always equal to the logical name in desk-<name>; a mismatch makes the desk unavailable. */
	name: string;
	createdAt: string;
	/** Append-only, keyed by channel id — the only place a channel id meets this desk's layout. */
	conversations: Record<string, DeskConversationRecord>;
	/**
	 * Optional absolute working directory for the agent (shell cwd, relative-path base, default
	 * delegation directory). Absent means the desk directory itself. Memory, tasks, events and
	 * every other piece of desk state stay in the desk directory regardless. Edited by hand (D9).
	 */
	cwd?: string;
}

export interface DeskBinding {
	desk: string;
	boundAt: string;
}

/** `desk-bindings.json`: channel id → desk. The single source of truth for bindings (INV-1). */
export interface BindingsFile {
	version: 1;
	bindings: Record<string, DeskBinding>;
}

/** One (desk, channel) pairing, resolved to disk: what a runner, reflect pass or recovery scan works on. */
export interface DeskConversation {
	desk: string;
	deskDir: string;
	/** Where the agent works: `desk.json`'s `cwd` when set, else `deskDir`. */
	cwd: string;
	channelId: string;
	/** The conversation directory's name, e.g. `group-1`. */
	conversation: string;
	conversationDir: string;
}

export type DeskAvailability = "available" | "missing" | "invalid";

/** A desk as found on disk. `record` is present exactly when `availability` is `available`. */
export interface DeskSummary {
	name: string;
	deskDir: string;
	availability: DeskAvailability;
	/** English diagnostic for a `missing`/`invalid` desk, for logs and the deployer. */
	reason?: string;
	record?: DeskRecord;
}

export type CreateDeskOutcome =
	| { kind: "created"; record: DeskRecord }
	| { kind: "invalid"; name: string }
	| { kind: "exists"; name: string }
	| { kind: "unavailable"; name: string };
