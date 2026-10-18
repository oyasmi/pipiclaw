/**
 * A dot is a named, explicitly created assistant (spec 058): it owns memory, journal, tasks,
 * events and working files. Channels are only addresses, bound to a dot through
 * `dots/bindings.json`; each channel that has talked to a dot gets its own conversation
 * directory inside it.
 */

/** Which family a channel belongs to; decides its conversation directory's `<kind>-<n>` name. */
export type ConversationKind = "dm" | "group" | "tui";

/** One `dot.json` `conversations` entry: where a channel's sessions live inside this dot. */
export interface DotConversationRecord {
	/** `<kind>-<n>`, fixed at allocation and never renamed. */
	dir: string;
	createdAt: string;
}

/** `dots/<dot>/dot.json`. */
export interface DotRecord {
	version: 1;
	/** Always equal to the directory name; a mismatch makes the dot unavailable. */
	name: string;
	createdAt: string;
	/** Append-only, keyed by channel id — the only place a channel id meets this dot's layout. */
	conversations: Record<string, DotConversationRecord>;
	/**
	 * Optional absolute working directory for the agent (shell cwd, relative-path base, default
	 * delegation directory). Absent means the dot directory itself. Memory, tasks, events and
	 * every other piece of dot state stay in the dot directory regardless. Edited by hand (D9).
	 */
	cwd?: string;
}

export interface DotBinding {
	dot: string;
	boundAt: string;
}

/** `dots/bindings.json`: channel id → dot. The single source of truth for bindings (INV-1). */
export interface BindingsFile {
	version: 1;
	bindings: Record<string, DotBinding>;
}

/** One (dot, channel) pairing, resolved to disk: what a runner, reflect pass or recovery scan works on. */
export interface DotConversation {
	dot: string;
	dotDir: string;
	/** Where the agent works: `dot.json`'s `cwd` when set, else `dotDir`. */
	cwd: string;
	channelId: string;
	/** The conversation directory's name, e.g. `group-1`. */
	conversation: string;
	conversationDir: string;
}

export type DotAvailability = "available" | "missing" | "invalid";

/** A dot as found on disk. `record` is present exactly when `availability` is `available`. */
export interface DotSummary {
	name: string;
	dotDir: string;
	availability: DotAvailability;
	/** English diagnostic for a `missing`/`invalid` dot, for logs and the deployer. */
	reason?: string;
	record?: DotRecord;
}

export type CreateDotOutcome =
	| { kind: "created"; record: DotRecord }
	| { kind: "invalid"; name: string }
	| { kind: "exists"; name: string };
