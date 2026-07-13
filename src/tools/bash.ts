import { randomBytes } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ChannelJobManager } from "../agent/job-manager.js";
import type { Executor } from "../executor.js";
import { guardCommand } from "../security/command-guard.js";
import { DEFAULT_SECURITY_CONFIG } from "../security/config.js";
import { logSecurityEvent } from "../security/logger.js";
import type { SecurityConfig, SecurityRuntimeContext } from "../security/types.js";
import { shellEscape } from "../shared/shell-escape.js";
import { maybeOptimizeCommand } from "./command-optimizer.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateTail } from "./truncate.js";

/**
 * Default wall-clock timeout for bash commands when the caller supplies neither a
 * per-call `timeout` nor a tool-level default. Without this, a hung command (a stray
 * dev server, an interactive prompt) would block the channel's run queue until `/stop`.
 * Callers that legitimately need longer must pass an explicit `timeout`.
 */
export const DEFAULT_BASH_TIMEOUT_SECONDS = 300;

/**
 * Generate a unique spill file path for full bash output. It lives under `/tmp` so the
 * path we report back is reachable by the same `read`/`bash` tools the model uses to
 * open it.
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
	async: Type.Optional(
		Type.Boolean({
			description:
				"Run in the background and return immediately with a job id instead of blocking. Use for long commands so the channel stays responsive; check it later with the job tool or a scheduled event_manage check-in.",
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
	/**
	 * When true, route each command through the `rtk` command optimizer before executing
	 * (best-effort; falls back to the raw command when rtk is unavailable or declines).
	 * Gated by `tools.rtk.enabled` in tools.json.
	 */
	rtkEnabled?: boolean;
	/**
	 * Present only on the main path when `tools.jobs.enabled` is on. Enables `async: true`
	 * background execution. Absent on the sub-agent path, so sub-agents cannot background jobs.
	 */
	jobManager?: ChannelJobManager;
	/**
	 * When true (`tools.bashInterceptor.enabled`), block a few bare shell patterns that have a
	 * better dedicated tool and steer the model to it. Off by default; main path only.
	 */
	interceptorEnabled?: boolean;
}

/**
 * Bare shell patterns that a dedicated tool handles better (with truncation, grouping, or a diff).
 * Deliberately narrow — only unambiguous bare forms, never piped/compound commands — so a legitimate
 * `cat x | jq` is untouched. Runs after the security guard (which must see the real command) and
 * before rtk. Complements rtk: rtk makes output cheaper, this steers to the right tool.
 */
const BASH_INTERCEPTOR_RULES: Array<{ test: RegExp; tool: string; why: string }> = [
	{
		test: /^\s*cat\s+[^|&;<>`$()]+$/,
		tool: "read",
		why: "it truncates safely and tells you how to page through the rest",
	},
	{
		// Anchored to end and free of pipe/redirect chars so only a *bare* recursive grep is caught;
		// a piped/compound form like `grep -rn foo . | wc -l` is a legitimate use and must pass through.
		test: /^\s*grep\b[^|&;<>]*\s-[A-Za-z]*r[A-Za-z]*\b[^|&;<>]*$/,
		tool: "grep",
		why: "it groups, paginates, and bounds output instead of flooding the context",
	},
	{ test: /^\s*rg\b[^|&;]*$/, tool: "grep", why: "it groups, paginates, and bounds output" },
	{
		test: /\b(?:sed|perl)\b[^|&;]*\s-i\b/,
		tool: "edit",
		why: "it verifies a unique match and echoes a diff of the change",
	},
];

function checkBashInterception(command: string): string | null {
	for (const rule of BASH_INTERCEPTOR_RULES) {
		if (rule.test.test(command)) {
			return `Blocked: use the ${rule.tool} tool instead — ${rule.why}. Command: ${command}`;
		}
	}
	return null;
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
	lines.push(
		"If this operation is genuinely needed, explain the intent to the user so they can adjust security.json.",
	);
	return lines.join("\n");
}

export function createBashTool(executor: Executor, options: BashToolOptions = {}): AgentTool<typeof bashSchema> {
	const securityConfig = options.securityConfig ?? DEFAULT_SECURITY_CONFIG;
	const securityContext = options.securityContext ?? {
		workspaceDir: process.cwd(),
		cwd: process.cwd(),
	};

	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout, stderr, and the exit code (a non-zero exit code is reported in the output, not raised as an error). Output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, the full output is saved to a temp file whose path is included. Commands time out after ${DEFAULT_BASH_TIMEOUT_SECONDS}s unless you pass a larger \`timeout\`.`,
		parameters: bashSchema,
		execute: async (
			_toolCallId: string,
			{
				label,
				command,
				timeout,
				async: runAsync,
			}: { label: string; command: string; timeout?: number; async?: boolean },
			signal?: AbortSignal,
		) => {
			if (securityConfig.enabled && securityConfig.commandGuard.enabled) {
				const guardResult = guardCommand(command, securityConfig.commandGuard);
				if (!guardResult.allowed) {
					await logSecurityEvent(securityContext.workspaceDir, securityConfig, {
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

			// Steer a few bare shell patterns to their dedicated tool. After the guard (which must see
			// the real command), before rtk (which would reshape it). Off by default.
			if (options.interceptorEnabled) {
				const intercepted = checkBashInterception(command);
				if (intercepted) {
					throw new Error(intercepted);
				}
			}

			// Optimize *after* the security guard: the guard must inspect the operator's real
			// intent (`command`), while rtk only reshapes a semantically-equivalent command for
			// compact output. Optimizing first would hide the true command from the guard.
			const effectiveCommand = options.rtkEnabled ? await maybeOptimizeCommand(command, executor, signal) : command;

			const effectiveTimeout = timeout ?? options.defaultTimeoutSeconds ?? DEFAULT_BASH_TIMEOUT_SECONDS;

			// Background execution: hand off to the channel's job manager and return immediately so
			// the run queue is not held for the command's duration. Gated by `tools.jobs.enabled`
			// (the main path supplies a jobManager; the sub-agent path never does).
			if (runAsync) {
				if (!options.jobManager) {
					throw new Error(
						"Background execution is not available here (enable tools.jobs.enabled, and note it is off for sub-agents). Run the command without async, or shorten it.",
					);
				}
				const job = await options.jobManager.start(effectiveCommand, label, effectiveTimeout, signal);
				return {
					content: [
						{
							type: "text",
							text:
								`Background job ${job.id} started: ${label}\n` +
								"It runs off-turn; you can end your turn now. Check it with the job tool (op:poll/list), " +
								"or schedule an event_manage check-in to be woken when it is likely done.",
						},
					],
					details: { kind: "bash", async: { state: "running", jobId: job.id } },
				};
			}

			const result = await executor.exec(effectiveCommand, { timeout: effectiveTimeout, signal });
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
					const spillResult = await executor.exec(`cat > ${shellEscape(candidatePath)}`, {
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
