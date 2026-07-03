import { randomBytes } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { Executor } from "../sandbox.js";
import { guardCommand } from "../security/command-guard.js";
import { DEFAULT_SECURITY_CONFIG } from "../security/config.js";
import { logSecurityEvent } from "../security/logger.js";
import type { SecurityConfig, SecurityRuntimeContext } from "../security/types.js";
import { shellEscapePath } from "../shared/shell-escape.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateTail } from "./truncate.js";

/**
 * Default wall-clock timeout for bash commands when the caller supplies neither a
 * per-call `timeout` nor a tool-level default. Without this, a hung command (a stray
 * dev server, an interactive prompt) would block the channel's run queue until `/stop`.
 * Callers that legitimately need longer must pass an explicit `timeout`.
 */
export const DEFAULT_BASH_TIMEOUT_SECONDS = 300;

/**
 * Generate a unique spill file path for full bash output. This lives inside the
 * executor's filesystem (the sandbox), not the host, so the path we report back is
 * reachable by the same `read`/`bash` tools the model uses to open it. `/tmp` exists
 * and is writable in both the host and Docker (Alpine) sandboxes.
 */
function getSpillFilePath(): string {
	const id = randomBytes(8).toString("hex");
	return `/tmp/pipiclaw-bash-${id}.log`;
}

const bashSchema = Type.Object({
	label: Type.String({ description: "Brief description of what this command does (shown to user)" }),
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(
		Type.Integer({
			minimum: 1,
			description: `Timeout in seconds. Defaults to ${DEFAULT_BASH_TIMEOUT_SECONDS}s; pass a larger value for long-running commands.`,
		}),
	),
});

interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
	exitCode?: number;
}

export interface BashToolOptions {
	defaultTimeoutSeconds?: number;
	securityConfig?: SecurityConfig;
	securityContext?: SecurityRuntimeContext;
	channelId?: string;
}

function formatCommandBlockMessage(command: string, category?: string, reason?: string, matchedText?: string): string {
	const lines = [`Command blocked${category ? ` [${category}]` : ""}`];
	if (reason) {
		lines.push(`Reason: ${reason}`);
	}
	if (matchedText) {
		lines.push(`Matched: ${matchedText}`);
	} else {
		lines.push(`Command: ${command}`);
	}
	return lines.join("\n");
}

export function createBashTool(executor: Executor, options: BashToolOptions = {}): AgentTool<typeof bashSchema> {
	const securityConfig = options.securityConfig ?? DEFAULT_SECURITY_CONFIG;
	const securityContext = options.securityContext ?? {
		workspaceDir: process.cwd(),
		workspacePath: process.cwd(),
		cwd: process.cwd(),
	};

	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout, stderr, and the exit code (a non-zero exit code is reported in the output, not raised as an error). Output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, the full output is saved to a temp file whose path is included. Commands time out after ${DEFAULT_BASH_TIMEOUT_SECONDS}s unless you pass a larger \`timeout\`.`,
		parameters: bashSchema,
		execute: async (
			_toolCallId: string,
			{ command, timeout }: { label: string; command: string; timeout?: number },
			signal?: AbortSignal,
		) => {
			if (securityConfig.enabled && securityConfig.commandGuard.enabled) {
				const guardResult = guardCommand(command, securityConfig.commandGuard);
				if (!guardResult.allowed) {
					logSecurityEvent(securityContext.workspaceDir, securityConfig, {
						type: "command",
						tool: "bash",
						channelId: options.channelId,
						command,
						category: guardResult.category,
						rule: guardResult.rule,
						reason: guardResult.reason,
						matchedText: guardResult.matchedText,
					});
					throw new Error(
						formatCommandBlockMessage(command, guardResult.category, guardResult.reason, guardResult.matchedText),
					);
				}
			}

			const effectiveTimeout = timeout ?? options.defaultTimeoutSeconds ?? DEFAULT_BASH_TIMEOUT_SECONDS;
			const result = await executor.exec(command, { timeout: effectiveTimeout, signal });
			let output = "";
			if (result.stdout) output += result.stdout;
			if (result.stderr) {
				if (output) output += "\n";
				output += result.stderr;
			}

			const totalBytes = Buffer.byteLength(output, "utf-8");

			// Spill the full output to a temp file (inside the executor's filesystem, so the
			// reported path is reachable by the model) when it exceeds the inline limit.
			// Best-effort: if the write fails, we simply omit the path hint from the notice.
			let tempFilePath: string | undefined;
			if (totalBytes > DEFAULT_MAX_BYTES) {
				const candidatePath = getSpillFilePath();
				try {
					const spillResult = await executor.exec(`cat > ${shellEscapePath(candidatePath)}`, {
						signal,
						stdin: output,
					});
					if (spillResult.code === 0) {
						tempFilePath = candidatePath;
					}
				} catch {
					// Ignore spill failures; the truncated output is still returned.
				}
			}

			// Apply tail truncation
			const truncation = truncateTail(output);
			let outputText = truncation.content || "(no output)";

			// Build details with truncation info
			let details: BashToolDetails | undefined;

			if (truncation.truncated) {
				details = {
					truncation,
					fullOutputPath: tempFilePath,
				};

				// Build actionable notice
				const startLine = truncation.totalLines - truncation.outputLines + 1;
				const endLine = truncation.totalLines;
				const fullOutputHint = tempFilePath ? ` Full output: ${tempFilePath}` : "";

				if (truncation.lastLinePartial) {
					// Edge case: last line alone > 50KB
					const lastLineSize = formatSize(Buffer.byteLength(output.split("\n").pop() || "", "utf-8"));
					outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}).${fullOutputHint}]`;
				} else if (truncation.truncatedBy === "lines") {
					outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}.${fullOutputHint}]`;
				} else {
					outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit).${fullOutputHint}]`;
				}
			}

			// A non-zero exit code is a normal result, not a tool failure: commands like
			// `grep` (no match), `diff` (differences), and `test` use exit codes as data.
			// Report the code inline so the model can react without treating it as an error.
			if (result.code !== 0) {
				outputText += `\n\nExit code: ${result.code}`;
				details = { ...details, exitCode: result.code };
			}

			return { content: [{ type: "text", text: outputText }], details };
		},
	};
}
