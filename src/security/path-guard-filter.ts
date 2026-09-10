import { guardPath } from "./path-guard.js";
import type { SecurityConfig, SecurityRuntimeContext } from "./types.js";

/**
 * Backstop read-guard filter for the recursive discovery tools (`grep`, `glob`, `skill list`).
 *
 * A direct `read`/`grep` on a denied path is refused by the per-path guard, but a *recursive*
 * walk rooted at an allowed directory descends straight into denied subtrees — so `grep` would
 * return the contents of a `readDeny`'d file and `glob` would leak its path. Every candidate hit
 * is re-checked here against the read guard and denied entries are dropped before anything is
 * rendered or counted.
 *
 * Residual risk, recorded honestly: for `grep` the child process has already read those files'
 * bytes by the time this JS filter runs. The boundary this actually enforces is "no denied
 * content reaches the model or the tool result". The push-down `--exclude`/`--exclude-dir` flags
 * are what additionally keep `grep` from opening the file at all; this filter is the guarantee,
 * those flags are the optimization. Do not claim the `grep` process never touches a denied file.
 */
export function partitionByReadGuard(
	absolutePaths: string[],
	securityConfig: SecurityConfig,
	securityContext: SecurityRuntimeContext,
): { allowed: string[]; deniedCount: number } {
	const config = securityConfig.enabled ? securityConfig.pathGuard : { ...securityConfig.pathGuard, enabled: false };
	const allowed: string[] = [];
	let deniedCount = 0;
	for (const path of absolutePaths) {
		if (guardPath(path, "read", { ...securityContext, config }).allowed) {
			allowed.push(path);
		} else {
			deniedCount++;
		}
	}
	return { allowed, deniedCount };
}

/** True when the read guard would allow this single absolute path. */
export function readGuardAllows(
	absolutePath: string,
	securityConfig: SecurityConfig,
	securityContext: SecurityRuntimeContext,
): boolean {
	const config = securityConfig.enabled ? securityConfig.pathGuard : { ...securityConfig.pathGuard, enabled: false };
	return guardPath(absolutePath, "read", { ...securityContext, config }).allowed;
}
