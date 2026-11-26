import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { type FileHandle, open, stat } from "node:fs/promises";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { DESK_DIR_PREFIX, isDeskEntry, isDeskName } from "../desk/paths.js";
import * as log from "../log.js";
import { parseLocalTime } from "../shared/local-time.js";
import { isNodeError, readOptionalTextFile } from "../shared/os.js";
import { errorMessage } from "../shared/text-utils.js";
import {
	getSearchIndexDir,
	getSearchIndexPath,
	removeSearchIndex,
	type SearchIndexHandle,
	transaction,
	withSearchIndex,
} from "./search-index-db.js";
import { searchTextFor } from "./search-terms.js";
import {
	archivedTaskDoc,
	dedupKey,
	listDeskTranscriptSources,
	listIndexSourceEntries,
	parseJsonLine,
	parseTranscriptLine,
	type TranscriptDoc,
	type TranscriptSourceFile,
} from "./session-corpus.js";

export interface DeskIndexTarget {
	appHomeDir: string;
	desk: string;
	deskDir: string;
}

export interface SyncStats {
	filesScanned: number;
	filesIndexed: number;
	filesAppended: number;
	filesRebuilt: number;
	filesRemoved: number;
	docsAdded: number;
	durationMs: number;
	maxSliceMs: number;
}

interface FileProgress {
	path: string;
	ino: number;
	size: number;
	mtime_ms: number;
	indexed_bytes: number;
	indexed_lines: number;
	head_len: number;
	head_hash: string;
}

const HEAD_BYTES = 4096;
const SLICE_ROWS = 2_000;
// Leave room for SQLite commit and the final row (individual transcript lines vary in size).
const SLICE_WORK_MS = 22;

function sha1(value: string | Buffer): string {
	return createHash("sha1").update(value).digest("hex");
}

function makeWriter(db: SearchIndexHandle["db"]) {
	const listFiles = db.prepare("SELECT * FROM files WHERE kind IN ('session', 'log', 'task')");
	const upsertFile = db.prepare(`
		INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(path) DO UPDATE SET kind=excluded.kind, conversation=excluded.conversation,
			ino=excluded.ino, size=excluded.size, mtime_ms=excluded.mtime_ms, indexed_bytes=excluded.indexed_bytes,
			indexed_lines=excluded.indexed_lines, head_len=excluded.head_len, head_hash=excluded.head_hash
	`);
	const deleteFile = db.prepare("DELETE FROM files WHERE path = ?");
	const readDocId = db.prepare("SELECT id FROM docs WHERE hash = ?");
	const insertDoc = db.prepare(`
		INSERT INTO docs(hash, role, text, search_text, truncated) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(hash) DO NOTHING
	`);
	const oldDocIds = db.prepare("SELECT DISTINCT doc_id FROM refs WHERE path = ?");
	const deleteRefs = db.prepare("DELETE FROM refs WHERE path = ?");
	// We only insert beyond committed progress or after removing all refs for a rebuilt file.
	const insertRef = db.prepare("INSERT INTO refs VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
	const orphanStatements = new Map<number, ReturnType<typeof db.prepare>>();

	return {
		files: () => listFiles.all() as unknown as FileProgress[],
		progress(source: TranscriptSourceFile, state: FileProgress) {
			upsertFile.run(
				state.path,
				source.kind,
				source.conversation ?? null,
				state.ino,
				state.size,
				state.mtime_ms,
				state.indexed_bytes,
				state.indexed_lines,
				state.head_len,
				state.head_hash,
			);
		},
		remove(path: string) {
			const ids = oldDocIds.all(path).map(({ doc_id }) => Number(doc_id));
			deleteRefs.run(path);
			deleteFile.run(path);
			for (let i = 0; i < ids.length; i += 500) {
				const batch = ids.slice(i, i + 500);
				let statement = orphanStatements.get(batch.length);
				if (!statement) {
					statement = db.prepare(
						`DELETE FROM docs WHERE id IN (${batch.map(() => "?").join(",")})
						 AND NOT EXISTS (SELECT 1 FROM refs WHERE refs.doc_id = docs.id)`,
					);
					orphanStatements.set(batch.length, statement);
				}
				statement.run(...batch);
			}
		},
		add(source: TranscriptSourceFile, line: number, doc: TranscriptDoc): number {
			const hash = sha1(`${doc.role}\0${dedupKey(doc.text)}`);
			const existing = readDocId.get(hash);
			const inserted = existing
				? undefined
				: insertDoc.run(hash, doc.role, doc.text, searchTextFor(doc.text), Number(doc.truncated));
			const id = existing?.id ?? (inserted?.changes ? inserted.lastInsertRowid : readDocId.get(hash)?.id);
			insertRef.run(
				source.relPath,
				line,
				Number(id),
				source.source,
				source.conversation ?? null,
				doc.speaker ?? null,
				doc.ts ?? null,
				doc.ts ? (parseLocalTime(doc.ts) ?? null) : null,
			);
			return inserted?.changes ? 1 : 0;
		},
	};
}

type Writer = ReturnType<typeof makeWriter>;

function measureTransaction(db: SearchIndexHandle["db"], stats: SyncStats, work: (started: number) => void): void {
	const started = performance.now();
	transaction(db, () => work(started));
	stats.maxSliceMs = Math.max(stats.maxSliceMs, performance.now() - started);
}

async function readRange(file: FileHandle, start: number, end: number): Promise<Buffer> {
	const buffer = Buffer.allocUnsafe(end - start);
	let offset = 0;
	while (offset < buffer.length) {
		const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, start + offset);
		if (bytesRead === 0) break;
		offset += bytesRead;
	}
	return buffer.subarray(0, offset);
}

