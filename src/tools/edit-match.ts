import type { FileStore } from "../file-store.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";

const MAX_DIAGNOSTIC_LINES = 10;
const BINARY_SNIFF_BYTES = 8 * 1024;
const MAX_REPLACE_ALL_OFFSETS = 200_000;
const CRLF = Buffer.from("\r\n");
const BARE_LF = /(?<!\r)\n/g;

export interface EditHunk {
	oldText: string;
	newText: string;
	replaceAll?: boolean;
}

interface EditInterval {
	start: number;
	end: number;
	replacement: Buffer;
	hunk: number;
}

function toCrlf(text: string) {
	return Buffer.from(text.replace(BARE_LF, "\r\n"));
}

function canRetryWithCrlf(text: string): boolean {
	return text.includes("\n") && !text.includes("\r\n");
}

function usesCrlfForReplacement(firstNewlineIsCrlf: boolean, oldText: string): boolean {
	return firstNewlineIsCrlf && (!oldText.includes("\n") || oldText.includes("\r\n"));
}

function binaryFileError(path: string): RecoverableToolError {
	return new RecoverableToolError(
		`${path} looks like a binary file (a NUL byte appears in the first ${BINARY_SNIFF_BYTES} bytes). Use bash for binary edits.`,
	);
}

function duplicateError(path: string, count: number, lines: number[]): RecoverableToolError {
	const more = count > lines.length ? ` +${count - lines.length} more` : "";
	return new RecoverableToolError(
		`Found ${count} occurrences of oldText in ${path} (at lines ${lines.join(", ")}${more}). Include more surrounding lines to uniquely identify the target, or set replaceAll: true.`,
	);
}

function missingError(path: string, nearLines: number[] = []): RecoverableToolError {
	return new RecoverableToolError(
		`Could not find exact oldText in ${path}. ` +
			(nearLines.length
				? `Near-matches with different whitespace/indentation appear around lines ${nearLines.join(", ")} — read that range to copy exact whitespace.`
				: `Re-read ${path} around the target section to verify current content.`),
	);
}

/** All non-overlapping byte offsets of `needle` in `haystack`, left to right (mirrors `String.split`). */
function findAllOffsets(haystack: Buffer, needle: Buffer): number[] {
	const offsets: number[] = [];
	let from = 0;
	while (true) {
		const idx = haystack.indexOf(needle, from);
		if (idx === -1) break;
		offsets.push(idx);
		from = idx + needle.length;
	}
	return offsets;
}

function linesAtOffsets(data: Buffer, offsets: number[]): number[] {
	let cursor = 0;
	let line = 1;
	return offsets.slice(0, MAX_DIAGNOSTIC_LINES).map((offset) => {
		line += countNewlines(data, cursor, offset);
		cursor = offset;
		return line;
	});
}

function findNearWhitespaceLines(data: Buffer, text: string): number[] {
	const anchor = text.split("\n").find((line) => line.trim());
	if (!anchor) return [];
	const trimmed = anchor.trim();
	const lines: number[] = [];
	let start = 0;
	for (let line = 1; start < data.length && lines.length < 5; line++) {
		const newline = data.indexOf(0x0a, start);
		const end = newline < 0 ? data.length : newline;
		const candidate = data.toString("utf-8", start, end).replace(/\r$/, "");
		if (candidate !== anchor.replace(/\r$/, "") && candidate.trim() === trimmed) lines.push(line);
		start = end + 1;
	}
	return lines;
}

function spliceIntervals(data: Buffer, intervals: EditInterval[]): Buffer {
	const size = intervals.reduce(
		(length, entry) => length + entry.replacement.length - (entry.end - entry.start),
		data.length,
	);
	const result = Buffer.allocUnsafe(size);
	let cursor = 0;
	let written = 0;
	for (const { start, end, replacement } of intervals) {
		written += data.copy(result, written, cursor, start);
		written += replacement.copy(result, written);
		cursor = end;
	}
	data.copy(result, written, cursor);
	return result;
}

