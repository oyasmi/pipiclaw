import type { AgentTool } from "@earendil-works/pi-agent-core";
import * as Diff from "diff";
import { Type } from "typebox";
import { type FileStat, type FileStore, fingerprintOf, fingerprintsEqual } from "../file-store.js";
import { DEFAULT_SECURITY_CONFIG } from "../security/config.js";
import { checkPathGuard } from "../security/path-guard-check.js";
import type { SecurityConfig, SecurityRuntimeContext } from "../security/types.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";

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

				oldLineNum += skipStart + skipEnd;
				newLineNum += skipStart + skipEnd;
			} else {
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return output.join("\n");
}

const editSchema = Type.Object({
	label: Type.String({ description: "Brief description of the edit you're making (shown to user)" }),
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	oldText: Type.String({ description: "Exact text to find and replace (must match exactly)" }),
	newText: Type.String({ description: "New text to replace the old text with" }),
	replaceAll: Type.Optional(
		Type.Boolean({
			description:
				"Replace every occurrence instead of requiring a unique match. Defaults to false (the match must be unique).",
		}),
	),
});

export interface EditToolOptions {
	securityConfig?: SecurityConfig;
	securityContext?: SecurityRuntimeContext;
	channelId?: string;
}

/** Max diff lines echoed back to the model in the success result before eliding the rest. */
const DIFF_ECHO_MAX_LINES = 40;
/** Consecutive byte-identical no-ops of the same payload before the soft error escalates to a hard stop. */
const NOOP_HARD_LIMIT = 3;
/** Above this, `edit` switches from "read whole file into memory" to the streaming two-pass path (D2.2). */
const EDIT_INLINE_MAX_BYTES = 8 * 1024 * 1024;
/** Bytes scanned from the head of the file for the binary guard (D2.5). */
const BINARY_SNIFF_BYTES = 8 * 1024;
/**
 * Hard cap on how many `replaceAll` match offsets the streaming path records in memory (D2.2). A
 * file with more occurrences than this is almost certainly the wrong target for a text edit (e.g.
 * a needle that matches on every line of a huge generated file); failing loudly with a narrowing
 * suggestion is one of the sanctioned "bounded" outcomes (spec 044, design principle P2), not a
 * silent truncation.
 */
const MAX_REPLACE_ALL_OFFSETS = 200_000;
/** Bytes of file context shown around each match in the streaming path's local diff (D2.3). */
const DIFF_WINDOW_BYTES = 2000;
/** How many of a `replaceAll` match's diffs get rendered on the streaming path. */
const MAX_DIFF_WINDOWS = 5;

