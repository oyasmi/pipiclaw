import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import * as log from "../log.js";
import { localDayKey } from "../shared/local-time.js";
import { isNodeError } from "../shared/os.js";
import { errorMessage } from "../shared/text-utils.js";
import { getJournalDir } from "./journal.js";
import { type SearchIndexHandle, transaction } from "./search-index-db.js";
import { listIndexSourceEntries, sameIndexSourceStat, statIndexSource } from "./search-index-files.js";
import {
	buildMatchExpression,
	effectiveTermCount,
	matchedTerms,
	type QueryTerms,
	searchTextFor,
	windowAroundDensestMatch,
} from "./search-terms.js";
import { redactSecrets } from "./secret-redaction.js";
import { getMemoryDir, isValidMemoryName, parseMemoryFile } from "./store.js";

const WORKSPACE_MEMORY_PATH = "../MEMORY.md";
const MAX_LINE_CHARS = 200;

export interface MemorySearchHit {
	kind: "memory" | "journal" | "workspace";
	/** Entry name, journal date, or workspace heading. */
	label: string;
	date?: string;
	line: string;
}

interface NoteSource {
	path: string;
	relPath: string;
	kind: MemorySearchHit["kind"];
}

interface Note {
	kind: MemorySearchHit["kind"];
	label: string;
	date?: string;
	expires?: string;
	text: string;
}

interface NoteFileState {
	path: string;
	ino: number;
	size: number;
	mtime_ms: number;
}

async function listNoteSources(deskDir: string, workspaceDir: string): Promise<NoteSource[]> {
	const memoryDir = getMemoryDir(deskDir);
	const journalDir = getJournalDir(deskDir);
	const [memory, journal] = await Promise.all([listIndexSourceEntries(memoryDir), listIndexSourceEntries(journalDir)]);
	return [
		...memory
			.filter(
				(entry) => entry.isFile() && entry.name.endsWith(".md") && isValidMemoryName(basename(entry.name, ".md")),
			)
			.map(({ name }) => ({ kind: "memory", path: join(memoryDir, name), relPath: `memory/${name}` }) as const),
		...journal
			.filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name))
			.map(({ name }) => ({ kind: "journal", path: join(journalDir, name), relPath: `journal/${name}` }) as const),
		{ kind: "workspace", path: join(workspaceDir, "MEMORY.md"), relPath: WORKSPACE_MEMORY_PATH },
	];
}

