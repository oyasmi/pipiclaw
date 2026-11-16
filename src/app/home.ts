/**
 * App-home scaffolding: create `~/.pipiclaw` (or `PIPICLAW_HOME`) on first run (writing the
 * `channel.json` template; `dingtalk/config.ts` loads and validates it), and parse CLI args
 * shared by every entrypoint. Pure functions over explicit
 * `paths`/`io` parameters — no dependency on the runtime wiring in `bootstrap.ts`.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { DEFAULT_AGENTS, DEFAULT_SOUL } from "../agent/prompt/workspace-templates.js";
import { generateWebApiKey, hashWebApiKey } from "../channel/config.js";
import { initializeDefaultDesk } from "../desk/default.js";
import * as log from "../log.js";
import {
	APP_HOME_DIR,
	APP_NAME,
	AUTH_CONFIG_PATH,
	CHANNEL_CONFIG_PATH,
	EVENT_HISTORY_PATH,
	MODELS_CONFIG_PATH,
	SECURITY_CONFIG_PATH,
	SETTINGS_CONFIG_PATH,
	TOOLS_CONFIG_PATH,
	WORKSPACE_DIR,
} from "../paths.js";
import { errorMessage } from "../shared/text-utils.js";

export interface BootstrapPaths {
	appName: string;
	appHomeDir: string;
	workspaceDir: string;
	authConfigPath: string;
	channelConfigPath: string;
	modelsConfigPath: string;
	settingsConfigPath: string;
	toolsConfigPath: string;
	securityConfigPath: string;
	eventHistoryPath: string;
}

export interface BootstrapIO {
	log: (...args: unknown[]) => void;
	error: (...args: unknown[]) => void;
}

export interface BootstrapResult {
	created: string[];
	channelTemplateCreated: boolean;
	/** Generated once when `channel.json` is first created; only its SHA-256 hash is written to disk. */
	initialWebApiKey?: string;
}

const DEFAULT_MEMORY = `# Workspace Memory

This file stores stable workspace-level memory.

- It is intended to be managed by a human administrator.
- It is not automatically rewritten by normal runtime consolidation.
- Store durable shared background here when it should apply across all desks.
- Keep this file focused on stable facts, policies, and shared context, not transient conversation history.

## Shared Context

<!-- Put team-wide or workspace-wide background here. -->

## Tooling And Environment

<!-- Put durable tool usage rules, environment assumptions, or shared operational conventions here. -->

## Project Notes

<!-- Put long-lived project facts here. -->
`;

const DEFAULT_ENVIRONMENT = `# Environment

This file records durable environment facts and notable machine-level changes.

- Record installed tools, runtime prerequisites, and important config changes here.
- Keep entries concise and factual.
- Do not use this file for task progress, conversation summaries, or project-specific decisions.

## Environment Facts

<!-- Put stable machine or runtime facts here. -->

## Installed Tools

<!-- Record durable tools or dependencies that were installed for this workspace. -->

## Config Changes

<!-- Record important config or environment changes that affect future work. -->
`;

function createChannelConfigTemplate(): { config: Record<string, unknown>; initialWebApiKey: string } {
	const initialWebApiKey = generateWebApiKey();
	return {
		initialWebApiKey,
		config: {
			dingtalk: {
				enabled: false,
				clientId: "your-dingtalk-client-id",
				clientSecret: "your-dingtalk-client-secret",
				robotCode: "",
				cardTemplateId: "",
				cardTemplateKey: "content",
				allowFrom: [],
				busyMessageDefault: "steer",
				responseMode: "full_progress_then_plain_final",
				cardAutoLayout: true,
			},
			webapi: {
				enabled: true,
				socket: true,
				tcp: "127.0.0.1:8787",
				tls: null,
				keys: [
					{
						name: "default",
						sha256: hashWebApiKey(initialWebApiKey),
						desks: ["default"],
					},
				],
			},
		},
	};
}

const MODELS_CONFIG_TEMPLATE = {
	providers: {},
	_examples: {
		"my-gateway": {
			baseUrl: "https://api.deepseek.com/v1",
			api: "openai-completions",
			apiKey: "DEEPSEEK_API_KEY",
			compat: {
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
			},
			models: [{ id: "deepseek-chat" }],
		},
	},
	_notes: [
		"将 _examples 中的条目复制到 providers 下，即可接入 OpenAI 兼容网关、DeepSeek、通义或本地 Ollama。",
		"apiKey 可直接填写密钥字符串、环境变量名（如 DEEPSEEK_API_KEY），或 !command。",
		"配置后可在 settings.json 中补充 defaultProvider 与 defaultModel 指定默认模型。",
	],
};

