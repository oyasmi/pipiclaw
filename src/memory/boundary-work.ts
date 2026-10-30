/** Durable pre-compaction reflect snapshots. Inference never holds up the compaction hook. */
import { createHash } from "node:crypto";
import { access, link, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { getMemoryWorkDir } from "../desk/paths.js";
import type { DeskConversation } from "../desk/types.js";
import * as log from "../log.js";
import { createAtomicTempPath, syncDirectoryBestEffort, writeFileAtomically } from "../shared/atomic-file.js";
import { formatLocalTime, parseLocalTime } from "../shared/local-time.js";
import { isNodeError } from "../shared/os.js";
import { errorMessage } from "../shared/text-utils.js";
import { isRecord } from "../shared/type-guards.js";
import { type DeskMemoryQueue, getDeskMemoryQueue } from "./desk-memory-queue.js";
import { readMemoryMaintenanceState, updateMemoryMaintenanceState } from "./maintenance-state.js";
import { runReflect } from "./reflect.js";
import { reviewLogEntryFor, tryAppendMemoryReviewLog } from "./review-log.js";
import { selectMemorySourceBatch } from "./source-window.js";
import { sanitizeMessagesForMemory } from "./transcript.js";

interface BoundaryWork {
	version: 1;
	id: string;
	createdAt: number;
	/** Remaining source ids, including metadata; the work id stays stable while batches drain. */
	entryIds: string[];
	messages: Array<{ entryId: string; message: AgentMessage }>;
}

function workDir(conversation: DeskConversation): string {
	return join(getMemoryWorkDir(conversation.deskDir), conversation.conversation);
}

async function pendingFiles(conversation: DeskConversation): Promise<string[]> {
	try {
		return (await readdir(workDir(conversation))).filter((name) => /^[a-f0-9]{32}\.json$/.test(name)).sort();
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return [];
		throw error;
	}
}

async function completed(conversation: DeskConversation, id: string): Promise<boolean> {
	try {
		await access(join(workDir(conversation), `${id}.done`));
		return true;
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return false;
		throw error;
	}
}

export async function hasBoundaryReflectWork(conversation: DeskConversation): Promise<boolean> {
	return (await pendingFiles(conversation)).length > 0;
}

/** Persist before context is replaced. No desk-memory queue/lock or model request on this path. */
export async function enqueueBoundaryReflectWork(
	conversation: DeskConversation,
	entries: SessionEntry[],
	firstKeptEntryId: string,
	signal: AbortSignal,
): Promise<void> {
	signal.throwIfAborted();
	const cut = entries.findIndex((entry) => entry.id === firstKeptEntryId);
	if (cut < 0) throw new Error("Cannot preserve compaction memory: kept entry is missing. Use /new to recover.");
	await enqueueBoundaryReflectEntries(conversation, entries.slice(0, cut), signal);
}

/** Also used by /new: publishing a snapshot never takes the inference/desk-memory lock. */
export async function enqueueBoundaryReflectEntries(
	conversation: DeskConversation,
	entries: SessionEntry[],
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted();
	if (entries.length === 0) return;
	const id = createHash("sha256")
		.update(entries.map((entry) => entry.id).join("\0"))
		.digest("hex")
		.slice(0, 32);
	if (await completed(conversation, id)) return;
	const work: BoundaryWork = {
		version: 1,
		id,
		createdAt: Date.now(),
		entryIds: entries.map((entry) => entry.id),
		messages: entries.flatMap((entry) =>
			entry.type === "message"
				? sanitizeMessagesForMemory([entry.message]).map((message) => ({ entryId: entry.id, message }))
				: [],
		),
	};
	const path = join(workDir(conversation), `${id}.json`);
	const temporary = createAtomicTempPath(path);
	try {
		await writeFileAtomically(temporary, `${JSON.stringify(work)}\n`);
		signal?.throwIfAborted();
		// Publish once: a duplicate enqueue must never restore already-processed batches.
		await link(temporary, path).catch((error) => {
			if (!isNodeError(error) || error.code !== "EEXIST") throw error;
		});
		syncDirectoryBestEffort(workDir(conversation));
	} finally {
		await unlink(temporary).catch(() => undefined);
	}
	signal?.throwIfAborted();
}

export interface BoundaryReflectOptions {
	conversation: DeskConversation;
	workspaceDir: string;
	appHomeDir: string;
	model: Model<Api>;
	resolveApiKey: (model: Model<Api>) => Promise<string>;
	queue?: DeskMemoryQueue;
}

/** Called by the live lifecycle and the startup/idle scheduler, including when idle maintenance is off. */
export async function drainBoundaryReflectWork(options: BoundaryReflectOptions): Promise<void> {
	const { conversation, appHomeDir } = options;
	try {
		if (!(await hasBoundaryReflectWork(conversation))) return;
		const queue = options.queue ?? getDeskMemoryQueue();
		await queue.run(conversation, async () => {
			const maintenance = await readMemoryMaintenanceState(appHomeDir, conversation);
			const retryAt = maintenance.failureBackoffUntil ? parseLocalTime(maintenance.failureBackoffUntil) : undefined;
			if (retryAt !== undefined && retryAt > Date.now()) return;
			const files = await pendingFiles(conversation);
			const work: BoundaryWork[] = [];
			for (const file of files) {
				if (await completed(conversation, file.slice(0, -5))) {
					await unlink(join(workDir(conversation), file));
					continue;
				}
				const value: unknown = JSON.parse(await readFile(join(workDir(conversation), file), "utf8"));
				if (
					!isRecord(value) ||
					value.version !== 1 ||
					typeof value.createdAt !== "number" ||
					!Number.isFinite(value.createdAt) ||
					value.id !== file.slice(0, -5) ||
					!Array.isArray(value.entryIds) ||
					value.entryIds.length === 0 ||
					!value.entryIds.every((id) => typeof id === "string") ||
					!Array.isArray(value.messages) ||
					!value.messages.every(
						(item) =>
							isRecord(item) &&
							typeof item.entryId === "string" &&
							isRecord(item.message) &&
							["user", "assistant"].includes(String(item.message.role)),
					)
				) {
					throw new Error(`Corrupt memory work ${file}; inspect it on the server before retrying.`);
				}
				work.push(value as unknown as BoundaryWork);
			}
			work.sort((a, b) => a.createdAt - b.createdAt);
			for (const item of work) {
				const state = await readMemoryMaintenanceState(appHomeDir, conversation);
				const cursor = state.lastReflectedEntryId ? item.entryIds.indexOf(state.lastReflectedEntryId) : -1;
				const byId = new Map(item.messages.map((entry) => [entry.entryId, entry.message]));
				const remaining = item.entryIds.slice(cursor + 1).map((id) => ({ id, message: byId.get(id) }));
				const batch = selectMemorySourceBatch(remaining, true);
				const throughEntryId = batch.entries.at(-1)?.id;
				// A crash after checkpointing but before removing work need not repeat inference.
				const result = batch.entries.length
					? await runReflect({
							channelId: conversation.channelId,
							deskDir: conversation.deskDir,
							workspaceDir: options.workspaceDir,
							model: options.model,
							resolveApiKey: options.resolveApiKey,
							messages: batch.messages,
							sourceClosed: true,
							usageContext: {
								channelId: conversation.channelId,
								desk: conversation.desk,
								correlationId: item.id,
							},
						})
					: undefined;
				if (throughEntryId) {
					await updateMemoryMaintenanceState(appHomeDir, conversation, (current) => ({
						...current,
						lastReflectedEntryId:
							!current.lastReflectedEntryId || item.entryIds.includes(current.lastReflectedEntryId)
								? throughEntryId
								: current.lastReflectedEntryId,
						failureBackoffUntil: null,
						lastReflectAt: batch.hasMore ? current.lastReflectAt : formatLocalTime(),
					}));
				}
				if (batch.hasMore) {
					const ids = remaining.slice(batch.entries.length).map((entry) => entry.id);
					const pending = new Set(ids);
					await writeFileAtomically(
						join(workDir(conversation), `${item.id}.json`),
						`${JSON.stringify({
							...item,
							entryIds: ids,
							messages: item.messages.filter((entry) => pending.has(entry.entryId)),
						})}\n`,
					);
				} else {
					await writeFileAtomically(join(workDir(conversation), `${item.id}.done`), `${item.id}\n`);
					await unlink(join(workDir(conversation), `${item.id}.json`));
				}
				if (result)
					await tryAppendMemoryReviewLog(conversation.deskDir, {
						timestamp: formatLocalTime(),
						channelId: conversation.channelId,
						reason: "reflect-boundary",
						correlationId: item.id,
						...reviewLogEntryFor(result, {
							hasMore: batch.hasMore,
							sampledChars: batch.sampledChars,
							throughEntryId,
							fromEntryId: state.lastReflectedEntryId,
						}),
					});
				// At most one model call per drain, including across queued snapshots.
				if (result) return;
			}
		});
	} catch (error: unknown) {
		await updateMemoryMaintenanceState(appHomeDir, conversation, (current) => ({
			...current,
			failureBackoffUntil: formatLocalTime(new Date(Date.now() + 30 * 60_000)),
		})).catch(() => undefined);
		log.logWarn("memory.boundary.failed", "Boundary memory reflect failed", {
			channelId: conversation.channelId,
			reason: errorMessage(error),
		});
	}
}
