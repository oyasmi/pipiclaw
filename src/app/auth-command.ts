/**
 * `pipiclaw auth` CLI: argument parsing and entry. Parsing is a pure function
 * (`parseAuthArgs`) so it can be unit-tested; `runAuth` wires it to the
 * transport-neutral orchestration in `provider-login.ts`. Deliberately does
 * not construct a runner, session or memory scheduler, and does not touch a desk —
 * login is a short, one-shot operation (spec 039 §5.1).
 */
import { createInterface } from "node:readline/promises";
import type { Api, AuthType, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PipiclawSettingsManager } from "../config/settings.js";
import * as log from "../log.js";
import { ReadlineLoginUi } from "../models/login-ui.js";
import {
	LoginCancelledError,
	type LoginUi,
	listProviderLoginOptions,
	loginProvider,
	logoutProvider,
	type ProviderLoginOption,
	renderAuthStatus,
} from "../models/provider-login.js";
import { formatModelReference } from "../models/reference.js";
import { createModelRuntime, resolveInitialModel, wrapModelRegistry } from "../models/runtime.js";
import { docsUrl } from "../paths.js";
import {
	BootstrapExitError,
	type BootstrapIO,
	type BootstrapPaths,
	bootstrapAppHome,
	DEFAULT_BOOTSTRAP_PATHS,
	printBootstrapSummary,
	readCliVersion,
} from "./home.js";
import { prepareAppServices } from "./services.js";

export type ParsedAuth =
	| { kind: "status" }
	| { kind: "login"; provider?: string; apiKey: boolean; oauth: boolean; deviceCode: boolean; noBrowser: boolean }
	| { kind: "logout"; provider?: string; yes: boolean }
	| { kind: "help" }
	| { kind: "version" }
	| { kind: "error"; message: string };

/** Parse `pipiclaw auth` arguments (everything after the `auth` subcommand, including the subcommand name itself). */
export function parseAuthArgs(args: string[]): ParsedAuth {
	if (args.length === 0) {
		return { kind: "error", message: "缺少子命令。用法：pipiclaw auth status|login|logout" };
	}
	if (args[0] === "--version") return { kind: "version" };
	if (args[0] === "--help" || args[0] === "-h") return { kind: "help" };

	const subcommand = args[0];
	const rest = args.slice(1);

	if (subcommand === "status") {
		if (rest.some((arg) => arg === "--help" || arg === "-h")) return { kind: "help" };
		if (rest.length > 0) return { kind: "error", message: `未知参数：${rest[0]}` };
		return { kind: "status" };
	}

	if (subcommand === "login") {
		let apiKey = false;
		let oauth = false;
		let deviceCode = false;
		let noBrowser = false;
		const positional: string[] = [];

		for (const arg of rest) {
			if (arg === "--api-key") apiKey = true;
			else if (arg === "--oauth") oauth = true;
			else if (arg === "--device-code") deviceCode = true;
			else if (arg === "--no-browser") noBrowser = true;
			else if (arg === "--help" || arg === "-h") return { kind: "help" };
			else if (arg.startsWith("--")) return { kind: "error", message: `未知参数：${arg}` };
			else positional.push(arg);
		}

		if (apiKey && oauth) return { kind: "error", message: "--api-key 与 --oauth 不能同时使用" };
		if (positional.length > 1) return { kind: "error", message: `多余的参数：${positional[1]}` };

		return { kind: "login", provider: positional[0], apiKey, oauth, deviceCode, noBrowser };
	}

	if (subcommand === "logout") {
		let yes = false;
		const positional: string[] = [];

		for (const arg of rest) {
			if (arg === "--yes" || arg === "-y") yes = true;
			else if (arg === "--help" || arg === "-h") return { kind: "help" };
			else if (arg.startsWith("--")) return { kind: "error", message: `未知参数：${arg}` };
			else positional.push(arg);
		}

		if (positional.length > 1) return { kind: "error", message: `多余的参数：${positional[1]}` };

		return { kind: "logout", provider: positional[0], yes };
	}

	return { kind: "error", message: `未知子命令：${subcommand}` };
}

