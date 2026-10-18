import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOLDER_SCRIPT = fileURLToPath(new URL("../support/lock-holder.mjs", import.meta.url));

export interface LockHolderProcess {
	pid: number;
	/** Ask the child to release and resolve once it has. */
	release(): Promise<void>;
	/** SIGKILL the child, leaving its lock file behind. */
	kill(): Promise<void>;
}

function waitForLine(child: ChildProcess, prefix: string): Promise<string> {
	return new Promise((resolve, reject) => {
		let buffer = "";
		const onData = (chunk: Buffer) => {
			buffer += chunk.toString();
			const line = buffer.split("\n").find((candidate) => candidate.startsWith(prefix));
			if (line) {
				child.stdout?.off("data", onData);
				resolve(line);
			}
		};
		child.stdout?.on("data", onData);
		child.once("exit", (code) => reject(new Error(`lock holder exited (${code}) before "${prefix}": ${buffer}`)));
	});
}

/** Spawn a separate process that takes `lockPath` with the real lock implementation. */
export async function spawnLockHolder(lockPath: string): Promise<LockHolderProcess> {
	const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", HOLDER_SCRIPT, lockPath], {
		stdio: ["pipe", "pipe", "inherit"],
	});
	await waitForLine(child, "held ");
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	return {
		pid: child.pid ?? -1,
		async release() {
			child.stdin?.write("release\n");
			await exited;
		},
		async kill() {
			child.kill("SIGKILL");
			await exited;
		},
	};
}
