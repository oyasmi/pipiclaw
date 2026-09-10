import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

/** Async supervision keeps other trial watchdogs and trace consumers responsive. */
export function runJudgeProcess(options: {
	workerPath: string;
	args: string[];
	homeDir: string;
	timeoutMs?: number;
	onSpawn?: (child: ChildProcessWithoutNullStreams) => void;
}): Promise<{ status: number | null; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [options.workerPath, ...options.args], {
			env: { ...process.env, PIPICLAW_HOME: options.homeDir },
			detached: process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stderr = "";
		let done = false;
		const kill = () => {
			try {
				if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch {
				/* Already exited. */
			}
		};
		const finish = (status: number | null) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			kill();
			resolve({ status, stderr });
		};
		const timer = setTimeout(() => {
			stderr += "Judge watchdog expired; inspect its saved input and retry grading.";
			finish(null);
		}, options.timeoutMs ?? 90_000);
		child.stdout.resume();
		child.stderr.on("data", (data: Buffer) => {
			stderr = (stderr + data.toString()).slice(-16000);
		});
		child.once("error", (error) => {
			stderr += error.message;
			finish(null);
		});
		child.once("exit", (code) => finish(code));
		options.onSpawn?.(child);
	});
}
