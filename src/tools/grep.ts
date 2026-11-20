import { isAbsolute, relative } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { Executor } from "../executor.js";
import { DEFAULT_SECURITY_CONFIG } from "../security/config.js";
import { checkPathGuard } from "../security/path-guard-check.js";
import { partitionByReadGuard, readGuardAllows } from "../security/path-guard-filter.js";
import type { SecurityConfig, SecurityRuntimeContext } from "../security/types.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { errorMessage } from "../shared/text-utils.js";
import { compileGlobPattern, type GlobMatcher } from "./glob-match.js";
import { buildSearchCommand, isRgAvailable } from "./grep-command.js";
import { IGNORED_DIR_SEGMENTS } from "./ignore-dirs.js";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.js";

/**
 * Structured filesystem search via ripgrep or grep, with per-file grouping, pagination and output limits.
 */

const LINE_MAX_CHARS = 512;
/** Match cap per file: tight for multi-file scopes (anti-monopoly), generous for a single file. */
const MULTI_FILE_PER_FILE_MATCHES = 20;
const SINGLE_FILE_MATCHES = 200;
/** Files shown per page; `skip` pages through the rest. */
const FILE_PAGE_LIMIT = 20;
const SEARCH_TIMEOUT_SECONDS = 30;
/**
 * Raw `grep` stdout capture cap (spec 044, D5.2). Bounded well under the executor's 10MB default so
 * a broad search can never flood memory, and `ExecResult.stdoutTruncated` (D6.2) says honestly
 * whether the cap was hit -- unlike piping through `head -n`, this leaves `result.code` as grep's
 * own exit status, so a real `grep` error (bad regex, missing path) still surfaces as one instead
 * of being masked by `head` exiting 0 regardless of what fed it.
 */
const MAX_RAW_RESULT_BYTES = 768 * 1024;

const grepSchema = Type.Object({
	pattern: Type.String({
		description: "Regex or literal search pattern.",
	}),
	path: Type.Optional(Type.String({ description: "File or directory; defaults to cwd." })),
	glob: Type.Optional(
		Type.String({
			description:
				'Filename filter for directory searches, matched against the basename. Supports `*`, `?`, `[abc]`, and `{a,b}` — e.g. "*.{ts,tsx}".',
		}),
	),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat `pattern` as a literal string, not a regex (like `grep -F`)." }),
	),
	mode: Type.Optional(
		Type.Union([Type.Literal("content"), Type.Literal("files"), Type.Literal("count")], {
			description:
				'"content" (default) includes context. "files" lists paths; "count" counts matching lines per file.',
		}),
	),
	caseSensitive: Type.Optional(Type.Boolean({ description: "Case-sensitive match. Defaults to true." })),
	skip: Type.Optional(
		Type.Integer({ minimum: 0, description: "File-page offset for paging through many matching files." }),
	),
});

export interface GrepToolOptions {
	securityConfig?: SecurityConfig;
	securityContext?: SecurityRuntimeContext;
	channelId?: string;
}

interface MatchEntry {
	line: number;
	text: string;
	isMatch: boolean;
}

function truncateLine(text: string): string {
	return text.length > LINE_MAX_CHARS ? `${text.slice(0, LINE_MAX_CHARS)}…` : text;
}

function isIgnoredPath(filePath: string, searchTarget: string): boolean {
	const checkPath = isAbsolute(filePath) && isAbsolute(searchTarget) ? relative(searchTarget, filePath) : filePath;
	if (!checkPath || checkPath.startsWith("..")) return false;
	return checkPath
		.split("/")
		.slice(0, -1)
		.some((segment) => IGNORED_DIR_SEGMENTS.has(segment));
}

/**
 * Both engines emit NUL-terminated filenames. Only the payload after NUL contains line syntax;
 * guessing the boundary from ':' or '-' can attribute a denied file's content to another path.
 * Complete records survive a capture cut; a partial filename or payload is discarded.
 */
