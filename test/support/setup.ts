import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

const REAL_PIPICLAW_HOME = join(homedir(), ".pipiclaw");

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

	writeJson(join(homeDir, "settings.json"), {
		defaultProvider: overrides?.defaultProvider ?? process.env.PIPICLAW_E2E_PROVIDER ?? "anthropic",
		defaultModel: overrides?.defaultModel ?? process.env.PIPICLAW_E2E_MODEL ?? "claude-sonnet-4-5",
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

export function cleanupE2ETestHome(homeDir: string): void {
	rmSync(homeDir, { recursive: true, force: true });
}
