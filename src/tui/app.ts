/**
 * Terminal TUI runtime: transport-neutral app init (no DingTalk gate), channel
 * resolution, and wiring of the collaborators the `TurnController` drives.
 *
 * The heavy lifting is reused as-is: `ChannelRunner` drives each turn, the
 * `ChannelContext` is a terminal one (`terminal-context.ts`), and app
 * preparation shares `prepareAppServices` with the DingTalk path.
 */
import { userInfo } from "node:os";
import { renderBuiltInHelp } from "../agent/commands.js";
import { type AgentRunner, createRunner } from "../agent/index.js";
import { channelRunningJobLines } from "../agent/job-manager.js";
import * as log from "../log.js";
import { ensureChannelMemoryFilesSync } from "../memory/files.js";
import {
	BootstrapExitError,
	type BootstrapIO,
	type BootstrapPaths,
	bootstrapAppHome,
	DEFAULT_BOOTSTRAP_PATHS,
	printBootstrapSummary,
	readCliVersion,
} from "../runtime/app-home.js";
import { prepareAppServices } from "../runtime/bootstrap.js";
import { ensureChannelDir } from "../runtime/channel-paths.js";
import { finalDeliveryOf, progressStyleOf } from "../runtime/dingtalk.js";
import { handleEventsCommand } from "../runtime/event-commands.js";
import { handleProjectCommand } from "../runtime/project-commands.js";
import { ChannelStore } from "../runtime/store.js";
import { handleSubagentsCommand } from "../runtime/subagent-commands.js";
import { handleTasksCommand } from "../runtime/task-commands.js";
import { flushSecurityLogs } from "../security/logger.js";
import { getSubAgentRunManager } from "../subagents/runs.js";
import { getUsageLedger } from "../usage/ledger.js";
import { parseUsageMode, renderUsageReport } from "../usage/render.js";
import { TUI_SLASH_COMMANDS } from "./commands.js";
import { createFrontend } from "./renderer.js";
import type { DeliveryTraits } from "./terminal-context.js";
import { createTerminalMediaSender } from "./terminal-media-sender.js";
import { TurnController } from "./turn-controller.js";

const DEFAULT_CHANNEL_ID = "tui_local";
const CHANNEL_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const STORAGE_FLUSH_TIMEOUT_MS = 10_000;

async function waitForStorageFlush(task: Promise<unknown>): Promise<void> {
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, STORAGE_FLUSH_TIMEOUT_MS);
		timer.unref?.();
		void task.then(
			() => {
				clearTimeout(timer);
				resolve();
			},
			() => {
				clearTimeout(timer);
				resolve();
			},
		);
	});
}

export interface TuiAppOptions {
	channel?: string;
	/** One-shot, non-interactive run: process a single prompt then exit. */
	print?: boolean;
	/** Suppress progress/notice output (plain frontend). */
	quiet?: boolean;
	/** Force the plain frontend even on a TTY. */
	plain?: boolean;
	/** Initial prompt to run before handing control to the input loop. */
	initialPrompt?: string;
	io?: BootstrapIO;
	paths?: BootstrapPaths;
}

/**
 * A replaceable `AgentRunner` reference (spec 043, D4.2): `TurnController` holds a single
 * `AgentRunner` for the process's lifetime, but `/project set|reset` needs to dispose the runner
 * built under the old scope and hand the next turn a fresh one built under the new scope. The
 * proxy forwards every call to whichever runner is current, so `TurnController` never needs to
 * know the reference changed.
 */
function createRunnerSlot(initial: AgentRunner): { runner: AgentRunner; replace(next: AgentRunner): void } {
	let current = initial;
	const runner = new Proxy({} as AgentRunner, {
		get(_target, prop, _receiver) {
			const value = Reflect.get(current as object, prop);
			return typeof value === "function" ? value.bind(current) : value;
		},
	});
	return {
		runner,
		replace(next) {
			current = next;
		},
	};
}

export function resolveChannelId(raw: string | undefined, io: BootstrapIO = console): string {
	const channel = raw?.trim() || DEFAULT_CHANNEL_ID;
	if (!CHANNEL_ID_PATTERN.test(channel)) {
		io.error(`Invalid --channel "${channel}": use letters, digits, dot, dash or underscore.`);
		throw new BootstrapExitError(1);
	}
	return channel;
}

