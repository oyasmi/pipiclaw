import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ChannelJobManager } from "../agent/job-manager.js";
import { CommandTerminatedError, EXECUTOR_SHELL_IS_BASH, type Executor } from "../executor.js";
import { formatBlockMessage } from "../security/block-message.js";
import { guardCommand } from "../security/command-guard.js";
import { DEFAULT_SECURITY_CONFIG } from "../security/config.js";
import { logSecurityEvent } from "../security/logger.js";
import type { SecurityConfig, SecurityRuntimeContext } from "../security/types.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { clipText } from "../shared/text-utils.js";
import { maybeOptimizeCommand } from "./command-optimizer.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateTail } from "./truncate.js";

/**
 * Default wall-clock timeout for bash commands when the caller supplies neither a
 * per-call `timeout` nor a tool-level default. Without this, a hung command (a stray
 * dev server, an interactive prompt) would block the channel's run queue until `/stop`.
 * Callers that legitimately need longer must pass an explicit `timeout`.
 */
export const DEFAULT_BASH_TIMEOUT_SECONDS = 300;

/** Subdirectory of the channel dir where full bash/job output spills live. */
const BASH_LOG_DIR_NAME = "logs";
/** Spill files kept per channel before the oldest are pruned on the next tool build. */
const BASH_LOG_RETENTION = 40;
/** Bytes read back from the spill file when the in-memory capture was truncated (D2.3). */
const TAIL_FROM_SPILL_BYTES = DEFAULT_MAX_BYTES * 4;

/**
 * Where the "full output" spill file for a command goes. Under `<channelDir>/logs/` on the main
 * path, which the model's `read` can open under both `boundary: "project"` and `unbounded` — a
 * `/tmp/...` pointer is unreadable under `boundary: "project"` (fix plan §2.2). Sub-agents get no
 * channel dir, so they fall back to the OS temp dir as before.
 */
function getSpillFilePath(channelDir: string | undefined): string {
	const id = randomBytes(8).toString("hex");
	const dir = channelDir ? join(channelDir, BASH_LOG_DIR_NAME) : tmpdir();
	return join(dir, `pipiclaw-bash-${id}.log`);
}

/** Best-effort: keep the channel's `logs/` dir from growing without bound. */
async function pruneBashLogs(channelDir: string): Promise<void> {
	const dir = join(channelDir, BASH_LOG_DIR_NAME);
	let names: string[];
	try {
		names = (await readdir(dir)).filter((n) => n.startsWith("pipiclaw-bash-") && n.endsWith(".log"));
	} catch {
		return;
	}
	if (names.length <= BASH_LOG_RETENTION) return;
	const withMtime = await Promise.all(
		names.map(async (n) => ({ n, m: (await stat(join(dir, n)).catch(() => null))?.mtimeMs ?? 0 })),
	);
	withMtime.sort((a, b) => b.m - a.m);
	await Promise.all(withMtime.slice(BASH_LOG_RETENTION).map(({ n }) => unlink(join(dir, n)).catch(() => undefined)));
}

/** Read the last `maxBytes` of a file as UTF-8 text (used when the in-memory capture is only a head). */
async function readFileTail(path: string, maxBytes: number): Promise<string> {
	const size = (await stat(path)).size;
	const start = Math.max(0, size - maxBytes);
	const fh = await open(path, "r");
	try {
		const buf = Buffer.alloc(size - start);
		await fh.read(buf, 0, buf.length, start);
		return buf.toString("utf-8");
	} finally {
		await fh.close();
	}
}

const bashSchema = Type.Object({
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
				"Run in the background and return immediately with a job id instead of blocking. Use for long commands so the channel stays responsive; you are woken automatically when the job finishes.",
		}),
	),
	notify: Type.Optional(
		Type.Boolean({
			description:
				"For async jobs: wake this channel when the job finishes (default true). Set false only for fire-and-forget work whose result you will never need.",
		}),
	),
	taskId: Type.Optional(
		Type.String({
			description: "For async jobs: the task this job advances, so the completion wake lands in that context.",
		}),
	),
});

/** Schema shown when background execution is unavailable (sub-agent path): the async trio is
 * dropped so the model is never offered a parameter its context cannot honor (fix plan §3.2). */