const SETTINGS_CONFIG_TEMPLATE = {
	defaultThinkingLevel: "medium",
	fallbackModel: null,
	subagentModel: null,
	compaction: { enabled: true },
	retry: { enabled: true },
	memoryMaintenance: { enabled: true },
	sessionSearch: { summarizeWithModel: false },
	logging: { level: "info", file: { enabled: true } },
	tui: { responseMode: "full_progress_then_plain_final" },
	delegation: { notices: "live" },
};

const TOOLS_CONFIG_TEMPLATE = {
	tools: {
		web: {
			enable: false,
			proxy: null,
			search: {
				provider: "duckduckgo",
				apiKey: "",
				maxResults: 5,
			},
		},
		tasks: {
			enabled: true,
		},
	},
	_examples: {
		proxy: "http://127.0.0.1:7890",
	},
	_notes: [
		"将 tools.web.enable 设为 true 可启用联网搜索（web_search）与网页读取（web_fetch）。",
		"默认搜索源 duckduckgo 无需 API Key；也可切换为 tavily、jina 或 searxng。",
		"如需为网页工具单独配置代理，可将 _examples.proxy 填入 tools.web.proxy。",
		"tools.tasks.enabled 是后台长程任务的总开关。",
	],
};

const SECURITY_CONFIG_TEMPLATE = {
	pathGuard: {
		enabled: true,
	},
	commandGuard: {
		enabled: true,
	},
	networkGuard: {
		enabled: false,
	},
};

export const DEFAULT_BOOTSTRAP_PATHS: BootstrapPaths = {
	appName: APP_NAME,
	appHomeDir: APP_HOME_DIR,
	workspaceDir: WORKSPACE_DIR,
	authConfigPath: AUTH_CONFIG_PATH,
	channelConfigPath: CHANNEL_CONFIG_PATH,
	modelsConfigPath: MODELS_CONFIG_PATH,
	settingsConfigPath: SETTINGS_CONFIG_PATH,
	toolsConfigPath: TOOLS_CONFIG_PATH,
	securityConfigPath: SECURITY_CONFIG_PATH,
	eventHistoryPath: EVENT_HISTORY_PATH,
};

export class BootstrapExitError extends Error {
	readonly code: number;

	constructor(code: number, message?: string) {
		super(message ?? `Bootstrap requested exit with code ${code}`);
		this.code = code;
		this.name = "BootstrapExitError";
	}
}

export function isBootstrapExitError(error: unknown): error is BootstrapExitError {
	return error instanceof BootstrapExitError;
}

export function readCliVersion(): string {
	try {
		const raw = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")) as {
			version?: unknown;
		};
		return typeof raw.version === "string" && raw.version.trim() ? raw.version : "0.0.0";
	} catch {
		return "0.0.0";
	}
}

function writeTextFileIfMissing(
	path: string,
	content: string,
	label: string,
	created: string[],
	mode?: number,
): boolean {
	if (existsSync(path)) {
		return false;
	}
	writeFileSync(path, content, mode !== undefined ? { encoding: "utf-8", mode } : "utf-8");
	created.push(label);
	return true;
}

function writeJsonFileIfMissing(
	path: string,
	value: unknown,
	label: string,
	created: string[],
	mode?: number,
): boolean {
	return writeTextFileIfMissing(path, `${JSON.stringify(value, null, 2)}\n`, label, created, mode);
}

// App-level config files that may hold secrets (DingTalk client secret, provider
// API keys). They are created owner-only, and any pre-existing file with
// looser bits is tightened on startup.
const SECRET_FILE_MODE = 0o600;

function hardenExistingSecretFile(path: string): void {
	if (!existsSync(path)) {
		return;
	}
	try {
		const mode = statSync(path).mode & 0o777;
		if ((mode & 0o077) !== 0) {
			chmodSync(path, SECRET_FILE_MODE);
			log.logInfo(`Tightened permissions on ${path} to 0600`);
		}
	} catch (err) {
		log.logWarn("runtime.permissions.tighten_failed", "Config file permission tightening failed", {
			reason: errorMessage(err),
			fields: { path },
		});
	}
}

