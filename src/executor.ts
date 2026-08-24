import { spawn } from "child_process";

const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;

/**
 * Create an executor that runs commands on the host machine.
 */
export function createExecutor(): Executor {
	return new HostExecutor();
}

/**
 * Thrown instead of a plain `Error` when a command is cut short by timeout or abort. Kept
 * deliberately short (no stdout/stderr in the message) because the caught `Error.message` is what
 * a pi SDK tool-call rejection puts, verbatim and untruncated, into the model's context (fix plan
 * §2.2) -- `stdout`/`stderr` are still here for a caller (bash.ts) that wants to show a truncated
 * tail instead of losing the partial output outright.
 */
export class CommandTerminatedError extends Error {
	readonly stdout: string;
	readonly stderr: string;
	readonly reason: "timeout" | "aborted";
	readonly timeoutSeconds?: number;

	constructor(reason: "timeout" | "aborted", stdout: string, stderr: string, timeoutSeconds?: number) {
		super(reason === "timeout" ? `Command timed out after ${timeoutSeconds} seconds` : "Command aborted");
		this.name = "CommandTerminatedError";
		this.reason = reason;
		this.stdout = stdout;
		this.stderr = stderr;
		this.timeoutSeconds = timeoutSeconds;
	}
}

export interface Executor {
	/**
	 * Execute a bash command
	 */
	exec(command: string, options?: ExecOptions): Promise<ExecResult>;
}

export interface ExecOptions {
	timeout?: number;
	signal?: AbortSignal;
	stdin?: string;
	/** Directory to run the command in. Defaults to the daemon's own working directory. */
	cwd?: string;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

class HostExecutor implements Executor {
	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		return new Promise((resolve, reject) => {
			const child = (() => {
				try {
					return spawn("sh", ["-c", command], {
						detached: true,
						stdio: ["pipe", "pipe", "pipe"],
						...(options?.cwd ? { cwd: options.cwd } : {}),
					});
				} catch (err) {
					reject(err instanceof Error ? err : new Error(String(err)));
					return null;
				}
			})();

			if (!child) {
				return;
			}

			let stdout = "";
			let stderr = "";
			let stdoutCapped = false;
			let stderrCapped = false;
			let timedOut = false;
			let settled = false;

			const cleanup = () => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (options?.signal) {
					options.signal.removeEventListener("abort", onAbort);
				}
			};

			const rejectOnce = (err: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(err);
			};

			const resolveOnce = (result: ExecResult) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(result);
			};

			const timeoutHandle =
				options?.timeout && options.timeout > 0
					? setTimeout(() => {
							timedOut = true;
							killProcessTree(child.pid!);
						}, options.timeout * 1000)
					: undefined;

			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};

			if (options?.signal) {
				if (options.signal.aborted) {
					onAbort();
				} else {
					options.signal.addEventListener("abort", onAbort, { once: true });
				}
			}

			// Capped-and-discard rather than "append then re-slice to the cap every chunk": the latter
			// re-copies up to MAX_CAPTURE_BYTES on every single data event once a command is already
			// at the cap, which for a high-output command is many GB of memcpy that blocks the event
			// loop for the whole daemon (fix plan §2.2).
			child.stdout?.on("data", (data) => {
				if (stdoutCapped) return;
				stdout += data.toString();
				if (stdout.length > MAX_CAPTURE_BYTES) {
					stdout = stdout.slice(0, MAX_CAPTURE_BYTES);
					stdoutCapped = true;
				}
			});

			child.stderr?.on("data", (data) => {
				if (stderrCapped) return;
				stderr += data.toString();
				if (stderr.length > MAX_CAPTURE_BYTES) {
					stderr = stderr.slice(0, MAX_CAPTURE_BYTES);
					stderrCapped = true;
				}
			});

			child.on("error", (err) => {
				rejectOnce(err instanceof Error ? err : new Error(String(err)));
			});

			child.on("close", (code) => {
				if (options?.signal?.aborted) {
					rejectOnce(new CommandTerminatedError("aborted", stdout, stderr));
					return;
				}

				if (timedOut) {
					rejectOnce(new CommandTerminatedError("timeout", stdout, stderr, options?.timeout));
					return;
				}

				resolveOnce({ stdout, stderr, code: code ?? 0 });
			});

			if (options?.stdin !== undefined) {
				child.stdin?.on("error", (err) => {
					if ((err as NodeJS.ErrnoException).code === "EPIPE") return;
					rejectOnce(err instanceof Error ? err : new Error(String(err)));
				});
				child.stdin?.end(options.stdin);
			} else {
				child.stdin?.end();
			}
		});
	}
}

function killProcessTree(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Process already dead
		}
	}
}
