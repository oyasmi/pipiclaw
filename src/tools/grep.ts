import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { Executor } from "../executor.js";
import { DEFAULT_SECURITY_CONFIG } from "../security/config.js";
import { checkPathGuard } from "../security/path-guard-check.js";
import type { SecurityConfig, SecurityRuntimeContext } from "../security/types.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { shellEscape } from "../shared/shell-escape.js";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.js";

/**
 * Structured content search over the filesystem. The execution layer is deliberately thin — one
 * `grep -rnH -B1 -A3` invocation through the shared Executor, with no native dependency. The value
 * lives in the JS-side output shaping: per-file grouping, per-file and per-page caps, and a final
 * byte bound, so a broad search can never flood the model's context the way raw `bash grep -rn` would.
 */

const CONTEXT_BEFORE = 1;
const CONTEXT_AFTER = 3;
const LINE_MAX_CHARS = 512;
/** Match cap per file: tight for multi-file scopes (anti-monopoly), generous for a single file. */
const MULTI_FILE_PER_FILE_MATCHES = 20;
const SINGLE_FILE_MATCHES = 200;
/** Files shown per page; `skip` pages through the rest. */
const FILE_PAGE_LIMIT = 20;
const SEARCH_TIMEOUT_SECONDS = 30;
/**
 * Directories never worth scanning. Pushed down to `grep --exclude-dir=` (spec 044, D5.1) so a huge
 * `node_modules` never gets scanned (and never fills the result capture cap below) in the first
 * place; kept as a JS-side post-filter too, as a backstop for a grep implementation whose
 * `--exclude-dir` semantics differ slightly.
 */
const IGNORED_DIR_SEGMENTS = new Set(["node_modules", ".git", ".hg", ".svn", "dist", "build", ".next", ".cache"]);
/**
 * Raw `grep` stdout capture cap (spec 044, D5.2). Bounded well under the executor's 10MB default so
 * a broad search can never flood memory, and `ExecResult.stdoutTruncated` (D6.2) says honestly
 * whether the cap was hit -- unlike piping through `head -n`, this leaves `result.code` as grep's
 * own exit status, so a real `grep` error (bad regex, missing path) still surfaces as one instead
 * of being masked by `head` exiting 0 regardless of what fed it.
 */
const MAX_RAW_RESULT_BYTES = 768 * 1024;

const grepSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're searching for and why (shown to user)" }),
	pattern: Type.String({ description: "Extended regular expression (ERE) to search for in file contents." }),
	path: Type.Optional(Type.String({ description: "File or directory to search. Defaults to the workspace root." })),
	glob: Type.Optional(
		Type.String({
			description: 'Filename filter for directory searches, e.g. "*.ts". Matched against the basename.',
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

/** Convert a simple `*`/`?` glob into an anchored regex matched against a basename. */
function globToRegExp(glob: string): RegExp {
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`);
}

function truncateLine(text: string): string {
	return text.length > LINE_MAX_CHARS ? `${text.slice(0, LINE_MAX_CHARS)}…` : text;
}

function isIgnoredPath(relPath: string): boolean {
	return relPath.split("/").some((segment) => IGNORED_DIR_SEGMENTS.has(segment));
}

/**
 * Parse `grep -rnH -B -A` output into ordered per-file entries. Match lines are `path:N:text`;
 * context lines are `path-N-text`. Context is attributed by anchoring on the current match file's
 * exact path string, so a hyphen or colon inside a filename can never misattribute a line. Before
 * context (which precedes a file's first match) is buffered until that match names the file.
 */
function parseGrepOutput(stdout: string): Map<string, MatchEntry[]> {
	const files = new Map<string, MatchEntry[]>();
	let currentFile: string | undefined;
	const pendingContext: string[] = [];

	const ensure = (file: string): MatchEntry[] => {
		let entries = files.get(file);
		if (!entries) {
			entries = [];
			files.set(file, entries);
		}
		return entries;
	};

	const attributeContext = (raw: string, file: string): boolean => {
		const prefix = `${file}-`;
		if (!raw.startsWith(prefix)) {
			return false;
		}
		const rest = raw.slice(prefix.length);
		const sep = rest.indexOf("-");
		if (sep < 0) {
			return false;
		}
		const lineNum = Number.parseInt(rest.slice(0, sep), 10);
		if (!Number.isFinite(lineNum)) {
			return false;
		}
		ensure(file).push({ line: lineNum, text: rest.slice(sep + 1), isMatch: false });
		return true;
	};

	for (const raw of stdout.split("\n")) {
		if (raw === "" || raw === "--") {
			continue;
		}
		const matchDelim = raw.match(/^(.+?):(\d+):/);
		if (matchDelim) {
			const file = matchDelim[1];
			const line = Number.parseInt(matchDelim[2], 10);
			const text = raw.slice(matchDelim[0].length);
			currentFile = file;
			// Retro-attribute any before-context buffered ahead of this file's first match.
			for (const buffered of pendingContext.splice(0)) {
				attributeContext(buffered, file);
			}
			ensure(file).push({ line, text, isMatch: true });
			continue;
		}
		// Context line: attribute to the current file, else buffer for the next match.
		if (!currentFile || !attributeContext(raw, currentFile)) {
			pendingContext.push(raw);
		}
	}

	return files;
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
		projectRoot: process.cwd(),
	};

	return {
		name: "grep",
		label: "grep",
		description:
			"Search file contents with an extended regular expression across a file or directory tree. Output is " +
			"grouped by file, capped per file, paginated, and token-bounded — prefer this over `bash grep -rn`, which " +
			"floods context. Match lines are marked with `*`, context lines with a space.",
		parameters: grepSchema,
		execute: async (
			_toolCallId: string,
			{
				pattern,
				path,
				glob,
				caseSensitive,
				skip,
			}: { label: string; pattern: string; path?: string; glob?: string; caseSensitive?: boolean; skip?: number },
			signal?: AbortSignal,
		) => {
			if (!pattern.trim()) {
				throw new RecoverableToolError("Pattern must not be empty.");
			}

			const searchPath = path?.trim() || ".";
			// Resolved once, then used for both the guard's judgment and the actual `grep` target
			// (spec 044, D1.1): no separate `cwd` needed on the executor call, so there is no chance of
			// the guard resolving against `projectRoot` while the shell actually runs against the
			// daemon's own cwd (F6).
			const target = await checkPathGuard(searchPath, "read", securityConfig, securityContext, {
				tool: "grep",
				channelId: options.channelId,
			});

			const flags = ["-rnH", "-E", `-B${CONTEXT_BEFORE}`, `-A${CONTEXT_AFTER}`];
			if (caseSensitive === false) {
				flags.push("-i");
			}
			// Push directory and glob filters down into `grep` itself (D5.1) so a huge `node_modules`
			// is never scanned in the first place, rather than being scanned, capped, and then
			// filtered away in JS after it already ate the whole result budget (F7). The JS-side
			// `isIgnoredPath`/`globRegExp` filtering below stays as a backstop for a `grep` whose
			// `--exclude-dir` semantics differ.
			for (const segment of IGNORED_DIR_SEGMENTS) {
				flags.push(`--exclude-dir=${segment}`);
			}
			if (glob) {
				flags.push(`--include=${glob}`);
			}
			// `--` terminates flags so a pattern beginning with `-` is not read as one. Bounded via
			// `maxCaptureBytes` (D5.2) rather than a `| head -n` pipe: piping through `head` would
			// have `sh -c` (no pipefail) report `head`'s exit status instead of grep's, silently
			// masking a real grep error (bad regex, missing path) behind `head`'s always-0 exit.
			const command = `grep ${flags.join(" ")} -- ${shellEscape(pattern)} ${shellEscape(target)}`;
			const result = await executor.exec(command, {
				timeout: SEARCH_TIMEOUT_SECONDS,
				signal,
				maxCaptureBytes: MAX_RAW_RESULT_BYTES,
			});

			// grep exit code 1 = no matches (normal), 0 = matches, >=2 = error.
			if (result.code >= 2) {
				const stderr = result.stderr.trim();
				throw new RecoverableToolError(
					`grep failed: ${stderr || `exit code ${result.code}`}. Check the regex (ERE syntax) and that the path exists.`,
				);
			}

			const rawTruncated = result.stdoutTruncated === true;
			// A truncated capture may end mid-line; drop that dangling partial line rather than feed
			// it to the parser, which expects each line to be a complete match or context line.
			const boundedStdout = rawTruncated ? result.stdout.slice(0, result.stdout.lastIndexOf("\n")) : result.stdout;

			const globRegExp = glob ? globToRegExp(glob) : undefined;
			const parsed = parseGrepOutput(boundedStdout);

			// Filter ignored dirs and (for directory scopes) the optional glob, on the basename.
			const files: Array<[string, MatchEntry[]]> = [];
			for (const [file, entries] of parsed) {
				const normalized = file.replace(/^\.\//, "");
				if (isIgnoredPath(normalized)) {
					continue;
				}
				if (globRegExp) {
					const base = normalized.split("/").pop() ?? normalized;
					if (!globRegExp.test(base)) {
						continue;
					}
				}
				files.push([normalized, entries]);
			}

			if (files.length === 0) {
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
				},
			};
		},
	};
}
