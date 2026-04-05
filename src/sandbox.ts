import { spawn, spawnSync } from "child_process";
import { shellEscape } from "./shared/shell-escape.js";

export type SandboxConfig = { type: "host" } | { type: "docker"; container: string };

export function parseSandboxArg(value: string): SandboxConfig {
	if (value === "host") {
		return { type: "host" };
	}
	if (value.startsWith("docker:")) {
		const container = value.slice("docker:".length);
		if (!container) {
			console.error("Error: docker sandbox requires container name (e.g., docker:pipiclaw-sandbox)");
			process.exit(1);
		}
		return { type: "docker", container };
	}
	console.error(`Error: Invalid sandbox type '${value}'. Use 'host' or 'docker:<container-name>'`);
	process.exit(1);
}

export async function validateSandbox(config: SandboxConfig): Promise<void> {
	if (config.type === "host") {
		if (process.platform === "win32") {
			try {
				resolveWindowsHostShell();
			} catch (error) {
				console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
				process.exit(1);
			}
		}
		return;
	}

	// Check if Docker is available
	try {
		await execSimple("docker", ["--version"]);
	} catch {
		console.error("Error: Docker is not installed or not in PATH");
		process.exit(1);
	}

	// Check if container exists and is running
	try {
		const result = await execSimple("docker", ["inspect", "-f", "{{.State.Running}}", config.container]);
		if (result.trim() !== "true") {
			console.error(`Error: Container '${config.container}' is not running.`);
			console.error(`Start it with: docker start ${config.container}`);
			process.exit(1);
		}
	} catch {
		console.error(`Error: Container '${config.container}' does not exist.`);
		console.error("Create it with: ./docker.sh create <data-dir>");
		process.exit(1);
	}

	console.log(`  Docker container '${config.container}' is running.`);
}

function execSimple(cmd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (d) => {
			stdout += d;
		});
		child.stderr?.on("data", (d) => {
			stderr += d;
		});
		child.on("close", (code) => {
			if (code === 0) resolve(stdout);
			else reject(new Error(stderr || `Exit code ${code}`));
		});
	});
}

interface HostShell {
	command: string;
	args: string[];
}

const WINDOWS_POSIX_SHELL_CANDIDATES = [
	"bash",
	"sh",
	"C:\\Program Files\\Git\\bin\\bash.exe",
	"C:\\Program Files\\Git\\usr\\bin\\bash.exe",
	"C:\\Program Files (x86)\\Git\\bin\\bash.exe",
	"C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
] as const;

let cachedWindowsHostShell: HostShell | undefined;

function looksLikeUnixShellPath(shell: string): boolean {
	return shell.endsWith("/bash") || shell.endsWith("/sh");
}

function isUsablePosixShell(command: string): boolean {
	const result = spawnSync(command, ["-lc", "printf pipiclaw"], {
		stdio: ["ignore", "pipe", "ignore"],
		encoding: "utf-8",
		windowsHide: true,
	});
	return !result.error && result.status === 0 && result.stdout === "pipiclaw";
}

function resolveWindowsHostShell(): HostShell {
	if (cachedWindowsHostShell) {
		return cachedWindowsHostShell;
	}

	const configuredShell = process.env.PIPICLAW_SHELL?.trim();
	const inheritedShell = process.env.SHELL?.trim();
	const shellCandidates = [
		configuredShell,
		inheritedShell && looksLikeUnixShellPath(inheritedShell) ? inheritedShell.split("/").pop() : undefined,
		...WINDOWS_POSIX_SHELL_CANDIDATES,
	].filter((value): value is string => Boolean(value));

	for (const command of shellCandidates) {
		if (isUsablePosixShell(command)) {
			cachedWindowsHostShell = { command, args: ["-lc"] };
			return cachedWindowsHostShell;
		}
	}

	throw new Error(
		"Windows host sandbox requires a POSIX shell. Install Git Bash and ensure `bash` is on PATH, set `PIPICLAW_SHELL`, or use the Docker sandbox.",
	);
}

function resolveHostShell(): HostShell {
	if (process.platform === "win32") {
		return resolveWindowsHostShell();
	}
	return { command: "sh", args: ["-c"] };
}

/**
 * Create an executor that runs commands either on host or in Docker container
 */
export function createExecutor(config: SandboxConfig): Executor {
	if (config.type === "host") {
		return new HostExecutor();
	}
	return new DockerExecutor(config.container);
}

export interface Executor {
	/**
	 * Execute a bash command
	 */
	exec(command: string, options?: ExecOptions): Promise<ExecResult>;

	/**
	 * Get the workspace path prefix for this executor
	 * Host: returns the actual path
	 * Docker: returns /workspace
	 */
	getWorkspacePath(hostPath: string): string;
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
			const shell = resolveHostShell();
			const child = (() => {
				try {
					return spawn(shell.command, [...shell.args, command], {
						detached: true,
						stdio: ["pipe", "pipe", "pipe"],
						windowsHide: true,
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

	getWorkspacePath(hostPath: string): string {
		return hostPath;
	}
}

class DockerExecutor implements Executor {
	constructor(private container: string) {}

	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		// Wrap command for docker exec
		const interactive = options?.stdin !== undefined ? "-i " : "";
		const dockerCmd = `docker exec ${interactive}${this.container} sh -c ${shellEscape(command)}`;
		const hostExecutor = new HostExecutor();
		return hostExecutor.exec(dockerCmd, options);
	}

	getWorkspacePath(_hostPath: string): string {
		// Docker container sees /workspace
		return "/workspace";
	}
}

function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
				windowsHide: true,
			});
		} catch {
			// Ignore errors
		}
	} else {
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
}