/** Resolve every edit against the original bytes before assembling any replacement. */
export function planInlineEdit(data: Buffer, path: string, hunks: EditHunk[]) {
	if (data.subarray(0, BINARY_SNIFF_BYTES).includes(0)) throw binaryFileError(path);
	const firstLf = data.indexOf(0x0a);
	const firstNewlineIsCrlf = firstLf > 0 && data[firstLf - 1] === 0x0d;
	const containsCrlf = firstNewlineIsCrlf || data.includes(CRLF);
	const intervals: EditInterval[] = [];
	for (const [index, { oldText, newText, replaceAll }] of hunks.entries()) {
		let needle = Buffer.from(oldText);
		let offsets = findAllOffsets(data, needle);
		let useCrlf = usesCrlfForReplacement(firstNewlineIsCrlf, oldText);
		if (offsets.length === 0 && containsCrlf && canRetryWithCrlf(oldText)) {
			needle = toCrlf(oldText);
			offsets = findAllOffsets(data, needle);
			useCrlf = true;
		}
		const location = hunks.length > 1 ? `${path} (edit #${index + 1})` : path;
		if (offsets.length === 0) throw missingError(location, findNearWhitespaceLines(data, oldText));
		if (offsets.length > 1 && !replaceAll)
			throw duplicateError(location, offsets.length, linesAtOffsets(data, offsets));
		const replacement = useCrlf ? toCrlf(newText) : Buffer.from(newText);
		for (const start of offsets) intervals.push({ start, end: start + needle.length, replacement, hunk: index + 1 });
	}
	intervals.sort((a, b) => a.start - b.start);
	for (let i = 1; i < intervals.length; i++) {
		const previous = intervals[i - 1];
		const current = intervals[i];
		if (previous.end > current.start) {
			const line = linesAtOffsets(data, [current.start])[0];
			throw new RecoverableToolError(
				`Edits #${previous.hunk} and #${current.hunk} overlap around line ${line}; merge them into one edit hunk.`,
			);
		}
	}
	return { newData: spliceIntervals(data, intervals), occurrences: intervals.length };
}

export async function planStreamingEdit(
	fileStore: FileStore,
	target: string,
	path: string,
	{ oldText, newText, replaceAll }: EditHunk,
	signal?: AbortSignal,
) {
	let needle = Buffer.from(oldText);
	const scanFor = (text: Buffer) =>
		scanOccurrences(
			readStreamChunks(fileStore, target, signal),
			text,
			replaceAll ? MAX_REPLACE_ALL_OFFSETS : MAX_DIAGNOSTIC_LINES,
		);
	let scan = await scanFor(needle);
	let useCrlf = usesCrlfForReplacement(scan.firstNewlineIsCrlf, oldText);
	if (scan.looksBinary) throw binaryFileError(path);
	if (scan.count === 0 && scan.headContainsCrlf && canRetryWithCrlf(oldText)) {
		needle = toCrlf(oldText);
		scan = await scanFor(needle);
		useCrlf = true;
		if (scan.looksBinary) throw binaryFileError(path);
	}
	if (scan.count === 0) throw missingError(path);
	if (scan.count > 1 && !replaceAll) throw duplicateError(path, scan.count, [...scan.lineNumbers.values()]);
	if (!scan.offsets) {
		throw new RecoverableToolError(
			`${path} has more than ${MAX_REPLACE_ALL_OFFSETS} matches. Add context to oldText to match fewer places.`,
		);
	}
	return {
		needle,
		replacement: useCrlf ? toCrlf(newText) : Buffer.from(newText),
		matchOffsets: scan.offsets,
		lineNumbers: scan.lineNumbers,
	};
}

/**
 * A streaming scan for every non-overlapping occurrence of `needle`, safe against a match that
 * straddles a chunk boundary (D2.2). Carries the last `needle.length - 1` bytes of each window into
 * the next iteration so a split match is still found, without ever holding more than one window in
 * memory. Also tracks the 1-indexed line number of each match (from a running newline count) and
 * sniffs the first `BINARY_SNIFF_BYTES` for a NUL byte (D2.5).
 */
