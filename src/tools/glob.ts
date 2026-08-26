import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { FileStore } from "../file-store.js";
import { DEFAULT_SECURITY_CONFIG } from "../security/config.js";
import { checkPathGuard } from "../security/path-guard-check.js";
import type { SecurityConfig, SecurityRuntimeContext } from "../security/types.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { compileGlobPattern } from "./glob-match.js";
import { IGNORED_DIR_SEGMENTS } from "./ignore-dirs.js";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.js";

/**
 * Path discovery by glob pattern, over `FileStore.walkFiles` rather than a `find` shell-out: no
 * GNU/BSD flag drift to worry about, and the walk (prune, entry cap) and the match/sort/format
 * pipeline are both ours to bound. Complements `grep` (content search) — this tool never reads
 * file bytes.
 */

/** Hard bound on directory entries the walk itself will traverse, regardless of match count. */
const MAX_SCAN_ENTRIES = 50_000;
/** Matched files are only `stat`-ed (for mtime ordering) up to this many; beyond it, scan order stands. */
const MAX_STAT_FOR_SORT = 2_000;
/** Paths shown inline; matching `grep`'s FILE_PAGE_LIMIT order of magnitude for a discovery tool. */
const GLOB_MAX_RESULTS = 100;

const globSchema = Type.Object({
	pattern: Type.String({
		description:
			'Glob pattern to match file paths against (e.g. "**/*.ts", "src/**/*.test.js"). A pattern with no "/" ' +
			'matches the basename at any depth, so "*" and "*.ts" both search the whole tree; include a "/" to anchor the depth.',
	}),
	path: Type.Optional(Type.String({ description: "Directory to search in. Defaults to the workspace/project root." })),
});

export interface GlobToolOptions {
	securityConfig?: SecurityConfig;
	securityContext?: SecurityRuntimeContext;
	channelId?: string;
}

interface MatchedFile {
	relativePath: string;
	mtimeMs: number;
}

export function createGlobTool(fileStore: FileStore, options: GlobToolOptions = {}): AgentTool<typeof globSchema> {
	const securityConfig = options.securityConfig ?? DEFAULT_SECURITY_CONFIG;
	const securityContext = options.securityContext ?? {
		agentWorkspaceDir: process.cwd(),
		projectRoot: process.cwd(),
	};

	return {
		name: "glob",
		label: "glob",
		description:
			"Find files whose paths match a glob pattern. Returns matching file paths only (never directories), " +
			"including hidden files; VCS/build directories (node_modules, .git, dist, ...) are excluded. Prefer this " +
			"over `bash find`/`ls -R` for path discovery — it is bounded and sorted by modification time (newest first) " +
			`when few enough files match; up to ${GLOB_MAX_RESULTS} paths come back inline.`,
		parameters: globSchema,
		execute: async (
			_toolCallId: string,
			{ pattern, path }: { pattern: string; path?: string },
			signal?: AbortSignal,
		) => {
			if (!pattern.trim()) {
				throw new RecoverableToolError("Pattern must not be empty.");
			}

			const searchPath = path?.trim() || ".";
			const target = await checkPathGuard(searchPath, "read", securityConfig, securityContext, {
				tool: "glob",
				channelId: options.channelId,
			});

			let matcher: RegExp;
			try {
				matcher = compileGlobPattern(pattern);
			} catch {
				throw new RecoverableToolError(`Invalid glob pattern: ${pattern}`);
			}

			const walk = await fileStore.walkFiles(target, {
				maxEntries: MAX_SCAN_ENTRIES,
				prune: (name) => IGNORED_DIR_SEGMENTS.has(name),
				signal,
			});

			const matched = walk.files.filter((relativePath) => matcher.test(relativePath));

			if (matched.length === 0) {
				const scope = path ? `${searchPath}` : "the workspace";
				const text = walk.truncated
					? `Scan of ${scope} hit the ${MAX_SCAN_ENTRIES.toLocaleString()}-file limit before any path matched "${pattern}". ` +
						"Narrow path to a smaller subtree so the scan can complete."
					: `No files matching "${pattern}" in ${scope}.`;
				return { content: [{ type: "text" as const, text }], details: { matchCount: 0 } };
			}

			const sortableByMtime = matched.length <= MAX_STAT_FOR_SORT;
			let ordered: string[];
			if (sortableByMtime) {
				const withMtime: MatchedFile[] = [];
				for (const relativePath of matched) {
					const stat = await fileStore.stat(join(target, ...relativePath.split("/")));
					withMtime.push({ relativePath, mtimeMs: stat?.mtimeMs ?? 0 });
				}
				withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
				ordered = withMtime.map((entry) => entry.relativePath);
			} else {
				ordered = matched;
			}

			const page = ordered.slice(0, GLOB_MAX_RESULTS);
			const footerParts: string[] = [];
			if (ordered.length > page.length) {
				footerParts.push(
					`Showing ${page.length} of ${ordered.length} matches${sortableByMtime ? ", newest first" : ""}. ` +
						"Narrow the pattern, or pass path=<subdir>, to see the rest.",
				);
			} else if (!sortableByMtime) {
				footerParts.push(`${ordered.length} matches, in scan order (too many to sort by modification time).`);
			}
			if (walk.truncated) {
				footerParts.push(
					`Scan stopped after ${MAX_SCAN_ENTRIES.toLocaleString()} files; results may be incomplete. Narrow path to search a smaller subtree.`,
				);
			}

			const body = page.join("\n");
			const truncation = truncateHead(body);
			let outputText = truncation.content;
			if (footerParts.length > 0) {
				outputText += `\n\n[${footerParts.join(" ")}]`;
			}
			if (truncation.truncated) {
				outputText += `\n\n[Output truncated at ${formatSize(DEFAULT_MAX_BYTES)}; narrow the pattern or path to see the rest.]`;
			}

			return {
				content: [{ type: "text" as const, text: outputText }],
				details: { matchCount: ordered.length, shownCount: page.length, scanTruncated: walk.truncated },
			};
		},
	};
}
