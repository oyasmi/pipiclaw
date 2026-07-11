import { spawn } from "child_process";

/**
 * Create an executor that runs commands on the host machine.
 */
export function createExecutor(): Executor {
	return new HostExecutor();
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

			child.stdout?.on("data", (data) => {
				stdout += data.toString();
				if (stdout.length > 10 * 1024 * 1024) {
					stdout = stdout.slice(0, 10 * 1024 * 1024);
				}
			});

			child.stderr?.on("data", (data) => {
				stderr += data.toString();
				if (stderr.length > 10 * 1024 * 1024) {
					stderr = stderr.slice(0, 10 * 1024 * 1024);
				}
			});

			child.on("error", (err) => {
				rejectOnce(err instanceof Error ? err : new Error(String(err)));
			});

			child.on("close", (code) => {
				if (options?.signal?.aborted) {
					rejectOnce(new Error(`${stdout}\n${stderr}\nCommand aborted`.trim()));
					return;
				}

				if (timedOut) {
					rejectOnce(
						new Error(`${stdout}\n${stderr}\nCommand timed out after ${options?.timeout} seconds`.trim()),
					);
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
