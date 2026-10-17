import { renderStatus } from "../agent/status-render.js";
import type { AgentRunner } from "../agent/types.js";
import type { ChannelDescription } from "../channel/channel-id.js";
import type { DotConversation } from "../dot/types.js";
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
 * The stateless report commands (`/events /tasks /status /usage /context /subagents /skills`) as
 * one transport-neutral handler. The DingTalk runtime and the terminal TUI both route through it,
 * so a report cannot behave differently depending on where it was typed; each transport supplies
 * only what is genuinely its own (how to find its runner, whether a task can be woken immediately).
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
	/**
	 * The asking channel's conversation in its dot. Reports exist only for a bound channel: an
	 * unbound one is answered before routing (spec 058, D4), so this is never optional.
	 */
	conversation: DotConversation;
	paths: ReportCommandPaths;
	/** Names a delivery channel and says whether it is still bound to this dot. */
	describeChannel: (channelId: string) => ChannelDescription;
	/** Channels with a conversation in this dot, for `/events history` records older than spec 058. */
	dotChannelIds: () => readonly string[];
	version: string;
	startedAt: number;
	/** The channel's live runner, if one exists; never builds one. */
	peekRunner: () => AgentRunner | undefined;
	/** The channel's runner, built on demand (`/context` needs a session to report on). */
	getRunner: () => AgentRunner;
	runManager: SubAgentRunManager;
	/** Immediate task wake for `/tasks run|reply`; absent where there is no durable dispatch (the TUI). */
	dispatchTask?: (taskId: string) => Promise<boolean>;
}

export async function runReportCommand(
	context: ReportCommandContext,
	name: RuntimeCommandName,
	args: string,
): Promise<string> {
	const { conversation, paths } = context;
	const { channelId, dot, dotDir } = conversation;
	switch (name) {
		case "events":
			return handleEventsCommand({
				args,
				dot,
				dotDir,
				historyPath: paths.eventHistoryPath,
				dotChannelIds: context.dotChannelIds(),
				describeChannel: context.describeChannel,
			});
		case "tasks":
			return handleTasksCommand({
				args,
				dotDir,
				currentChannelId: channelId,
				describeChannel: context.describeChannel,
				dispatchTask: context.dispatchTask,
			});
		case "status":
			return renderStatus({
				runner: context.peekRunner(),
				version: context.version,
				uptimeMs: Date.now() - context.startedAt,
			});
		case "usage":
			return renderUsageReport(getUsageLedger(), { dot, channelId }, parseUsageMode(args), new Date());
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
		case "skills":
			return handleSkillsCommand({
				args,
				workspaceDir: paths.workspaceDir,
				appHomeDir: paths.appHomeDir,
				channelId,
			});
	}
}