function* searchRecords(stdout: string, truncated: boolean): Generator<[file: string, payload: string]> {
	let cursor = 0;
	while (cursor < stdout.length) {
		if (stdout.startsWith("--\n", cursor)) cursor += 3;
		const delimiter = stdout.indexOf("\0", cursor);
		if (delimiter < 0) break;
		const newline = stdout.indexOf("\n", delimiter + 1);
		if (newline < 0 && truncated) break;
		const end = newline < 0 ? stdout.length : newline;
		yield [stdout.slice(cursor, delimiter), stdout.slice(delimiter + 1, end)];
		cursor = end + 1;
	}
}

function parseGrepOutput(stdout: string, truncated: boolean): Map<string, MatchEntry[]> {
	const files = new Map<string, MatchEntry[]>();
	for (const [file, payload] of searchRecords(stdout, truncated)) {
		const prefix = /^(\d+)([:-])/.exec(payload);
		if (!prefix) continue;
		const entry = { line: Number(prefix[1]), text: payload.slice(prefix[0].length), isMatch: prefix[2] === ":" };
		const entries = files.get(file);
		if (entries) entries.push(entry);
		else files.set(file, [entry]);
	}
	return files;
}

function boundedList(body: string): string {
	const result = truncateHead(body);
	return result.truncated
		? `${result.content}\n\n[Output truncated; narrow the pattern or path to see the rest.]`
		: result.content;
}

function renderFileGroup(
	file: string,
	entries: MatchEntry[],
	perFileMatchCap: number,
): { text: string; capped: boolean; matchesShown: number } {
	const lines: string[] = [`== ${file} ==`];
	let matchesShown = 0;
	let capped = false;
	for (const entry of entries) {
		if (entry.isMatch && matchesShown >= perFileMatchCap) {
			capped = true;
			break;
		}
		const marker = entry.isMatch ? "*" : " ";
		lines.push(`${marker}${entry.line}:${truncateLine(entry.text)}`);
		if (entry.isMatch) {
			matchesShown++;
		}
	}
	return { text: lines.join("\n"), capped, matchesShown };
}

