/**
 * `pipiclaw tui` CLI: argument parsing and entry. Parsing is a pure function (`parseTuiArgs`) so
 * it can be unit-tested. The terminal is a client of the Web API (spec 061, D25): it connects to
 * the daemon's socket, or — when no daemon is running — to a runtime it starts inside this
 * process (D26, `startEmbeddedRuntime`, supplied by the entry so `tui/` never imports `runtime/`).
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import { ensureModelOnboarding, type ModelReadiness } from "../app/auth-command.js";
import {
	BootstrapExitError,
	type BootstrapIO,
	type BootstrapPaths,
	bootstrapAppHome,
	DEFAULT_BOOTSTRAP_PATHS,
	printBootstrapSummary,
	readCliVersion,
} from "../app/home.js";
import { PipiclawSettingsManager } from "../config/settings.js";
import { getDeskDir } from "../desk/paths.js";
import { resolveDeskCwdSync } from "../desk/registry.js";
import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";
import { createLink, createSocketClient, openConversation, printOnce, requireSocket } from "./client.js";
import { TUI_SLASH_COMMANDS } from "./commands.js";
import { traitsOf } from "./render.js";
import { createFrontend } from "./renderer.js";
import { TuiSession } from "./session.js";

export type ParsedTui =
	| {
			kind: "run";
			desk?: string;
			cwd?: string;
			here: boolean;
			create: boolean;
			fresh: boolean;
			print: boolean;
			quiet: boolean;
			plain: boolean;
			positional: string[];
	  }
	| { kind: "help" }
	| { kind: "version" }
	| { kind: "error"; message: string };

/** Parse `pipiclaw tui` arguments (everything after the `tui` subcommand). */
export function parseTuiArgs(args: string[]): ParsedTui {
	let desk: string | undefined;
	let cwd: string | undefined;
	let here = false;
	let create = false;
	let fresh = false;
	let print = false;
	let quiet = false;
	let plain = false;
	const positional: string[] = [];

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--desk") {
			desk = args[index + 1];
			if (!desk || desk.startsWith("-"))
				return { kind: "error", message: "--desk 需要指定工位名称；省略时默认打开 default 工位。" };
			index += 1;
		} else if (arg.startsWith("--desk=")) {
			desk = arg.slice("--desk=".length);
		} else if (arg === "--cwd") {
			cwd = args[index + 1];
			if (!cwd || cwd.startsWith("-")) return { kind: "error", message: "--cwd 需要指定目录路径。" };
			index += 1;
		} else if (arg.startsWith("--cwd=")) {
			cwd = arg.slice("--cwd=".length);
		} else if (arg === "--here") {
			here = true;
		} else if (arg === "--create") {
			create = true;
		} else if (arg === "--new") {
			fresh = true;
		} else if (arg === "--print" || arg === "-p") {
			print = true;
		} else if (arg === "--quiet" || arg === "-q") {
			quiet = true;
		} else if (arg === "--plain") {
			plain = true;
		} else if (arg === "--help" || arg === "-h") {
			return { kind: "help" };
		} else if (arg === "--version") {
			return { kind: "version" };
		} else if (arg.startsWith("--")) {
			// An unknown long option is a typo, not part of the prompt — reject it
			// instead of silently sending `--pritn` to the model as prompt text.
			return { kind: "error", message: `未知参数：${arg}` };
		} else {
			positional.push(arg);
		}
	}

	if (here && (desk !== undefined || cwd !== undefined)) {
		return {
			kind: "error",
			message: "--here 会自动打开或创建当前目录对应的工位，不能与 --desk 或 --cwd 同时指定。",
		};
	}

	return {
		kind: "run",
		desk,
		...(cwd !== undefined ? { cwd } : {}),
		here,
		create,
		fresh,
		print,
		quiet,
		plain,
		positional,
	};
}