function printAuthHelp(io: BootstrapIO): void {
	io.log("用法：pipiclaw auth status|login|logout [options]");
	io.log("");
	io.log("管理保存在 auth.json 中的模型供应商凭据（订阅登录或 API Key）。");
	io.log("");
	io.log("  pipiclaw auth status");
	io.log("      查看各供应商的配置状态、凭据类型与文件路径。");
	io.log("");
	io.log("  pipiclaw auth login [provider] [--api-key] [--oauth] [--device-code] [--no-browser]");
	io.log("      交互式登录模型供应商。不传参数时依次选择认证方式与供应商。");
	io.log("      --api-key / --oauth   直接指定认证方式，跳过第一步选择。");
	io.log("      --device-code         无头服务器推荐使用设备码授权（无需本机浏览器与回调端口）。");
	io.log("      --no-browser          仅打印授权链接，不尝试自动打开浏览器。");
	io.log("");
	io.log("  pipiclaw auth logout [provider] [--yes]");
	io.log("      移除已保存的凭据（默认需二次确认，--yes 跳过确认）。");
	io.log("");
	io.log("提示：已运行的会话可发送 `/reload` 或重启服务以加载新凭据。");
}

type LoginTarget = { kind: "target"; providerId: string; authType: AuthType } | { kind: "unsupported"; name: string };

function providerAuthAvailable(runtime: ModelRuntime, option: ProviderLoginOption): boolean {
	const provider = runtime.getProvider(option.id);
	if (!provider) return false;
	return option.authType === "oauth"
		? provider.auth.oauth?.login !== undefined
		: provider.auth.apiKey?.login !== undefined;
}

function toTarget(runtime: ModelRuntime, option: ProviderLoginOption): LoginTarget {
	return providerAuthAvailable(runtime, option)
		? { kind: "target", providerId: option.id, authType: option.authType }
		: { kind: "unsupported", name: option.name };
}

async function askAuthTypeChoice(ui: LoginUi): Promise<AuthType> {
	const answer = await ui.ask({
		type: "select",
		message: "请选择认证方式：",
		options: [
			{ id: "oauth", label: "订阅账号登录（OAuth）" },
			{ id: "api_key", label: "填写 API Key" },
		],
	});
	return answer === "api_key" ? "api_key" : "oauth";
}

async function resolveLoginTarget(
	runtime: ModelRuntime,
	parsed: Extract<ParsedAuth, { kind: "login" }>,
	ui: LoginUi,
): Promise<LoginTarget> {
	const forcedAuthType: AuthType | undefined = parsed.oauth ? "oauth" : parsed.apiKey ? "api_key" : undefined;

	if (parsed.provider) {
		const needle = parsed.provider.toLowerCase();
		let candidates = listProviderLoginOptions(runtime).filter(
			(option) => option.id.toLowerCase() === needle || option.name.toLowerCase() === needle,
		);
		if (forcedAuthType) candidates = candidates.filter((option) => option.authType === forcedAuthType);
		if (candidates.length === 0) {
			throw new Error(
				`未知或不支持该认证方式的供应商："${parsed.provider}"。可运行 \`pipiclaw auth status\` 查看支持的供应商。`,
			);
		}

		let chosen = candidates[0];
		if (candidates.length > 1) {
			const authTypeId = await ui.ask({
				type: "select",
				message: `请选择 ${chosen.name} 的登录方式：`,
				options: candidates.map((candidate) => ({
					id: candidate.authType,
					label: candidate.authType === "oauth" ? (candidate.loginLabel ?? "订阅登录（OAuth）") : "API Key",
				})),
			});
			chosen = candidates.find((candidate) => candidate.authType === authTypeId) ?? chosen;
		}
		return toTarget(runtime, chosen);
	}

	const authType = forcedAuthType ?? (await askAuthTypeChoice(ui));
	const options = listProviderLoginOptions(runtime, authType);
	if (options.length === 0) {
		throw new Error(`当前没有支持${authType === "oauth" ? "订阅登录" : "API Key 登录"}的供应商。`);
	}

	const providerId = await ui.ask({
		type: "select",
		message: "请选择模型供应商：",
		options: options.map((option) => ({
			id: option.id,
			label: option.name,
			description: option.configured ? `已配置（${option.configuredAs}）` : "未配置",
		})),
	});
	const chosen = options.find((option) => option.id === providerId);
	if (!chosen) throw new Error(`未知供应商："${providerId}"。`);
	return toTarget(runtime, chosen);
}

function auditAuthEvent(
	action: "login" | "logout",
	providerId: string,
	authType: AuthType | undefined,
	ok: boolean,
): void {
	// Deliberately not routed through src/security/logger.ts: that module is
	// scoped to per-channel blocked-operation audit (workspaceDir + SecurityConfig
	// gate) and this is a process-level, channel-less event. Never includes a
	// token/secret fragment.
	log.logInfo(`auth ${action}: ${providerId}${authType ? ` (${authType})` : ""} — ${ok ? "ok" : "failed"}`);
}

const MAX_DEFAULT_MODEL_PROMPT_CHOICES = 12;
const SKIP_DEFAULT_MODEL_ID = "__skip__";

