import { renderStatus } from "../agent/status-render.js";
import type { AgentRunner } from "../agent/types.js";
import { getChannelDir } from "../channel/channel-paths.js";
import { handleProjectCommand } from "../channel/commands.js";
import { handleEventsCommand } from "../events/commands.js";
import { handleSkillsCommand } from "../skills/commands.js";
import { handleSubagentsCommand } from "../subagents/commands.js";
import { loadDetachedSubAgentDiscovery } from "../subagents/detached-discovery.js";
import type { SubAgentRunManager } from "../subagents/runs.js";
import { handleTasksCommand } from "../tasks/commands.js";
import { getUsageLedger } from "../usage/ledger.js";
import { parseUsageMode, renderUsageReport } from "../usage/render.js";
import type { RuntimeCommandName } from "./catalog.js";

/**
 * The stateless report commands (`/events /tasks /status /usage /context /subagents /project
 * /skills`) as one transport-neutral handler. The DingTalk runtime and the terminal TUI both route
 * through it, so a report cannot behave differently depending on where it was typed; each
 * transport supplies only what is genuinely its own (how to find its runner, how to rebuild one
 * after `/project`, whether a task can be woken immediately).
 */
/** The path fields the reports read; structurally satisfied by the app's `BootstrapPaths`. */
export interface ReportCommandPaths {
	workspaceDir: string;
	appHomeDir: string;
	eventHistoryPath: string;
	authConfigPath: string;
	modelsConfigPath: string;
}

export interface ReportCommandContext {
	channelId: string;
	paths: ReportCommandPaths;
	actor: "dingtalk-command" | "tui-command";
	version: string;
	startedAt: number;
	/** The channel's live runner, if one exists; never builds one. */
	peekRunner: () => AgentRunner | undefined;
	/** The channel's runner, built on demand (`/context` needs a session to report on). */
	getRunner: () => AgentRunner;
	runManager: SubAgentRunManager;
	/** One line per running background job, for `/project`'s "busy" check. */
	runningJobLines: () => string[];
	/** Drop the runner built under the old project scope so the next access rebuilds it. */
	onScopeChanged: () => Promise<void>;
	/** Immediate task wake for `/tasks run|reply`; absent where there is no durable dispatch (the TUI). */
	dispatchTask?: (taskId: string) => Promise<boolean>;
}

export async function runReportCommand(
	context: ReportCommandContext,
	name: RuntimeCommandName,
	args: string,
): Promise<string> {
	const { channelId, paths } = context;
	const channelDir = getChannelDir(paths.workspaceDir, channelId);
	switch (name) {
		case "events":
			return handleEventsCommand({ args, workspaceDir: paths.workspaceDir, historyPath: paths.eventHistoryPath });
		case "tasks":
			return handleTasksCommand({ args, channelDir, dispatchTask: context.dispatchTask });
		case "status":
			return renderStatus({
				runner: context.peekRunner(),
				version: context.version,
				uptimeMs: Date.now() - context.startedAt,
			});
		case "usage":
			return renderUsageReport(getUsageLedger(), channelId, parseUsageMode(args), new Date());
		// Read-only prompt accounting; safe mid-turn.
		case "context":
			return context.getRunner().renderContextReport(args);
		// A human control path independent of the model (spec 040, D6): `/stop` does not kill a
		// dispatched delegation, so cancel must work whether or not a runner is currently active.
		case "subagents":
			return handleSubagentsCommand({
				args,
				runManager: context.runManager,
				channelId,
				discovery: context.peekRunner()?.getSubAgentDiscoverySnapshot(),
				// `roles` needs a role directory even for a channel that has never spoken this boot —
				// resolved from disk, without spinning up a full runner (spec 041).
				getDetachedDiscovery: () =>
					loadDetachedSubAgentDiscovery({
						workspaceDir: paths.workspaceDir,
						authConfigPath: paths.authConfigPath,
						modelsConfigPath: paths.modelsConfigPath,
					}),
			});
		case "project":
			return handleProjectCommand({
				args,
				channelId,
				channelDir,
				appHomeDir: paths.appHomeDir,
				actor: context.actor,
				isBusy: () => context.peekRunner()?.isBusy() ?? false,
				listActiveBlockers: () => [
					...context.runManager
						.list()
						.filter((record) => record.status === "running")
						.map((record) => `委派 \`${record.runId}\`（${record.agent}）仍在运行`),
					...context.runningJobLines(),
				],
				onScopeChanged: context.onScopeChanged,
			});
		case "skills":
			return handleSkillsCommand({
				args,
				workspaceDir: paths.workspaceDir,
				appHomeDir: paths.appHomeDir,
				channelId,
			});
	}
}
