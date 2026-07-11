import type { AgentTool } from "@earendil-works/pi-agent-core";
import * as Diff from "diff";
import { Type } from "typebox";
import type { Executor } from "../executor.js";
import { DEFAULT_SECURITY_CONFIG } from "../security/config.js";
import { logSecurityEvent } from "../security/logger.js";
import { guardPath } from "../security/path-guard.js";
import type { SecurityConfig, SecurityRuntimeContext } from "../security/types.js";
import { shellEscape } from "../shared/shell-escape.js";
import { writeContent } from "./write-content.js";

/**
 * Generate a unified diff string with line numbers and context
 */
function generateDiffString(oldContent: string, newContent: string, contextLines = 4): string {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
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

/** Max diff lines echoed back to the model in the success result before eliding the rest. */
const DIFF_ECHO_MAX_LINES = 40;
/** Consecutive byte-identical no-ops of the same payload before the soft error escalates to a hard stop. */
const NOOP_HARD_LIMIT = 3;

function clampDiffForEcho(diff: string): string {
	const lines = diff.split("\n");
	if (lines.length <= DIFF_ECHO_MAX_LINES) {
		return diff;
	}
	const shown = lines.slice(0, DIFF_ECHO_MAX_LINES).join("\n");
	return `${shown}\n[diff truncated, ${lines.length - DIFF_ECHO_MAX_LINES} more lines]`;
}

export function createEditTool(executor: Executor, options: EditToolOptions = {}): AgentTool<typeof editSchema> {
	const securityConfig = options.securityConfig ?? DEFAULT_SECURITY_CONFIG;
	const securityContext = options.securityContext ?? {
		workspaceDir: process.cwd(),
		cwd: process.cwd(),
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
			if (securityConfig.enabled && securityConfig.pathGuard.enabled) {
				const readGuard = guardPath(path, "read", { ...securityContext, config: securityConfig.pathGuard });
				if (!readGuard.allowed) {
					logSecurityEvent(securityContext.workspaceDir, securityConfig, {
						type: "path",
						tool: "edit",
						channelId: options.channelId,
						rawPath: path,
						operation: "read",
						resolvedPath: readGuard.resolvedPath,
						category: readGuard.category,
						reason: readGuard.reason,
					});
					throw new Error(formatPathBlockMessage(readGuard.resolvedPath, readGuard.category, readGuard.reason));
				}
			}

			// Read the file
			const readResult = await executor.exec(`cat ${shellEscape(path)}`, { signal });
			if (readResult.code !== 0) {
				throw new Error(readResult.stderr || `File not found: ${path}`);
			}

			const content = readResult.stdout;

			// Check if old text exists
			if (!content.includes(oldText)) {
				throw new Error(
					`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
				);
			}

			// Count occurrences
			const occurrences = content.split(oldText).length - 1;

			if (occurrences > 1 && !replaceAll) {
				throw new Error(
					`Found ${occurrences} occurrences of the text in ${path}. The text must be unique, or pass replaceAll: true to replace all of them. Please provide more context to make it unique.`,
				);
			}

			// Perform replacement
			let newContent: string;
			if (replaceAll) {
				newContent = content.split(oldText).join(newText);
			} else {
				const index = content.indexOf(oldText);
				newContent = content.substring(0, index) + newText + content.substring(index + oldText.length);
			}

			if (content === newContent) {
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
				throw new Error(
					`No changes made to ${path}: oldText and newText are byte-identical at the match, so the replacement produced no change. ` +
						`Re-read the file to confirm what actually needs changing before editing again.`,
				);
			}
			// A real edit breaks any no-op streak.
			noopCounts.clear();

			// Write the file back
			await writeContent(executor, path, newContent, signal, {
				securityConfig,
				securityContext,
				channelId: options.channelId,
				toolName: "edit",
			});

			const replacementSummary = replaceAll
				? `Replaced ${occurrences} occurrence${occurrences === 1 ? "" : "s"} in ${path}.`
				: `Successfully replaced text in ${path}. Changed ${oldText.length} characters to ${newText.length} characters.`;

			const diff = generateDiffString(content, newContent);
			// Echo the diff into the model-visible text so it can confirm the change landed where it
			// intended without a follow-up read; `details.diff` stays the full diff for the UI.
			const echoedDiff = diff.trim() ? `\n\n${clampDiffForEcho(diff)}` : "";

			return {
				content: [{ type: "text", text: `${replacementSummary}${echoedDiff}` }],
				details: {
					diff,
					patch: Diff.createPatch(path, content, newContent),
				},
			};
		},
	};
}