async function maybeOfferDefaultModelSelection(
	runtime: ModelRuntime,
	providerId: string,
	newModels: Model<Api>[],
	ui: LoginUi,
	io: BootstrapIO,
	paths: BootstrapPaths,
): Promise<void> {
	const available = runtime.getAvailableSnapshot();
	const providerModels = (
		newModels.length > 0 ? newModels : available.filter((model) => model.provider === providerId)
	)
		.slice()
		.sort((a, b) => formatModelReference(a).localeCompare(formatModelReference(b)));
	if (providerModels.length === 0) return;

	const settingsManager = new PipiclawSettingsManager(paths.appHomeDir);
	const savedProvider = settingsManager.getDefaultProvider();
	const savedModel = settingsManager.getDefaultModel();
	const hasValidSavedDefault = Boolean(
		savedProvider &&
			savedModel &&
			available.some((model) => model.provider === savedProvider && model.id === savedModel),
	);

	if (hasValidSavedDefault) {
		io.log(`当前默认模型保持为 \`${savedProvider}/${savedModel}\`。如需切换可在会话中发送 \`/model\`。`);
		return;
	}

	if (providerModels.length === 1) {
		const only = providerModels[0];
		settingsManager.setDefaultModelAndProvider(only.provider, only.id);
		io.log(`已自动将默认模型设为 \`${formatModelReference(only)}\`（已写入 ${paths.settingsConfigPath}）。`);
		return;
	}

	const shown = providerModels.slice(0, MAX_DEFAULT_MODEL_PROMPT_CHOICES);
	const chosenRef = await ui.ask({
		type: "select",
		message: "请选择要设为默认的模型（直接回车选择第 1 项）：",
		options: [
			...shown.map((model) => ({
				id: formatModelReference(model),
				label: formatModelReference(model),
				...(model.name && model.name !== model.id ? { description: model.name } : {}),
			})),
			{ id: SKIP_DEFAULT_MODEL_ID, label: "暂不设置（稍后在会话中用 /model 切换）" },
		],
	});
	if (chosenRef === SKIP_DEFAULT_MODEL_ID) return;
	const chosen = providerModels.find((model) => formatModelReference(model) === chosenRef);
	if (chosen) {
		settingsManager.setDefaultModelAndProvider(chosen.provider, chosen.id);
		io.log(`已将默认模型设为 \`${formatModelReference(chosen)}\`（已写入 ${paths.settingsConfigPath}）。`);
	}
}

async function runLogin(
	runtime: ModelRuntime,
	parsed: Extract<ParsedAuth, { kind: "login" }>,
	io: BootstrapIO,
	signal: AbortSignal,
	paths: BootstrapPaths,
	uiOverride?: LoginUi & { close?: () => void },
): Promise<void> {
	const ui =
		uiOverride ??
		new ReadlineLoginUi({
			signal,
			presetFirstSelect: parsed.deviceCode ? "device_code" : undefined,
			noBrowser: parsed.noBrowser,
		});

	try {
		const target = await resolveLoginTarget(runtime, parsed, ui);
		if (target.kind === "unsupported") {
			io.error(`"${target.name}" 使用环境变量或本地配置文件认证，不支持交互式登录。`);
			io.error(`配置方式请参考：${docsUrl("configuration.md")}`);
			throw new BootstrapExitError(1);
		}

		let result: Awaited<ReturnType<typeof loginProvider>>;
		try {
			result = await loginProvider(runtime, target.providerId, target.authType, ui, {
				appHomeDir: paths.appHomeDir,
			});
		} catch (error) {
			auditAuthEvent("login", target.providerId, target.authType, false);
			throw error;
		}
		auditAuthEvent("login", target.providerId, target.authType, true);

		io.log(`✅ 登录成功：${target.providerId}（${result.credentialType}）`);
		await maybeOfferDefaultModelSelection(runtime, target.providerId, result.newModels, ui, io, paths);
		io.log("提示：若已有正在运行的会话，发送 `/reload` 或重启服务即可加载新凭据。");

		if (process.env.PIPICLAW_PROXY && !process.env.HTTPS_PROXY && !process.env.HTTP_PROXY) {
			io.log("");
			io.log(
				"⚠️ 注意：当前设置了 PIPICLAW_PROXY 但未设置 HTTPS_PROXY / HTTP_PROXY。Codex 对话所使用的 WebSocket 连接仅识别 HTTPS_PROXY / HTTP_PROXY，详见 " +
					`${docsUrl("configuration.md")}。`,
			);
		}
	} catch (error) {
		if (error instanceof BootstrapExitError) throw error;
		if (error instanceof LoginCancelledError || signal.aborted) {
			io.error("已取消登录。");
			throw new BootstrapExitError(130);
		}
		io.error(error instanceof Error ? error.message : String(error));
		throw new BootstrapExitError(2);
	} finally {
		ui.close?.();
	}
}

