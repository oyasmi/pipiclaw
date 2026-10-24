/**
 * Terminal TUI runtime: transport-neutral app init (no DingTalk gate), opening a desk (spec 058,
 * D18), and wiring of the collaborators the `TurnController` drives.
 *
 * The heavy lifting is reused as-is: `ChannelRunner` drives each turn, the
 * `ChannelContext` is a terminal one (`terminal-context.ts`), and app
 * preparation shares `prepareAppServices` with the DingTalk path.
 */
import { userInfo } from "node:os";
import { join } from "node:path";
import { createRunner } from "../agent/runner-factory.js";
import {
	BootstrapExitError,
	type BootstrapIO,
	type BootstrapPaths,
	bootstrapAppHome,
	DEFAULT_BOOTSTRAP_PATHS,
	printBootstrapSummary,
	readCliVersion,
} from "../app/home.js";
import { prepareAppServices } from "../app/services.js";
import { finalDeliveryOf, progressStyleOf } from "../channel/channel-context.js";
import { formatChannelLabel, TUI_CHANNEL_ID } from "../channel/channel-id.js";
import { CHANNELS_INDEX_FILENAME, loadChannelNames } from "../channel/channel-index.js";
import { ChannelStore } from "../channel/store.js";
import { renderBuiltInHelp } from "../commands/catalog.js";
import { runReportCommand } from "../commands/router.js";
import { loadBindings } from "../desk/bindings.js";
import { buildDeskList } from "../desk/commands.js";
import { DEFAULT_DESK, isDeskName, normalizeDeskName } from "../desk/paths.js";
import { allocateConversation, createDeskRecord, listDesks, readDeskRecord } from "../desk/registry.js";
import type { DeskConversation } from "../desk/types.js";
import { createExecutor } from "../executor.js";
import { createJobRuntime } from "../jobs/manager.js";
import * as log from "../log.js";
import { flushSecurityLogs } from "../security/logger.js";
import { acquireFileLock } from "../shared/file-lock.js";
import { createSubAgentRuntime } from "../subagents/run-registry.js";
import { getUsageLedger } from "../usage/ledger.js";
import { TUI_SLASH_COMMANDS } from "./commands.js";
import { createFrontend } from "./renderer.js";
import type { DeliveryTraits } from "./terminal-context.js";
import { createTerminalMediaSender } from "./terminal-media-sender.js";
import { TurnController } from "./turn-controller.js";

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
	/** The desk to open; defaults to the built-in personal assistant. */
	desk?: string;
	/** Create the desk when it does not exist — an explicit creation, like `/desk new` (INV-2). */
	create?: boolean;
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
 * Resolve `--desk` to this TUI's conversation in it: validate the name, create the desk only with
 * `--create`, and allocate the `tui` conversation (under the desk.json lock, D3). Exits with a
 * deployer-facing message on any failure.
 */
async function openDesk(options: TuiAppOptions, paths: BootstrapPaths, io: BootstrapIO): Promise<DeskConversation> {
	const fail = (message: string): never => {
		io.error(message);
		throw new BootstrapExitError(1);
	};
	const name = normalizeDeskName(options.desk ?? DEFAULT_DESK);
	if (!isDeskName(name)) {
		fail(
			`Invalid desk name "${name}": use 1-32 lowercase letters, digits or hyphens, not starting or ending with "-".`,
		);
	}
	let summary = await readDeskRecord(paths.workspaceDir, name);
	if (summary.availability === "missing" && options.create) {
		const created = createDeskRecord(paths.workspaceDir, name, new Date());
		if (created.kind !== "created") {
			fail(
				`Could not create desk "${name}" (${created.kind}). Inspect ${summary.deskDir} and desk-bindings.json; restore missing records from backup.`,
			);
		}
		summary = await readDeskRecord(paths.workspaceDir, name);
	}
	if (summary.availability === "missing") {
		const known = (await listDesks(paths.workspaceDir)).map((desk) => desk.name);
		fail(
			`Desk "${name}" has no readable record. ${known.length > 0 ? `Existing desks: ${known.join(", ")}.` : "No desks exist yet."} ` +
				"Restore an existing desk from backup; use --create only for a new desk.",
		);
	}
	if (summary.availability === "invalid") {
		fail(`Desk "${name}" is unavailable: ${summary.reason}. Inspect or restore ${summary.deskDir}/desk.json.`);
	}
	return allocateConversation(paths.workspaceDir, name, TUI_CHANNEL_ID, "tui", new Date());
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

	const conversation = await openDesk(options, paths, io);
	const { desk } = conversation;
	// One writer per conversation (D6): a second TUI on this desk would append to the same session file.
	const lock = await acquireFileLock(join(conversation.conversationDir, ".lock"));
	if (lock.kind === "held") {
		io.error(
			`Desk "${desk}" is already open in another terminal (pid ${lock.heldBy?.pid ?? "unknown"}); close it first.`,
		);
		throw new BootstrapExitError(1);
	}
	try {
		await runWithConversation(options, io, paths, conversation, settingsManager);
	} finally {
		// Interactive Ctrl-C exits through here (both frontends route it to the controller). A
		// signal that kills the process — Ctrl-C under `--print`, a kill — leaves a stale lock that
		// the next start reclaims (same host, dead pid).
		await lock.handle.release();
	}
}

