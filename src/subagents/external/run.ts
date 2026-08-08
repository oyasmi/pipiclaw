import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as log from "../../log.js";
import { logSecurityEvent } from "../../security/logger.js";
import type { SecurityConfig } from "../../security/types.js";
import { killProcessGroup } from "../../shared/host-process.js";
import { formatLocalTime } from "../../shared/local-time.js";
import { splitShellWords } from "../../shared/shell-words.js";
import { errorMessage } from "../../shared/text-utils.js";
import { workspaceSubjectHash } from "../../tasks/artifact-subject.js";
import { parseVerificationVerdict, writeVerificationAttestation } from "../../tasks/verification.js";
import type { SubAgentThinkingLevel } from "../discovery.js";
import { getSubAgentRunManager, type RunMutates, type SettleInput } from "../runs.js";
import { classifyExternalOutcome } from "./harness.js";
import { getExternalHarness } from "./registry.js";

/**
 * The external-run orchestrator (spec 040, D1/D3/D4). One prompt, one short-lived, argv-direct,
 * detached process. The launch order matters (D1): admission and the lease are the caller's job
 * (tool.ts, shared with internal runs); this module owns everything from "persist launch intent"
 * onward — spawn, pid persistence, stdin delivery, output capture, and settlement.
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
	/** Where the audit trail lives (`<workspaceDir>/.pipiclaw/security.log` by default) and whether
	 *  it is enabled — every external dispatch writes an `external-agent` audit event (D8.1), since
	 *  external processes never pass through command-guard and this is the only record of what
	 *  actually ran. */
	workspaceDir: string;
	securityConfig: SecurityConfig;
	/** Test seam: inject a fake `child_process.spawn`. */
	spawnFn?: typeof nodeSpawn;
}

const WAKE_OUTPUT_TAIL_CHARS = 2_000;

function buildStdinContent(harnessId: string, systemPrompt: string, task: string): string {
	// claude-code has a real system-prompt flag (--append-system-prompt-file, D4); every other
	// harness has no such channel, so the role's system prompt has nowhere to go but the prompt
	// itself, folded ahead of the task.
	if (harnessId === "claude-code") return task;
	return `${systemPrompt.trim()}\n\n---\n\n${task.trim()}\n`;
}

/** Launches an external run. Returns once the process is confirmed spawned (or fails fast if it
 *  never starts); the wait-for-exit-and-settle work continues in the background afterward. */
