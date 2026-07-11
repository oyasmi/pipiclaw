import type { Executor } from "../executor.js";
import { shellEscape } from "../shared/shell-escape.js";

/**
 * Optional "outbound command transform" for the bash tool. When enabled, a command is
 * handed to the `rtk` binary (https://github.com/rtk-ai/rtk) which rewrites known
 * read-only commands to their token-compact equivalents (e.g. `git status` →
 * `rtk git status`) before execution, cutting the output the model has to read.
 *
 * pipiclaw owns none of rtk's rules: `rtk rewrite` is rtk's single source of truth for
 * hooks. It prints the rewritten command on stdout when it can optimize, and prints
 * nothing when it cannot. We key off stdout, not the exit code: the exit code is not a
 * reliable success signal across rtk versions — 0.43.0 exits 3 on a successful rewrite
 * and 1 on "no equivalent", while its own `--help` claims 0/1. Presence of stdout is the
 * stable contract, so a non-empty line is the rewrite and empty means "keep original".
 *
 * This is best-effort by contract: any failure (rtk absent, timeout, empty output) falls
 * back to the original command. Enabling rtk must never make a bash command fail.
 */

/**
 * rtk rewrite is a pure, local string transform (no network), so a tight bound is safe.
 * On timeout we simply run the original command.
 */
const RTK_TIMEOUT_SECONDS = 2;

/**
 * rtk must exist on the host PATH. We probe through the executor so the check reflects
 * where the command will actually run, and memoize the probe promise per executor instance
 * so concurrent turns share one probe and we do not re-shell on every command. The instance
 * is stable for a channel's lifetime, so this is effectively "probe once".
 */
const availabilityByExecutor = new WeakMap<Executor, Promise<boolean>>();

function probeRtk(executor: Executor): Promise<boolean> {
	return executor
		.exec("command -v rtk", { timeout: RTK_TIMEOUT_SECONDS })
		.then((result) => result.code === 0 && result.stdout.trim().length > 0)
		.catch(() => false);
}

function isRtkAvailable(executor: Executor): Promise<boolean> {
	let probe = availabilityByExecutor.get(executor);
	if (!probe) {
		probe = probeRtk(executor);
		availabilityByExecutor.set(executor, probe);
	}
	return probe;
}

/**
 * Return the rtk-optimized form of `command`, or `command` unchanged when rtk is
 * unavailable or declines to rewrite it. Never throws.
 */
export async function maybeOptimizeCommand(command: string, executor: Executor, signal?: AbortSignal): Promise<string> {
	if (signal?.aborted) {
		return command;
	}
	if (!(await isRtkAvailable(executor))) {
		return command;
	}
	try {
		const result = await executor.exec(`rtk rewrite ${shellEscape(command)}`, {
			timeout: RTK_TIMEOUT_SECONDS,
			signal,
		});
		// Trust stdout over the exit code (see the module comment): a non-empty line is the
		// rewrite; empty output means rtk had no equivalent, so keep the original command.
		const rewritten = result.stdout.trim();
		if (rewritten.length > 0) {
			return rewritten;
		}
	} catch {
		// Any failure — spawn error, timeout, abort — falls back to the original command.
	}
	return command;
}
