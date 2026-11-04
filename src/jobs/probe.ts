import type { Executor } from "../executor.js";
import { shellEscape } from "../shared/os.js";
import type { JobRecord } from "./record.js";

export async function probeJobs(
	executor: Executor,
	records: JobRecord[],
	signal?: AbortSignal,
): Promise<Map<string, string>> {
	const states = new Map<string, string>();
	if (records.length === 0) {
		return states;
	}
	const script = records
		.map((record) => {
			const id = shellEscape(record.id);
			const exitFile = shellEscape(record.exitFile);
			// Liveness: when the job's start time was captured, require the pid to still report
			// that exact `ps -o lstart=` — a recycled pid then reads as GONE, not ALIVE, so the
			// manager never mistakes an unrelated process for the job. Older records without a
			// captured start time fall back to a bare `kill -0`, the best they can do.
			// `-s`, not `-f`: an existing-but-empty `.exit` file (a torn write) must not count as
			// a finished job. The writer renames a fully-written temp file into place, so `-s`
			// here only ever sees the settled value (T4).
			//
			// Identity liveness is three-state: with a captured start time, `ps` reporting the
			// *same* lstart is ALIVE, a *different* one is DIFFERENT (pid recycled — our process
			// is gone), and `ps` returning nothing while `kill -0` still says alive is UNKNOWN
			// (do not conclude anything — a later probe retries). Legacy records have only
			// `kill -0`: ALIVE / GONE.
			const liveness = record.pidStartedAt
				? `__pc_cur="$(ps -o lstart= -p ${record.pid} 2>/dev/null)"; ` +
					`if [ -z "$__pc_cur" ]; then ` +
					`if kill -0 ${record.pid} 2>/dev/null; then printf '%s UNKNOWN\\n' ${id}; else printf '%s GONE\\n' ${id}; fi; ` +
					`elif [ "$__pc_cur" = ${shellEscape(record.pidStartedAt)} ]; then printf '%s ALIVE\\n' ${id}; ` +
					`else printf '%s DIFFERENT\\n' ${id}; fi`
				: `if kill -0 ${record.pid} 2>/dev/null; then printf '%s ALIVE\\n' ${id}; else printf '%s GONE\\n' ${id}; fi`;
			return `if [ -s ${exitFile} ]; then printf '%s EXIT:%s\\n' ${id} "$(cat ${exitFile})"; else ${liveness}; fi`;
		})
		.join("\n");
	const probe = await executor.exec(script, { signal });
	for (const line of probe.stdout.split("\n")) {
		const separator = line.indexOf(" ");
		if (separator <= 0) continue;
		states.set(line.slice(0, separator), line.slice(separator + 1).trim());
	}
	return states;
}
