/**
 * App-home scaffolding: create `~/.pipiclaw` (or `PIPICLAW_HOME`) on first run, validate
 * `channel.json`, and parse CLI args shared by every entrypoint. Pure functions over explicit
 * `paths`/`io` parameters — no dependency on the runtime wiring in `bootstrap.ts`.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";
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
import {
	type DingTalkConfig,
	isBusyMessageDefaultConfig,
	isResponseModeConfig,
	normalizeBusyMessageDefault,
	normalizeResponseMode,
} from "./dingtalk.js";
import { DEFAULT_AGENTS, DEFAULT_SOUL } from "./workspace-templates.js";

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
}

const DEFAULT_MEMORY = `# Workspace Memory

This file stores stable workspace-level memory.

- It is intended to be managed by a human administrator.
- It is not automatically rewritten by normal runtime consolidation.
- Store durable shared background here when it should apply across channels.
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

const CHANNEL_CONFIG_TEMPLATE = {
	clientId: "your-dingtalk-client-id",
	clientSecret: "your-dingtalk-client-secret",
	robotCode: "your-robot-code",
	cardTemplateId: "your-card-template-id",
	cardTemplateKey: "content",
	allowFrom: ["your-staff-id"],
	busyMessageDefault: "steer",
	responseMode: "full_progress_then_plain_final",
	cardAutoLayout: true,
} satisfies DingTalkConfig;

const MODELS_CONFIG_TEMPLATE = { providers: {} };
const TOOLS_CONFIG_TEMPLATE = {
	tools: {
		web: {
			enable: false,
			proxy: null,
			search: {
				provider: "brave",
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
		apiKey: "BSA...",
	},
	_notes: [
		"Set tools.web.enable to true to register web_search and web_fetch.",
		"Replace tools.web.search.apiKey with your Brave API key before enabling web tools.",
		"If needed, copy _examples.proxy to tools.web.proxy.",
		"tools.tasks.enabled is the master switch for autonomous long-running tasks (task_manage tool + task driver + task digest).",
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
// API keys, Brave key). They are created owner-only, and any pre-existing file with
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
		log.logWarning(`Failed to tighten permissions on ${path}`, errorMessage(err));
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

	for (const dir of ["skills", "events", "sub-agents"]) {
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

	const channelTemplateCreated = writeJsonFileIfMissing(
		paths.channelConfigPath,
		CHANNEL_CONFIG_TEMPLATE,
		"channel.json",
		created,
		SECRET_FILE_MODE,
	);
	writeJsonFileIfMissing(paths.authConfigPath, {}, "auth.json", created, SECRET_FILE_MODE);
	writeJsonFileIfMissing(paths.modelsConfigPath, MODELS_CONFIG_TEMPLATE, "models.json", created, SECRET_FILE_MODE);
	writeJsonFileIfMissing(paths.settingsConfigPath, {}, "settings.json", created, SECRET_FILE_MODE);
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

	return { created, channelTemplateCreated };
}

function isPlaceholderString(value: string): boolean {
	return value.trim().startsWith("your-");
}

function listChannelConfigIssues(config: Partial<DingTalkConfig>): string[] {
	const issues: string[] = [];

	if (!config.clientId) {
		issues.push("Missing required field `clientId`.");
	} else if (isPlaceholderString(config.clientId)) {
		issues.push("Replace placeholder value for `clientId`.");
	}

	if (!config.clientSecret) {
		issues.push("Missing required field `clientSecret`.");
	} else if (isPlaceholderString(config.clientSecret)) {
		issues.push("Replace placeholder value for `clientSecret`.");
	}

	if (config.robotCode && isPlaceholderString(config.robotCode)) {
		issues.push("Replace placeholder value for `robotCode`, or set it to an empty string to reuse `clientId`.");
	}

	if (config.cardTemplateId && isPlaceholderString(config.cardTemplateId)) {
		issues.push(
			"Replace placeholder value for `cardTemplateId`, or set it to an empty string to disable AI Card streaming.",
		);
	}

	if (Array.isArray(config.allowFrom) && config.allowFrom.some((value) => isPlaceholderString(value))) {
		issues.push("Replace placeholder values in `allowFrom`, or set it to an empty array to allow all users.");
	}

	const busyMessageDefault = (config as { busyMessageDefault?: unknown }).busyMessageDefault;
	if (busyMessageDefault !== undefined && !isBusyMessageDefaultConfig(busyMessageDefault)) {
		issues.push('Invalid `busyMessageDefault`: expected "steer", "followUp", or "followup".');
	}

	const responseMode = (config as { responseMode?: unknown }).responseMode;
	if (responseMode !== undefined && !isResponseModeConfig(responseMode)) {
		issues.push(
			'Invalid `responseMode`: expected "full_progress_then_plain_final", "rolling_progress_then_plain_final", or "final_card_only".',
		);
	}

	const cardAutoLayout = (config as { cardAutoLayout?: unknown }).cardAutoLayout;
	if (cardAutoLayout !== undefined && typeof cardAutoLayout !== "boolean") {
		issues.push("Invalid `cardAutoLayout`: expected boolean.");
	}

	return issues;
}

export function printBootstrapSummary(
	result: BootstrapResult,
	io: BootstrapIO = console,
	paths: BootstrapPaths = DEFAULT_BOOTSTRAP_PATHS,
): void {
	if (result.created.length === 0) {
		return;
	}

	io.log(`Initialized ${paths.appName} under ${paths.appHomeDir}:`);
	for (const item of result.created) {
		io.log(`  - ${item}`);
	}
	io.log("");
}

export function loadConfig(paths: BootstrapPaths = DEFAULT_BOOTSTRAP_PATHS, io: BootstrapIO = console): DingTalkConfig {
	let parsed: DingTalkConfig;

	try {
		parsed = JSON.parse(readFileSync(paths.channelConfigPath, "utf-8")) as DingTalkConfig;
	} catch (err) {
		io.error(`Failed to parse configuration: ${paths.channelConfigPath}`);
		io.error(errorMessage(err));
		throw new BootstrapExitError(1);
	}

	const issues = listChannelConfigIssues(parsed);
	if (issues.length > 0) {
		io.error(`Configuration is not ready: ${paths.channelConfigPath}`);
		for (const issue of issues) {
			io.error(`  - ${issue}`);
		}
		io.error("");
		io.error(`Fill in ${paths.channelConfigPath} and run \`${paths.appName}\` again.`);
		throw new BootstrapExitError(1);
	}

	parsed.cardTemplateKey = parsed.cardTemplateKey || "content";
	parsed.robotCode = parsed.robotCode?.trim() ? parsed.robotCode : parsed.clientId;
	parsed.busyMessageDefault = normalizeBusyMessageDefault(
		(parsed as { busyMessageDefault?: unknown }).busyMessageDefault,
	);
	parsed.responseMode = normalizeResponseMode((parsed as { responseMode?: unknown }).responseMode);
	parsed.cardAutoLayout = (parsed as { cardAutoLayout?: boolean }).cardAutoLayout ?? true;
	if (Array.isArray(parsed.allowFrom)) {
		parsed.allowFrom = parsed.allowFrom.filter((value) => value.trim().length > 0);
	}

	return parsed;
}

/**
 * The one place that lists `pipiclaw`'s top-level subcommands. `parseArgs`'s own `--help` uses it;
 * `main.ts`'s unknown-subcommand branch used to hand-copy the same three lines separately (review
 * 2026-08-24 §1.10) — it now calls this instead, so the two can't drift apart again.
 */
export function formatCliCommandsHelp(appName: string): string[] {
	return [
		`  ${appName} [run] [options]         Run the DingTalk daemon (default)`,
		`  ${appName} tui [options] [prompt]   Chat with the agent in the terminal`,
		`  ${appName} auth status|login|logout Manage provider credentials`,
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
			io.log(`Usage:`);
			for (const line of formatCliCommandsHelp(paths.appName)) io.log(line);
			io.log("");
			io.log("Options:");
			io.log("  --version                   Print the current version and exit");
			io.log("  --help, -h                  Show this help and exit");
			io.log("");
			io.log(`Config:    ${paths.channelConfigPath}`);
			io.log(`Workspace: ${paths.workspaceDir}`);
			throw new BootstrapExitError(0);
		} else if (arg === "--version") {
			io.log(readCliVersion());
			throw new BootstrapExitError(0);
		} else {
			io.error(`Unknown option: ${arg}`);
			io.error(`Run \`${paths.appName} --help\` for usage.`);
			throw new BootstrapExitError(1);
		}
	}
}
