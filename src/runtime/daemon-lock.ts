/**
 * `state/daemon.lock` (spec 061, INV-11): one runtime process per app home. The daemon, or the
 * terminal when it runs the runtime itself, holds it for its whole life.
 */
import { join } from "node:path";
import { StartupRefusal } from "../desk/startup-error.js";
import { acquireFileLock, type FileLockHandle } from "../shared/file-lock.js";

const lockPath = (appHomeDir: string): string => join(appHomeDir, "state", DAEMON_LOCK_FILE);

export const DAEMON_LOCK_FILE = "daemon.lock";

/** Take the lock if it is free; otherwise say who holds it. */
export async function tryAcquireDaemonLock(
	appHomeDir: string,
): Promise<{ kind: "acquired"; handle: FileLockHandle } | { kind: "held"; holder: string }> {
	const result = await acquireFileLock(lockPath(appHomeDir));
	if (result.kind === "acquired") return result;
	return {
		kind: "held",
		holder: result.heldBy
			? `pid ${result.heldBy.pid}（主机 ${result.heldBy.hostname}，启动于 ${result.heldBy.acquiredAt}）`
			: "另一个进程",
	};
}

/** Take the lock, or refuse to start and say who holds it. */
export async function acquireDaemonLock(appHomeDir: string): Promise<FileLockHandle> {
	const result = await tryAcquireDaemonLock(appHomeDir);
	if (result.kind === "acquired") return result.handle;
	throw new StartupRefusal(
		`目录 ${appHomeDir} 已被另一个 Pipiclaw 进程占用（${result.holder}）。\n如需与正在运行的服务对话，请直接执行 \`pipiclaw tui\`；如需重启服务，请先停止原进程（若确认无进程运行，可删除锁文件 ${lockPath(appHomeDir)}）。`,
	);
}
