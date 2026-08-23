import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as log from "../../log.js";
import { logSecurityEvent } from "../../security/logger.js";
import type { SecurityConfig } from "../../security/types.js";
import {
	killProcessGroup,
	probeCliVersion,
	readProcessStartTime,
	reapProcessGroup,
} from "../../shared/host-process.js";
import { splitShellWords } from "../../shared/shell-words.js";
import { errorMessage } from "../../shared/text-utils.js";
import { createEmptyUsageTotals } from "../../shared/types.js";
import { workspaceSubjectHash } from "../../tasks/artifact-subject.js";
import type { SubAgentThinkingLevel } from "../discovery.js";
import { getSubAgentRunManager, type RunMutates, type SettleInput } from "../runs.js";
import { getExternalHarness } from "./registry.js";
import { finalizeExternalRun } from "./settlement.js";

/**
 * Env vars the daemon's own credentials tend to live in — dropped by default from an external
 * process's environment. A target repo's `CLAUDE.md`/prompt can steer an external agent's actions
 * (it is a separate, untrusted host process, not sandboxed by pipiclaw's own guards), so it should
 * not inherit pipiclaw's own provider keys or DingTalk credentials just because it inherits the
 * daemon's shell (review 2026-08-23 §2.4). A role can add any of these back explicitly via `env:`.
 */
const SENSITIVE_ENV_PATTERN = /(?:_API_KEY|_SECRET|_TOKEN|_PASSWORD)$/i;

function filterSensitiveEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const filtered: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(env)) {
		if (SENSITIVE_ENV_PATTERN.test(key) || key.startsWith("DINGTALK_")) continue;
		filtered[key] = value;
	}
	return filtered;
}

/**
 * The external-run orchestrator (spec 040, D1/D3/D4). One prompt, one short-lived, argv-direct,
 * detached process. The launch order matters (D1): admission and the lease are the caller's job
 * (tool.ts, shared with internal runs); this module owns everything from "persist launch intent"
 * onward — spawn, pid persistence, stdin delivery, output capture, and settlement.
 *
 * stdout/stderr are opened as real files and handed to the child directly via `stdio` (P0-1): the
 * child writes its own output, so it survives the daemon disappearing mid-run instead of writing
 * into a pipe nobody is reading. A restart's own recovery (`SubAgentRunManager.restore()` /
 * `sweep()`) reads the same files back once the process is confirmed gone.
 */

export interface LaunchExternalRunInput {
	runId: string;
	channelId: string;
	/** Needed only for `purpose=verify`: where the attestation gets written. */
	channelDir?: string;
	label: string;
	agent: string;
	source: "predefined" | "inline";
	harness: string;
	/** The role's raw `command` frontmatter — tokenized here, never handed to a shell (D4). */
	command: string;
	shell?: boolean;
	env?: Record<string, string>;
	externalModelRef?: string;
	thinkingLevel?: SubAgentThinkingLevel;
	maxWallTimeSec: number;
	/** The role's system-prompt body (the role file's markdown). */
	systemPrompt: string;
	task: string;
	workingDirectory: string;
	artifactDir: string;
	purpose: "work" | "verify";
	taskId?: string;
	leaseKey?: string;
	resumeSessionId?: string;
	/** The role's own `mutates` declaration, carried through to the dispatch audit event (D8.1). */
	mutates?: RunMutates;
	/** Spec 042 D7: fingerprint of the role's `command`/`externalModelRef`/`shell`, persisted so a
	 *  later `follow_up` can detect a hot-edited role before resuming under it. */
	roleFingerprint?: string;
	/** Where the audit trail lives (`<workspaceDir>/.pipiclaw/security.log` by default) and whether
	 *  it is enabled — every external dispatch writes an `external-agent` audit event (D8.1), since
	 *  external processes never pass through command-guard and this is the only record of what
	 *  actually ran. */
	workspaceDir: string;
	securityConfig: SecurityConfig;
	/** Test seam: inject a fake `child_process.spawn`. */
	spawnFn?: typeof nodeSpawn;
}

/**
 * Spec 042 D2: a pre-run failure (file open, spawn, or a cancel that lands before the process
 * exists) used to settle the run and return `void`, leaving the caller no way to tell the model
 * anything went wrong in this same turn — it would see "[Dispatched] ... running" and then, for
 * two of the three cases, never be woken at all. `missing-binary` (spawn `ENOENT`/`EACCES`) needs
 * a human to install the CLI or fix `command`, so callers should surface it as a plain `Error`
 * (AGENTS.md's "can the model resolve this alone?" test says no); the other two are model-fixable
 * (retry the dispatch, or accept that a race cancelled it) and should be a `RecoverableToolError`.
 */
