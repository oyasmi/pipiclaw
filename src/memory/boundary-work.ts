/** Durable pre-compaction reflect snapshots. Inference never holds up the compaction hook. */
import { createHash } from "node:crypto";
import { access, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { getMemoryWorkDir } from "../desk/paths.js";
import type { DeskConversation } from "../desk/types.js";
import * as log from "../log.js";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { formatLocalTime, parseLocalTime } from "../shared/local-time.js";
import { isNodeError } from "../shared/os.js";
import { errorMessage } from "../shared/text-utils.js";
import { isRecord } from "../shared/type-guards.js";
import { type DeskMemoryQueue, getDeskMemoryQueue } from "./desk-memory-queue.js";
import { readMemoryMaintenanceState, updateMemoryMaintenanceState } from "./maintenance-state.js";
import { runReflect } from "./reflect.js";
import { appendMemoryReviewLog } from "./review-log.js";
import { sanitizeMessagesForMemory } from "./transcript.js";

interface BoundaryWork {
	version: 1;
	id: string;
	createdAt: number;
	/** The fixed prefix includes metadata ids so checkpoints can only advance, never regress. */
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
	const prefix = entries.slice(0, cut);
	if (prefix.length === 0) return;
	const id = createHash("sha256")
		.update(prefix.map((entry) => entry.id).join("\0"))
		.digest("hex")
		.slice(0, 32);
	if (await completed(conversation, id)) return;
	signal.throwIfAborted();
	const work: BoundaryWork = {
		version: 1,
		id,
		createdAt: Date.now(),
		entryIds: prefix.map((entry) => entry.id),
		messages: prefix.flatMap((entry) =>
			entry.type === "message"
				? sanitizeMessagesForMemory([entry.message]).map((message) => ({ entryId: entry.id, message }))
				: [],
		),
	};
	await writeFileAtomically(join(workDir(conversation), `${id}.json`), `${JSON.stringify(work)}\n`);
	signal.throwIfAborted();
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
				const remaining = new Set(item.entryIds.slice(cursor + 1));
				const messages = item.messages
					.filter((entry) => remaining.has(entry.entryId))
					.map((entry) => entry.message);
				// A crash after checkpointing but before removing the work must not repeat inference.
				if (cursor !== item.entryIds.length - 1) {
					const result = await runReflect({
						channelId: conversation.channelId,
						deskDir: conversation.deskDir,
						workspaceDir: options.workspaceDir,
						model: options.model,
						resolveApiKey: options.resolveApiKey,
						messages,
						usageContext: { channelId: conversation.channelId, desk: conversation.desk, correlationId: item.id },
					});
					await appendMemoryReviewLog(conversation.deskDir, {
						timestamp: formatLocalTime(),
						channelId: conversation.channelId,
						reason: "reflect-boundary",
						correlationId: item.id,
						actions: [{ target: "memory", action: "reflect", added: result.added, updated: result.updated }],
					});
				}
				await updateMemoryMaintenanceState(appHomeDir, conversation, (current) => ({
					...current,
					// A later session/idle pass may already be ahead of this snapshot.
					lastReflectedEntryId:
						!current.lastReflectedEntryId || item.entryIds.includes(current.lastReflectedEntryId)
							? item.entryIds.at(-1)
							: current.lastReflectedEntryId,
				}));
				await updateMemoryMaintenanceState(appHomeDir, conversation, (current) => ({
					...current,
					failureBackoffUntil: null,
				}));
				await writeFileAtomically(join(workDir(conversation), `${item.id}.done`), `${item.id}\n`);
				await unlink(join(workDir(conversation), `${item.id}.json`));
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
