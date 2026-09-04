import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { readOptionalTextFile } from "../shared/fs-utils.js";
import { localDayKey } from "../shared/local-time.js";

/**
 * Spec 050, D5: `journal/YYYY-MM-DD.md`, append-only, one file per local day. Replaces
 * `SESSION.md` (current state) and `HISTORY.md` (folded older history) — a day is never
 * folded or rewritten, only appended to, so it stays a plain, growing record.
 */

export function getJournalDir(channelDir: string): string {
	return join(channelDir, "journal");
}

export function getJournalPath(channelDir: string, date: string): string {
	return join(getJournalDir(channelDir), `${date}.md`);
}

export async function readJournalDay(channelDir: string, date: string = localDayKey()): Promise<string> {
	return readOptionalTextFile(getJournalPath(channelDir, date));
}

export async function listJournalDates(channelDir: string): Promise<string[]> {
	try {
		const files = await readdir(getJournalDir(channelDir));
		return files
			.filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
			.map((f) => f.slice(0, -3))
			.sort();
	} catch {
		return [];
	}
}

function normalizeLine(line: string): string {
	return line
		.replace(/^[-*]\s*/, "")
		.replace(/^\d{2}:\d{2}\s+/, "")
		.normalize("NFKC")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

export interface JournalAppendResult {
	appended: number;
	skippedDuplicate: number;
}

/**
 * Append `lines` (bare text, no `- ` prefix) to today's journal, skipping any line whose
 * normalized text (time prefix stripped) already appears in the day — the reflect pass can see
 * the day it is about to write to, but a deterministic backstop costs nothing and protects a
 * hand-edited file too.
 */
export async function appendJournalEntries(
	channelDir: string,
	date: string,
	lines: string[],
): Promise<JournalAppendResult> {
	const trimmedLines = lines.map((line) => line.trim()).filter(Boolean);
	if (trimmedLines.length === 0) {
		return { appended: 0, skippedDuplicate: 0 };
	}

	await mkdir(getJournalDir(channelDir), { recursive: true });
	const path = getJournalPath(channelDir, date);
	const existing = await readOptionalTextFile(path);
	const existingNormalized = new Set(
		existing
			.split("\n")
			.filter((line) => line.trim().startsWith("-"))
			.map(normalizeLine),
	);

	const toAppend: string[] = [];
	let skippedDuplicate = 0;
	for (const line of trimmedLines) {
		const key = normalizeLine(line);
		if (existingNormalized.has(key)) {
			skippedDuplicate++;
			continue;
		}
		existingNormalized.add(key);
		toAppend.push(`- ${line}`);
	}
	if (toAppend.length === 0) {
		return { appended: 0, skippedDuplicate };
	}

	const header = `# ${date}`;
	const base = existing.trim() ? existing.trimEnd() : header;
	const next = `${base}\n${toAppend.join("\n")}\n`;
	await writeFileAtomically(path, next);
	return { appended: toAppend.length, skippedDuplicate };
}
