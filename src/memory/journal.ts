import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { localDayKey } from "../shared/local-time.js";
import { isNodeError, readOptionalTextFile } from "../shared/os.js";
import { redactSecrets } from "./secret-redaction.js";

/**
 * Spec 050, D5: `journal/YYYY-MM-DD.md`, append-only, one file per local day — never folded or
 * rewritten, so it stays a plain, growing record.
 */

export function getJournalDir(deskDir: string): string {
	return join(deskDir, "journal");
}

export function getJournalPath(deskDir: string, date: string): string {
	return join(getJournalDir(deskDir), `${date}.md`);
}

export async function readJournalDay(deskDir: string, date: string = localDayKey()): Promise<string> {
	return readOptionalTextFile(getJournalPath(deskDir, date));
}

export async function listJournalDates(deskDir: string): Promise<string[]> {
	try {
		const files = await readdir(getJournalDir(deskDir));
		return files
			.filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
			.map((f) => f.slice(0, -3))
			.sort();
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return [];
		throw error;
	}
}

/** Read today's journal and, when present, the most recent earlier day for morning backfill (B2). */
export async function readRecentJournalForBootstrap(
	deskDir: string,
	today: string = localDayKey(),
): Promise<{ todayText: string; previous?: { date: string; text: string } }> {
	const [todayText, dates] = await Promise.all([readJournalDay(deskDir, today), listJournalDates(deskDir)]);
	const previousDate = dates.filter((date) => date < today).at(-1);
	if (!previousDate) return { todayText };
	const previousText = await readJournalDay(deskDir, previousDate);
	return previousText.trim() ? { todayText, previous: { date: previousDate, text: previousText } } : { todayText };
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
	deskDir: string,
	date: string,
	lines: string[],
): Promise<JournalAppendResult> {
	const trimmedLines = lines.map((line) => redactSecrets(line).trim()).filter(Boolean);
	if (trimmedLines.length === 0) {
		return { appended: 0, skippedDuplicate: 0 };
	}

	await mkdir(getJournalDir(deskDir), { recursive: true });
	const path = getJournalPath(deskDir, date);
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