async function runWithConversation(
	options: TuiAppOptions,
	io: BootstrapIO,
	paths: BootstrapPaths,
	conversation: DeskConversation,
	settingsManager: ReturnType<typeof prepareAppServices>["settingsManager"],
): Promise<void> {
	const channelId = TUI_CHANNEL_ID;
	const { desk } = conversation;
	const names = await loadChannelNames(paths.workspaceDir);
	// Read once, for labels only: the TUI never writes bindings (D18).
	const bindings = (await loadBindings(paths.workspaceDir)).bindings;
	const record = (await readDeskRecord(paths.workspaceDir, desk)).record;

	const store = new ChannelStore({
		resolveArchiveDir: (id) => (id === channelId ? conversation.conversationDir : undefined),
	});
	const jobs = createJobRuntime(createExecutor(), { workspaceDir: paths.workspaceDir });
	const runs = createSubAgentRuntime({ workspaceDir: paths.workspaceDir });
	const makeRunner = () =>
		createRunner(conversation, {
			jobManager: jobs.get(desk),
			runManager: runs.get(desk),
			appHomeDir: paths.appHomeDir,
			workspaceDir: paths.workspaceDir,
			describeChannel: (id) => names.get(id),
			describeConversation: (dir) => {
				const owner = Object.entries(record?.conversations ?? {}).find(([, entry]) => entry.dir === dir)?.[0];
				return owner ? formatChannelLabel(owner, names.get(owner)) : undefined;
			},
			authConfigPath: paths.authConfigPath,
			modelsConfigPath: paths.modelsConfigPath,
			settingsManager,
			mediaSender: createTerminalMediaSender(io),
		});

	let runner = makeRunner();
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

	const startedAt = Date.now();
	const controller = new TurnController({
		runner,
		replaceRunner: () => {
			runner = makeRunner();
			return runner;
		},
		frontend,
		store,
		traits,
		channelId,
		userName: safeUserName(),
		renderHelp: (args) => renderBuiltInHelp(args),
		runReport: (name, args) =>
			runReportCommand(
				{
					kind: "bound",
					conversation,
					// The TUI lists and creates desks but never binds (D18): its port has no `bind`.
					deskPort: {
						list: async () =>
							buildDeskList(await listDesks(paths.workspaceDir), bindings, desk, (id) =>
								formatChannelLabel(id, names.get(id)),
							),
						channelIndexPath: join(paths.workspaceDir, CHANNELS_INDEX_FILENAME),
						create: (name) => Promise.resolve(createDeskRecord(paths.workspaceDir, name, new Date())),
					},
					paths,
					describeChannel: (id) => ({
						label: formatChannelLabel(id, names.get(id)),
						boundHere: bindings[id]?.desk === desk,
					}),
					version: readCliVersion(),
					startedAt,
					peekRunner: () => runner,
					getRunner: () => runner,
					runManager: runs.get(desk),
				},
				name,
				args,
			),
	});

	try {
		if (options.print) {
			await controller.runOnce(options.initialPrompt);
		} else {
			await controller.startInteractive(options.initialPrompt);
		}
	} finally {
		await runner.dispose();
		runs.stop();
		jobs.stop();
		await waitForStorageFlush(
			Promise.allSettled([store.close(), getUsageLedger().flush?.() ?? Promise.resolve(), flushSecurityLogs()]),
		);
		await waitForStorageFlush(log.flushLogging());
	}
}
