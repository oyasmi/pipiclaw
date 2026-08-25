import { createWriteStream, type WriteStream } from "node:fs";
import { spawn } from "child_process";

/**
 * Default in-memory capture cap for a command's stdout/stderr, in bytes (spec 044, D6.1/D6.2).
 * This is `Executor`'s own bound for *command output* -- file content never goes through it (see
 * `src/file-store.ts`). A caller that needs a different bound (e.g. `grep`) can override it with
 * `ExecOptions.maxCaptureBytes`.
 */
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
	/** Override the default 10MB in-memory capture cap for this call (spec 044, D6.2). */
	maxCaptureBytes?: number;
	/**
	 * When set, every stdout/stderr byte is also streamed to this path as it arrives, independent
	 * of `maxCaptureBytes` -- so a caller (e.g. `bash`) can offer a genuinely complete "full output"
	 * file even for a command whose captured `ExecResult.stdout`/`stderr` was truncated (spec 044,
	 * D6.3). Best-effort: a stream failure is swallowed, since the capped in-memory result is still
	 * returned either way. Interleaves stdout and stderr in arrival order.
	 */
	spillTo?: string;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	/** True when `stdout` was cut at the capture cap and does not hold the command's full output. */
	stdoutTruncated?: boolean;
	/** True when `stderr` was cut at the capture cap and does not hold the command's full output. */
	stderrTruncated?: boolean;
}

/** Accumulates raw chunks up to a byte cap without re-copying already-capped data on every event. */
class CappedByteAccumulator {
	private readonly chunks: Buffer[] = [];
	private bytes = 0;
	private capped = false;

	constructor(private readonly maxBytes: number) {}

	push(chunk: Buffer): void {
		if (this.capped) return;
		const room = this.maxBytes - this.bytes;
		if (chunk.length <= room) {
			this.chunks.push(chunk);
			this.bytes += chunk.length;
			if (this.bytes >= this.maxBytes) {
				this.capped = true;
			}
			return;
		}
		if (room > 0) {
			this.chunks.push(chunk.subarray(0, room));
			this.bytes += room;
		}
		this.capped = true;
	}

	get truncated(): boolean {
		return this.capped;
	}

	/** Decode once, at close, rather than per-chunk -- see D6.1: per-chunk `toString()` can split a
	 * multi-byte UTF-8 sequence across chunk boundaries and mint U+FFFD in the middle of valid text. */
	toText(): string {
		return Buffer.concat(this.chunks).toString("utf-8");
	}
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

			const maxCaptureBytes = options?.maxCaptureBytes ?? MAX_CAPTURE_BYTES;
			const stdoutAcc = new CappedByteAccumulator(maxCaptureBytes);
			const stderrAcc = new CappedByteAccumulator(maxCaptureBytes);
			let timedOut = false;
			let settled = false;

			let spillStream: WriteStream | undefined;
			let spillFailed = false;
			if (options?.spillTo) {
				try {
					spillStream = createWriteStream(options.spillTo, { mode: 0o600 });
					spillStream.on("error", () => {
						spillFailed = true;
					});
				} catch {
					spillFailed = true;
				}
			}
			const spill = (chunk: Buffer) => {
				if (spillStream && !spillFailed) {
					spillStream.write(chunk);
				}
			};

			// Waits for the spill file to actually finish flushing to disk before settling the promise
			// -- `spillStream.end()` alone only *starts* the flush, so a caller that reads the spill
			// path immediately after `exec()` resolves could otherwise race an incomplete write.
			const finalize = (action: () => void) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (options?.signal) {
					options.signal.removeEventListener("abort", onAbort);
				}
				if (!spillStream) {
					action();
					return;
				}
				const stream = spillStream;
				let settledSpill = false;
				const done = () => {
					if (settledSpill) return;
					settledSpill = true;
					action();
				};
				stream.once("error", done);
				stream.end(done);
			};

			const rejectOnce = (err: Error) => {
				if (settled) return;
				settled = true;
				finalize(() => reject(err));
			};

			const resolveOnce = (result: ExecResult) => {
				if (settled) return;
				settled = true;
				finalize(() => resolve(result));
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
			child.stdout?.on("data", (data: Buffer) => {
				stdoutAcc.push(data);
				spill(data);
			});

			child.stderr?.on("data", (data: Buffer) => {
				stderrAcc.push(data);
				spill(data);
			});

			child.on("error", (err) => {
				rejectOnce(err instanceof Error ? err : new Error(String(err)));
			});

			child.on("close", (code) => {
				const stdout = stdoutAcc.toText();
				const stderr = stderrAcc.toText();

				if (options?.signal?.aborted) {
					rejectOnce(new CommandTerminatedError("aborted", stdout, stderr));
					return;
				}

				if (timedOut) {
					rejectOnce(new CommandTerminatedError("timeout", stdout, stderr, options?.timeout));
					return;
				}

				resolveOnce({
					stdout,
					stderr,
					code: code ?? 0,
					...(stdoutAcc.truncated ? { stdoutTruncated: true } : {}),
					...(stderrAcc.truncated ? { stderrTruncated: true } : {}),
				});
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