export function createGrepTool(executor: Executor, options: GrepToolOptions = {}): AgentTool<typeof grepSchema> {
	const securityConfig = options.securityConfig ?? DEFAULT_SECURITY_CONFIG;
	const securityContext = options.securityContext ?? {
		agentWorkspaceDir: process.cwd(),
		cwd: process.cwd(),
	};

	return {
		name: "grep",
		label: "grep",
		description:
			"Search file contents with a regex or literal pattern. Content mode marks matches with * and shows nearby context. Use files/count to locate matches cheaply.",
		parameters: grepSchema,
		execute: async (
			_toolCallId: string,
			{
				pattern,
				path,
				glob,
				literal,
				mode,
				caseSensitive,
				skip,
			}: {
				pattern: string;
				path?: string;
				glob?: string;
				literal?: boolean;
				mode?: "content" | "files" | "count";
				caseSensitive?: boolean;
				skip?: number;
			},
			signal?: AbortSignal,
		) => {
			if (!pattern.trim()) {
				throw new RecoverableToolError("Pattern must not be empty.");
			}
			const effectiveMode = mode ?? "content";

			const searchPath = path?.trim() || ".";
			// Resolved once, then used for both the guard's judgment and the actual `grep` target
			// (spec 044, D1.1): no separate `cwd` needed on the executor call, so there is no chance of
			// the guard resolving against the tool `cwd` while the shell actually runs against the
			// daemon's own cwd (F6).
			const target = await checkPathGuard(searchPath, "read", securityConfig, securityContext, {
				tool: "grep",
				channelId: options.channelId,
			});

			let basenameFilter: GlobMatcher | undefined;
			if (glob) {
				try {
					basenameFilter = compileGlobPattern(glob, { characterClasses: true });
				} catch (error) {
					throw new RecoverableToolError(
						`Invalid filename glob (${errorMessage(error)}). Simplify the glob or omit it.`,
					);
				}
			}
			const useRg = await isRgAvailable(executor);
			signal?.throwIfAborted();
			const command = buildSearchCommand(useRg, {
				mode: effectiveMode,
				pattern,
				target,
				glob,
				literal,
				caseSensitive,
				readDeny: securityConfig.pathGuard.readDeny,
			});
			const result = await executor.exec(command, {
				timeout: SEARCH_TIMEOUT_SECONDS,
				signal,
				maxCaptureBytes: MAX_RAW_RESULT_BYTES,
			});

			// grep exit code 1 = no matches (normal), 0 = matches, >=2 = error.
			if (result.code >= 2) {
				const stderr = result.stderr.trim();
				throw new RecoverableToolError(
					`grep failed: ${stderr || `exit code ${result.code}`}. ${
						literal ? "Check that the path exists." : "Check the regex syntax and path, or pass literal:true."
					}`,
				);
			}

			const rawTruncated = result.stdoutTruncated === true;

			const keepFile = (file: string): boolean => {
				const normalized = file.replace(/^\.\//, "");
				if (isIgnoredPath(normalized, target)) return false;
				if (basenameFilter) {
					const base = normalized.split("/").pop() ?? normalized;
					if (!basenameFilter.test(base)) return false;
				}
				return readGuardAllows(normalized, securityConfig, securityContext);
			};
			const truncationFooter = rawTruncated
				? `\n\n[Search hit the ${formatSize(MAX_RAW_RESULT_BYTES)} raw result cap; narrow the path or pattern to see the rest.]`
				: "";

			// `mode: "files"` — just the paths that matched, one per line.
			if (effectiveMode === "files") {
				const paths = [...new Set(result.stdout.split("\0").slice(0, -1).filter(Boolean))]
					.filter(keepFile)
					.sort((a, b) => a.localeCompare(b));
				if (paths.length === 0) {
					return {
						content: [{ type: "text", text: `No files contain a match in ${searchPath}.${truncationFooter}` }],
						details: { matchCount: 0, fileCount: 0 },
					};
				}
				return {
					content: [{ type: "text", text: boundedList(paths.join("\n")) + truncationFooter }],
					details: { fileCount: paths.length, mode: "files" },
				};
			}

			// Both engines count matching lines. The fallback derives counts from numbered records.
			if (effectiveMode === "count") {
				const counts = new Map<string, number>();
				for (const [file, payload] of searchRecords(result.stdout, rawTruncated)) {
					if (useRg) {
						if (/^\d+$/.test(payload)) counts.set(file, Number(payload));
					} else if (/^\d+:/.test(payload)) {
						counts.set(file, (counts.get(file) ?? 0) + 1);
					}
				}
				const rows = [...counts]
					.filter(([file, count]) => count > 0 && keepFile(file))
					.map(([file, count]): [string, number] => [file.replace(/^\.\//, ""), count]);
				rows.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
				if (rows.length === 0) {
					return {
						content: [{ type: "text", text: `No matches in ${searchPath}.${truncationFooter}` }],
						details: { matchCount: 0, fileCount: 0 },
					};
				}
				const total = rows.reduce((sum, [, n]) => sum + n, 0);
				const body = rows.map(([f, n]) => `${n}\t${f}`).join("\n");
				return {
					content: [{ type: "text", text: boundedList(body) + truncationFooter }],
					details: { matchCount: total, fileCount: rows.length, mode: "count" },
				};
			}

			const parsed = parseGrepOutput(result.stdout, rawTruncated);

			// Filter ignored dirs and (for directory scopes) the optional glob, on the basename.
			const files: Array<[string, MatchEntry[]]> = [];
			for (const [file, entries] of parsed) {
				if (!entries.some((entry) => entry.isMatch)) continue;
				const normalized = file.replace(/^\.\//, "");
				if (isIgnoredPath(normalized, target)) {
					continue;
				}
				if (basenameFilter) {
					const base = normalized.split("/").pop() ?? normalized;
					if (!basenameFilter.test(base)) {
						continue;
					}
				}
				files.push([normalized, entries]);
			}

			// Backstop: a recursive `grep` descends into `readDeny`/sensitive subtrees the per-path
			// guard would refuse. Drop any hit file the read guard denies before it is rendered or
			// counted (the residual risk — grep already read the bytes — is documented in
			// path-guard-filter.ts).
			let readDenyExcluded = 0;
			if (files.length > 0) {
				const { allowed } = partitionByReadGuard(
					files.map(([file]) => file),
					securityConfig,
					securityContext,
				);
				const allowedSet = new Set(allowed);
				const kept = files.filter(([file]) => allowedSet.has(file));
				readDenyExcluded = files.length - kept.length;
				files.length = 0;
				files.push(...kept);
			}

			if (files.length === 0) {
				if (readDenyExcluded > 0) {
					return {
						content: [
							{
								type: "text",
								text:
									`All ${readDenyExcluded} matching file(s) in ${searchPath} are excluded by the read policy. ` +
									"Search a path you are allowed to read.",
							},
						],
						details: { matchCount: 0, fileCount: 0, readDenyExcluded },
					};
				}
				const scope = glob ? `${searchPath} (glob ${glob})` : searchPath;
				// D5.3: a result set that hit the raw-line cap but still filtered down to nothing must
				// not be reported as "no matches" -- that tells the model to try a *broader* search,
				// which is exactly backwards when the real problem is that the cap was hit before
				// filtering ever got a chance to keep anything.
				const text = rawTruncated
					? `Search hit the ${formatSize(MAX_RAW_RESULT_BYTES)} raw result cap before any match survived filtering in ${scope}. ` +
						"Narrow the path or pattern so fewer raw hits are needed."
					: `No matches found in ${scope}. Try a broader pattern, drop the glob, or widen the path.`;
				return {
					content: [{ type: "text", text }],
					details: { matchCount: 0, fileCount: 0 },
				};
			}

			files.sort((a, b) => a[0].localeCompare(b[0]));
			const isSingleFile = files.length === 1;
			const perFileMatchCap = isSingleFile ? SINGLE_FILE_MATCHES : MULTI_FILE_PER_FILE_MATCHES;

			const startOffset = skip && skip > 0 ? skip : 0;
			const page = files.slice(startOffset, startOffset + FILE_PAGE_LIMIT);
			if (page.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No more matching files (skip=${startOffset} is past the last of ${files.length}).`,
						},
					],
					details: { matchCount: 0, fileCount: files.length },
				};
			}

			const blocks: string[] = [];
			let shownMatchCount = 0;
			let anyFileCapped = false;
			for (const [file, entries] of page) {
				const { text, capped, matchesShown } = renderFileGroup(file, entries, perFileMatchCap);
				blocks.push(text);
				shownMatchCount += matchesShown;
				anyFileCapped = anyFileCapped || capped;
			}

			const footerLines: string[] = [];
			if (anyFileCapped) {
				footerLines.push(
					`[Some files were capped at ${perFileMatchCap} matches; narrow the pattern for the rest.]`,
				);
			}
			const moreFiles = files.length - (startOffset + page.length);
			if (moreFiles > 0) {
				footerLines.push(
					`[${moreFiles} more matching file(s). Use skip=${startOffset + page.length} for the next page.]`,
				);
			}
			if (rawTruncated) {
				footerLines.push(
					`[Search hit the ${formatSize(MAX_RAW_RESULT_BYTES)} raw result cap; there may be matches beyond what's shown above. Narrow the path or pattern to see them.]`,
				);
			}
			if (readDenyExcluded > 0) {
				footerLines.push(
					`[${readDenyExcluded} matching file(s) were excluded by the read policy and are not shown.]`,
				);
			}

			const body = blocks.join("\n\n");
			const footer = footerLines.length > 0 ? `\n\n${footerLines.join("\n")}` : "";
			const truncation = truncateHead(body);
			let outputText = truncation.content + footer;
			if (truncation.truncated) {
				outputText += `\n\n[Output truncated at ${DEFAULT_MAX_BYTES / 1024}KB; narrow the pattern or path to see the rest.]`;
			}

			return {
				content: [{ type: "text", text: outputText }],
				details: {
					matchCount: shownMatchCount,
					fileCount: files.length,
					shownFileCount: page.length,
					...(readDenyExcluded > 0 ? { readDenyExcluded } : {}),
				},
			};
		},
	};
}
