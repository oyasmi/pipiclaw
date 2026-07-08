import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { extname } from "path";
import { Type } from "typebox";
import type { Executor } from "../sandbox.js";
import { DEFAULT_SECURITY_CONFIG } from "../security/config.js";
import { logSecurityEvent } from "../security/logger.js";
import { guardPath } from "../security/path-guard.js";
import type { SecurityConfig, SecurityRuntimeContext } from "../security/types.js";
import { shellEscape } from "../shared/shell-escape.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

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
 * Render a depth-2 directory tree from a newline-separated list of paths (directories carry a
 * trailing `/`, produced by the shell). Kept deliberately portable — no sizes or mtimes, since
 * `find -printf` / `stat` formats differ across BSD, GNU, and busybox; the structure is the value.
 */
function renderDirectoryTree(rootPath: string, rawPaths: string): string {
	const rootPrefix = rootPath.endsWith("/") ? rootPath : `${rootPath}/`;
	const entries = rawPaths
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && line !== rootPath && line !== rootPrefix)
		.map((line) => (line.startsWith(rootPrefix) ? line.slice(rootPrefix.length) : line))
		.sort((a, b) => a.replace(/\/$/, "").localeCompare(b.replace(/\/$/, "")));

	if (entries.length === 0) {
		return "(empty directory)";
	}

	// Group by immediate parent so we can cap children per directory.
	const perParentCount = new Map<string, number>();
	const lines: string[] = [];
	const elided = new Map<string, number>();
	for (const entry of entries) {
		const isDir = entry.endsWith("/");
		const rel = isDir ? entry.slice(0, -1) : entry;
		const segments = rel.split("/");
		const depth = segments.length - 1;
		const parent = depth === 0 ? "" : segments.slice(0, -1).join("/");
		const count = (perParentCount.get(parent) ?? 0) + 1;
		perParentCount.set(parent, count);
		if (count > DIR_PER_DIR_LIMIT) {
			elided.set(parent, (elided.get(parent) ?? 0) + 1);
			continue;
		}
		lines.push(`${"  ".repeat(depth)}${segments[segments.length - 1]}${isDir ? "/" : ""}`);
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

function countTextLines(content: string): number {
	if (content.length === 0) {
		return 0;
	}

	return content.endsWith("\n") ? content.split("\n").length - 1 : content.split("\n").length;
}

function formatPathBlockMessage(resolvedPath: string | undefined, category?: string, reason?: string): string {
	const lines = [`Path blocked${category ? ` [${category}]` : ""}`];
	if (reason) {
		lines.push(`Reason: ${reason}`);
	}
	if (resolvedPath) {
		lines.push(`Resolved path: ${resolvedPath}`);
	}
	return lines.join("\n");
}

export function createReadTool(executor: Executor, options: ReadToolOptions = {}): AgentTool<typeof readSchema> {
	const securityConfig = options.securityConfig ?? DEFAULT_SECURITY_CONFIG;
	const securityContext = options.securityContext ?? {
		workspaceDir: process.cwd(),
		workspacePath: process.cwd(),
		cwd: process.cwd(),
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
			if (securityConfig.enabled && securityConfig.pathGuard.enabled) {
				const guardResult = guardPath(path, "read", { ...securityContext, config: securityConfig.pathGuard });
				if (!guardResult.allowed) {
					logSecurityEvent(securityContext.workspaceDir, securityConfig, {
						type: "path",
						tool: "read",
						channelId: options.channelId,
						rawPath: path,
						operation: "read",
						resolvedPath: guardResult.resolvedPath,
						category: guardResult.category,
						reason: guardResult.reason,
					});
					throw new Error(
						formatPathBlockMessage(guardResult.resolvedPath, guardResult.category, guardResult.reason),
					);
				}
			}

			const mimeType = isImageFile(path);

			if (mimeType) {
				// Read as image (binary) - use base64
				const result = await executor.exec(`base64 < ${shellEscape(path)}`, { signal });
				if (result.code !== 0) {
					throw new Error(result.stderr || `Failed to read file: ${path}`);
				}
				const base64 = result.stdout.replace(/\s/g, ""); // Remove whitespace from base64

				return {
					content: [
						{ type: "text", text: `Read image file [${mimeType}]` },
						{ type: "image", data: base64, mimeType },
					],
					details: undefined,
				};
			}

			// PDF documents are converted to text with pdftotext, then run through the same
			// offset/limit/truncation pipeline as any text file.
			const isPdf = extname(path).toLowerCase() === ".pdf";
			let pdfText = "";
			if (isPdf) {
				const converted = await executor.exec(`pdftotext -layout ${shellEscape(path)} - 2>&1`, { signal });
				if (converted.code === 127) {
					throw new Error(
						`Cannot read ${path}: pdftotext is not installed. Install poppler-utils (host) or rebuild the Docker sandbox image, or ask the user to send a text version.`,
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

			// Get total line count. For non-PDF paths this same command also detects a directory
			// (`cat`/`awk` on a directory would fail), so a directory read is a shallow tree rather
			// than a confusing error — all in one exec to keep the call sequence unchanged.
			let totalFileLines: number;
			if (isPdf) {
				totalFileLines = countTextLines(pdfText);
			} else {
				const countResult = await executor.exec(
					`if [ -d ${shellEscape(path)} ]; then echo __DIR__; else awk 'END { print NR }' ${shellEscape(path)}; fi`,
					{ signal },
				);
				if (countResult.code !== 0) {
					throw new Error(countResult.stderr || `Failed to read file: ${path}`);
				}
				if (countResult.stdout.trim() === "__DIR__") {
					const listing = await executor.exec(
						`{ find ${shellEscape(path)} -maxdepth ${DIR_MAX_DEPTH} -type d | sed 's,$,/,'; ` +
							`find ${shellEscape(path)} -maxdepth ${DIR_MAX_DEPTH} ! -type d; }`,
						{ signal },
					);
					if (listing.code !== 0) {
						throw new Error(listing.stderr || `Failed to list directory: ${path}`);
					}
					return {
						content: [
							{ type: "text", text: `Directory: ${path}\n\n${renderDirectoryTree(path, listing.stdout)}` },
						],
						details: undefined,
					};
				}
				totalFileLines = Number.parseInt(countResult.stdout.trim(), 10);
			}

			// Apply offset if specified (1-indexed)
			const startLine = offset ? Math.max(1, offset) : 1;
			const startLineDisplay = startLine;

			// Check if offset is out of bounds
			if (
				(totalFileLines === 0 && offset !== undefined && startLine > 1) ||
				(totalFileLines > 0 && startLine > totalFileLines)
			) {
				const guidance =
					totalFileLines > 0
						? `Use offset=${totalFileLines} to read the last line, or omit offset to read from the start.`
						: "The file is empty; omit offset.";
				throw new Error(`Offset ${offset} is beyond end of file (${totalFileLines} lines total). ${guidance}`);
			}

			// Read content from the offset. PDF text is already in memory; files stream from disk.
			let selectedContent: string;
			if (isPdf) {
				selectedContent =
					startLine === 1
						? pdfText
						: pdfText
								.split("\n")
								.slice(startLine - 1)
								.join("\n");
			} else {
				const cmd = startLine === 1 ? `cat ${shellEscape(path)}` : `tail -n +${startLine} ${shellEscape(path)}`;
				const result = await executor.exec(cmd, { signal });
				if (result.code !== 0) {
					throw new Error(result.stderr || `Failed to read file: ${path}`);
				}
				selectedContent = result.stdout;
			}
			let userLimitedLines: number | undefined;

			// Apply user limit if specified
			if (limit !== undefined) {
				const lines = selectedContent.split("\n");
				const endLine = Math.min(limit, countTextLines(selectedContent));
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

				outputText = truncation.content;

				if (truncation.truncatedBy === "lines") {
					outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue]`;
				} else {
					outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue]`;
				}
				details = { truncation };
			} else if (userLimitedLines !== undefined) {
				// User specified limit, check if there's more content
				const linesFromStart = startLine - 1 + userLimitedLines;
				if (linesFromStart < totalFileLines) {
					const remaining = totalFileLines - linesFromStart;
					const nextOffset = startLine + userLimitedLines;

					outputText = truncation.content;
					outputText += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue]`;
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
