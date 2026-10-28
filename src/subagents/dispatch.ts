/**
 * Delegation dispatch, shared by `subagent` and `subagent_inline` (spec 046 D2.5): prepare the run
 * (working directory, artifact directory), admit it (verify rules, workspace write
 * lease), then fork to the internal or external runtime.
 */
import { realpathSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getSubAgentArtifactsDir } from "../desk/paths.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { findTaskItem, parseTaskItems } from "../tasks/contract.js";
import { readStoredTask } from "../tasks/store.js";
import type { ResolvedSubAgentConfig } from "./discovery.js";
import { dispatchExternalRun } from "./external/dispatch.js";
import { dispatchInternalRun } from "./internal/run.js";
import { assertVerifyAdmissible } from "./task-envelope.js";
import type {
	DelegationParams,
	DelegationResult,
	SubAgentRunContext,
	SubAgentToolFields,
	SubAgentToolOptions,
} from "./types.js";
import { acquireWorkspaceLease, formatWorkspaceLeaseConflict } from "./workspace-lease.js";
import { snapshotWorkspace } from "./workspace-summary.js";

function safeRunSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 48) || "run";
}

function getSubAgentArtifactsRoot(deskDir: string): string {
	return getSubAgentArtifactsDir(deskDir);
}

/** Every run gets its own artifact directory (spec 032 D4), independent of `returns` mode. */
async function prepareArtifactDir(deskDir: string, runId: string): Promise<string> {
	const artifactDir = join(getSubAgentArtifactsRoot(deskDir), safeRunSegment(runId));
	await mkdir(artifactDir, { recursive: true });
	return artifactDir;
}

/**
 * Resolve the checkout a run works in (spec 036, D3).
 *
 * Spec 036 removed task-owned worktrees on the premise that a caller needing a separate checkout
 * would `git worktree add` on the host and "pass it in as an ordinary working directory" — but no
 * parameter for that ever existed, so every run was pinned to the daemon's own cwd. This is that
 * parameter. Path guards are unaffected: they judge the *resolved absolute* target, so a cwd
 * outside the allowed roots makes relative paths fail exactly as an absolute one there would.
 */
function realpathOrSelf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function resolveRunWorkingDirectory(requested: string | undefined, options: SubAgentToolOptions): string {
	const base = resolve(options.workingDirectory ?? process.cwd());
	const trimmed = requested?.trim();
	// Canonicalize once: returning an alias here would leave the later lease, executor, subject
	// hash, and external cwd exposed to a symlink swap after admission.
	const canonicalBase = realpathOrSelf(base);
	if (!trimmed) return canonicalBase;
	const target = resolve(canonicalBase, trimmed);
	let canonicalTarget: string;
	try {
		canonicalTarget = realpathSync(target);
		if (!statSync(canonicalTarget).isDirectory()) throw new Error("not a directory");
	} catch {
		throw new RecoverableToolError(`workingDirectory "${requested}" is not an existing directory.`);
	}
	return canonicalTarget;
}

async function prepareRunContext(
	runId: string,
	params: Pick<DelegationParams, "purpose" | "item" | "workingDirectory">,
	options: SubAgentToolOptions,
): Promise<SubAgentRunContext> {
	const purpose = params.purpose ?? "work";
	// A delegation belongs to the task whose step started it, and to no task when started in chat
	// (spec 064, INV-8): the model has no parameter to choose.
	const taskId = options.boundTaskId;
	const item = params.item?.trim() || undefined;
	if (item && !taskId) {
		throw new RecoverableToolError(
			"item names a Work Item of a task and is only valid inside a task step. Omit item for a delegation started from chat; to hand work to a task, tell it with task_message and let its leader delegate.",
		);
	}
	if (taskId) {
		const task = await readStoredTask(options.deskDir, taskId);
		if (!task) {
			throw new RecoverableToolError(
				`Task ${taskId} no longer exists, so this delegation cannot be bound to it. End the step.`,
			);
		}
		if (item && !findTaskItem(task.body, item)) {
			const known = parseTaskItems(task.body)
				?.items.map((entry) => entry.id)
				.join(", ");
			throw new RecoverableToolError(
				`Task ${taskId} has no Work Item "${item}"${known ? ` (known: ${known})` : " (it has no Work Items yet — add one to the contract with edit first)"}.`,
			);
		}
	}
	const artifactDir = await prepareArtifactDir(options.deskDir, runId);
	const workingDirectory = resolveRunWorkingDirectory(params.workingDirectory, options);
	return { runId, purpose, taskId, item, workingDirectory, artifactDir };
}