const bashSchemaNoJobs = Type.Omit(bashSchema, ["async", "notify", "taskId"]);
/** Schema shown inside a task session: `taskId` is bound by the runtime, so the model never
 * supplies (or misfills) it (fix plan §3.3). */
const bashSchemaBoundTask = Type.Omit(bashSchema, ["taskId"]);

interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
	/** Always set on the synchronous path, including 0 — the task governor reads it (D7). */
	exitCode?: number;
	/** Whether the command wrote anything to stdout/stderr. */
	producedOutput?: boolean;
	/** Set instead of `exitCode` when the command was cut short by timeout or abort. */
	timedOut?: boolean;
}

export interface BashToolOptions {
	defaultTimeoutSeconds?: number;
	securityConfig?: SecurityConfig;
	securityContext?: SecurityRuntimeContext;
	channelId?: string;
	/**
	 * The channel directory. When set, the "full output" spill file lives under
	 * `<channelDir>/logs/` so the pointer the tool hands back is one the model's `read` can open
	 * under both path-guard boundaries. Absent on the sub-agent path (spill falls back to tmpdir).
	 */
	channelDir?: string;
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
	 * Set inside a task cycle's session. A background job started here belongs to this task, so the
	 * runtime binds the id rather than asking the model to repeat it (and rejects a conflicting one
	 * before the job launches — the old "relaunch with taskId=…" told the model to re-run a command
	 * that may have side effects). Chat sessions leave this unset and keep the optional `taskId`.
	 */
	boundTaskId?: string;
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
	{
		// Only a *pure content* `rg` (no output-shape flag) has a `grep`-tool equivalent. Let
		// `rg --files`, `rg -l`/`--files-with-matches`, `rg -c`/`--count`, `rg --type*` through —
		// forms the grep tool cannot express (fix plan §3.5). Erring toward passing a command
		// through is the safe direction.
		test: /^\s*rg\b(?![^|&;]*\s-{1,2}\S*[lct])[^|&;]*$/,
		tool: "grep",
		why: "it groups, paginates, and bounds output",
	},
	{
		test: /^\s*find\s+[^|&;<>`$()]*-name\b[^|&;<>`$()]*$/,
		tool: "glob",
		why: "it discovers paths by pattern without a platform-dependent find dialect, and bounds/sorts the result",
	},
	{
		test: /^\s*ls\s+-[A-Za-z]*R[A-Za-z]*\b[^|&;<>]*$/,
		tool: "glob",
		why: "it discovers file paths without listing directories, and bounds/sorts the result",
	},
	{
		// Only a *single-file* in-place `sed`/`perl` maps to what `edit` does: flags, `-i`, a script
		// arg, then exactly one non-glob path. A multi-file batch replace (two paths, or a glob) is
		// something `edit` cannot do, so let it through (fix plan §3.5).
		test: /\b(?:sed|perl)\b(?:\s+-\S+)*\s+-i\S*\s+(?:'[^']*'|"[^"]*"|\S+)\s+[^\s|&;*?[\]]+\s*$/,
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
	const details = [];
	if (reason) details.push({ label: "Reason", value: reason });
	details.push(matchedText ? { label: "Matched", value: matchedText } : { label: "Command", value: command });
	return `${formatBlockMessage("Command", category, details)}\nIf this operation is genuinely needed, explain the intent to the user so they can adjust security.json.`;
}

export function createBashTool(executor: Executor, options: BashToolOptions = {}): AgentTool<typeof bashSchema> {
	const securityConfig = options.securityConfig ?? DEFAULT_SECURITY_CONFIG;
	const securityContext = options.securityContext ?? {
		agentWorkspaceDir: process.cwd(),
		projectRoot: process.cwd(),
	};
	if (options.channelDir) {
		void pruneBashLogs(options.channelDir);
	}

	return {
		name: "bash",
		label: "bash",
		// A bash command can write any file, so running it alongside a concurrent `edit`/`write` in
		// the same batch reopens the lost-update window that `checkFingerprintUnchanged` cannot close
		// (both calls pass the pre-write fingerprint check, then each rewrites the whole file). This
		// is a process-local measure only: external sub-agents are separate host processes and are
		// not serialized by it. The SDK serializes the whole batch if *any* tool in it is sequential.
		executionMode: "sequential",
		description: `Execute a ${EXECUTOR_SHELL_IS_BASH ? "bash" : "POSIX sh (no bash on this host)"} command in the current working directory. Returns stdout, stderr, and the exit code (a non-zero exit code is reported in the output, not raised as an error). Output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, the full output is saved to a file whose path is included. Commands time out after ${options.defaultTimeoutSeconds ?? DEFAULT_BASH_TIMEOUT_SECONDS}s unless you pass a larger \`timeout\`.`,
		parameters: (options.jobManager
			? options.boundTaskId
				? bashSchemaBoundTask
				: bashSchema
			: bashSchemaNoJobs) as typeof bashSchema,
		execute: async (
			_toolCallId: string,
			{
				command,
				timeout,
				async: runAsync,
				notify,
				taskId,
			}: { command: string; timeout?: number; async?: boolean; notify?: boolean; taskId?: string },
			signal?: AbortSignal,
		) => {
			if (securityConfig.enabled && securityConfig.commandGuard.enabled) {
				const guardResult = guardCommand(command, securityConfig.commandGuard);
				if (!guardResult.allowed) {
					await logSecurityEvent(securityContext.agentWorkspaceDir, securityConfig, {
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
					throw new RecoverableToolError(intercepted);
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
			// Inside a task session the runtime owns the task id; a conflicting one supplied through a
			// non-schema path is rejected before anything launches (fix plan §3.3).
			if (options.boundTaskId && taskId && taskId !== options.boundTaskId) {
				throw new RecoverableToolError(
					`This is task ${options.boundTaskId}'s session — drop taskId (it is bound automatically); "${taskId}" does not belong here.`,
				);
			}
			const effectiveTaskId = options.boundTaskId ?? taskId;

			if (runAsync) {
				if (effectiveTaskId && notify === false) {
					throw new RecoverableToolError(
						"Task-owned jobs must notify their task when they finish. Keep notify=true (the default); only use notify=false for fire-and-forget work with no taskId.",
					);
				}
				if (!options.jobManager) {
					throw new RecoverableToolError(
						"This context does not support background execution (sub-agents never get it). Run the command without async, or split it into shorter steps.",
					);
				}
				const willNotify = notify ?? true;
				const jobLabel = clipText(effectiveCommand, 60, { collapseWhitespace: true });
				const job = await options.jobManager.start(effectiveCommand, jobLabel, effectiveTimeout, {
					signal,
					notify: willNotify,
					...(effectiveTaskId ? { taskId: effectiveTaskId } : {}),
				});
				return {
					content: [
						{
							type: "text",
							text:
								`Background job ${job.id} started: ${jobLabel}\n` +
								(willNotify
									? "Complete any independent work, then end the turn when only waiting remains. Completion wakes this channel with the exit code and output; do not poll or schedule a check-in. " +
										"Inside a task step, park with task_step_end on this job id."
									: "It runs off-turn and will NOT wake you when it finishes; check it with the job tool (op:poll/list)."),
						},
					],
					details: { async: { state: "running", jobId: job.id } },
				};
			}

			// Spill + tail-truncate a combined stdout/stderr blob, sharing the same path for a normal
			// result and one cut short by timeout/abort (fix plan §2.2): a timed-out `npm test` used
			// to reject with up to 10MB of raw output stuffed straight into the tool-call error
			// message, which the pi SDK puts into the model's context verbatim and unbounded.
			//
			// `spillPath` was written by the executor as stdout/stderr arrived (`ExecOptions.spillTo`,
			// spec 044 D6.3) -- unlike the in-memory `stdout`/`stderr` here, it is never capped at
			// the 10MB capture bound, so it is the one place that can honestly be called "full
			// output" for a command whose real output exceeds that cap. It is deleted below when it
			// turns out not to be needed.
			const buildOutputText = async (
				stdout: string,
				stderr: string,
				spillPath: string,
				captureTruncated: boolean,
			): Promise<{ text: string; details: BashToolDetails }> => {
				let output = "";
				if (stdout) output += stdout;
				if (stderr) {
					if (output) output += "\n";
					output += stderr;
				}

				// When the executor's 10MB in-memory capture was itself truncated, `output` is only
				// the *head* of the stream, so `truncateTail(output)` would return the middle of the
				// command's output and label it the tail (fix plan §2.3). Read the real tail from the
				// spill file — the one uncapped copy — and never quote a total line count we never saw.
				if (captureTruncated) {
					let tailSource = output;
					try {
						tailSource = await readFileTail(spillPath, TAIL_FROM_SPILL_BYTES);
					} catch {
						// Spill unreadable: fall back to the capped head's tail; still bounded.
					}
					const tailTrunc = truncateTail(tailSource);
					const shownBytes = Buffer.byteLength(tailTrunc.content, "utf-8");
					const text =
						`${tailTrunc.content || "(no output)"}\n\n` +
						`[Output capture was cut off at ${formatSize(DEFAULT_MAX_BYTES)}+; showing the last ${formatSize(shownBytes)} of the complete output. Full output: ${spillPath}]`;
					return {
						text,
						details: { truncation: tailTrunc, fullOutputPath: spillPath, producedOutput: true },
					};
				}

				const truncation = truncateTail(output);
				let text = truncation.content || "(no output)";
				let details: BashToolDetails | undefined;

				if (truncation.truncated) {
					details = { truncation, fullOutputPath: spillPath };

					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					const fullOutputHint = ` Full output: ${spillPath}`;

					if (truncation.lastLinePartial) {
						const lastLineSize = formatSize(Buffer.byteLength(output.split("\n").pop() || "", "utf-8"));
						text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}).${fullOutputHint}]`;
					} else if (truncation.truncatedBy === "lines") {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}.${fullOutputHint}]`;
					} else {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit).${fullOutputHint}]`;
					}
				} else {
					// No truncation happened after all -- the spill file was insurance against the
					// in-memory capture cap, not a promised artifact; clean it up rather than leaving
					// clutter behind on every single bash call.
					await unlink(spillPath).catch(() => undefined);
				}

				return { text, details: { ...details, producedOutput: output.trim().length > 0 } };
			};

			const spillPath = getSpillFilePath(options.channelDir);
			if (options.channelDir) {
				await mkdir(join(options.channelDir, BASH_LOG_DIR_NAME), { recursive: true }).catch(() => undefined);
			}
			try {
				const result = await executor.exec(effectiveCommand, {
					timeout: effectiveTimeout,
					signal,
					spillTo: spillPath,
				});
				const built = await buildOutputText(
					result.stdout,
					result.stderr,
					spillPath,
					result.stdoutTruncated === true || result.stderrTruncated === true,
				);
				let outputText = built.text;

				// A non-zero exit code is a normal result, not a tool failure: commands like
				// `grep` (no match), `diff` (differences), and `test` use exit codes as data.
				// Report the code inline so the model can react without treating it as an error.
				if (result.code !== 0) {
					outputText += `\n\nExit code: ${result.code}`;
				}
				// Recorded unconditionally (not only on failure) because the task governor judges a
				// wake's productivity from it: a command that ran clean and returned something is the
				// evidence that a turn spent driving an external tool was not idle.
				const details: BashToolDetails = { ...built.details, exitCode: result.code };

				return { content: [{ type: "text", text: outputText }], details };
			} catch (error) {
				if (!(error instanceof CommandTerminatedError)) {
					throw error;
				}
				const built = await buildOutputText(error.stdout, error.stderr, spillPath, error.captureTruncated);
				const nextStep =
					error.reason === "timeout"
						? `Retry with a larger \`timeout\` (currently ${error.timeoutSeconds}s), or pass \`async: true\` to run it in the background and be woken when it finishes.`
						: "The command was stopped (e.g. by /stop or a run cancellation); partial output above.";
				const outputText = `${built.text}\n\n[${error.message}; partial output above. ${nextStep}]`;
				const details: BashToolDetails = { ...built.details, timedOut: true };
				return { content: [{ type: "text", text: outputText }], details };
			}
		},
	};
}
