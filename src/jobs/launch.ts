/**
 * Launching a background job: the wrapper shell with its verifiable startup handshake, the scratch
 * files it owns, and the parser for its stdout. Pure string building and parsing (spec 054 D11).
 */
import { shellEscape } from "../shared/os.js";

/** Every scratch file a single job owns, all derived from its spill path. */
export interface JobArtifacts {
	spillFile: string;
	exitFile: string;
	exitTmp: string;
	readyFile: string;
	readyTmp: string;
	metaFile: string;
	metaTmp: string;
}

export function jobArtifacts(spillFile: string): JobArtifacts {
	return {
		spillFile,
		exitFile: `${spillFile}.exit`,
		exitTmp: `${spillFile}.exit.tmp`,
		readyFile: `${spillFile}.ready`,
		readyTmp: `${spillFile}.ready.tmp`,
		metaFile: `${spillFile}.meta`,
		metaTmp: `${spillFile}.meta.tmp`,
	};
}

/** ~2s of readiness polling: 40 iterations of a 50ms sleep in the wrapper shell. */
const LAUNCH_HANDSHAKE_MAX_POLLS = 40;

/**
 * Build the wrapper shell that launches a background job with a verifiable startup handshake.
 *
 * The inner shell writes an atomic `ready` marker as its very first action — *before* the user
 * command — so the parent can distinguish "wrapper live, spill writable, command about to run"
 * from "launch silently failed" (a read-only spill dir, a `setsid`/`sh` that could not exec). The
 * parent also writes a metadata file (pid, and under `setsid` the pgid/start-time) *before* it
 * waits on the handshake, so an abort that lands mid-handshake still leaves a recoverable pid.
 *
 * `setsid` (when present) makes the job its own session/process-group leader (pgid == pid), so a
 * later cancel/timeout can terminate the whole group. A host without it falls back to `nohup` —
 * still detached and restart-safe, but single-pid, so pgid/identity are deliberately not claimed.
 *
 * On handshake success the parent prints `MODE`/`PID`(/`PGID`/`LSTART`) and exits 0. On failure it
 * kills whatever it spawned, echoes the inner error, removes the scratch files, and exits 1.
 */