export function bootstrapAppHome(paths: BootstrapPaths = DEFAULT_BOOTSTRAP_PATHS): BootstrapResult {
	const created: string[] = [];

	if (!existsSync(paths.appHomeDir)) {
		mkdirSync(paths.appHomeDir, { recursive: true });
		created.push("app home");
	}
	if (!existsSync(paths.workspaceDir)) {
		mkdirSync(paths.workspaceDir, { recursive: true });
		created.push("workspace/");
	}

	// Validate current state before supplementing any shared files or capabilities.
	if (initializeDefaultDesk(paths)) created.push("workspace/desk-default/");

	// Only shared capabilities live at the root; work state belongs to desk-<name>/.
	for (const dir of ["skills", "sub-agents"]) {
		const dirPath = join(paths.workspaceDir, dir);
		if (!existsSync(dirPath)) {
			mkdirSync(dirPath, { recursive: true });
			created.push(`workspace/${dir}/`);
		}
	}

	writeTextFileIfMissing(join(paths.workspaceDir, "SOUL.md"), DEFAULT_SOUL, "workspace/SOUL.md", created);
	writeTextFileIfMissing(join(paths.workspaceDir, "AGENTS.md"), DEFAULT_AGENTS, "workspace/AGENTS.md", created);
	writeTextFileIfMissing(join(paths.workspaceDir, "MEMORY.md"), DEFAULT_MEMORY, "workspace/MEMORY.md", created);
	writeTextFileIfMissing(
		join(paths.workspaceDir, "ENVIRONMENT.md"),
		DEFAULT_ENVIRONMENT,
		"workspace/ENVIRONMENT.md",
		created,
	);

	const secretConfigPaths = [
		paths.channelConfigPath,
		paths.authConfigPath,
		paths.modelsConfigPath,
		paths.settingsConfigPath,
		paths.toolsConfigPath,
		paths.securityConfigPath,
	];

	let channelTemplateCreated = false;
	let initialWebApiKey: string | undefined;
	if (!existsSync(paths.channelConfigPath)) {
		const generated = createChannelConfigTemplate();
		channelTemplateCreated = writeJsonFileIfMissing(
			paths.channelConfigPath,
			generated.config,
			"channel.json",
			created,
			SECRET_FILE_MODE,
		);
		if (channelTemplateCreated) initialWebApiKey = generated.initialWebApiKey;
	}
	writeJsonFileIfMissing(paths.authConfigPath, {}, "auth.json", created, SECRET_FILE_MODE);
	writeJsonFileIfMissing(paths.modelsConfigPath, MODELS_CONFIG_TEMPLATE, "models.json", created, SECRET_FILE_MODE);
	writeJsonFileIfMissing(
		paths.settingsConfigPath,
		SETTINGS_CONFIG_TEMPLATE,
		"settings.json",
		created,
		SECRET_FILE_MODE,
	);
	writeJsonFileIfMissing(paths.toolsConfigPath, TOOLS_CONFIG_TEMPLATE, "tools.json", created, SECRET_FILE_MODE);
	writeJsonFileIfMissing(
		paths.securityConfigPath,
		SECURITY_CONFIG_TEMPLATE,
		"security.json",
		created,
		SECRET_FILE_MODE,
	);

	// Tighten any pre-existing config that predates owner-only creation.
	for (const secretPath of secretConfigPaths) {
		hardenExistingSecretFile(secretPath);
	}

	return {
		created,
		channelTemplateCreated,
		...(initialWebApiKey ? { initialWebApiKey } : {}),
	};
}

export function printBootstrapSummary(
	result: BootstrapResult,
	io: BootstrapIO = console,
	paths: BootstrapPaths = DEFAULT_BOOTSTRAP_PATHS,
): void {
	if (result.created.length === 0) {
		return;
	}

	io.log(`已初始化 ${paths.appName} 配置目录（${paths.appHomeDir}）：`);
	for (const item of result.created) {
		io.log(`  - ${item}`);
	}
	io.log("");

	if (result.initialWebApiKey) {
		io.log("==================================================================");
		io.log("🔑 已自动生成本机 Web API 默认密钥（名称：default，授权工位：default）");
		io.log("   明文密钥仅展示这一次，请立即妥善保存（配置文件仅保存其 SHA-256）：");
		io.log("");
		io.log(`   ${result.initialWebApiKey}`);
		io.log("");
		io.log("   本机 HTTP 接口：http://127.0.0.1:8787/v1 （Authorization: Bearer <密钥>）");
		io.log(
			`   若遗忘可执行 \`${paths.appName} webapi key remove default && ${paths.appName} webapi key add default\` 重新生成。`,
		);
		io.log("==================================================================");
		io.log("");
	}
}