function clampDiffForEcho(diff: string): string {
	const lines = diff.split("\n");
	if (lines.length <= DIFF_ECHO_MAX_LINES) {
		return diff;
	}
	const shown = lines.slice(0, DIFF_ECHO_MAX_LINES).join("\n");
	return `${shown}\n[diff truncated, ${lines.length - DIFF_ECHO_MAX_LINES} more lines]`;
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

/** Byte-level splice: replace `needle` at every offset in `offsets` (ascending) with `replacement`. */
function spliceBuffer(source: Buffer, needle: Buffer, replacement: Buffer, offsets: number[]): Buffer {
	const parts: Buffer[] = [];
	let cursor = 0;
	for (const offset of offsets) {
		parts.push(source.subarray(cursor, offset));
		parts.push(replacement);
		cursor = offset + needle.length;
	}
	parts.push(source.subarray(cursor));
	return Buffer.concat(parts);
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
	totalBytes: number;
}> {
	const overlapLen = needle.length - 1;
	let carry: Buffer = Buffer.alloc(0);
	let windowBaseOffset = 0;
	let newlinesBeforeWindow = 0;
	let count = 0;
	let offsets: number[] | undefined = [];
	const lineNumbers = new Map<number, number>();
	let looksBinary = false;
	let sniffed = 0;
	let totalBytes = 0;

	for await (const chunk of stream) {
		totalBytes += chunk.length;
		if (sniffed < BINARY_SNIFF_BYTES) {
			const take = chunk.subarray(0, BINARY_SNIFF_BYTES - sniffed);
			if (take.includes(0)) looksBinary = true;
			sniffed += take.length;
		}

		const window = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
		let from = 0;
		while (true) {
			const idx = window.indexOf(needle, from);
			if (idx === -1) break;
			count++;
			if (offsets && offsets.length < maxOffsets) {
				const absoluteOffset = windowBaseOffset + idx;
				offsets.push(absoluteOffset);
				const lineNumber = newlinesBeforeWindow + countNewlines(window, 0, idx) + 1;
				lineNumbers.set(absoluteOffset, lineNumber);
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

	return { count, offsets, lineNumbers, looksBinary, totalBytes };
}

function countNewlines(buf: Buffer, start: number, end: number): number {
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

/** Copy `[start, end)` of `path` onto `out`, with simple backpressure handling. */
function copyRange(
	store: FileStore,
	path: string,
	start: number,
	end: number,
	out: NodeJS.WritableStream,
): Promise<void> {
	if (end <= start) return Promise.resolve();
	return new Promise((resolveCopy, reject) => {
		const src = store.openRead(path, { start, end: end - 1 });
		src.on("data", (chunk: Buffer) => {
			if (!out.write(chunk)) {
				src.pause();
				out.once("drain", () => src.resume());
			}
		});
		src.on("end", () => resolveCopy());
		src.on("error", reject);
	});
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

async function checkFingerprintUnchanged(
	fileStore: FileStore,
	target: string,
	path: string,
	before: FileStat,
): Promise<void> {
	const after = await fileStore.stat(target);
	if (!after || !fingerprintsEqual(fingerprintOf(before), fingerprintOf(after))) {
		throw new RecoverableToolError(
			`${path} changed during this edit (likely a background job or another agent writing concurrently). ` +
				"Re-read the file and re-apply the edit against its current content.",
		);
	}
}

export function createEditTool(fileStore: FileStore, options: EditToolOptions = {}): AgentTool<typeof editSchema> {
	const securityConfig = options.securityConfig ?? DEFAULT_SECURITY_CONFIG;
	const securityContext = options.securityContext ?? {
		agentWorkspaceDir: process.cwd(),
		projectRoot: process.cwd(),
	};

	// Per-tool-instance counter of consecutive byte-identical no-op edits, keyed by the exact
	// (path, oldText, newText) payload. A model stuck re-issuing the same no-op edit is chasing a
	// bug that lives elsewhere; after NOOP_HARD_LIMIT we escalate from a soft steer to a hard stop
	// so the loop can't burn turns. Any successful edit clears the streak (see below).
	const noopCounts = new Map<string, number>();

	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.",
		parameters: editSchema,
		execute: async (
			_toolCallId: string,
			{
				path,
				oldText,
				newText,
				replaceAll,
			}: { label: string; path: string; oldText: string; newText: string; replaceAll?: boolean },
			signal?: AbortSignal,
		) => {
			if (oldText.length === 0) {
				throw new RecoverableToolError("oldText must not be empty.");
			}

			const target = await checkPathGuard(path, "read", securityConfig, securityContext, {
				tool: "edit",
				channelId: options.channelId,
			});

			const before = await fileStore.stat(target);
			if (!before || !before.isFile) {
				throw new RecoverableToolError(`File not found: ${path}`);
			}

			const needle = Buffer.from(oldText, "utf-8");
			const replacement = Buffer.from(newText, "utf-8");
			const isNoopPayload = needle.equals(replacement);

			const applyNoop = () => {
				const noopKey = `${path}\x00${oldText}\x00${newText}`;
				const streak = (noopCounts.get(noopKey) ?? 0) + 1;
				noopCounts.set(noopKey, streak);
				if (streak >= NOOP_HARD_LIMIT) {
					throw new Error(
						`STOP. This exact edit to ${path} has been a no-op ${streak} times in a row. ` +
							`The bug is somewhere else — re-read the file to verify the anchor text before editing again. ` +
							`Do NOT widen oldText or add lines to force a match.`,
					);
				}
				throw new RecoverableToolError(
					`No changes made to ${path}: oldText and newText are byte-identical at the match, so the replacement produced no change. ` +
						`Re-read the file to confirm what actually needs changing before editing again.`,
				);
			};

			let result: { text: string; diff: string; patch: string; occurrences: number };
			if (before.size <= EDIT_INLINE_MAX_BYTES) {
				result = await editInline(
					fileStore,
					target,
					path,
					before,
					needle,
					replacement,
					replaceAll === true,
					signal,
				);
			} else {
				result = await editStreaming(
					fileStore,
					target,
					path,
					before,
					needle,
					replacement,
					replaceAll === true,
					isNoopPayload,
					signal,
				);
			}

			if (isNoopPayload) {
				applyNoop();
			}
			// A real edit breaks any no-op streak.
			noopCounts.clear();

			const replacementSummary = replaceAll
				? `Replaced ${result.occurrences} occurrence${result.occurrences === 1 ? "" : "s"} in ${path}.`
				: `Successfully replaced text in ${path}. Changed ${oldText.length} characters to ${newText.length} characters.`;

			const echoedDiff = result.diff.trim() ? `\n\n${clampDiffForEcho(result.diff)}` : "";

			return {
				content: [{ type: "text", text: `${replacementSummary}${echoedDiff}` }],
				details: {
					diff: result.diff,
					patch: result.patch,
				},
			};
		},
	};
}

/** D2.1: small file path -- read whole, splice in memory, write atomically. */
async function editInline(
	fileStore: FileStore,
	target: string,
	path: string,
	before: FileStat,
	needle: Buffer,
	replacement: Buffer,
	replaceAll: boolean,
	signal: AbortSignal | undefined,
): Promise<{ text: string; diff: string; patch: string; occurrences: number }> {
	const { data } = await fileStore.readBytes(target, { signal });
	if (data.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
		throw new RecoverableToolError(
			`${path} looks like a binary file (a NUL byte appears in the first ${BINARY_SNIFF_BYTES} bytes). ` +
				"Use bash for binary edits — edit is for text.",
		);
	}

	const offsets = findAllOffsets(data, needle);
	if (offsets.length === 0) {
		throw new RecoverableToolError(
			`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
		);
	}
	if (offsets.length > 1 && !replaceAll) {
		throw new RecoverableToolError(
			`Found ${offsets.length} occurrences of the text in ${path}. The text must be unique, or pass replaceAll: true to replace all of them. Please provide more context to make it unique.`,
		);
	}

	const useOffsets = replaceAll ? offsets : [offsets[0]];
	const newData = spliceBuffer(data, needle, replacement, useOffsets);

	if (newData.equals(data)) {
		// Byte-identical payload -- caller (createEditTool) turns this into the no-op error/hard-stop.
		return { text: "", diff: "", patch: "", occurrences: useOffsets.length };
	}

	await checkFingerprintUnchanged(fileStore, target, path, before);
	await fileStore.writeAtomic(target, newData, { preserveMode: true, signal });

	const oldText = data.toString("utf-8");
	const newText = newData.toString("utf-8");
	const diff = generateDiffString(oldText, newText);
	const patch = Diff.createPatch(path, oldText, newText);

	return { text: "", diff, patch, occurrences: useOffsets.length };
}

/** D2.2: streaming two-pass path for files over EDIT_INLINE_MAX_BYTES. */
async function editStreaming(
	fileStore: FileStore,
	target: string,
	path: string,
	before: FileStat,
	needle: Buffer,
	replacement: Buffer,
	replaceAll: boolean,
	isNoopPayload: boolean,
	signal: AbortSignal | undefined,
): Promise<{ text: string; diff: string; patch: string; occurrences: number }> {
	// Pass 1: scan for occurrences, line numbers, and a binary sniff -- no writes yet, so the
	// uniqueness/existence judgment is made before anything touches disk.
	const scan = await scanOccurrences(readStreamChunks(fileStore, target, signal), needle, MAX_REPLACE_ALL_OFFSETS);

	if (scan.looksBinary) {
		throw new RecoverableToolError(
			`${path} looks like a binary file (a NUL byte appears in the first ${BINARY_SNIFF_BYTES} bytes). ` +
				"Use bash for binary edits — edit is for text.",
		);
	}
	if (scan.count === 0) {
		throw new RecoverableToolError(
			`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
		);
	}
	if (scan.count > 1 && !replaceAll) {
		throw new RecoverableToolError(
			`Found ${scan.count} occurrences of the text in ${path}. The text must be unique, or pass replaceAll: true to replace all of them. Please provide more context to make it unique.`,
		);
	}
	if (!scan.offsets) {
		throw new RecoverableToolError(
			`${path} has more than ${MAX_REPLACE_ALL_OFFSETS} occurrences of the text -- too many to replace in one call on a file this large. ` +
				"Narrow the pattern (add more context) so it matches far fewer places.",
		);
	}

	const matchOffsets = replaceAll ? scan.offsets : [scan.offsets[0]];
	const occurrences = matchOffsets.length;

	if (isNoopPayload) {
		// The caller turns this into the no-op error/hard-stop; no point writing an identical file.
		return { text: "", diff: "", patch: "", occurrences };
	}

	// Local diff windows, read from the *original* file before pass 2 rewrites it.
	const diffParts: string[] = [];
	const patchParts: string[] = [];
	const shown = Math.min(matchOffsets.length, MAX_DIFF_WINDOWS);
	for (let i = 0; i < shown; i++) {
		const offset = matchOffsets[i];
		const rawStart = Math.max(0, offset - DIFF_WINDOW_BYTES);
		const rawEnd = Math.min(before.size, offset + needle.length + DIFF_WINDOW_BYTES);
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
		const startLine = scan.lineNumbers.get(offset) ?? 1;
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

	// Pass 2: apply. Stream-copy the file, splicing in `replacement` at each recorded offset.
	await checkFingerprintUnchanged(fileStore, target, path, before);
	await fileStore.replaceViaTemp(
		target,
		async (out) => {
			let cursor = 0;
			for (const offset of matchOffsets) {
				await copyRange(fileStore, target, cursor, offset, out);
				out.write(replacement);
				cursor = offset + needle.length;
			}
			await copyRange(fileStore, target, cursor, before.size, out);
		},
		{ preserveMode: true, signal },
	);

	return { text: "", diff: diffParts.join("\n\n"), patch: patchParts.join("\n"), occurrences };
}