function sameStat(previous: FileProgress, current: Stats): boolean {
	return previous.ino === current.ino && previous.size === current.size && previous.mtime_ms === current.mtimeMs;
}

async function syncJsonl(
	db: SearchIndexHandle["db"],
	writer: Writer,
	source: TranscriptSourceFile,
	previous: FileProgress | undefined,
	stats: SyncStats,
	listed: Stats,
): Promise<void> {
	if (previous && previous.indexed_bytes === listed.size && sameStat(previous, listed)) return;
	const file = await open(source.path, "r");
	try {
		const current = await file.stat();
		const head = await readRange(file, 0, Math.min(HEAD_BYTES, current.size));
		const replaced =
			previous &&
			((previous.ino !== 0 && current.ino !== 0 && previous.ino !== current.ino) ||
				current.size < previous.size ||
				(current.size === previous.size && current.mtimeMs !== previous.mtime_ms) ||
				sha1(head.subarray(0, previous.head_len)) !== previous.head_hash);
		const state: FileProgress = {
			path: source.relPath,
			ino: current.ino,
			size: current.size,
			mtime_ms: current.mtimeMs,
			indexed_bytes: replaced ? 0 : (previous?.indexed_bytes ?? 0),
			indexed_lines: replaced ? 0 : (previous?.indexed_lines ?? 0),
			head_len: head.length,
			head_hash: sha1(head),
		};
		const data = await readRange(file, state.indexed_bytes, current.size);
		// A truncation during the read must not commit progress for a snapshot that vanished.
		if (data.length !== current.size - state.indexed_bytes || head.length !== Math.min(HEAD_BYTES, current.size))
			return;
		const consumed = data.lastIndexOf(0x0a) + 1;
		if (!consumed && previous && !replaced) return;
		let cursor = 0;
		do {
			measureTransaction(db, stats, (started) => {
				if (cursor === 0 && replaced) writer.remove(source.relPath);
				let rows = 0;
				while (cursor < consumed) {
					const end = data.indexOf(0x0a, cursor);
					const doc = parseTranscriptLine(source.source, parseJsonLine(data.toString("utf8", cursor, end)));
					state.indexed_lines++;
					if (doc) stats.docsAdded += writer.add(source, state.indexed_lines, doc);
					state.indexed_bytes += end + 1 - cursor;
					cursor = end + 1;
					if (++rows >= SLICE_ROWS || performance.now() - started >= SLICE_WORK_MS) break;
				}
				writer.progress(source, state);
			});
			await yieldToLoop();
		} while (cursor < consumed);
		if (replaced) stats.filesRebuilt++;
		else if (previous) stats.filesAppended++;
		else stats.filesIndexed++;
	} finally {
		await file.close();
	}
}

async function optionalStat(path: string): Promise<Stats | undefined> {
	try {
		return await stat(path);
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") throw error;
		return undefined;
	}
}