async function scanOccurrences(
	stream: AsyncIterable<Buffer>,
	needle: Buffer,
	maxOffsets: number,
): Promise<{
	count: number;
	offsets: number[] | undefined;
	lineNumbers: Map<number, number>;
	looksBinary: boolean;
	firstNewlineIsCrlf: boolean;
	headContainsCrlf: boolean;
}> {
	const overlapLen = needle.length - 1;
	let carry: Buffer = Buffer.alloc(0);
	let windowBaseOffset = 0;
	let newlinesBeforeWindow = 0;
	let count = 0;
	// Absolute byte position just past the last accepted match. A window carries the last
	// `overlapLen` bytes of its predecessor, so without this guard a match that ended inside the
	// carry region would be re-found (from a fresh `from = 0`) and reported as a second, overlapping
	// offset -- which `spliceBuffer` then turns into a corrupt file. Verified against a non-overlapping
	// `Buffer.indexOf` reference over 165 boundary combinations.
	let nextAllowed = 0;
	let offsets: number[] | undefined = [];
	const lineNumbers = new Map<number, number>();
	let looksBinary = false;
	let sniffed = 0;
	let headContainsCrlf = false;
	let previousSniffedByte: number | undefined;
	let firstNewlineIsCrlf: boolean | undefined;
	let previousByte: number | undefined;
	const CR = 0x0d;

	for await (const chunk of stream) {
		if (firstNewlineIsCrlf === undefined) {
			const newline = chunk.indexOf(0x0a);
			if (newline >= 0) firstNewlineIsCrlf = (newline === 0 ? previousByte : chunk[newline - 1]) === CR;
			previousByte = chunk.at(-1) ?? previousByte;
		}
		if (sniffed < BINARY_SNIFF_BYTES) {
			const take = chunk.subarray(0, BINARY_SNIFF_BYTES - sniffed);
			if (take.includes(0)) looksBinary = true;
			headContainsCrlf ||= (previousSniffedByte === CR && take[0] === 0x0a) || take.includes(CRLF);
			previousSniffedByte = take.at(-1) ?? previousSniffedByte;
			sniffed += take.length;
		}

		const window = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
		let from = Math.max(0, nextAllowed - windowBaseOffset);
		let lineFrom = 0;
		let line = newlinesBeforeWindow + 1;
		while (true) {
			const idx = window.indexOf(needle, from);
			if (idx === -1) break;
			const absoluteOffset = windowBaseOffset + idx;
			count++;
			nextAllowed = absoluteOffset + needle.length;
			if (offsets && offsets.length < maxOffsets) {
				offsets.push(absoluteOffset);
				// Only the first few matches need line numbers for diagnostics or diff windows.
				if (lineNumbers.size < MAX_DIAGNOSTIC_LINES) {
					line += countNewlines(window, lineFrom, idx);
					lineFrom = idx;
					lineNumbers.set(absoluteOffset, line);
				}
			} else if (offsets) {
				offsets = undefined; // Overflowed: stop tracking, caller must fail closed if it needed them.
			}
			from = idx + needle.length;
		}

		const retiredLen = Math.max(0, window.length - overlapLen);
		newlinesBeforeWindow += countNewlines(window, 0, retiredLen);
		windowBaseOffset += retiredLen;
		carry = window.subarray(retiredLen);
	}

	return {
		count,
		offsets,
		lineNumbers,
		looksBinary,
		firstNewlineIsCrlf: firstNewlineIsCrlf === true,
		headContainsCrlf,
	};
}

export function countNewlines(buf: Buffer, start: number, end: number): number {
	let n = 0;
	for (let i = start; i < end; i++) {
		if (buf[i] === 0x0a) n++;
	}
	return n;
}

async function* readStreamChunks(store: FileStore, path: string, signal?: AbortSignal): AsyncGenerator<Buffer> {
	for await (const chunk of store.openRead(path)) {
		if (signal?.aborted) throw new Error("Aborted");
		yield chunk as Buffer;
	}
}