export function printStartupReadySummary(
	io: BootstrapIO,
	paths: BootstrapPaths,
	transportNames: readonly string[],
	modelStatus?: { ready: boolean; activeModelRef: string },
): void {
	let tcpAddress: string | undefined;
	let tlsEnabled = false;
	if (transportNames.includes("webapi")) {
		try {
			const raw = JSON.parse(readFileSync(paths.channelConfigPath, "utf-8")) as {
				webapi?: { tcp?: unknown; tls?: unknown };
			};
			if (typeof raw.webapi?.tcp === "string" && raw.webapi.tcp.trim()) {
				tcpAddress = raw.webapi.tcp.trim();
			}
			tlsEnabled = Boolean(raw.webapi?.tls);
		} catch {
			// Best-effort summary only; actual config was already validated by loadTransports.
		}
	}

	io.log("");
	io.log(`🚀 ${paths.appName} 服务已启动（配置目录：${paths.appHomeDir}）`);
	if (transportNames.includes("webapi")) {
		const scheme = tlsEnabled ? "https" : "http";
		io.log(
			`  - Web API：已启用${tcpAddress ? `（本机接口 ${scheme}://${tcpAddress}/v1 + 本机 Socket）` : "（本机 Socket）"}`,
		);
	}
	if (transportNames.includes("dingtalk")) {
		io.log("  - 钉钉渠道：已启用（可在钉钉私聊或群内 @机器人 对话）");
	} else {
		io.log(`  - 钉钉渠道：未启用（如需接入，编辑 ${paths.channelConfigPath} 中 dingtalk 段即可）`);
	}
	if (modelStatus) {
		io.log(
			modelStatus.ready
				? `  - 默认模型：${modelStatus.activeModelRef}（已就绪）`
				: `  - 模型状态：⚠️ 尚未检测到凭据（请执行 \`${paths.appName} auth login\` 或配置 ${paths.modelsConfigPath}）`,
		);
	}
	io.log(`  - 立即对话：打开新终端运行 \`${paths.appName} tui\`（在项目目录下可加 \`--cwd .\`）`);
	io.log("");
}

/**
 * The one place that lists `pipiclaw`'s top-level subcommands. `parseArgs`'s own `--help` uses it;
 * `main.ts`'s unknown-subcommand branch calls this too so the two cannot drift apart.
 */
export function formatCliCommandsHelp(appName: string): string[] {
	return [
		`  ${appName} [run] [options]           启动后台常驻服务（默认开启本机 Web API，按需开启钉钉）`,
		`  ${appName} tui [options] [prompt]    在终端与助手交互对话（自动连接常驻服务或内嵌运行）`,
		`  ${appName} auth status|login|logout  管理模型供应商登录凭据（订阅 OAuth / API Key）`,
		`  ${appName} webapi key add|list|remove 管理 Web API 访问密钥`,
	];
}

export function parseArgs(
	argv: string[],
	paths: BootstrapPaths = DEFAULT_BOOTSTRAP_PATHS,
	io: BootstrapIO = console,
): void {
	const args = argv.slice(2);

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (index === 0 && arg === "run") {
			// Explicit name for the default daemon mode (`pipiclaw run` == `pipiclaw`).
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			io.log("用法：");
			for (const line of formatCliCommandsHelp(paths.appName)) io.log(line);
			io.log("");
			io.log("选项：");
			io.log("  --version                   输出当前版本号并退出");
			io.log("  --help, -h                  显示帮助信息并退出");
			io.log("");
			io.log(`渠道配置：${paths.channelConfigPath}`);
			io.log(`工作空间：${paths.workspaceDir}`);
			throw new BootstrapExitError(0);
		} else if (arg === "--version") {
			io.log(readCliVersion());
			throw new BootstrapExitError(0);
		} else {
			io.error(`未知参数：${arg}`);
			io.error(`运行 \`${paths.appName} --help\` 查看用法。`);
			throw new BootstrapExitError(1);
		}
	}
}