async function syncTask(
	db: SearchIndexHandle["db"],
	writer: Writer,
	source: TranscriptSourceFile,
	previous: FileProgress | undefined,
	stats: SyncStats,
	md: Stats,
): Promise<void> {
	const jsonlPath = source.path.replace(/\.md$/, ".jsonl");
	const jsonl = await optionalStat(jsonlPath);
	const mtimeMs = Math.max(md.mtimeMs, jsonl?.mtimeMs ?? 0);
	const size = md.size + (jsonl?.size ?? 0);
	// Keep each member's fingerprint: max mtime and total bytes alone can hide a replaced sibling.
	const fingerprint = sha1(JSON.stringify([md.ino, md.mtimeMs, md.size, jsonl?.ino, jsonl?.mtimeMs, jsonl?.size]));
	if (previous?.head_hash === fingerprint) return;
	const [markdown, notes] = await Promise.all([readOptionalTextFile(source.path), readOptionalTextFile(jsonlPath)]);
	const doc = archivedTaskDoc(source.path, markdown, notes, md.mtimeMs);
	measureTransaction(db, stats, () => {
		if (previous) writer.remove(source.relPath);
		if (doc) stats.docsAdded += writer.add(source, 0, doc);
		writer.progress(source, {
			path: source.relPath,
			ino: md.ino,
			size,
			mtime_ms: mtimeMs,
			indexed_bytes: size,
			indexed_lines: 0,
			head_len: 0,
			head_hash: fingerprint,
		});
	});
	await yieldToLoop();
	if (previous) stats.filesRebuilt++;
	else stats.filesIndexed++;
}

export async function syncTranscriptSources(handle: SearchIndexHandle, deskDir: string): Promise<SyncStats> {
	const started = performance.now();
	const db = handle.db;
	const writer = makeWriter(db);
	const sources = await listDeskTranscriptSources(deskDir);
	const previous = new Map(writer.files().map((state) => [state.path, state]));
	const stats: SyncStats = {
		filesScanned: sources.length,
		filesIndexed: 0,
		filesAppended: 0,
		filesRebuilt: 0,
		filesRemoved: 0,
		docsAdded: 0,
		durationMs: 0,
		maxSliceMs: 0,
	};
	// Batch metadata reads while keeping SQLite writes serialized and bounding outstanding I/O.
	for (let i = 0; i < sources.length; i += 64) {
		const batch = sources.slice(i, i + 64);
		const metadata = await Promise.allSettled(batch.map((source) => optionalStat(source.path)));
		for (const [index, source] of batch.entries()) {
			const state = previous.get(source.relPath);
			previous.delete(source.relPath);
			const result = metadata[index];
			try {
				if (result.status === "rejected") throw result.reason;
				if (!result.value) {
					if (state) previous.set(source.relPath, state);
				} else if (source.kind === "task") {
					await syncTask(db, writer, source, state, stats, result.value);
				} else {
					await syncJsonl(db, writer, source, state, stats, result.value);
				}
			} catch (error) {
				// Handle source I/O independently. SQLite faults must reach the connection's recovery loop.
				if (!isNodeError(error) || error.code?.startsWith("ERR_SQLITE")) throw error;
				if (error.code === "ENOENT" && state) previous.set(source.relPath, state);
				else if (error.code !== "ENOENT") {
					log.logWarn("memory.search_index.sync_failed", "Search index sync failed", {
						reason: errorMessage(error),
						fields: { path: source.path },
					});
				}
			}
		}
	}
	for (const path of previous.keys()) {
		measureTransaction(db, stats, () => writer.remove(path));
		stats.filesRemoved++;
		await yieldToLoop();
	}
	stats.durationMs = performance.now() - started;
	return stats;
}

export function syncDeskSearchIndex(target: DeskIndexTarget): Promise<SyncStats> {
	return withSearchIndex(getSearchIndexPath(target.appHomeDir, target.desk), (handle) =>
		syncTranscriptSources(handle, target.deskDir),
	);
}

export async function pruneOrphanSearchIndexes(appHomeDir: string, workspaceDir: string): Promise<string[]> {
	const indexDir = getSearchIndexDir(appHomeDir);
	const [indexes, entries] = await Promise.all([
		listIndexSourceEntries(indexDir),
		listIndexSourceEntries(workspaceDir),
	]);
	const desks = new Set(entries.filter(isDeskEntry).map((entry) => entry.name));
	const orphans = new Set<string>();
	for (const entry of indexes) {
		const desk = /^(.+)\.sqlite(?:-wal|-shm)?$/.exec(entry.name)?.[1];
		if (desk && isDeskName(desk) && !desks.has(`${DESK_DIR_PREFIX}${desk}`)) orphans.add(desk);
	}
	await Promise.all([...orphans].map((desk) => removeSearchIndex(getSearchIndexPath(appHomeDir, desk))));
	return [...orphans];
}
