import type { ExecResult, Executor } from "../executor.js";
import { shellEscape } from "../shared/os.js";
import type { JobRecord } from "./record.js";

/**
 * The outcome of one kill attempt, decided from the kill script's own printed token plus the
 * executor result — never from "the shell exited 0", which a failed `kill` inside `2>/dev/null`
 * would still do.
 * - `terminated` — we signalled the target and then confirmed the pid is gone.
 * - `gone` — the target was already gone before we signalled (or its pgid became unroutable).
 * - `identity-mismatch` — the pid now belongs to an unrelated process, so *our* process is gone.
 * - `unconfirmed` — the kill ran but the pid is still alive afterwards.
 * - `not-submitted` — the executor could not even run the kill.
 * - `no-target` — there is no pid we can safely signal (pid <= 1 / not finite).
 */
type KillOutcome = "terminated" | "gone" | "identity-mismatch" | "unconfirmed" | "not-submitted" | "no-target";

/** Outcomes that prove the job's process is gone — safe to apply a terminal status. */
export const KILL_CONFIRMED_GONE: ReadonlySet<KillOutcome> = new Set<KillOutcome>([
	"terminated",
	"gone",
	"identity-mismatch",
	"no-target",
]);

/**
 * The shell command that terminates `record`'s process and prints one token describing what
 * happened (`TERMINATED` / `GONE` / `IDENTITY_MISMATCH` / `UNCONFIRMED`), or `undefined` when
 * there is no pid we can safely signal.
 *
 * A negative-PGID target is used only when `setsid` gave the job pgid == pid (spec: everything
 * the command spawned dies with it). When a start time was captured it is checked first: a
 * recycled pid reads as `IDENTITY_MISMATCH` and is never signalled; a pid `ps` cannot see but
 * that `kill -0` says is alive reads as `UNCONFIRMED` (do not signal what we cannot prove is
 * ours). Legacy / nohup records have only `kill -0` liveness and a plain pid kill.
 */
function buildKillCommand(record: Pick<JobRecord, "pid" | "pgid" | "pidStartedAt">): string | undefined {
	const pid = record.pid;
	if (!Number.isFinite(pid) || pid <= 1) return undefined;
	const groupSafe = record.pgid !== undefined && record.pgid === pid;
	const target = groupSafe ? `"-${pid}"` : `${pid}`;
	const gate = record.pidStartedAt
		? `__pc_cur="$(ps -o lstart= -p ${pid} 2>/dev/null)"; ` +
			`if [ -z "$__pc_cur" ]; then ` +
			`if kill -0 ${pid} 2>/dev/null; then printf 'UNCONFIRMED\\n'; exit 0; else printf 'GONE\\n'; exit 0; fi; fi; ` +
			`if [ "$__pc_cur" != ${shellEscape(record.pidStartedAt)} ]; then printf 'IDENTITY_MISMATCH\\n'; exit 0; fi; `
		: `if ! kill -0 ${pid} 2>/dev/null; then printf 'GONE\\n'; exit 0; fi; `;
	return (
		gate +
		`kill -TERM ${target} 2>/dev/null; sleep 0.2; kill -KILL ${target} 2>/dev/null; sleep 0.05; ` +
		`if kill -0 ${pid} 2>/dev/null; then printf 'UNCONFIRMED\\n'; else printf 'TERMINATED\\n'; fi`
	);
}

/**
 * Run one kill attempt and classify it from the printed token plus the executor result — never
 * from "the shell exited 0". Used by cancel, timeout, the persist-failure rollback and the
 * interrupted-launch recovery; the last two pass no signal so an aborted caller cannot skip it.
 */
export async function killJob(
	executor: Executor,
	record: Pick<JobRecord, "pid" | "pgid" | "pidStartedAt">,
	signal?: AbortSignal,
): Promise<KillOutcome> {
	const command = buildKillCommand(record);
	if (!command) return "no-target";
	let result: ExecResult;
	try {
		result = await executor.exec(command, signal ? { signal } : {});
	} catch {
		return "not-submitted";
	}
	const token = result.stdout.trim().split("\n").pop()?.trim() ?? "";
	switch (token) {
		case "TERMINATED":
			return "terminated";
		case "GONE":
			return "gone";
		case "IDENTITY_MISMATCH":
			return "identity-mismatch";
		case "UNCONFIRMED":
			return "unconfirmed";
		default:
			return "not-submitted";
	}
}