function printTuiHelp(io: BootstrapIO): void {
	io.log("用法：pipiclaw tui [options] [prompt]");
	io.log("");
	io.log("在终端中与 Pipiclaw 助手对话（与后台服务共享同一套配置、记忆、任务与文件）。");
	io.log("");
	io.log("终端通过本机 Web API socket 连接服务：若后台服务已在运行则直接连接；");
	io.log("否则在当前终端进程内自动启动运行时，退出终端时一并关闭。");
	io.log("默认打开 default 工位并续接该工位上次的终端会话。");
	io.log("");
	io.log("选项：");
	io.log("  --here                    打开或自动创建当前目录对应的专属工位（自动绑定工作目录）");
	io.log("  --desk <名称>             打开指定工位（默认：default）");
	io.log("  --cwd <目录>              设置该工位的工作目录（如 `--cwd .` 绑定当前仓库）");
	io.log("  --create                  先新建该工位（等价于 `/desk new`）");
	io.log("  --new                     开启全新会话而非续接上次会话");
	io.log("  --print, -p               单次执行：运行 [prompt]（或标准输入），输出结果后退出");
	io.log("  --plain                   使用行模式输出替代全屏终端界面");
	io.log("  --quiet, -q               仅输出最终回复，不展示中间进度（自动启用 --plain）");
	io.log("  --version                 输出当前版本号并退出");
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** A runtime this process started for the terminal. */
export interface EmbeddedRuntimeHandle {
	stop(): Promise<void>;
}

export interface TuiHooks {
	/** Start the runtime in this process, or `undefined` when a daemon already holds the app home. */
	startEmbeddedRuntime(paths: BootstrapPaths, io: BootstrapIO): Promise<EmbeddedRuntimeHandle | undefined>;
	/** Override TTY interactivity detection (for deterministic unit tests). */
	interactive?: boolean;
	confirmModelLogin?: () => Promise<boolean>;
	performModelLogin?: () => Promise<void>;
}

export async function runTui(
	argv: string[],
	hooks: TuiHooks,
	io: BootstrapIO = console,
	paths: BootstrapPaths = DEFAULT_BOOTSTRAP_PATHS,
): Promise<void> {
	const parsed = parseTuiArgs(argv.slice(3));

	if (parsed.kind === "help") {
		printTuiHelp(io);
		return;
	}
	if (parsed.kind === "version") {
		io.log(readCliVersion());
		return;
	}
	if (parsed.kind === "error") {
		io.error(parsed.message);
		io.error("运行 `pipiclaw tui --help` 查看用法。");
		throw new BootstrapExitError(1);
	}

	let initialPrompt = parsed.positional.join(" ").trim() || undefined;
	if (parsed.print && !initialPrompt && process.stdin.isTTY !== true) {
		initialPrompt = (await readStdin()).trim() || undefined;
	}

	const boot = bootstrapAppHome(paths);
	printBootstrapSummary(boot, io, paths);

	let readiness: ModelReadiness | undefined;
	if (!parsed.print) {
		const interactive =
			hooks.interactive ?? (io === console && process.stdin.isTTY === true && process.stderr.isTTY === true);
		readiness = await ensureModelOnboarding({
			paths,
			io,
			interactive,
			confirmLogin: hooks.confirmModelLogin,
			performLogin: hooks.performModelLogin,
		});
	}

	// The pi-tui frontend owns stdout; the plain frontend prints only the final answer. Either way
	// the console log sink would corrupt the output, so logging goes to its file sink only.
	log.setConsoleLoggingEnabled(false);
	const embedded = await hooks.startEmbeddedRuntime(paths, io);
	let stoppingEmbedded = false;
	const stopEmbedded = async (): Promise<void> => {
		if (!embedded || stoppingEmbedded) return;
		stoppingEmbedded = true;
		process.stderr.write("正在关闭运行时…\n");
		await embedded.stop();
	};
	const onSignal = (): void => {
		void stopEmbedded().finally(() => {
			process.exitCode = 0;
		});
	};
	if (embedded) {
		process.once("SIGTERM", onSignal);
		process.once("SIGHUP", onSignal);
	}
	try {
		if (!embedded) requireSocket(paths, io);
		try {
			await runClient(parsed, initialPrompt, paths, io, boot.initialWebApiKey, readiness);
		} catch (error) {
			if (error instanceof BootstrapExitError) throw error;
			// A refused or failed request is a message for the user, not a stack trace.
			io.error(errorMessage(error));
			throw new BootstrapExitError(1);
		}
	} finally {
		if (embedded) {
			process.off("SIGTERM", onSignal);
			process.off("SIGHUP", onSignal);
			await stopEmbedded();
		}
	}
}

async function runClient(
	parsed: Extract<ParsedTui, { kind: "run" }>,
	initialPrompt: string | undefined,
	paths: BootstrapPaths,
	io: BootstrapIO,
	initialWebApiKey?: string,
	readiness?: ModelReadiness,
): Promise<void> {
	const client = createSocketClient(paths);
	const resolvedCwdArg = parsed.cwd ? resolve(parsed.cwd) : undefined;
	const {
		id,
		desk: deskName,
		replies,
	} = await openConversation(
		client,
		paths,
		{
			desk: parsed.desk,
			cwd: resolvedCwdArg,
			here: parsed.here,
			create: parsed.create,
			fresh: parsed.fresh,
		},
		io,
	);

	if (parsed.print) {
		const frontend = createFrontend({ plain: true, quiet: parsed.quiet, interactive: false });
		for (const reply of replies) frontend.showNotice(reply);
		if (initialPrompt) frontend.showFinal(await printOnce(client, id, initialPrompt));
		frontend.stop();
		return;
	}

	const deskCwd = resolveDeskCwdSync(paths.workspaceDir, deskName);
	const defaultDeskDir = getDeskDir(paths.workspaceDir, deskName);
	const notices = [...replies];
	if (initialWebApiKey) {
		notices.unshift(
			`🔑 已自动生成本机 Web API 默认密钥（仅展示一次，请保存）：\`${initialWebApiKey}\`（接口：http://127.0.0.1:8787/v1）`,
		);
	}
	if (readiness && !readiness.ready) {
		notices.push(
			"⚠️ 当前尚未配置可用模型凭据；可退出后执行 `pipiclaw auth login`，或配置环境变量 / `models.json` 后发送 `/reload`。",
		);
	}
	const launchCwd = process.cwd();
	if (
		!parsed.cwd &&
		!parsed.here &&
		deskCwd === defaultDeskDir &&
		launchCwd !== deskCwd &&
		launchCwd !== homedir() &&
		!launchCwd.startsWith(paths.appHomeDir)
	) {
		notices.push(
			`💡 当前工位工作目录为默认目录；如需操作当前终端所在目录，可发送 \`/desk cwd ${launchCwd}\`（或下次用 \`pipiclaw tui --here\` 打开当前目录专属工位）。`,
		);
	}

	const frontend = createFrontend({
		plain: parsed.plain,
		quiet: parsed.quiet,
		interactive: true,
		commands: TUI_SLASH_COMMANDS,
		basePath: deskCwd,
	});
	const traits = traitsOf(new PipiclawSettingsManager(paths.appHomeDir).getTuiSettings().responseMode);
	const session = new TuiSession({
		link: createLink(client, paths, id),
		frontend,
		traits,
		label: `终端 · 工位 ${deskName} · 目录 ${deskCwd}`,
		notices,
	});
	await session.startInteractive(initialPrompt);
}