async function runLogout(
	runtime: ModelRuntime,
	parsed: Extract<ParsedAuth, { kind: "logout" }>,
	io: BootstrapIO,
	signal: AbortSignal,
): Promise<void> {
	const credentials = await runtime.listCredentials();
	if (credentials.length === 0) {
		io.log("当前没有已保存的模型凭据。");
		return;
	}
	const providerNames = new Map(runtime.getProviders().map((provider) => [provider.id, provider.name]));

	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		let providerId = parsed.provider;
		if (providerId) {
			const needle = providerId.toLowerCase();
			const match = credentials.find(
				(credential) =>
					credential.providerId.toLowerCase() === needle ||
					(providerNames.get(credential.providerId) ?? "").toLowerCase() === needle,
			);
			if (!match) {
				io.error(`未找到 "${providerId}" 的已保存凭据。可运行 \`pipiclaw auth status\` 查看已配置项。`);
				throw new BootstrapExitError(1);
			}
			providerId = match.providerId;
		} else if (credentials.length === 1) {
			providerId = credentials[0].providerId;
		} else {
			io.error("请选择要退出登录的供应商：");
			credentials.forEach((credential, index) => {
				io.error(
					`  ${index + 1}) ${providerNames.get(credential.providerId) ?? credential.providerId} (${credential.type})`,
				);
			});
			const raw = (await rl.question("> ", { signal })).trim();
			const index = Number.parseInt(raw, 10);
			const match = Number.isInteger(index) ? credentials[index - 1] : undefined;
			if (!match) {
				io.error(`输入无效：${raw}`);
				throw new BootstrapExitError(1);
			}
			providerId = match.providerId;
		}

		const displayName = providerNames.get(providerId) ?? providerId;
		if (!parsed.yes) {
			const answer = (await rl.question(`确认退出 ${displayName} 的登录凭据？ [y/N] `, { signal }))
				.trim()
				.toLowerCase();
			if (answer !== "y" && answer !== "yes") {
				io.log("已取消。");
				return;
			}
		}

		try {
			await logoutProvider(runtime, providerId);
		} catch (error) {
			auditAuthEvent("logout", providerId, undefined, false);
			io.error(error instanceof Error ? error.message : String(error));
			throw new BootstrapExitError(2);
		}
		auditAuthEvent("logout", providerId, undefined, true);
		io.log(`已移除凭据：${displayName}`);
	} catch (error) {
		if (error instanceof BootstrapExitError) throw error;
		if (signal.aborted) {
			io.error("已取消。");
			throw new BootstrapExitError(130);
		}
		throw error;
	} finally {
		rl.close();
	}
}

export interface ModelReadiness {
	/** True when at least one model has usable credentials (or `ANTHROPIC_API_KEY` is present). */
	ready: boolean;
	/** Resolved initial model (`provider/id`). */
	activeModelRef: string;
	/** Non-empty when `models.json` failed to parse or validate. */
	modelsError?: string;
}

/** Local, offline-safe check of whether any model credential is configured. */
export async function inspectModelReadiness(
	paths: BootstrapPaths = DEFAULT_BOOTSTRAP_PATHS,
	settingsManager = new PipiclawSettingsManager(paths.appHomeDir),
): Promise<ModelReadiness> {
	const runtime = await createModelRuntime({
		authConfigPath: paths.authConfigPath,
		modelsConfigPath: paths.modelsConfigPath,
	});
	const registry = wrapModelRegistry(runtime);
	const available = registry.getAvailable();
	const active = resolveInitialModel(registry, settingsManager);
	const ready = available.length > 0 || Boolean(process.env.ANTHROPIC_API_KEY?.trim());
	const modelsError = runtime.getError();
	return {
		ready,
		activeModelRef: formatModelReference(active),
		...(modelsError ? { modelsError } : {}),
	};
}

export interface EnsureModelOnboardingOptions {
	paths?: BootstrapPaths;
	io?: BootstrapIO;
	/** True only when attached to a live interactive terminal (never in daemons under systemd/pm2, `--print`, or tests). */
	interactive: boolean;
	/** Optional overrides for deterministic unit testing. */
	confirmLogin?: () => Promise<boolean>;
	performLogin?: () => Promise<void>;
}

