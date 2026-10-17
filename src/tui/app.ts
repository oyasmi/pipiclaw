/**
 * Terminal TUI runtime: transport-neutral app init (no DingTalk gate), opening a dot (spec 058,
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
import { buildDotList } from "../dot/commands.js";
import { assertNoLegacyLayout, StartupRefusal } from "../dot/legacy-layout.js";
import { isDotName, normalizeDotName } from "../dot/paths.js";
import { allocateConversation, createDot, listDots, loadBindings, readDotRecord } from "../dot/registry.js";
import type { DotConversation } from "../dot/types.js";
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
	/** The dot to open (D18): required; any dot, bound or not, served by a daemon or not. */
	dot?: string;
	/** Create the dot when it does not exist — an explicit creation, like `/dot new` (INV-2). */
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
 * Resolve `--dot` to this TUI's conversation in it: validate the name, create the dot only with
 * `--create`, and allocate the `tui` conversation (under the dot.json lock, D3). Exits with a
 * deployer-facing message on any failure.
 */
async function openDot(options: TuiAppOptions, paths: BootstrapPaths, io: BootstrapIO): Promise<DotConversation> {
	const fail = (message: string): never => {
		io.error(message);
		throw new BootstrapExitError(1);
	};
	const name = normalizeDotName(options.dot ?? "");
	if (!name) fail("Missing --dot <name>: the terminal opens one dot. Run `pipiclaw tui --help` for usage.");
	if (!isDotName(name)) {
		fail(
			`Invalid dot name "${name}": use 1-32 lowercase letters, digits or hyphens, not starting or ending with "-".`,
		);
	}
	let summary = await readDotRecord(paths.workspaceDir, name);
	if (summary.availability === "missing" && options.create) {
		const created = await createDot(paths.workspaceDir, name, new Date());
		if (created.kind !== "created") fail(`Could not create dot "${name}" (${created.kind}).`);
		summary = await readDotRecord(paths.workspaceDir, name);
	}
	if (summary.availability === "missing") {
		const known = (await listDots(paths.workspaceDir)).map((dot) => dot.name);
		fail(
			`Dot "${name}" does not exist. ${known.length > 0 ? `Existing dots: ${known.join(", ")}.` : "No dots exist yet."} ` +
				"Add --create to create it.",
		);
	}
	if (summary.availability === "invalid") fail(`Dot "${name}" is unavailable: ${summary.reason}`);
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

	try {
		assertNoLegacyLayout(paths);
	} catch (error) {
		if (!(error instanceof StartupRefusal)) throw error;
		io.error(error.message);
		throw new BootstrapExitError(1);
	}
	const conversation = await openDot(options, paths, io);
	const { dot } = conversation;
	// One writer per conversation (D6): a second TUI on this dot would append to the same session file.
	const lock = await acquireFileLock(join(conversation.conversationDir, ".lock"));
	if (lock.kind === "held") {
		io.error(
			`Dot "${dot}" is already open in another terminal (pid ${lock.heldBy?.pid ?? "unknown"}); close it first.`,
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
	conversation: DotConversation,
	settingsManager: ReturnType<typeof prepareAppServices>["settingsManager"],
): Promise<void> {
	const channelId = TUI_CHANNEL_ID;
	const { dot } = conversation;
	const names = await loadChannelNames(paths.workspaceDir);
	// Read once, for labels only: the TUI never writes bindings (D18).
	const bindings = (await loadBindings(paths.workspaceDir).catch(() => undefined))?.bindings ?? {};
	const record = (await readDotRecord(paths.workspaceDir, dot)).record;

	const store = new ChannelStore({
		resolveArchiveDir: (id) => (id === channelId ? conversation.conversationDir : undefined),
	});
	const jobs = createJobRuntime(createExecutor(), { workspaceDir: paths.workspaceDir });
	const runs = createSubAgentRuntime({ workspaceDir: paths.workspaceDir });
	const runner = createRunner(conversation, {
		jobManager: jobs.get(dot),
		runManager: runs.get(dot),
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
					// The TUI lists and creates dots but never binds (D18): its port has no `bind`.
					dotPort: {
						list: async () =>
							buildDotList(await listDots(paths.workspaceDir), bindings, dot, (id) =>
								formatChannelLabel(id, names.get(id)),
							),
						channelIndexPath: join(paths.workspaceDir, CHANNELS_INDEX_FILENAME),
						create: (name) => createDot(paths.workspaceDir, name, new Date()),
					},
					paths,
					describeChannel: (id) => ({
						label: formatChannelLabel(id, names.get(id)),
						boundHere: bindings[id]?.dot === dot,
					}),
					dotChannelIds: () => Object.keys(record?.conversations ?? {}),
					version: readCliVersion(),
					startedAt,
					peekRunner: () => runner,
					getRunner: () => runner,
					runManager: runs.get(dot),
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