function safeUserName(): string {
	try {
		return userInfo().username || "you";
	} catch {
		return "you";
	}
}

export async function runTuiApp(options: TuiAppOptions): Promise<void> {
	const io = options.io ?? console;
	const paths = options.paths ?? DEFAULT_BOOTSTRAP_PATHS;
	const channelId = resolveChannelId(options.channel, io);

	// The pi-tui frontend owns stdout; the plain frontend prints only the final
	// answer. Either way the human-readable console log sink would corrupt output,
	// so route logging to the file sink only. Turn progress and errors are still
	// surfaced through the transcript.
	log.setConsoleLoggingEnabled(false);

	// Transport-neutral init. Unlike the DingTalk path, the TUI ignores
	// channelTemplateCreated (it needs no channel.json) and shares app services
	// (settings, diagnostics) with bootstrap via prepareAppServices.
	printBootstrapSummary(bootstrapAppHome(paths), io, paths);
	const { settingsManager } = prepareAppServices(paths);
	log.configureLogging(settingsManager.getLoggingSettings());
	log.logStartup(paths.workspaceDir);

	const channelDir = ensureChannelDir(paths.workspaceDir, channelId);
	ensureChannelMemoryFilesSync(channelDir);
	const store = new ChannelStore({ workingDir: paths.workspaceDir });
	const buildRunner = (): AgentRunner =>
		createRunner(channelId, channelDir, {
			appHomeDir: paths.appHomeDir,
			authConfigPath: paths.authConfigPath,
			modelsConfigPath: paths.modelsConfigPath,
			settingsManager,
			mediaSender: createTerminalMediaSender(io),
		});
	const runnerSlot = createRunnerSlot(buildRunner());
	const runner = runnerSlot.runner;

	const tuiSettings = settingsManager.getTuiSettings();
	const traits: DeliveryTraits = {
		progressStyle: progressStyleOf(tuiSettings.responseMode),
		finalDelivery: finalDeliveryOf(tuiSettings.responseMode),
	};

	const interactive = !options.print;
	const frontend = createFrontend({
		plain: options.plain,
		quiet: options.quiet,
		interactive,
		commands: TUI_SLASH_COMMANDS,
		basePath: paths.workspaceDir,
	});

	const controller = new TurnController({
		runner,
		frontend,
		store,
		traits,
		channelId,
		userName: safeUserName(),
		renderHelp: () => renderBuiltInHelp(),
		renderUsage: async (args) => renderUsageReport(getUsageLedger(), channelId, parseUsageMode(args), new Date()),
		runEvents: (args) =>
			handleEventsCommand({ args, workspaceDir: paths.workspaceDir, historyPath: paths.eventHistoryPath }),
		runTasks: (args) =>
			handleTasksCommand({
				args,
				channelDir,
				workspaceDir: paths.workspaceDir,
				channelId,
			}),
		runSubagents: (args) =>
			handleSubagentsCommand({ args, channelId, discovery: runner.getSubAgentDiscoverySnapshot() }),
		runProject: (args) =>
			handleProjectCommand({
				args,
				channelId,
				channelDir,
				appHomeDir: paths.appHomeDir,
				actor: "tui-command",
				isBusy: () => runner.isBusy(),
				listActiveBlockers: () => [
					...getSubAgentRunManager(channelId)
						.list()
						.filter((record) => record.status === "running")
						.map((record) => `subagent run \`${record.runId}\` (${record.agent})`),
					...channelRunningJobLines(channelId),
				],
				onScopeChanged: async () => {
					await runner.dispose();
					runnerSlot.replace(buildRunner());
				},
			}),
		statusInfo: { version: readCliVersion(), startedAt: Date.now() },
	});

	try {
		if (options.print) {
			await controller.runOnce(options.initialPrompt);
		} else {
			await controller.startInteractive(options.initialPrompt);
		}
	} finally {
		await runner.dispose();
		await waitForStorageFlush(
			Promise.allSettled([store.close(), getUsageLedger().flush?.() ?? Promise.resolve(), flushSecurityLogs()]),
		);
		await waitForStorageFlush(log.flushLogging());
	}
}