async function promptConfirmLoginOnTty(signal: AbortSignal): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		const answer = (
			await rl.question("是否现在进入交互式模型登录引导？（直接回车进入，输入 n 稍后配置）[Y/n] ", { signal })
		)
			.trim()
			.toLowerCase();
		return answer === "" || answer === "y" || answer === "yes";
	} finally {
		rl.close();
	}
}

/**
 * Loudly surface `models.json` errors and missing model credentials on startup. When `interactive`
 * is true and no model credentials exist yet, offers to run the interactive login flow right away.
 */
export async function ensureModelOnboarding(options: EnsureModelOnboardingOptions): Promise<ModelReadiness> {
	const paths = options.paths ?? DEFAULT_BOOTSTRAP_PATHS;
	const io = options.io ?? console;
	let readiness = await inspectModelReadiness(paths);

	if (readiness.modelsError) {
		io.error("==================================================================");
		io.error(`❌ 模型配置文件存在错误（${paths.modelsConfigPath}）：`);
		io.error(readiness.modelsError);
		io.error("==================================================================");
	}

	if (readiness.ready) {
		return readiness;
	}

	io.error("==================================================================");
	io.error("⚠️  尚未检测到任何可用的大模型凭据！（未配置模型前无法正常对话）");
	io.error("   请任选以下一种方式配置模型：");
	io.error(`   1) 订阅登录或填写内置供应商 API Key：运行 \`${paths.appName} auth login\``);
	io.error("   2) 环境变量：例如 `export ANTHROPIC_API_KEY=sk-...` 或 `export OPENAI_API_KEY=sk-...`");
	io.error(`   3) 自定义网关 / DeepSeek / 通义 / Ollama：编辑 ${paths.modelsConfigPath}（内附示例）`);
	io.error("==================================================================");

	if (!options.interactive) {
		return readiness;
	}

	const controller = new AbortController();
	const onSigint = () => controller.abort();
	process.once("SIGINT", onSigint);
	try {
		const wantsLogin = options.confirmLogin
			? await options.confirmLogin()
			: await promptConfirmLoginOnTty(controller.signal);
		if (!wantsLogin) {
			io.error(`已跳过模型登录引导；随时可在新终端运行 \`${paths.appName} auth login\` 完成配置。\n`);
			return readiness;
		}
		if (options.performLogin) {
			await options.performLogin();
		} else {
			prepareAppServices(paths);
			const runtime = await createModelRuntime({
				authConfigPath: paths.authConfigPath,
				modelsConfigPath: paths.modelsConfigPath,
			});
			await runLogin(
				runtime,
				{ kind: "login", apiKey: false, oauth: false, deviceCode: false, noBrowser: false },
				io,
				controller.signal,
				paths,
			);
		}
		readiness = await inspectModelReadiness(paths);
		return readiness;
	} catch (error) {
		if (error instanceof BootstrapExitError) throw error;
		if (controller.signal.aborted || error instanceof LoginCancelledError) {
			io.error("\n已取消启动。");
			throw new BootstrapExitError(130);
		}
		throw error;
	} finally {
		process.removeListener("SIGINT", onSigint);
	}
}

export async function runAuth(
	argv: string[],
	io: BootstrapIO = console,
	paths: BootstrapPaths = DEFAULT_BOOTSTRAP_PATHS,
): Promise<void> {
	const parsed = parseAuthArgs(argv.slice(3));

	if (parsed.kind === "help") {
		printAuthHelp(io);
		return;
	}
	if (parsed.kind === "version") {
		io.log(readCliVersion());
		return;
	}
	if (parsed.kind === "error") {
		io.error(parsed.message);
		io.error("运行 `pipiclaw auth --help` 查看用法。");
		throw new BootstrapExitError(1);
	}

	if (parsed.kind !== "status" && process.stdin.isTTY !== true) {
		io.error("`pipiclaw auth login/logout` 需要交互式终端（当前 stdin 不是 TTY）。");
		throw new BootstrapExitError(1);
	}

	printBootstrapSummary(bootstrapAppHome(paths), io, paths);
	prepareAppServices(paths);
	const runtime = await createModelRuntime({
		authConfigPath: paths.authConfigPath,
		modelsConfigPath: paths.modelsConfigPath,
	});

	if (parsed.kind === "status") {
		io.log(await renderAuthStatus(runtime, paths.authConfigPath));
		return;
	}

	const controller = new AbortController();
	const onSigint = () => controller.abort();
	process.once("SIGINT", onSigint);
	try {
		if (parsed.kind === "login") {
			await runLogin(runtime, parsed, io, controller.signal, paths);
		} else {
			await runLogout(runtime, parsed, io, controller.signal);
		}
	} finally {
		process.removeListener("SIGINT", onSigint);
	}
}