/**
 * A run's lifecycle is deliberately unlinked from the tool call's `AbortSignal` (spec 040, D2):
 * `/stop` ends the current turn but no longer kills an in-flight delegation, matching background
 * jobs. Stopping a run is now an explicit decision (`subagent_run op=cancel`), not a side
 * effect of stopping something else.
 */
/**
 * Shared dispatch path for both `subagent` and `subagent_inline` (spec 046, D2.5): everything
 * after a role has been resolved into a `ResolvedSubAgentConfig` — workspace lease admission,
 * the internal/external fork, budget/turn/tool-call enforcement, the verification verdict, and
 * the sync-grace/detached-placeholder split — is identical regardless of which schema the model
 * called through.
 */
export async function dispatchSubAgentRun(
	options: SubAgentToolOptions,
	currentModel: Model<Api>,
	config: ResolvedSubAgentConfig,
	warning: string | undefined,
	params: DelegationParams,
	signal: AbortSignal | undefined,
	onUpdate?: (update: { content: Array<{ type: "text"; text: string }>; details: SubAgentToolFields }) => void,
): Promise<DelegationResult> {
	// Derived rather than model-supplied (spec 045): `${agent}: ${task's first line}`, the
	// same shape `subagent_run op=follow_up` already builds by hand.
	const runLabel = `${config.name}: ${params.task.split("\n")[0]?.slice(0, 80) ?? ""}`;
	// Only ever set for an inline (internal) delegation with `bash` in `tools` and no explicit
	// `mutates` — surfaced to the model, not just a log, since it has no role file to fix.
	const mutatesNote = warning ? `Note: ${warning}\n\n` : "";
	const runManager = options.getRunManager(options.runtimeContext.channelId);
	// A short, human-typeable id (spec 041) — never the dispatching tool call's own id, which
	// on some providers is a long `call_<id>|fc_<id>` composite unreadable in a chat UI.
	const runContext = await prepareRunContext(runManager.mintRunId(), params, options);

	// D9: an independent verifier checks against a target that isn't moving under it — shared
	// with `subagent_run op=follow_up` (spec 042 D7) so a verify run's admission rules
	// cannot drift between the two dispatch paths.
	assertVerifyAdmissible(config, runContext.purpose, runContext.workingDirectory);

	// Admission: every write-mutating run, including a write-capable verifier, takes an exclusive
	// workspace lease before it is even registered (spec 040, D10.1). A rejected delegation should
	// never count as "started"; the lease is handed to SubAgentRunManager as the settlement owner.
	let leaseKey: string | undefined;
	if (config.mutates === "write") {
		const lease = acquireWorkspaceLease({
			runId: runContext.runId,
			channelId: options.runtimeContext.channelId,
			workingDirectory: runContext.workingDirectory,
		});
		if (!lease.ok) {
			throw new RecoverableToolError(formatWorkspaceLeaseConflict(lease.heldBy));
		}
		leaseKey = lease.leaseKey;
	}
	// Taken under the lease, before the run can write: what "already dirty" means for this run.
	const workspaceBaseline =
		config.mutates === "write" ? await snapshotWorkspace(runContext.workingDirectory) : undefined;

	if (config.runtime === "external") {
		return dispatchExternalRun({
			options,
			currentModel,
			config,
			runLabel,
			runContext,
			leaseKey,
			params,
			runManager,
			workspaceBaseline,
		});
	}

	return dispatchInternalRun({
		options,
		currentModel,
		config,
		runLabel,
		mutatesNote,
		runContext,
		leaseKey,
		params,
		signal,
		onUpdate,
		runManager,
		workspaceBaseline,
	});
}