export function buildLaunchScript(command: string, art: JobArtifacts): string {
	const spill = shellEscape(art.spillFile);
	const exitFile = shellEscape(art.exitFile);
	const exitTmp = shellEscape(art.exitTmp);
	const ready = shellEscape(art.readyFile);
	const readyTmp = shellEscape(art.readyTmp);
	const meta = shellEscape(art.metaFile);
	const metaTmp = shellEscape(art.metaTmp);

	// Subshell around the user command so its own `exit N` only leaves the subshell and the
	// exit-capture still runs; the exit code is written temp-then-renamed so a probe never reads a
	// half-written `.exit`.
	const inner =
		`printf 'ready\\n' > ${readyTmp} && mv -f ${readyTmp} ${ready} || exit 127; ` +
		`( ${command} )\n__pc_rc=$?; ` +
		`printf '%s\\n' "$__pc_rc" > ${exitTmp} && mv -f ${exitTmp} ${exitFile}`;
	const escInner = shellEscape(inner);

	// `ps` can momentarily miss a just-forked process on a loaded host: one short retry.
	const psField = (field: string) =>
		`"$(ps -o ${field}= -p "$__pc_pid" 2>/dev/null || { sleep 0.1; ps -o ${field}= -p "$__pc_pid" 2>/dev/null; })"`;

	const handshake = (killExpr: string) =>
		`__pc_i=0; while [ ! -s ${ready} ] && [ "$__pc_i" -lt ${LAUNCH_HANDSHAKE_MAX_POLLS} ]; do ` +
		`sleep 0.05; __pc_i=$((__pc_i+1)); done; ` +
		`if [ ! -s ${ready} ]; then ${killExpr}printf 'HANDSHAKE failed\\n'; cat ${spill} 2>/dev/null; ` +
		`rm -f ${ready} ${readyTmp} ${meta} ${metaTmp} ${exitFile} ${exitTmp} ${spill}; exit 1; fi`;

	const setsidKill =
		`kill -TERM "-$__pc_pid" 2>/dev/null; kill -TERM "$__pc_pid" 2>/dev/null; sleep 0.1; ` +
		`kill -KILL "-$__pc_pid" 2>/dev/null; `;
	const nohupKill = `kill -TERM "$__pc_pid" 2>/dev/null; sleep 0.1; kill -KILL "$__pc_pid" 2>/dev/null; `;

	const setsidBranch =
		`setsid sh -c ${escInner} > ${spill} 2>&1 & __pc_pid=$!; ` +
		`__pc_pgid=$(printf '%s' ${psField("pgid")} | tr -d ' '); __pc_lstart=${psField("lstart")}; ` +
		`printf 'MODE setsid\\nPID %s\\nPGID %s\\nLSTART %s\\n' "$__pc_pid" "$__pc_pgid" "$__pc_lstart" ` +
		`> ${metaTmp} && mv -f ${metaTmp} ${meta}; ` +
		`${handshake(setsidKill)}; ` +
		`printf 'MODE setsid\\nPID %s\\nPGID %s\\nLSTART %s\\n' "$__pc_pid" "$__pc_pgid" "$__pc_lstart"`;

	const nohupBranch =
		`nohup sh -c ${escInner} > ${spill} 2>&1 & __pc_pid=$!; ` +
		`printf 'MODE nohup\\nPID %s\\n' "$__pc_pid" > ${metaTmp} && mv -f ${metaTmp} ${meta}; ` +
		`${handshake(nohupKill)}; ` +
		`printf 'MODE nohup\\nPID %s\\n' "$__pc_pid"`;

	// `umask 077`: the spill holds whatever the command printed (routinely credentials) in a
	// world-readable /tmp; set the mask rather than chmod afterwards so there is no readable window.
	return (
		`umask 077; rm -f ${exitFile} ${exitTmp} ${ready} ${readyTmp} ${meta} ${metaTmp}; ` +
		`if command -v setsid >/dev/null 2>&1; then ${setsidBranch}; else ${nohupBranch}; fi`
	);
}

/**
 * Read the launch command's stdout: an optional `MODE setsid|nohup` line followed by `PID <n>`
 * and — only in `setsid` mode — `PGID <n>` / `LSTART <...>`. A bare number on its own line is also
 * accepted as the pid so older/simpler executor fakes keep working. `pgid` and `pidStartedAt` are
 * returned only when the job was launched under `setsid` *and* `ps` actually reported them; the
 * `nohup` fallback never yields them, and the caller must then treat identity as unprovable.
 */
export function parseLaunchOutput(stdout: string): {
	pid?: number;
	pgid?: number;
	pidStartedAt?: string;
	mode?: "setsid" | "nohup";
	handshakeFailed?: boolean;
} {
	let pid: number | undefined;
	let pgid: number | undefined;
	let pidStartedAt: string | undefined;
	let mode: "setsid" | "nohup" | undefined;
	let handshakeFailed = false;
	for (const raw of stdout.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		if (line === "HANDSHAKE failed") {
			handshakeFailed = true;
			continue;
		}
		if (/^\d+$/.test(line)) {
			pid ??= Number.parseInt(line, 10);
			continue;
		}
		const match = line.match(/^(MODE|PID|PGID|LSTART)\s+(.*)$/);
		if (!match) continue;
		const [, key, value] = match;
		if (key === "MODE" && (value === "setsid" || value === "nohup")) mode = value;
		else if (key === "PID" && /^\d+$/.test(value)) pid = Number.parseInt(value, 10);
		else if (key === "PGID" && /^\d+$/.test(value)) pgid = Number.parseInt(value, 10);
		else if (key === "LSTART" && value) pidStartedAt = value;
	}
	// The nohup fallback cannot capture these reliably; drop them even if something printed them.
	if (mode === "nohup") {
		pgid = undefined;
		pidStartedAt = undefined;
	}
	return { pid, pgid, pidStartedAt, mode, handshakeFailed };
}
