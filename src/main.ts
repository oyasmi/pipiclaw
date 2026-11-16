#!/usr/bin/env node

import { runAuth } from "./app/auth-command.js";
import { formatCliCommandsHelp, isBootstrapExitError } from "./app/home.js";
import { StartupRefusal } from "./desk/startup-error.js";
import * as log from "./log.js";
import { bootstrap, bootstrapEmbedded } from "./runtime/bootstrap.js";
import { errorMessage } from "./shared/text-utils.js";
import { runTui } from "./tui/cli.js";

/**
 * Node exits the process on an unhandled rejection, and the daemon is long-lived enough that
 * this has to leave a trace: without a handler the crash reaches stderr only, so a daemon that
 * died overnight leaves nothing in the runtime log to explain it.
 *
 * This records and exits — it deliberately does not swallow. An unhandled rejection means some
 * invariant already failed, and a process that keeps serving after one is a worse outcome than
 * a restart. Individual timer/watch callbacks that can fail routinely catch at their own call
 * site; this is the backstop for the ones nobody predicted.
 */
function installFatalRejectionHandler(): void {
	process.on("unhandledRejection", (reason) => {
		log.logEvent("error", "system.fatal", "Unhandled promise rejection; shutting down", {
			details: errorMessage(reason),
		});
		// Bound the flush: a sink that cannot drain must not turn a crash into a hang.
		const forceExit = setTimeout(() => process.exit(1), 2000);
		void log
			.flushLogging()
			.catch(() => {})
			.finally(() => {
				clearTimeout(forceExit);
				process.exit(1);
			});
	});
}

function handleError(error: unknown): never {
	if (isBootstrapExitError(error)) {
		process.exit(error.code);
	}
	console.error(error instanceof StartupRefusal ? error.message : error);
	process.exit(1);
}

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 19;

function ensureSupportedNodeVersion(): void {
	const [majorRaw = "0", minorRaw = "0"] = process.versions.node.split(".");
	const major = Number.parseInt(majorRaw, 10);
	const minor = Number.parseInt(minorRaw, 10);
	if (major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR)) return;
	console.error(
		`错误：Pipiclaw 需要 Node.js >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0（当前版本：v${process.versions.node}）。请升级 Node.js 后重试。`,
	);
	process.exit(1);
}

ensureSupportedNodeVersion();

const command = process.argv[2];

if (command === "tui") {
	// The TUI resolves when the user exits (Ctrl-C / Ctrl-D / /exit) or a one-shot
	// --print finishes. Exit explicitly: raw-mode stdin and the runner session
	// keep the event loop alive, so the process would otherwise hang after the UI
	// tears down.
	runTui(process.argv, { startEmbeddedRuntime: bootstrapEmbedded }).then(() => process.exit(0), handleError);
} else if (command === "webapi") {
	// Only the key commands live here; the Web API itself is loaded by the daemon, if channel.json turns it on.
	import("./webapi/key-command.js")
		.then(({ runWebApiCommand }) => runWebApiCommand(process.argv))
		.then(() => process.exit(0), handleError);
} else if (command === "auth") {
	// readline keeps stdin open, so exit explicitly on success too.
	runAuth(process.argv).then(() => process.exit(0), handleError);
} else if (command === undefined || command === "run" || command.startsWith("-")) {
	// Default mode: the long-lived daemon. `run` names it explicitly;
	// a bare `pipiclaw` still runs it, and leading flags (--version/--help) are
	// handled by bootstrap's parseArgs. The daemon does not resolve, so there is
	// no success path to exit on — only surface fatal errors.
	installFatalRejectionHandler();
	bootstrap(process.argv).catch(handleError);
} else {
	console.error(`未知子命令：${command}`);
	for (const line of formatCliCommandsHelp("pipiclaw")) console.error(line);
	console.error("运行 `pipiclaw --help` 查看完整用法。");
	process.exit(1);
}
