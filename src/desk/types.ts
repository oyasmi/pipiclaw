/**
 * A desk is a named work context of the one Pipiclaw assistant (spec 060): it owns memory, journal, tasks,
 * events and working files. Channels are only addresses, bound to a desk through
 * `desk-bindings.json`; each channel that has talked to a desk gets its own conversation
 * directory inside it.
 */

/** Which family a channel belongs to; decides its conversation directory's `<kind>-<n>` name. */
export type ConversationKind = "dm" | "group" | "webapi";

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
	 * every other piece of desk state stay in the desk directory regardless.
	 */
	cwd?: string;
	/** Set when the desk is archived (`/desk archive`): dormant until rebound or unarchived. */
	archivedAt?: string;
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
	| { kind: "invalid_cwd"; cwd: string; reason: string }
	| { kind: "exists"; name: string }
	| { kind: "unavailable"; name: string };

export type DeskCwdOutcome =
	| { kind: "ok"; desk: string; cwd: string; isDefault: boolean }
	| { kind: "busy"; desk: string; reason: string }
	| { kind: "invalid_cwd"; cwd: string; reason: string }
	| { kind: "unavailable"; desk: string };

export type ArchiveDeskOutcome =
	| { kind: "archived"; desk: string; unboundTerminals: number; stoppedEvents: number }
	| { kind: "already_archived"; desk: string }
	| { kind: "default" }
	| { kind: "current_channel"; desk: string }
	| { kind: "bound_channels"; desk: string; channels: string[] }
	| { kind: "open_tasks"; desk: string; count: number; sampleId: string }
	| { kind: "busy"; desk: string; reason: string }
	| { kind: "unknown"; desk: string }
	| { kind: "unavailable"; desk: string }
	| { kind: "invalid"; desk: string }
	| { kind: "forbidden"; desk: string };

export type UnarchiveDeskOutcome =
	| { kind: "unarchived"; desk: string; activated: boolean }
	| { kind: "not_archived"; desk: string }
	| { kind: "unknown"; desk: string }
	| { kind: "unavailable"; desk: string }
	| { kind: "invalid"; desk: string }
	| { kind: "forbidden"; desk: string };