function notesFromFile(source: NoteSource, raw: string, fallbackDate: string): Note[] {
	switch (source.kind) {
		case "memory": {
			const { description, body, name, updated, expires } = parseMemoryFile(
				basename(source.path, ".md"),
				raw,
				fallbackDate,
			);
			return [{ kind: "memory", label: name, date: updated, expires, text: `${description}\n${body}`.trim() }];
		}
		case "journal": {
			const date = basename(source.path, ".md");
			return raw
				.split("\n")
				.map((line) => line.replace(/^[-*]\s*/, "").trim())
				.filter((line) => line && !line.startsWith("#"))
				.map((text) => ({ kind: "journal", label: date, date, text }));
		}
		case "workspace":
			return raw
				.split(/(?=^## )/m)
				.map((text) => text.trim())
				.filter(Boolean)
				.map((text) => ({
					kind: "workspace",
					label: /^## ([^\n]+)/.exec(text)?.[1]?.trim() ?? "Background",
					text,
				}));
	}
}

export async function syncNoteSources(handle: SearchIndexHandle, deskDir: string, workspaceDir: string): Promise<void> {
	const db = handle.db;
	const files = db
		.prepare("SELECT path, ino, size, mtime_ms FROM files WHERE kind IN ('memory', 'journal', 'workspace')")
		.all() as unknown as NoteFileState[];
	const previous = new Map(files.map((file) => [file.path, file]));
	const deleteNotes = db.prepare("DELETE FROM notes WHERE path = ?");
	const deleteFile = db.prepare("DELETE FROM files WHERE path = ?");
	const insertNote = db.prepare(
		"INSERT INTO notes(path, kind, label, date, expires, text, search_text) VALUES (?, ?, ?, ?, ?, ?, ?)",
	);
	const upsertFile = db.prepare(`
		INSERT INTO files VALUES (?, ?, NULL, ?, ?, ?, ?, 0, 0, '')
		ON CONFLICT(path) DO UPDATE SET ino=excluded.ino, size=excluded.size,
			mtime_ms=excluded.mtime_ms, indexed_bytes=excluded.indexed_bytes
	`);
	const sources = await listNoteSources(deskDir, workspaceDir);
	for (let offset = 0; offset < sources.length; offset += 64) {
		const batch = sources.slice(offset, offset + 64);
		const metadata = await Promise.allSettled(batch.map((source) => statIndexSource(source.path)));
		for (const [index, source] of batch.entries()) {
			const file = previous.get(source.relPath);
			const result = metadata[index];
			let notes: Note[];
			try {
				if (result.status === "rejected") throw result.reason;
				if (!result.value) continue;
				if (file && sameIndexSourceStat(file, result.value)) {
					previous.delete(source.relPath);
					continue;
				}
				notes = notesFromFile(source, await readFile(source.path, "utf8"), localDayKey(result.value.mtime));
			} catch (error) {
				if (!isNodeError(error)) throw error;
				if (error.code !== "ENOENT") {
					previous.delete(source.relPath);
					log.logWarn("memory.search_index.sync_failed", "Search index sync failed", {
						reason: errorMessage(error),
						fields: { path: source.path },
					});
				}
				continue;
			}
			const { ino, size, mtimeMs } = result.value;
			transaction(db, () => {
				deleteNotes.run(source.relPath);
				for (const note of notes) {
					const text = redactSecrets(note.text);
					if (!text) continue;
					insertNote.run(
						source.relPath,
						note.kind,
						redactSecrets(note.label),
						note.date ?? null,
						note.expires ?? null,
						text,
						searchTextFor(text),
					);
				}
				upsertFile.run(source.relPath, source.kind, ino, size, mtimeMs, size);
			});
			previous.delete(source.relPath);
		}
	}
	for (const path of previous.keys()) {
		transaction(db, () => {
			deleteNotes.run(path);
			deleteFile.run(path);
		});
	}
}

function densestLine(text: string, terms: QueryTerms): string {
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	let best = { text: lines[0] ?? text.trim(), matches: [] as string[], units: 0 };
	for (const line of lines) {
		const matched = matchedTerms(line, terms);
		const units = effectiveTermCount(matched);
		const matches = [...matched.latin, ...matched.cjk];
		if (units > best.units || (units === best.units && matches.length > best.matches.length)) {
			best = { text: line, units, matches };
		}
	}
	return windowAroundDensestMatch(best.text, best.matches, MAX_LINE_CHARS, "…");
}

export function queryNotes(
	handle: SearchIndexHandle,
	terms: QueryTerms,
	today: string,
	limit: number,
): MemorySearchHit[] {
	const expression = buildMatchExpression(terms);
	if (!expression) return [];
	const rows = handle.db
		.prepare(`
		SELECT n.kind, n.label, n.date, n.text, bm25(notes_fts) AS rank
		FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid
		WHERE notes_fts MATCH ? AND (n.expires IS NULL OR n.expires >= ?)
		ORDER BY rank, n.date DESC, n.path, n.id LIMIT ?
	`)
		.all(expression, today, limit) as unknown as Array<{
		kind: MemorySearchHit["kind"];
		label: string;
		date: string | null;
		text: string;
	}>;
	return rows.map(({ kind, label, date, text }) => ({
		kind,
		label,
		date: date ?? undefined,
		line: densestLine(text, terms),
	}));
}
