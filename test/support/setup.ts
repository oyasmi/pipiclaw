import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

const REAL_PIPICLAW_HOME = join(homedir(), ".pipiclaw");

/**
 * The e2e (live) layer follows the machine's own `settings.json` provider/model
 * rather than hard-coding `anthropic`. Copying `auth.json` while forcing an
 * unrelated default is exactly how F4 (spec 048) happened: `resolveInitialModel`
 * silently fell back and the suite tested a model nobody declared.
 */
function readLocalModelDefaults(): { defaultProvider?: string; defaultModel?: string } {
	try {
		const raw = JSON.parse(readFileSync(join(REAL_PIPICLAW_HOME, "settings.json"), "utf-8")) as Record<
			string,
			unknown
		>;
		return {
			defaultProvider: typeof raw.defaultProvider === "string" ? raw.defaultProvider : undefined,
			defaultModel: typeof raw.defaultModel === "string" ? raw.defaultModel : undefined,
		};
	} catch {
		return {};
	}
}

export interface E2ETestHome {
	homeDir: string;
	workspaceDir: string;
	channelConfigPath: string;
}

export function canRunE2E(): boolean {
	return existsSync(join(REAL_PIPICLAW_HOME, "auth.json")) || Boolean(process.env.ANTHROPIC_API_KEY);
}

