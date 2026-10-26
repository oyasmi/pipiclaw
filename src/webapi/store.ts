/**
 * Where the Web API keeps what it has told its callers (spec 061, D23). It lives under the
 * channel's own `state/webapi/`, not in a desk, so a conversation's history survives `/desk bind`.
 *
 *   state/webapi/                        0700
 *   ├── responses.jsonl                  response id → conversation id, append-only, for operators
 *   └── conversations/<conv_id>/
 *       ├── conversation.json            { id, created_at, metadata, owner }, written atomically
 *       └── responses.jsonl              a snapshot per response when created and when ended; the last wins
 *
 * Everything is read into memory once at start. A response that never reached an end (the process
 * died mid-turn) is marked failed then, once — it is never re-run, because its tools may already
 * have had effects.
 */
import { appendFile, chmod, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import * as log from "../log.js";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { createJsonlAppender, type JsonlAppender } from "../shared/jsonl-appender.js";
import { errorMessage } from "../shared/text-utils.js";
import { isPlainObject } from "../shared/type-guards.js";
import { isConversationId, newId } from "./ids.js";
import { isTerminal, nowSeconds, type ResponseRecord } from "./response-record.js";

export interface ConversationRecord {
	id: string;
	created_at: number;
	metadata: Record<string, string> | null;
	owner: string;
}

interface Line {
	path: string;
	record: unknown;
}

const RESTART_MESSAGE = "服务重启，回合被中断。";

const MAX_SNAPSHOT_PENDING_BYTES = 128 * 1024 * 1024;

export class WebApiStore {
	private readonly conversations = new Map<string, ConversationRecord>();
	private readonly responses = new Map<string, ResponseRecord>();
	/** Response ids per conversation, in the order they were created. */
	private readonly order = new Map<string, string[]>();
	private readonly appender: JsonlAppender;
	/** The tail of the disk writes `saveResponse` has queued. */
	private writes: Promise<void> = Promise.resolve();

	private constructor(private readonly dir: string) {
		this.appender = createJsonlAppender({
			pathFor: (_now, record) => (record as Line).path,
			recordForWrite: (record) => (record as Line).record,
			// A snapshot carries its input and its continuation, each able to hold the full set of
			// base64 images a request may attach; the default 8 MiB would refuse a legitimate one.
			maxPendingBytes: MAX_SNAPSHOT_PENDING_BYTES,
		});
	}

	/** Open the store, reading everything and failing the responses a previous run left unfinished. */
	static async open(stateDir: string): Promise<WebApiStore> {
		const store = new WebApiStore(stateDir);
		await mkdir(join(stateDir, "conversations"), { recursive: true, mode: 0o700 });
		// `mkdir -p` applies the mode to the leaf only; the whole tree must be private.
		await chmod(stateDir, 0o700);
		await chmod(join(stateDir, "conversations"), 0o700);
		await store.load();
		return store;
	}

	private conversationDir(id: string): string {
		return join(this.dir, "conversations", id);
	}

	private async load(): Promise<void> {
		let names: string[] = [];
		try {
			names = await readdir(join(this.dir, "conversations"));
		} catch {
			return;
		}
		for (const name of names.filter(isConversationId).sort()) {
			const conversation = await this.readConversation(name);
			if (!conversation) continue;
			this.conversations.set(conversation.id, conversation);
			await this.readResponses(conversation.id);
		}
		await this.readResponses();
		let interrupted = 0;
		for (const record of this.responses.values()) {
			if (isTerminal(record.status)) continue;
			interrupted++;
			record.status = "failed";
			record.error = { code: "server_error", message: RESTART_MESSAGE };
			record.completed_at = nowSeconds();
			await this.appendSnapshot(record);
		}
		if (interrupted > 0) {
			log.logWarn("webapi.store.interrupted", "Responses left unfinished by a restart were marked failed", {
				fields: { count: interrupted },
			});
		}
	}

	private async readConversation(id: string): Promise<ConversationRecord | undefined> {
		try {
			const parsed: unknown = JSON.parse(
				await readFile(join(this.conversationDir(id), "conversation.json"), "utf-8"),
			);
			if (
				isPlainObject(parsed) &&
				parsed.id === id &&
				typeof parsed.created_at === "number" &&
				typeof parsed.owner === "string"
			) {
				return {
					id,
					created_at: parsed.created_at,
					owner: parsed.owner,
					metadata: isPlainObject(parsed.metadata) ? (parsed.metadata as Record<string, string>) : null,
				};
			}
		} catch (error) {
			log.logWarn("webapi.store.conversation_unreadable", "Conversation record skipped", {
				reason: errorMessage(error),
				fields: { conversationId: id },
			});
		}
		return undefined;
	}

	private async readResponses(conversationId?: string): Promise<void> {
		const path = conversationId
			? join(this.conversationDir(conversationId), "responses.jsonl")
			: join(this.dir, "standalone.jsonl");
		let text: string;
		try {
			text = await readFile(path, "utf-8");
		} catch {
			return;
		}
		const ids: string[] = [];
		// A crash can leave a partial last line; end it, or the next snapshot would be glued onto it and lost.
		if (text.length > 0 && !text.endsWith("\n")) {
			await appendFile(path, "\n");
		}
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const record = JSON.parse(line) as ResponseRecord;
				if (
					!isPlainObject(record) ||
					typeof record.id !== "string" ||
					(conversationId ? record.conversation_id !== conversationId : record.request_scoped !== true)
				) {
					throw new Error("not a response snapshot");
				}
				if (!this.responses.has(record.id)) ids.push(record.id);
				this.responses.set(record.id, record);
			} catch (error) {
				log.logWarn("webapi.store.line_skipped", "Unreadable response snapshot skipped", {
					reason: errorMessage(error),
					fields: { conversationId },
				});
			}
		}
		if (conversationId) this.order.set(conversationId, ids);
	}

	// ---- conversations ---------------------------------------------------------------------

	async createConversation(
		owner: string,
		metadata: Record<string, string> | null,
		id: string = newId("conv"),
	): Promise<ConversationRecord> {
		const record: ConversationRecord = { id, created_at: nowSeconds(), metadata, owner };
		this.conversations.set(record.id, record);
		this.order.set(record.id, []);
		await this.writeConversation(record);
		return record;
	}

	getConversation(id: string): ConversationRecord | undefined {
		return this.conversations.get(id);
	}

	async updateConversationMetadata(id: string, metadata: Record<string, string> | null): Promise<ConversationRecord> {
		const existing = this.conversations.get(id);
		if (!existing) throw new Error(`Unknown conversation ${id}`);
		const updated = { ...existing, metadata };
		await this.writeConversation(updated);
		this.conversations.set(id, updated);
		return updated;
	}

	/**
	 * Forget a conversation and its responses, and remove its directory. The index line in
	 * `responses.jsonl` stays: it is the operator's record, and it names an id that no longer resolves.
	 */
	async deleteConversation(id: string): Promise<void> {
		for (const responseId of this.order.get(id) ?? []) this.responses.delete(responseId);
		this.order.delete(id);
		this.conversations.delete(id);
		// Snapshots queued before the delete must not recreate the directory afterwards.
		await this.writes;
		await rm(this.conversationDir(id), { recursive: true, force: true });
	}

	private async writeConversation(record: ConversationRecord): Promise<void> {
		await writeFileAtomically(
			join(this.conversationDir(record.id), "conversation.json"),
			`${JSON.stringify(record)}\n`,
		);
	}

	// ---- responses -------------------------------------------------------------------------

	getResponse(id: string): ResponseRecord | undefined {
		return this.responses.get(id);
	}

	/** A conversation's responses, oldest first. */
	listResponses(conversationId: string): ResponseRecord[] {
		return (this.order.get(conversationId) ?? []).flatMap((id) => {
			const record = this.responses.get(id);
			return record ? [record] : [];
		});
	}

	latestResponseId(conversationId: string): string | undefined {
		return this.order.get(conversationId)?.at(-1);
	}

	/**
	 * Record a response's current state: the first call for an id also registers it in the conversation.
	 * Registration is immediate; the disk writes happen in call order, so the last snapshot on disk is
	 * always the last one saved (the first save also writes the index line, which would otherwise let a
	 * later snapshot overtake it).
	 */
	saveResponse(record: ResponseRecord): Promise<void> {
		if (record.request_scoped && record.store === false) return Promise.resolve();
		// A late snapshot of a deleted conversation's response (one that was settling) is dropped.
		if (!record.request_scoped && !this.conversations.has(record.conversation_id)) return Promise.resolve();
		const isNew = !this.responses.has(record.id);
		this.responses.set(record.id, record);
		if (isNew && !record.request_scoped) {
			const ids = this.order.get(record.conversation_id) ?? [];
			ids.push(record.id);
			this.order.set(record.conversation_id, ids);
		}
		const snapshot = structuredClone(record);
		const written = this.writes.then(async () => {
			if (isNew) {
				await this.appender.appendStrict({
					path: join(this.dir, "responses.jsonl"),
					record: { id: snapshot.id, conversation_id: snapshot.conversation_id },
				});
			}
			await this.appendSnapshot(snapshot);
		});
		this.writes = written.catch(() => undefined);
		return written;
	}

	private appendSnapshot(record: ResponseRecord): Promise<void> {
		return this.appender.appendStrict({
			path: record.request_scoped
				? join(this.dir, "standalone.jsonl")
				: join(this.conversationDir(record.conversation_id), "responses.jsonl"),
			record,
		});
	}

	async close(): Promise<void> {
		await this.writes;
		await this.appender.close();
	}
}
