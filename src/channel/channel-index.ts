/**
 * `workspace/CHANNELS.md` — the readable map of every channel this runtime knows.
 *
 * A channel's on-disk identity is its raw id (`group_cidYDhGqxhJOzS7VDv/eDInUw==`), which is
 * unreadable in a directory listing, in `/events` output and in the logs. This index gives
 * every id a name and a last-seen time in one place, so the operator browsing the workspace
 * and the agent asking "what other channels are there?" both have something to read.
 *
 * ## Maintenance contract
 *
 * - **What is recorded**: only real inbound human messages — the DingTalk transport calls
 *   `noteChannelActivity` once per accepted message, before command/busy routing splits the
 *   path. Background wakes (scheduled events, the task driver, durable re-dispatch) are
 *   deliberately *not* recorded: they would keep every dormant channel looking fresh and
 *   destroy the one signal this file carries.
 * - **When it is written**: immediately on a structural change — a channel seen for the first
 *   time, or a group that changed its name — because those are rare and are the whole point
 *   of the file. A change to the timestamp alone is debounced to at most one write per
 *   {@link DEFAULT_DEBOUNCE_MS} however busy the channel gets, plus a final flush from
 *   `close()` at shutdown.
 * - **What survives a rewrite**: every flush re-reads the file first, so the hand-written
 *   `主题` column — and any row for a channel this process never saw — is carried over
 *   verbatim. The runtime owns three columns; the fourth belongs to whoever edits it.
 *
 * The index is the durable store for channel names: the transport learns a name only while a
 * message is being handled, so nothing else outlives a restart. It fills in from the first
 * message in each channel rather than being seeded from disk — a channel *directory* name is
 * the escaped form of the id (`/` → `__`, see `channel-paths.ts`) and cannot be turned back
 * into one, so scanning the workspace would populate rows keyed by ids that do not exist.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as log from "../log.js";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { formatLocalTime, parseLocalTime } from "../shared/local-time.js";
import { createSerialQueue } from "../shared/serial-queue.js";
import { errorMessage } from "../shared/text-utils.js";
import { getChannelDirName, isChannelId } from "./channel-paths.js";

export const CHANNELS_INDEX_FILENAME = "CHANNELS.md";

/**
 * Timestamp-only debounce. Five minutes is far below the resolution anyone reads this file at,
 * and it caps the file at 12 writes/hour no matter how many messages arrive.
 */
export const DEFAULT_DEBOUNCE_MS = 5 * 60_000;

/** Names come from a chat platform; clip so one absurd group title cannot deform the table. */
const MAX_NAME_CHARS = 80;

export interface ChannelObservation {
	channelId: string;
	/** Group title, or the peer's nickname for a DM. Absent when the transport had none. */
	name?: string;
	/** Epoch milliseconds of the message that triggered this observation. */
	at: number;
}

export interface ChannelIndexEntry {
	channelId: string;
	name: string;
	/** Local wall-clock time of the last human message, or `""` when never observed. */
	lastMessageAt: string;
	/** Hand-written; the runtime only ever copies it forward. */
	topic: string;
}

export interface ChannelIndex {
	/** Record one inbound human message. Cheap and synchronous; writing is decided internally. */
	note(observation: ChannelObservation): void;
	/** Write pending changes now. No-op when nothing changed. */
	flush(): Promise<void>;
	/** Cancel the debounce timer and write one last time. */
	close(): Promise<void>;
}

// === Rendering and parsing ===

const HEADER_CELLS = ["频道 ID", "名称", "最近消息", "主题"];

const FILE_HEADER = `# Channels

<!--
运行时自动维护的频道索引。

- 「频道 ID」「名称」「最近消息」三列由运行时在收到消息时更新，手工改动会在下次重写时被覆盖。
- 「主题」一列留给你（或 agent）填写，重写索引时原样保留 — 用一句话写清这个频道是干什么的。
- 「最近消息」只统计真人消息，不含定时事件和任务驱动的后台唤醒，所以它能反映频道是否还活跃。
- 行按最近消息时间倒序排列。
-->
`;

/** Local time at second precision: exact round-trip through `parseLocalTime`, no millisecond noise. */
function renderTimestamp(atMs: number): string {
	return formatLocalTime(new Date(atMs)).replace(/\.\d{3}(?=[+-]\d{2}:\d{2}$)/, "");
}

