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

export interface PausedReclaimerProcess extends LockHolderProcess {
	/** Let the child finish its reclaim; resolves once it holds the lock. */
	resume(): Promise<void>;
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

function spawnHolderScript(args: string[]): ChildProcess {
	return spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", HOLDER_SCRIPT, ...args], {
		stdio: ["pipe", "pipe", "inherit"],
	});
}

function controls(child: ChildProcess): LockHolderProcess {
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

/** Spawn a separate process that takes `lockPath` with the real lock implementation. */
export async function spawnLockHolder(lockPath: string): Promise<LockHolderProcess> {
	const child = spawnHolderScript([lockPath]);
	await waitForLine(child, "held ");
	return controls(child);
}

/**
 * Spawn a separate process that finds `lockPath` stale and stops inside its reclaim guard, just
 * before unlinking the dead lock. Resolves once it is parked there.
 */
export async function spawnPausedReclaimer(lockPath: string): Promise<PausedReclaimerProcess> {
	const child = spawnHolderScript([lockPath, "--pause-in-reclaim"]);
	await waitForLine(child, "in-guard");
	return {
		...controls(child),
		async resume() {
			const held = waitForLine(child, "held ");
			child.stdin?.write("resume\n");
			await held;
		},
	};
}
