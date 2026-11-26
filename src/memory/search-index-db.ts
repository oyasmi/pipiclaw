import { chmodSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeskName } from "../desk/paths.js";
import * as log from "../log.js";
import { isNodeError } from "../shared/os.js";
import { createSerialQueue } from "../shared/serial-queue.js";
import { errorMessage } from "../shared/text-utils.js";
import { isRecord } from "../shared/type-guards.js";

type Sqlite = typeof import("node:sqlite");
type Database = InstanceType<Sqlite["DatabaseSync"]>;
const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE files (
	path TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	conversation TEXT,
	ino INTEGER NOT NULL,
	size INTEGER NOT NULL,
	mtime_ms INTEGER NOT NULL,
	indexed_bytes INTEGER NOT NULL,
	indexed_lines INTEGER NOT NULL,
	head_len INTEGER NOT NULL,
	head_hash TEXT NOT NULL
);
CREATE TABLE docs (
	id INTEGER PRIMARY KEY,
	hash TEXT NOT NULL UNIQUE,
	role TEXT NOT NULL,
	text TEXT NOT NULL,
	search_text TEXT,
	truncated INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE refs (
	path TEXT NOT NULL,
	line INTEGER NOT NULL,
	doc_id INTEGER NOT NULL,
	source TEXT NOT NULL,
	conversation TEXT,
	speaker TEXT,
	ts TEXT,
	ts_ms INTEGER,
	PRIMARY KEY (path, line)
) WITHOUT ROWID;
CREATE INDEX refs_doc ON refs(doc_id);
CREATE INDEX refs_ts ON refs(ts_ms);
CREATE VIEW docs_search AS SELECT id AS rid, coalesce(search_text, text) AS text FROM docs;
CREATE VIRTUAL TABLE docs_fts USING fts5(
	text, content='docs_search', content_rowid='rid', tokenize='unicode61'
);
CREATE TRIGGER docs_ai AFTER INSERT ON docs BEGIN
	INSERT INTO docs_fts(rowid, text) VALUES (new.id, coalesce(new.search_text, new.text));
END;
CREATE TRIGGER docs_ad AFTER DELETE ON docs BEGIN
	INSERT INTO docs_fts(docs_fts, rowid, text) VALUES ('delete', old.id, coalesce(old.search_text, old.text));
END;
CREATE TRIGGER docs_au AFTER UPDATE ON docs BEGIN
	INSERT INTO docs_fts(docs_fts, rowid, text) VALUES ('delete', old.id, coalesce(old.search_text, old.text));
	INSERT INTO docs_fts(rowid, text) VALUES (new.id, coalesce(new.search_text, new.text));
END;
`;

let sqlitePromise: Promise<Sqlite> | undefined;

function loadSqlite(): Promise<Sqlite> {
	sqlitePromise ??= (async () => {
		const original = process.emitWarning;
		process.emitWarning = ((...args: Parameters<typeof process.emitWarning>) => {
			const [warning, options] = args;
			const type = typeof options === "object" ? options?.type : options;
			if (type === "ExperimentalWarning" && typeof warning === "string" && warning.includes("SQLite")) return;
			Reflect.apply(original, process, args);
		}) as typeof original;
		try {
			return await import("node:sqlite");
		} finally {
			process.emitWarning = original;
		}
	})();
	return sqlitePromise;
}

export interface SearchIndexHandle {
	db: Database;
	ino: number;
}

const queue = createSerialQueue<string>();
const handles = new Map<string, SearchIndexHandle>();
const rebuiltOnce = new Set<string>();

export function getSearchIndexDir(appHomeDir: string): string {
	return resolve(appHomeDir, "state", "search-index");
}

export function getSearchIndexPath(appHomeDir: string, desk: string): string {
	if (!isDeskName(desk)) throw new Error(`Invalid desk name: ${desk}`);
	return join(getSearchIndexDir(appHomeDir), `${desk}.sqlite`);
}

export class SearchIndexUnavailableError extends Error {}

class IndexVersionMismatch extends Error {}

export function transaction<T>(db: Database, work: () => T): T {
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = work();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {
			// SQLite can already have rolled back the transaction. Preserve the original error.
		}
		throw error;
	}
}

function closeIndex(path: string): void {
	const handle = handles.get(path);
	if (!handle) return;
	handles.delete(path);
	handle.db.close();
}

export async function closeSearchIndexes(): Promise<void> {
	await Promise.all([...handles.keys()].map((path) => queue.run(path, async () => closeIndex(path))));
}

function removeIndexFiles(path: string): void {
	closeIndex(path);
	for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
}

export async function removeSearchIndex(path: string): Promise<void> {
	await queue.run(resolve(path), async () => removeIndexFiles(resolve(path)));
}

function statIndex(path: string) {
	try {
		return statSync(path);
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") throw error;
		return undefined;
	}
}

async function ensureOpen(path: string): Promise<SearchIndexHandle> {
	const stats = statIndex(path);
	const cached = handles.get(path);
	if (cached) {
		if (stats && stats.ino === cached.ino) return cached;
		removeIndexSidecars(path);
	}
	const { DatabaseSync } = await loadSqlite();
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const db = new DatabaseSync(path);
	try {
		// Set the mode before SQLite creates the WAL and SHM, which inherit the database mode.
		chmodSync(path, 0o600);
		db.exec("PRAGMA busy_timeout = 5000");
		const version = db.prepare("PRAGMA user_version").get()?.user_version;
		if (version !== SCHEMA_VERSION && (version !== 0 || (stats && stats.size > 0))) {
			throw new IndexVersionMismatch(`schema version ${version}, expected ${SCHEMA_VERSION}`);
		}
		db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL");
		if (version === 0) transaction(db, () => db.exec(`${SCHEMA} PRAGMA user_version = ${SCHEMA_VERSION}`));
		const handle = { db, ino: statSync(path).ino };
		handles.set(path, handle);
		return handle;
	} catch (error) {
		db.close();
		throw error;
	}
}

function removeIndexSidecars(path: string): void {
	closeIndex(path);
	rmSync(`${path}-wal`, { force: true });
	rmSync(`${path}-shm`, { force: true });
}

function rebuildable(error: unknown): boolean {
	return (
		error instanceof IndexVersionMismatch ||
		(isRecord(error) && error.code === "ERR_SQLITE_ERROR" && (error.errcode === 11 || error.errcode === 26))
	);
}

function unavailable(path: string, error: unknown): SearchIndexUnavailableError {
	const reason = errorMessage(error);
	log.logWarn("memory.search_index.open_failed", "Search index open failed", { reason, fields: { path } });
	return new SearchIndexUnavailableError(reason, { cause: error });
}

export function withSearchIndex<T>(path: string, job: (handle: SearchIndexHandle) => Promise<T>): Promise<T> {
	const key = resolve(path);
	return queue.run(key, async () => {
		for (;;) {
			let opened = false;
			try {
				const handle = await ensureOpen(key);
				opened = true;
				return await job(handle);
			} catch (error) {
				if (rebuildable(error) && !rebuiltOnce.has(key)) {
					rebuiltOnce.add(key);
					log.logWarn("memory.search_index.rebuilt", "Search index rebuild started", {
						reason: errorMessage(error),
						fields: { path: key },
					});
					try {
						removeIndexFiles(key);
					} catch (cleanupError) {
						throw unavailable(key, cleanupError);
					}
					continue;
				}
				// Generic SQL errors (including MATCH syntax errors) are programming errors.
				if (
					!opened ||
					rebuildable(error) ||
					(isRecord(error) && error.code === "ERR_SQLITE_ERROR" && error.errcode !== 1)
				) {
					throw unavailable(key, error);
				}
				throw error;
			}
		}
	});
}