export async function launchExternalRun(input: LaunchExternalRunInput): Promise<void> {
	const harness = getExternalHarness(input.harness);
	if (!harness) {
		throw new Error(`Unknown external harness "${input.harness}".`);
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

	// Security gate: the final executable/argv/cwd/capability record must be durable before a
	// process can exist. `external-agent` uses the strict appender path and rejects on queue or I/O
	// failure; callers then release any admission lease without an unaudited child ever starting.
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

	let cancelledBeforeSpawn = false;
	const launchClaimed = await runManager.claimExternalLaunch(input.runId, () => {
		cancelledBeforeSpawn = true;
	});
	if (!launchClaimed) {
		await runManager.settle(
			input.runId,
			{ ...failedSettleInput("Cancelled before the external process was spawned."), status: "cancelled" },
			{ announce: false },
		);
		return;
	}

	const eventsPath = join(input.artifactDir, "events.jsonl");
	const stderrPath = join(input.artifactDir, "stderr.log");
	const eventsStream = createWriteStream(eventsPath);
	const stderrStream = createWriteStream(stderrPath);
	// A stream closed before its "open" completes (e.g. the spawn-failure path below) can emit its
	// own "error"; without a listener that becomes an uncaught exception rather than a settled run.
	eventsStream.on("error", () => {});
	stderrStream.on("error", () => {});

	const spawnFn = input.spawnFn ?? nodeSpawn;
	let child: ChildProcess;
	try {
		child = spawnFn(invocation.executable, invocation.args, {
			detached: true,
			cwd: input.workingDirectory,
			env: input.env ? { ...process.env, ...input.env } : process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch (error) {
		eventsStream.close();
		stderrStream.close();
		await runManager.settle(input.runId, failedSettleInput(`Failed to launch: ${errorMessage(error)}`), {
			announce: true,
		});
		return;
	}

	const spawnFailure = await new Promise<Error | undefined>((resolve) => {
		child.once("error", (error) => resolve(error));
		child.once("spawn", () => resolve(undefined));
	});
	if (spawnFailure || !child.pid) {
		eventsStream.close();
		stderrStream.close();
		await runManager.settle(
			input.runId,
			failedSettleInput(`Failed to launch: ${spawnFailure ? errorMessage(spawnFailure) : "no pid"}`),
			{ announce: true },
		);
		return;
	}

	const pid = child.pid;
	if (cancelledBeforeSpawn) {
		void killProcessGroup(pid);
		eventsStream.close();
		stderrStream.close();
		await runManager.settle(
			input.runId,
			{ ...failedSettleInput("Cancelled while the external process was spawning."), status: "cancelled" },
			{ announce: false },
		);
		return;
	}
	const fingerprint = randomBytes(6).toString("hex");
	await runManager.setLaunched(input.runId, {
		pid,
		fingerprint,
		argv: spawnedArgv,
		sessionId: invocation.presetSessionId,
	});

	child.stdout?.on("data", (chunk: Buffer) => eventsStream.write(chunk));
	child.stderr?.on("data", (chunk: Buffer) => stderrStream.write(chunk));
	if (child.stdin) {
		child.stdin.on("error", () => {}); // EPIPE if the process already exited; harmless.
		child.stdin.end(stdinContent);
	}

	let cancelled = false;
	runManager.registerCancelHandle(input.runId, () => {
		cancelled = true;
		void killProcessGroup(pid);
	});
	const wallClockTimer = setTimeout(() => {
		void killProcessGroup(pid);
	}, input.maxWallTimeSec * 1000);
	wallClockTimer.unref?.();

	// Deliberately not awaited by the caller (D2: external's sync grace window is 0) — this
	// continues in the background and settles the run itself once the process exits.
	void new Promise<number | undefined>((resolve) => {
		child.once("close", (code) => resolve(code ?? undefined));
	}).then(async (exitCode) => {
		clearTimeout(wallClockTimer);
		runManager.clearCancelHandle(input.runId);
		// The leader can exit before a detached descendant it spawned (e.g. a shell that forked and
		// returned); `-pid` still reaches the whole group as long as the group itself is still
		// around, so reap it unconditionally rather than only on an explicit cancel/timeout.
		await killProcessGroup(pid);
		await new Promise<void>((resolve) => eventsStream.end(resolve));
		await new Promise<void>((resolve) => stderrStream.end(resolve));

		if (cancelled) {
			await runManager
				.settle(
					input.runId,
					{ ...failedSettleInput("Cancelled by request."), status: "cancelled" },
					{ announce: false },
				)
				.catch((error) => {
					log.logWarning(`Failed to settle external run ${input.runId}`, errorMessage(error));
				});
			return;
		}

		const eventsText = await readFile(eventsPath, "utf-8").catch(() => "");
		const stderrTail = (await readFile(stderrPath, "utf-8").catch(() => "")).slice(-WAKE_OUTPUT_TAIL_CHARS);
		const outcome = harness.parseOutcome({ eventsText, exitCode, stderrTail });
		const classification = classifyExternalOutcome(harness.id, outcome);

		// D9: the verdict is a fact the run reported, independent of whether the run itself
		// "succeeded" — a verifier that cleanly concludes VERDICT: FAIL is still a completed run.
		let verificationVerdict: "pass" | "fail" | undefined;
		if (input.purpose === "verify" && input.taskId && input.channelDir && classification.status === "completed") {
			const subjectAfter = await workspaceSubjectHash(input.workingDirectory);
			const workspaceChanged =
				verifySubjectBefore !== undefined && subjectAfter !== undefined && verifySubjectBefore !== subjectAfter;
			const declaredVerdict = parseVerificationVerdict(outcome.finalText);
			verificationVerdict = declaredVerdict === "pass" && !workspaceChanged ? "pass" : "fail";
			const evidence = workspaceChanged
				? "Verifier's workspace subject changed; the attestation is invalid."
				: !declaredVerdict
					? "Verifier did not emit the required final VERDICT marker."
					: outcome.finalText.trim().slice(0, 8_000);
			await writeVerificationAttestation(input.channelDir, {
				runId: input.runId,
				taskId: input.taskId,
				verdict: verificationVerdict,
				checkedAt: formatLocalTime(),
				evidence,
				workspaceChanged,
				subjectHash: workspaceChanged ? undefined : subjectAfter,
				subjectDir: input.workingDirectory,
				// External verifiers cannot have their tools structurally removed the way an
				// internal verifier's are — the sandbox flag lives in the role's own `command`,
				// unverifiable by pipiclaw. Advisory, not enforced (D9).
				verificationStrength: "advisory",
			}).catch((error) => {
				log.logWarning(`Failed to write verification attestation for run ${input.runId}`, errorMessage(error));
			});
		}

		await runManager
			.settle(
				input.runId,
				{
					status: classification.status,
					failureReason: classification.failureReason,
					usage: {
						input: outcome.usage?.input ?? 0,
						output: outcome.usage?.output ?? 0,
						cacheRead: outcome.usage?.cacheRead ?? 0,
						cacheWrite: outcome.usage?.cacheWrite ?? 0,
						total: outcome.usage?.total ?? 0,
						cost: outcome.usage?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					usageKnown: outcome.usageKnown,
					costKnown: outcome.costKnown,
					turns: 0,
					toolCalls: 0,
					durationMs: 0,
					outputText: outcome.finalText,
					sessionId: outcome.sessionId,
					verificationVerdict,
					verificationStrength: verificationVerdict ? "advisory" : undefined,
				},
				{ announce: true },
			)
			.catch((error) => {
				log.logWarning(`Failed to settle external run ${input.runId}`, errorMessage(error));
			});
	});

	function failedSettleInput(reason: string): SettleInput {
		return {
			status: "failed",
			failureReason: reason,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			usageKnown: false,
			costKnown: false,
			turns: 0,
			toolCalls: 0,
			durationMs: 0,
			outputText: "",
		};
	}
}
