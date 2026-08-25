import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { extname } from "path";
import { Type } from "typebox";
import type { Executor } from "../executor.js";
import type { DirectoryEntry, FileStore } from "../file-store.js";
import { DEFAULT_SECURITY_CONFIG } from "../security/config.js";
import { checkPathGuard } from "../security/path-guard-check.js";
import type { SecurityConfig, SecurityRuntimeContext } from "../security/types.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { shellEscape } from "../shared/shell-escape.js";
import { resolveLineOffset } from "./line-index.js";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	MAX_INLINE_BINARY_BYTES,
	type TruncationResult,
	truncateHead,
} from "./truncate.js";

/**
 * Map of file extensions to MIME types for common image formats
 */
const IMAGE_MIME_TYPES: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
};

/**
 * Check if a file is an image based on its extension
 */
function isImageFile(filePath: string): string | null {
	const ext = extname(filePath).toLowerCase();
	return IMAGE_MIME_TYPES[ext] || null;
}

/** Directory tree caps, mirroring oh-my-pi's read: shallow and per-directory bounded. */
const DIR_MAX_DEPTH = 2;
const DIR_PER_DIR_LIMIT = 12;

/**
 * Render a depth-2 directory tree from `FileStore.listDirectory` entries. Kept deliberately
 * portable — no sizes or mtimes, since formats differ across platforms; the structure is the value.
 */
function renderDirectoryTree(entries: DirectoryEntry[]): string {
	if (entries.length === 0) {
		return "(empty directory)";
	}

	const sorted = [...entries].sort((a, b) => a.relativePath.localeCompare(b.relativePath));

	// Group by immediate parent so we can cap children per directory.
	const perParentCount = new Map<string, number>();
	const lines: string[] = [];
	const elided = new Map<string, number>();
	for (const entry of sorted) {
		const segments = entry.relativePath.split("/");
		const depth = segments.length - 1;
		const parent = depth === 0 ? "" : segments.slice(0, -1).join("/");
		const count = (perParentCount.get(parent) ?? 0) + 1;
		perParentCount.set(parent, count);
		if (count > DIR_PER_DIR_LIMIT) {
			elided.set(parent, (elided.get(parent) ?? 0) + 1);
			continue;
		}
		lines.push(`${"  ".repeat(depth)}${entry.name}${entry.isDirectory ? "/" : ""}`);
	}
	for (const [, count] of elided) {
		lines.push(`  [+${count} more]`);
	}
	return lines.join("\n");
}

const readSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're reading and why (shown to user)" }),
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Integer({ minimum: 1, description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines to read" })),
});

interface ReadToolDetails {
	truncation?: TruncationResult;
}

export interface ReadToolOptions {
	securityConfig?: SecurityConfig;
	securityContext?: SecurityRuntimeContext;
	channelId?: string;
}

/** Lines in `content`, given its `split("\n")` — callers that already split should pass it. */
function countSplitLines(content: string, lines: string[]): number {
	if (content.length === 0) {
		return 0;
	}
	return content.endsWith("\n") ? lines.length - 1 : lines.length;
}

