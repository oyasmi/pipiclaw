import { existsSync } from "node:fs";
import { homedir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";

export const APP_NAME = "pipiclaw";
/**
 * Agent-facing playbooks bundled inside the installed package (src/playbooks
 * in a checkout, dist/playbooks when built). Read-only runtime self-docs: the
 * system prompt carries a small index and the agent reads them on demand.
 */
const bundledPlaybooksDir = fileURLToPath(new URL("./playbooks", import.meta.url));
const checkoutPlaybooksDir = fileURLToPath(new URL("../src/playbooks", import.meta.url));
/** Prefer live source docs in a checkout; installed packages fall back to dist/playbooks. */
export const PLAYBOOKS_DIR = existsSync(checkoutPlaybooksDir) ? checkoutPlaybooksDir : bundledPlaybooksDir;
export const APP_HOME_DIR = process.env.PIPICLAW_HOME ?? join(homedir(), ".pi", APP_NAME);
export const WORKSPACE_DIR = join(APP_HOME_DIR, "workspace");
export const STATE_DIR = join(APP_HOME_DIR, "state");
export const EVENT_STATE_DIR = join(STATE_DIR, "events");
export const EVENT_HISTORY_PATH = join(EVENT_STATE_DIR, "history.jsonl");
export const LOG_STATE_DIR = join(STATE_DIR, "logs");
export const RUNTIME_LOG_PATH = join(LOG_STATE_DIR, "runtime.jsonl");
export const USAGE_STATE_DIR = join(STATE_DIR, "usage");
export const SUB_AGENTS_DIR_NAME = "sub-agents";
export const SUB_AGENTS_DIR = join(WORKSPACE_DIR, SUB_AGENTS_DIR_NAME);
export const CHANNEL_CONFIG_PATH = join(APP_HOME_DIR, "channel.json");
export const AUTH_CONFIG_PATH = join(APP_HOME_DIR, "auth.json");
export const MODELS_CONFIG_PATH = join(APP_HOME_DIR, "models.json");
export const SETTINGS_CONFIG_PATH = join(APP_HOME_DIR, "settings.json");
export const TOOLS_CONFIG_PATH = join(APP_HOME_DIR, "tools.json");
export const SECURITY_CONFIG_PATH = join(APP_HOME_DIR, "security.json");