export function getE2ESkipReason(): string | null {
	if (canRunE2E()) {
		return null;
	}
	return "E2E credentials unavailable: add ~/.pipiclaw/auth.json or set ANTHROPIC_API_KEY.";
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function writeDefaultWorkspace(workspaceDir: string): void {
	mkdirSync(workspaceDir, { recursive: true });
	for (const dir of ["skills", "events", "sub-agents"]) {
		mkdirSync(join(workspaceDir, dir), { recursive: true });
	}
	writeFileSync(
		join(workspaceDir, "SOUL.md"),
		"# SOUL.md\n\nYou are a concise coding assistant running inside E2E tests.\n",
		"utf-8",
	);
	writeFileSync(
		join(workspaceDir, "AGENTS.md"),
		"# AGENTS.md\n\n- Be concise.\n- Use tools when needed.\n- Avoid unnecessary clarification.\n",
		"utf-8",
	);
	writeFileSync(join(workspaceDir, "MEMORY.md"), "# Workspace Memory\n\n", "utf-8");
	writeFileSync(join(workspaceDir, "ENVIRONMENT.md"), "# Environment\n\n", "utf-8");
}

function writeAuthAndModels(homeDir: string): void {
	const authSrc = join(REAL_PIPICLAW_HOME, "auth.json");
	const modelsSrc = join(REAL_PIPICLAW_HOME, "models.json");

	if (existsSync(authSrc)) {
		copyFileSync(authSrc, join(homeDir, "auth.json"));
	} else if (process.env.ANTHROPIC_API_KEY) {
		writeJson(join(homeDir, "auth.json"), {
			anthropic: {
				type: "api_key",
				key: process.env.ANTHROPIC_API_KEY,
			},
		});
	} else {
		throw new Error(getE2ESkipReason() ?? "Missing E2E auth");
	}

	if (existsSync(modelsSrc)) {
		copyFileSync(modelsSrc, join(homeDir, "models.json"));
	} else {
		writeJson(join(homeDir, "models.json"), { providers: {} });
	}
}

export function createE2ETestHome(overrides?: {
	defaultProvider?: string;
	defaultModel?: string;
	enableDebug?: boolean;
	/** Reuse a parent-owned directory for multi-process behavior-eval segments. */
	homeDir?: string;
}): E2ETestHome {
	const homeDir = overrides?.homeDir ?? mkdtempSync(join(tmpdir(), "pipiclaw-e2e-"));
	mkdirSync(homeDir, { recursive: true });
	const workspaceDir = join(homeDir, "workspace");
	const channelConfigPath = join(homeDir, "channel.json");
	writeDefaultWorkspace(workspaceDir);
	writeAuthAndModels(homeDir);

	// Maintenance cadence is no longer configurable (spec 035 D1). E2E asserts
	// SESSION.md refreshes within tens of seconds, which the production idle and
	// interval gates forbid, so tests opt into the fast tuning instead.
	process.env.PIPICLAW_TEST_FAST_MAINTENANCE = "1";

	const localDefaults = readLocalModelDefaults();
	const resolvedProvider =
		overrides?.defaultProvider ??
		process.env.PIPICLAW_E2E_PROVIDER ??
		localDefaults.defaultProvider ??
		(process.env.ANTHROPIC_API_KEY ? "anthropic" : undefined);
	const resolvedModel =
		overrides?.defaultModel ??
		process.env.PIPICLAW_E2E_MODEL ??
		localDefaults.defaultModel ??
		(process.env.ANTHROPIC_API_KEY ? "claude-sonnet-4-5" : undefined);
	if (!resolvedProvider || !resolvedModel) {
		throw new Error(
			"E2E: cannot resolve a provider/model. Set PIPICLAW_E2E_PROVIDER / PIPICLAW_E2E_MODEL, " +
				"or a defaultProvider/defaultModel in ~/.pipiclaw/settings.json, or ANTHROPIC_API_KEY.",
		);
	}

	writeJson(join(homeDir, "settings.json"), {
		defaultProvider: resolvedProvider,
		defaultModel: resolvedModel,
		memoryRecall: {
			enabled: true,
			rerankWithModel: true,
		},
		sessionMemory: { enabled: true },
		memoryMaintenance: { enabled: true },
	});

	writeJson(channelConfigPath, {
		clientId: "e2e-client-id",
		clientSecret: "e2e-client-secret",
		robotCode: "e2e-client-id",
		cardTemplateId: "",
		cardTemplateKey: "content",
		allowFrom: [],
	});

	if (overrides?.enableDebug) {
		process.env.PIPICLAW_DEBUG = "1";
	}

	return { homeDir, workspaceDir, channelConfigPath };
}

/**
 * A test home for the deterministic e2e layer (spec 048 D2.2): the model provider
 * is the in-process mock, wired through `models.json` with an inline apiKey. No
 * `auth.json` is copied — there is no credential concept in this layer, so it runs
 * on any machine, offline. `mock-fallback` exists for the 429→fallback case (A22).
 */
export function createDeterministicHome(opts: {
	mockBaseUrl: string;
	homeDir?: string;
	/** Written to `security.json`; omitted entirely when not provided (guard uses its defaults). */
	securityJson?: unknown;
	/** Written to `tools.json`; omitted when not provided. */
	toolsJson?: unknown;
}): E2ETestHome {
	const homeDir = opts.homeDir ?? mkdtempSync(join(tmpdir(), "pipiclaw-e2e-det-"));
	mkdirSync(homeDir, { recursive: true });
	const workspaceDir = join(homeDir, "workspace");
	const channelConfigPath = join(homeDir, "channel.json");
	writeDefaultWorkspace(workspaceDir);

	if (opts.securityJson !== undefined) {
		writeJson(join(homeDir, "security.json"), opts.securityJson);
	}
	if (opts.toolsJson !== undefined) {
		writeJson(join(homeDir, "tools.json"), opts.toolsJson);
	}
	writeJson(join(homeDir, "auth.json"), {});
	writeJson(join(homeDir, "models.json"), {
		providers: {
			"e2e-mock": {
				baseUrl: opts.mockBaseUrl,
				api: "openai-completions",
				apiKey: "e2e-mock-key",
				compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
				models: [
					{ id: "mock-main", name: "mock-main", contextWindow: 200000, maxTokens: 8192 },
					{ id: "mock-fallback", name: "mock-fallback", contextWindow: 200000, maxTokens: 8192 },
				],
			},
		},
	});
	writeJson(join(homeDir, "settings.json"), {
		defaultProvider: "e2e-mock",
		defaultModel: "mock-main",
		memoryRecall: { enabled: true, rerankWithModel: false },
		sessionMemory: { enabled: true },
		memoryMaintenance: { enabled: true },
	});
	writeJson(channelConfigPath, {
		clientId: "e2e-client-id",
		clientSecret: "e2e-client-secret",
		robotCode: "e2e-client-id",
		cardTemplateId: "",
		cardTemplateKey: "content",
		allowFrom: [],
	});

	return { homeDir, workspaceDir, channelConfigPath };
}

export function cleanupE2ETestHome(homeDir: string): void {
	rmSync(homeDir, { recursive: true, force: true });
}