export function createReadTool(
	executor: Executor,
	fileStore: FileStore,
	options: ReadToolOptions = {},
): AgentTool<typeof readSchema> {
	const securityConfig = options.securityConfig ?? DEFAULT_SECURITY_CONFIG;
	const securityContext = options.securityContext ?? {
		agentWorkspaceDir: process.cwd(),
		projectRoot: process.cwd(),
	};

	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files.`,
		parameters: readSchema,
		execute: async (
			_toolCallId: string,
			{ path, offset, limit }: { label: string; path: string; offset?: number; limit?: number },
			signal?: AbortSignal,
		): Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }> => {
			const target = await checkPathGuard(path, "read", securityConfig, securityContext, {
				tool: "read",
				channelId: options.channelId,
			});

			const mimeType = isImageFile(path);

			if (mimeType) {
				// Stat before reading: base64-encoding a file over the inline limit is pointless work,
				// and doing it via `FileStore.readBytes` rather than shelling out to `base64` (spec 044,
				// D7) means there is no 4/3 blow-up through a captured stdout string to worry about.
				const stat = await fileStore.stat(target);
				if (!stat || !stat.isFile) {
					throw new RecoverableToolError(
						`Failed to read file: ${path}. Check the path — try \`read\` on its parent directory to confirm it exists.`,
					);
				}
				if (stat.size > MAX_INLINE_BINARY_BYTES) {
					throw new RecoverableToolError(
						`Image ${path} is ${formatSize(stat.size)}, over the ${formatSize(MAX_INLINE_BINARY_BYTES)} inline limit. ` +
							"Compress or resize it first with bash (e.g. sips/convert/ffmpeg), or read it as text to inspect metadata only.",
					);
				}
				const { data } = await fileStore.readBytes(target, { signal });
				return {
					content: [
						{ type: "text", text: `Read image file [${mimeType}]` },
						{ type: "image", data: data.toString("base64"), mimeType },
					],
					details: undefined,
				};
			}

			// PDF documents are converted to text with pdftotext, then run through the same
			// offset/limit/truncation pipeline as any text file. That's a command, not a file read, so
			// it still goes through `Executor`.
			const isPdf = extname(path).toLowerCase() === ".pdf";
			let pdfText = "";
			if (isPdf) {
				const converted = await executor.exec(`pdftotext -layout ${shellEscape(target)} - 2>&1`, { signal });
				if (converted.code === 127) {
					throw new Error(
						`Cannot read ${path}: pdftotext is not installed. Install poppler-utils, or ask the user to send a text version.`,
					);
				}
				if (converted.code !== 0 || !converted.stdout.trim()) {
					throw new Error(
						`Cannot read .pdf file ${path}: ${converted.stdout.trim() || "conversion produced no text"}. ` +
							`The file may be scanned/image-based — ask the user for a text version or a screenshot.`,
					);
				}
				pdfText = converted.stdout;
			}

			const stat = isPdf ? undefined : await fileStore.stat(target);
			if (!isPdf && !stat) {
				throw new RecoverableToolError(
					`Failed to read file: ${path}. Check the path — try \`read\` on its parent directory to confirm it exists.`,
				);
			}
			if (stat?.isDirectory) {
				const entries = await fileStore.listDirectory(target, { maxDepth: DIR_MAX_DEPTH });
				return {
					content: [{ type: "text", text: `Directory: ${path}\n\n${renderDirectoryTree(entries)}` }],
					details: undefined,
				};
			}

			const startLine = offset ? Math.max(1, offset) : 1;
			const startLineDisplay = startLine;

			// Resolve the byte offset of `startLine` via the incremental line index (D4.2). PDF text is
			// small and already fully in memory, so it just splits directly. For a real file, the index
			// scans forward from wherever it last left off; reaching EOF without finding `startLine`
			// means the offset is out of bounds -- decided from what the scan actually observed (D4.3),
			// never from a separate precomputed total.
			let selectedContent: string;
			let windowEof: boolean;
			let linesBeforeWindow: number;

			if (isPdf) {
				const pdfLines = pdfText.split("\n");
				const totalPdfLines = countSplitLines(pdfText, pdfLines);
				if (startLine > Math.max(totalPdfLines, 1)) {
					throw new RecoverableToolError(
						`Offset ${offset} is beyond end of file (${totalPdfLines} lines total). ` +
							(totalPdfLines > 0
								? `Use offset=${totalPdfLines} to read the last line, or omit offset to read from the start.`
								: "The file is empty; omit offset."),
					);
				}
				selectedContent = startLine === 1 ? pdfText : pdfLines.slice(startLine - 1).join("\n");
				windowEof = true;
				linesBeforeWindow = startLine - 1;
			} else {
				const fileStat = stat!;
				if (fileStat.size === 0) {
					if (offset !== undefined && startLine > 1) {
						throw new RecoverableToolError(
							`Offset ${offset} is beyond end of file (0 lines total). The file is empty; omit offset.`,
						);
					}
					selectedContent = "";
					windowEof = true;
					linesBeforeWindow = 0;
				} else {
					const located = await resolveLineOffset(fileStore, target, fileStat, startLine, signal);
					if (located.offset === undefined) {
						const guidance =
							located.knownLines > 0
								? `Use offset=${located.knownLines} to read the last line, or omit offset to read from the start.`
								: "The file is empty; omit offset.";
						throw new RecoverableToolError(
							`Offset ${offset} is beyond end of file (${located.knownLines} lines total). ${guidance}`,
						);
					}
					// Bounded at the source: read at most twice the byte cap, which always leaves
					// `truncateHead` enough to apply whichever limit binds first (line or byte), however
					// short the lines are.
					const readWindowBytes = DEFAULT_MAX_BYTES * 2;
					const { data, eof } = await fileStore.readBytes(target, {
						start: located.offset,
						maxBytes: readWindowBytes,
						signal,
					});
					selectedContent = data.toString("utf-8");
					windowEof = eof;
					linesBeforeWindow = startLine - 1;
				}
			}

			// Total lines known so far, from the *whole* read window before any user `limit` slices
			// it down: exact when the window reached the real EOF, a lower bound otherwise (D4.3) --
			// never a number nobody actually counted.
			const linesInWindow = countSplitLines(selectedContent, selectedContent.split("\n"));
			const knownTotalLines = linesBeforeWindow + linesInWindow;
			const totalIsExact = windowEof;

			let userLimitedLines: number | undefined;

			// Apply user limit if specified
			if (limit !== undefined) {
				const lines = selectedContent.split("\n");
				const endLine = Math.min(limit, countSplitLines(selectedContent, lines));
				selectedContent = lines.slice(0, endLine).join("\n");
				userLimitedLines = endLine;
			}

			// Apply truncation (respects both line and byte limits)
			const truncation = truncateHead(selectedContent);

			let outputText: string;
			let details: ReadToolDetails | undefined;

			if (truncation.firstLineExceedsLimit) {
				// First line at offset exceeds 50KB - tell model to use bash
				const firstLineSize = formatSize(Buffer.byteLength(selectedContent.split("\n")[0], "utf-8"));
				outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
				details = { truncation };
			} else if (truncation.truncated) {
				// Truncation occurred - build actionable notice
				const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
				const nextOffset = endLineDisplay + 1;
				const totalLabel = totalIsExact ? `${knownTotalLines}` : `>=${knownTotalLines}`;

				outputText = truncation.content;

				if (truncation.truncatedBy === "lines") {
					outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalLabel}. Use offset=${nextOffset} to continue]`;
				} else {
					outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalLabel} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue]`;
				}
				details = { truncation };
			} else if (userLimitedLines !== undefined) {
				// User specified limit, check if there's more content
				const linesFromStart = startLine - 1 + userLimitedLines;
				const moreAvailable = !windowEof || linesFromStart < knownTotalLines;
				if (moreAvailable) {
					const nextOffset = startLine + userLimitedLines;
					outputText = truncation.content;
					const remainingLabel = windowEof ? `${knownTotalLines - linesFromStart}` : "more";
					outputText += `\n\n[${remainingLabel} more lines in file. Use offset=${nextOffset} to continue]`;
				} else {
					outputText = truncation.content;
				}
			} else {
				// No truncation, no user limit exceeded
				outputText = truncation.content;
			}

			return {
				content: [{ type: "text", text: outputText }],
				details,
			};
		},
	};
}