export type ExternalLaunchResult =
	| { ok: true }
	| { ok: false; kind: "missing-binary" | "launch-failed" | "cancelled"; reason: string };

function classifySpawnError(error: Error): "missing-binary" | "launch-failed" {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "EACCES" ? "missing-binary" : "launch-failed";
}

function buildStdinContent(harnessId: string, systemPrompt: string, task: string): string {
	// claude-code has a real system-prompt flag (--append-system-prompt-file, D4); every other
	// harness has no such channel, so the role's system prompt has nowhere to go but the prompt
	// itself, folded ahead of the task.
	if (harnessId === "claude-code") return task;
	return `${systemPrompt.trim()}\n\n---\n\n${task.trim()}\n`;
}

/** Launches an external run. Resolves once the process is confirmed spawned (or fails fast if it
 *  never starts, spec 042 D2); the wait-for-exit-and-settle work continues in the background
 *  afterward. */
export async function launchExternalRun(input: LaunchExternalRunInput): Promise<ExternalLaunchResult> {
	const harness = getExternalHarness(input.harness);
	if (!harness) {
		throw new Error(`Unknown external harness "${input.harness}".`);
	}
	if (input.shell && harness.id !== "exec") {
		throw new Error(
			`External harness "${harness.id}" cannot use shell mode because it would bypass protocol argv assembly. Use a wrapper script as command, or use harness: exec.`,
		);
	}

	// `tool.ts` already creates the artifact dir for a fresh run; `follow_up` (subagent-manage.ts)
	// mints a new runId/artifactDir on the spot, so this is the one place that must be reliable
	// either way.
	await mkdir(input.artifactDir, { recursive: true });
	const promptFile = join(input.artifactDir, "prompt.txt");
	const systemPromptFile = join(input.artifactDir, "system-prompt.txt");
	const stdinContent = buildStdinContent(harness.id, input.systemPrompt, input.task);
	await writeFile(promptFile, `${input.task.trim()}\n`, "utf-8");
	await writeFile(systemPromptFile, `${input.systemPrompt.trim()}\n`, "utf-8");

	// D9: an external verifier's advisory attestation needs a before/after subject snapshot the
	// same way the internal path does — taken here, before the process starts, since this is the
	// earliest point at which the run is committed to running against this workingDirectory.
	const verifySubjectBefore =
		input.purpose === "verify" ? await workspaceSubjectHash(input.workingDirectory) : undefined;

	const argv = input.shell ? [] : splitShellWords(input.command);
	const invocation = input.shell
		? { executable: "/bin/sh", args: ["-lc", input.command], resumable: false }
		: harness.buildInvocation({
				argv,
				model: input.externalModelRef,
				thinkingLevel: input.thinkingLevel,
				artifactDir: input.artifactDir,
				promptFile,
				systemPromptFile,
				resumeSessionId: input.resumeSessionId,
			});
	const spawnedArgv = [invocation.executable, ...invocation.args];

	// Spec 042 D11: admission (inside register(), including the concurrency-limit checks) happens
	// *before* the audit write, not after — previously a run rejected for being over the per-channel
	// or host-wide cap still left behind an `external-agent` audit record claiming a process that
	// never existed. `external-agent` records what was *executed* (D8.1), so the record must not
	// precede the point where this run is actually admitted to run.
	const runManager = getSubAgentRunManager(input.channelId);
	await runManager.register({
		runId: input.runId,
		channelId: input.channelId,
		runtime: "external",
		harness: harness.id as "claude-code" | "codex-cli" | "exec",
		agent: input.agent,
		label: input.label,
		source: input.source,
		tools: [],
		model: input.externalModelRef,
		purpose: input.purpose,
		taskId: input.taskId,
		workingDirectory: input.workingDirectory,
		artifactDir: input.artifactDir,
		leaseKey: input.leaseKey,
	});

	// The final executable/argv/cwd/capability record must be durable before a process can exist.
	// `external-agent` uses the strict appender path and rejects on queue or I/O failure; a failure
	// here settles the run instead of leaving it an orphaned "running" record (spec 042 D2) — the
	// same reasoning as every other pre-spawn failure below: this is a real fault requiring human
	// attention (disk full, permissions), not something a retry would fix on its own.
	try {
		await logSecurityEvent(input.workspaceDir, input.securityConfig, {
			type: "external-agent",
			tool: "subagent",
			channelId: input.channelId,
			runId: input.runId,
			agent: input.agent,
			harness: harness.id,
			argv: spawnedArgv,
			workingDirectory: input.workingDirectory,
			mutates: input.mutates ?? "read",
			model: input.externalModelRef,
		});
	} catch (error) {
		const reason = `Failed to write the mandatory dispatch audit record: ${errorMessage(error)}`;
		await runManager.settle(input.runId, failedSettleInput(reason), { announce: false });
		return { ok: false, kind: "launch-failed", reason };
	}

	let cancelledBeforeSpawn = false;
	const launchClaimed = await runManager.claimExternalLaunch(input.runId, () => {
		cancelledBeforeSpawn = true;
	});
	if (!launchClaimed) {
		const reason = "Cancelled before the external process was spawned.";
		await runManager.settle(input.runId, { ...failedSettleInput(reason), status: "cancelled" }, { announce: false });
		return { ok: false, kind: "cancelled", reason };
	}

	const eventsPath = join(input.artifactDir, "events.jsonl");
	const stderrPath = join(input.artifactDir, "stderr.log");
	let eventsFd: number;
	let stderrFd: number;
	try {
		eventsFd = openSync(eventsPath, "a");
		stderrFd = openSync(stderrPath, "a");
	} catch (error) {
		const reason = `Failed to open output files: ${errorMessage(error)}`;
		// Spec 042 D2: `announce: false` — this failure happened inside the same tool call that is
		// still on the stack; the caller reports it directly instead of waking the channel for a
		// result it can hand back right now.
		await runManager.settle(input.runId, failedSettleInput(reason), { announce: false });
		return { ok: false, kind: "launch-failed", reason };
	}

	const spawnFn = input.spawnFn ?? nodeSpawn;
	let child: ChildProcess;
	try {
		child = spawnFn(invocation.executable, invocation.args, {
			detached: true,
			cwd: input.workingDirectory,
			env: { ...filterSensitiveEnv(process.env), ...input.env },
			// stdout/stderr point straight at the artifact files (P0-1): the child writes them
			// itself, so they land on disk even if this daemon disappears before it exits.
			stdio: ["pipe", eventsFd, stderrFd],
		});
	} catch (error) {
		closeSync(eventsFd);
		closeSync(stderrFd);
		const reason = `Failed to launch: ${errorMessage(error)}`;
		await runManager.settle(input.runId, failedSettleInput(reason), { announce: false });
		return {
			ok: false,
			kind: classifySpawnError(error instanceof Error ? error : new Error(String(error))),
			reason,
		};
	}
	// The child has its own duped copy of both fds now; ours would otherwise leak across the
	// lifetime of a long-running daemon dispatching many external runs.
	closeSync(eventsFd);
	closeSync(stderrFd);

	const spawnFailure = await new Promise<Error | undefined>((resolve) => {
		child.once("error", (error) => resolve(error));
		child.once("spawn", () => resolve(undefined));
	});
	if (spawnFailure || !child.pid) {
		const reason = `Failed to launch: ${spawnFailure ? errorMessage(spawnFailure) : "no pid"}`;
		await runManager.settle(input.runId, failedSettleInput(reason), { announce: false });
		return {
			ok: false,
			kind: spawnFailure ? classifySpawnError(spawnFailure) : "launch-failed",
			reason,
		};
	}

	const pid = child.pid;
	const processStartedAt = Date.now();
	// Attached immediately, before any further `await`: a very fast process (e.g. `exec` running
	// `printf`) can exit and fire "close" before a listener registered after an async gap ever
	// gets attached — `EventEmitter` does not replay missed events, so that gap would hang this
	// run in `running` forever.
	const closePromise = new Promise<number | undefined>((resolve) => {
		child.once("close", (code) => resolve(code ?? undefined));
	});
	if (cancelledBeforeSpawn) {
		void killProcessGroup(pid);
		const reason = "Cancelled while the external process was spawning.";
		await runManager.settle(input.runId, { ...failedSettleInput(reason), status: "cancelled" }, { announce: false });
		return { ok: false, kind: "cancelled", reason };
	}

	// The OS-verifiable identity check (D10.3): a restart tells this pid apart from an unrelated
	// process that later reuses the same number. `undefined` when `ps` itself is unavailable —
	// restore()/sweep() then fall back to trusting `isProcessAlive` alone. Run alongside the D12
	// CLI-version probe — neither depends on the other, and both are best-effort/bounded.
	const [pidStartedAt, cliVersion] = await Promise.all([
		readProcessStartTime(pid),
		probeCliVersion(invocation.executable),
	]);
	const deadlineAt = processStartedAt + input.maxWallTimeSec * 1000;
	await runManager.setLaunched(input.runId, {
		pid,
		pidStartedAt,
		argv: spawnedArgv,
		deadlineAt,
		sessionId: invocation.presetSessionId,
		// Spec 042 D1: persisted so a restart reconciliation has the same inputs the live watcher
		// below would — without these, a run that finishes after the daemon disappears would settle
		// with an inaccurate timeout message, no verify attestation, and an unestimatable duration.
		verifySubjectBefore,
		maxWallTimeSec: input.maxWallTimeSec,
		processStartedAt,
		channelDir: input.channelDir,
		invocationWarnings: invocation.warnings,
		// Spec 042 D12: distinguishes "the target CLI's schema drifted" from "the agent failed".
		parserVersion: harness.parserVersion,
		cliVersion,
		roleFingerprint: input.roleFingerprint,
	});

	if (child.stdin) {
		child.stdin.on("error", () => {}); // EPIPE if the process already exited; harmless.
		child.stdin.end(stdinContent);
	}

	runManager.registerCancelHandle(input.runId, () => {
		void killProcessGroup(pid);
	});
	// The narrow window between the pre-spawn placeholder handle (claimExternalLaunch) and the
	// real one just above: a cancel arriving there durably marked `terminationReason` (P1-1) but
	// had no live process to kill yet. Act on it now.
	if (runManager.get(input.runId)?.terminationReason === "cancelled") {
		void killProcessGroup(pid);
	}
	// Prompt, same-process enforcement. Restart recovery persists this same deadline and installs
	// one replacement check only when it actually adopts a still-running process.
	const wallClockTimer = setTimeout(() => {
		void runManager.markTerminationReason(input.runId, "timeout").then(() => killProcessGroup(pid));
	}, input.maxWallTimeSec * 1000);
	wallClockTimer.unref?.();

	// Deliberately not awaited by the caller (D2: external's sync grace window is 0) — this
	// continues in the background and settles the run itself once the process exits.
	void closePromise.then(async (exitCode) => {
		clearTimeout(wallClockTimer);
		runManager.clearCancelHandle(input.runId);
		// Spec 042 D8: this fires on every exit (normal, cancelled, or timed out) as a backup reap —
		// a cancel/timeout already killed the group via its own call site above. The common case
		// (nothing left) returns immediately with no signal and no wait; only a genuinely lingering
		// descendant (the leader exited before it did) pays the TERM-then-KILL sequence.
		await reapProcessGroup(pid);

		const durationMs = Date.now() - processStartedAt;
		const terminationReason = runManager.get(input.runId)?.terminationReason;
		// Spec 042 D1: parse whatever the process actually wrote *before* applying a cancel/timeout
		// override, instead of returning early on those two reasons. A run killed for wall-time
		// budget or cancelled by request may still have produced useful output, usage, and a
		// resumable session id — `finalizeExternalRun` keeps all of that; only `status` and
		// `failureReason` get overridden by `terminationReason` (P1-1).
		await finalizeExternalRun(
			{
				runId: input.runId,
				channelId: input.channelId,
				channelDir: input.channelDir,
				harnessId: harness.id,
				purpose: input.purpose,
				taskId: input.taskId,
				workingDirectory: input.workingDirectory,
				artifactDir: input.artifactDir,
				exitCode,
				durationMs,
				terminationReason,
				maxWallTimeSec: input.maxWallTimeSec,
				verifySubjectBefore,
			},
			(settleInput, options) => runManager.settle(input.runId, settleInput, options),
			{ announce: terminationReason !== "cancelled" },
		).catch((error) => {
			log.logWarning(`Failed to settle external run ${input.runId}`, errorMessage(error));
		});
	});

	return { ok: true };

	function failedSettleInput(reason: string): SettleInput {
		return {
			status: "failed",
			failureReason: reason,
			usage: createEmptyUsageTotals(),
			usageKnown: false,
			costKnown: false,
			turns: 0,
			toolCalls: 0,
			durationMs: 0,
			outputText: "",
		};
	}
}
