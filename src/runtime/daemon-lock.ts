/**
 * `state/daemon.lock` (spec 061, INV-11): one runtime process per app home. The daemon, or the
 * terminal when it runs the runtime itself, holds it for its whole life.
 */
import { join } from "node:path";
import { StartupRefusal } from "../desk/startup-error.js";
import { acquireFileLock, type FileLockHandle } from "../shared/file-lock.js";

export const DAEMON_LOCK_FILE = "daemon.lock";

/** Take the lock, or refuse to start and say who holds it. */
export async function acquireDaemonLock(appHomeDir: string): Promise<FileLockHandle> {
	const path = join(appHomeDir, "state", DAEMON_LOCK_FILE);
	const result = await acquireFileLock(path);
	if (result.kind === "acquired") return result.handle;
	const holder = result.heldBy
		? `pid ${result.heldBy.pid} on ${result.heldBy.hostname} since ${result.heldBy.acquiredAt}`
		: "another process";
	throw new StartupRefusal(
		`Another Pipiclaw runtime is already using ${appHomeDir} (${holder}). Stop it first; if no Pipiclaw process is running, delete ${path}.`,
	);
}
