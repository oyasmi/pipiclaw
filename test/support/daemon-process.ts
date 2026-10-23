import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

export async function startDaemon(homeDir: string) {
	const child = fork(fileURLToPath(new URL("./daemon-worker.mjs", import.meta.url)), [homeDir], {
		env: { ...process.env, PIPICLAW_HOME: homeDir, PI_OFFLINE: "1" },
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	let stderr = "";
	child.stderr!.on("data", (data) => {
		stderr += String(data);
	});
	async function receive(): Promise<{ ready?: boolean; value?: unknown; error?: string }> {
		try {
			return (await once(child, "message", { signal: AbortSignal.timeout(10_000) }))[0];
		} catch (error) {
			throw new Error(`daemon IPC failed: ${stderr}`, { cause: error });
		}
	}
	try {
		if (!(await receive()).ready) throw new Error(`daemon did not become ready: ${stderr}`);
	} catch (error) {
		await crash(child);
		throw error;
	}
	return {
		child,
		// This fixture deliberately has one request in flight; no general RPC layer is needed.
		async call(action: string, fields: Record<string, string> = {}): Promise<unknown> {
			const response = receive();
			child.send({ action, ...fields });
			const result = await response;
			if (result.error) throw new Error(result.error);
			return result.value;
		},
	};
}

export async function crash(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, "exit");
	child.kill("SIGKILL");
	await exited;
}
