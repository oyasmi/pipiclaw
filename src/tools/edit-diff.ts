import * as Diff from "diff";
import type { FileStore } from "../file-store.js";
import { countNewlines } from "./edit-match.js";

const DIFF_ECHO_MAX_LINES = 40;
const DIFF_ECHO_MAX_BYTES = 8 * 1024;
const DIFF_WINDOW_BYTES = 2000;
const MAX_DIFF_WINDOWS = 5;

export function renderEditDiff(path: string, before: Buffer, after: Buffer) {
	const oldText = before.toString("utf-8");
	const newText = after.toString("utf-8");
	return { diff: generateDiffString(oldText, newText), patch: Diff.createPatch(path, oldText, newText) };
}

/**
 * Generate a unified diff string with line numbers and context. `startLineOld`/`startLineNew` let
 * a caller render a *window* of a larger file (spec 044, D2.3) while still printing the file's real
 * absolute line numbers instead of restarting at 1.
 */
function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
	startLineOld = 1,
	startLineNew = 1,
): string {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(startLineOld + oldLines.length, startLineNew + newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = startLineOld;
	let newLineNum = startLineNew;
	let lastWasChange = false;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);

			if (lastWasChange || nextPartIsChange) {
				let linesToShow = raw;
				let skipStart = 0;
				let skipEnd = 0;

				if (!lastWasChange) {
					skipStart = Math.max(0, raw.length - contextLines);
					linesToShow = raw.slice(skipStart);
				}

				if (!nextPartIsChange && linesToShow.length > contextLines) {
					skipEnd = linesToShow.length - contextLines;
					linesToShow = linesToShow.slice(0, contextLines);
				}

				if (skipStart > 0) {
					oldLineNum += skipStart;
					newLineNum += skipStart;
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				}

				for (const line of linesToShow) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				if (skipEnd > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				}

				oldLineNum += skipEnd;
				newLineNum += skipEnd;
			} else {
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return output.join("\n");
}

export function clampDiffForEcho(diff: string): string {
	const lines = diff.split("\n");
	if (lines.length <= DIFF_ECHO_MAX_LINES && Buffer.byteLength(diff, "utf-8") <= DIFF_ECHO_MAX_BYTES) {
		return diff;
	}
	let kept = lines.slice(0, DIFF_ECHO_MAX_LINES);
	while (kept.length > 1 && Buffer.byteLength(kept.join("\n"), "utf-8") > DIFF_ECHO_MAX_BYTES) {
		kept = kept.slice(0, -1);
	}
	let shown = kept.join("\n");
	if (Buffer.byteLength(shown, "utf-8") > DIFF_ECHO_MAX_BYTES) {
		// A single line still over budget: hard-cut on a UTF-8 boundary.
		shown = Buffer.from(shown, "utf-8").subarray(0, DIFF_ECHO_MAX_BYTES).toString("utf-8");
	}
	const omitted = lines.length - kept.length;
	return `${shown}\n[diff truncated${omitted > 0 ? `, ${omitted} more line(s)` : ""}; the full diff is in the tool result details]`;
}

/** Expand a byte window to the nearest line boundaries so the rendered diff never starts/ends mid-line. */
function expandToLineBoundaries(
	bytes: Buffer,
	start: number,
	end: number,
	fileSize: number,
): { start: number; end: number } {
	let s = start;
	while (s > 0 && bytes[s - 1] !== undefined && bytes[s - 1] !== 0x0a) s--;
	let e = end;
	while (e < fileSize && bytes[e] !== undefined && bytes[e] !== 0x0a) e++;
	return { start: s, end: e };
}

/** Show a few local windows without loading the full file. */
export async function renderStreamingEditDiff(
	fileStore: FileStore,
	target: string,
	path: string,
	fileSize: number,
	needle: Buffer,
	replacement: Buffer,
	matchOffsets: number[],
	lineNumbers: Map<number, number>,
	signal?: AbortSignal,
) {
	// Local diff windows, read from the *original* file before pass 2 rewrites it.
	const diffParts: string[] = [];
	const patchParts: string[] = [];
	const shown = Math.min(matchOffsets.length, MAX_DIFF_WINDOWS);
	for (let i = 0; i < shown; i++) {
		const offset = matchOffsets[i];
		const rawStart = Math.max(0, offset - DIFF_WINDOW_BYTES);
		const rawEnd = Math.min(fileSize, offset + needle.length + DIFF_WINDOW_BYTES);
		const { data: windowBytes } = await fileStore.readBytes(target, {
			start: rawStart,
			maxBytes: rawEnd - rawStart,
			signal,
		});
		const { start, end } = expandToLineBoundaries(
			windowBytes,
			offset - rawStart,
			offset - rawStart + needle.length,
			windowBytes.length,
		);
		const oldWindow = windowBytes.subarray(start, end).toString("utf-8");
		const newWindow =
			windowBytes.subarray(start, offset - rawStart).toString("utf-8") +
			replacement.toString("utf-8") +
			windowBytes.subarray(offset - rawStart + needle.length, end).toString("utf-8");
		const startLine = lineNumbers.get(offset) ?? 1;
		// The window itself may start mid-file above `offset`'s line, so back up the printed line
		// number by however many newlines are in the window before the expanded start.
		const linesBeforeWindowStart = countNewlines(windowBytes, 0, start);
		const linesBeforeMatch = countNewlines(windowBytes, 0, offset - rawStart);
		const windowStartLine = startLine - (linesBeforeMatch - linesBeforeWindowStart);
		diffParts.push(generateDiffString(oldWindow, newWindow, 4, windowStartLine, windowStartLine));
		patchParts.push(Diff.createPatch(path, oldWindow, newWindow));
	}
	if (matchOffsets.length > shown) {
		diffParts.push(`[+${matchOffsets.length - shown} more occurrence(s) replaced, diff not shown]`);
	}

	return { diff: diffParts.join("\n\n"), patch: patchParts.join("\n") };
}