function escapeCell(value: string): string {
	return value
		.replace(/[\r\n]+/g, " ")
		.replace(/\\/g, "\\\\")
		.replace(/\|/g, "\\|")
		.trim();
}

/** Split one markdown table row, honouring the `\|` escapes {@link escapeCell} writes. */
function splitRow(line: string): string[] {
	const cells: string[] = [];
	let current = "";
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index];
		if (char === "\\" && index + 1 < line.length) {
			current += line[index + 1];
			index += 1;
			continue;
		}
		if (char === "|") {
			cells.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	cells.push(current);
	// A well-formed row is bounded by pipes, so the first and last cells are empty padding.
	if (cells.length >= 2 && cells[0].trim() === "" && cells[cells.length - 1].trim() === "") {
		return cells.slice(1, -1).map((cell) => cell.trim());
	}
	return cells.map((cell) => cell.trim());
}

function isSeparatorRow(cells: string[]): boolean {
	return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

export function renderChannelIndex(entries: ChannelIndexEntry[]): string {
	const rows = entries.map(
		(entry) =>
			`| \`${escapeCell(entry.channelId)}\` | ${escapeCell(entry.name)} | ${escapeCell(entry.lastMessageAt)} | ${escapeCell(entry.topic)} |`,
	);
	return [
		FILE_HEADER,
		`| ${HEADER_CELLS.join(" | ")} |`,
		`| ${HEADER_CELLS.map(() => "---").join(" | ")} |`,
		...rows,
		"",
	].join("\n");
}

/**
 * Read back whatever a previous render — or a human editing the file — left behind.
 *
 * Rows are identified structurally (a pipe-delimited line that is neither the header nor the
 * separator) rather than by matching the id against a pattern: DingTalk conversation ids are
 * base64 and routinely contain `/` and `=`, so any shape check here would quietly discard real
 * channels. Anything unparseable is skipped instead of throwing — a mangled index must never
 * stop the runtime from recording the next message.
 */
export function parseChannelIndex(content: string): ChannelIndexEntry[] {
	const entries: ChannelIndexEntry[] = [];
	const seen = new Set<string>();
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("|")) continue;
		const cells = splitRow(trimmed);
		if (isSeparatorRow(cells)) continue;
		const channelId = cells[0]?.replace(/`/g, "").trim() ?? "";
		if (!channelId || channelId === HEADER_CELLS[0] || seen.has(channelId)) continue;
		seen.add(channelId);
		entries.push({
			channelId,
			name: cells[1] ?? "",
			lastMessageAt: cells[2] ?? "",
			topic: cells[3] ?? "",
		});
	}
	return entries;
}

// === Discovery ===

/** Channel ids recorded in the index, i.e. every channel that has ever received a message. */
export async function readChannelIndexIds(workspaceDir: string): Promise<string[]> {
	try {
		const content = await readFile(join(workspaceDir, CHANNELS_INDEX_FILENAME), "utf-8");
		return parseChannelIndex(content)
			.map((entry) => entry.channelId)
			.filter(isChannelId);
	} catch {
		return [];
	}
}

/**
 * Every channel this workspace knows about, for the background workers that must visit
 * channels nobody has spoken to since the process started (memory maintenance, the task
 * driver). Live channels come from the caller's runner map; this covers the rest.
 *
 * The index is the accurate source — it stores real ids. Scanning the workspace root is the
 * fallback for a workspace that predates the index, and it is inherently lossy: a channel
 * *directory* is the escaped form of the id (`/` → `__`), which cannot be turned back into the
 * original. It is still kept alongside the index rather than only when the file is missing,
 * because the index fills in one channel at a time: on the first run after an upgrade the file
 * exists with a single row, and treating that as "the index has answers now" would drop every
 * other pre-existing channel until each of them happened to be spoken in. Directories whose
 * name is the escaped form of an already-indexed id are skipped, so a channel is never visited
 * twice under two spellings.
 */
export async function discoverWorkspaceChannelIds(workspaceDir: string): Promise<string[]> {
	const channelIds = new Set(await readChannelIndexIds(workspaceDir));
	const indexedDirNames = new Set([...channelIds].map(getChannelDirName));
	try {
		const dirents = await readdir(workspaceDir, { withFileTypes: true });
		for (const entry of dirents) {
			if (!entry.isDirectory() || indexedDirNames.has(entry.name) || !isChannelId(entry.name)) continue;
			channelIds.add(entry.name);
		}
	} catch {
		// A missing or unreadable workspace simply has no channels to report.
	}
	return [...channelIds].sort();
}

function entryTime(entry: Pick<ChannelIndexEntry, "lastMessageAt">): number {
	return entry.lastMessageAt ? (parseLocalTime(entry.lastMessageAt) ?? 0) : 0;
}

function sortEntries(entries: ChannelIndexEntry[]): ChannelIndexEntry[] {
	return [...entries].sort((a, b) => {
		const delta = entryTime(b) - entryTime(a);
		return delta !== 0 ? delta : a.channelId.localeCompare(b.channelId);
	});
}

// === The maintainer ===

interface ObservedChannel {
	name: string;
	atMs: number;
}

function normalizeName(name: string | undefined): string {
	if (!name) return "";
	const collapsed = name.replace(/\s+/g, " ").trim();
	return collapsed.length > MAX_NAME_CHARS ? `${collapsed.slice(0, MAX_NAME_CHARS - 1)}…` : collapsed;
}

export interface CreateChannelIndexOptions {
	workspaceDir: string;
	/** Override the timestamp-only debounce; tests use a short one. */
	debounceMs?: number;
}

export function createChannelIndex(options: CreateChannelIndexOptions): ChannelIndex {
	const indexPath = join(options.workspaceDir, CHANNELS_INDEX_FILENAME);
	const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	// Serialized so two flushes can never interleave their read-merge-write.
	const queue = createSerialQueue<string>();
	const observed = new Map<string, ObservedChannel>();
	let dirty = false;
	let closed = false;
	let timer: NodeJS.Timeout | null = null;
	/** The most recently started write, so a caller can await work it did not start itself. */
	let pending: Promise<void> = Promise.resolve();

	const cancelTimer = (): void => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	};

	const scheduleFlush = (): void => {
		if (timer || closed) return;
		timer = setTimeout(() => {
			timer = null;
			void flush();
		}, debounceMs);
		// Never keep the process alive just to update an index file.
		timer.unref?.();
	};

	/** Merge the file on disk with this process's observations. Disk wins on `主题`, we win on the rest. */
	const merge = async (): Promise<ChannelIndexEntry[]> => {
		const byId = new Map<string, ChannelIndexEntry>();
		try {
			for (const entry of parseChannelIndex(await readFile(indexPath, "utf-8"))) {
				byId.set(entry.channelId, entry);
			}
		} catch {
			// No index yet, or it is unreadable: start from what this process knows.
		}

		for (const [channelId, channel] of observed) {
			const existing = byId.get(channelId);
			byId.set(channelId, {
				channelId,
				// An observation without a name (a DM from a nameless sender) must not erase a
				// name the file already carries.
				name: channel.name || existing?.name || "",
				lastMessageAt: renderTimestamp(Math.max(channel.atMs, existing ? entryTime(existing) : 0)),
				topic: existing?.topic ?? "",
			});
		}

		return sortEntries([...byId.values()]);
	};

	const flush = (): Promise<void> => {
		// A structural change starts its write without awaiting it, so "nothing to do" still has
		// to resolve behind whatever is already in flight — otherwise `await flush()` can return
		// before the write it was meant to wait for has landed.
		if (!dirty) return pending;
		// Cleared up front so observations arriving during the write are not swallowed by it;
		// restored on failure so the next note retries instead of silently dropping them.
		dirty = false;
		pending = queue
			.run(indexPath, async () => {
				await writeFileAtomically(indexPath, renderChannelIndex(await merge()));
			})
			.catch((error: unknown) => {
				dirty = true;
				log.logWarning(`Failed to update ${CHANNELS_INDEX_FILENAME}`, errorMessage(error));
			});
		return pending;
	};

	return {
		note(observation: ChannelObservation): void {
			if (closed || !observation.channelId) return;
			const name = normalizeName(observation.name);
			const previous = observed.get(observation.channelId);
			// A first sighting or a rename is the information this file exists to carry, so it
			// bypasses the debounce; a fresher timestamp on an already-named channel can wait.
			const structural = !previous || (name !== "" && name !== previous.name);
			observed.set(observation.channelId, {
				name: name || previous?.name || "",
				atMs: Math.max(observation.at, previous?.atMs ?? 0),
			});
			dirty = true;
			if (structural) {
				cancelTimer();
				void flush();
				return;
			}
			scheduleFlush();
		},

		async flush(): Promise<void> {
			await flush();
		},

		async close(): Promise<void> {
			cancelTimer();
			await flush();
			closed = true;
		},
	};
}
