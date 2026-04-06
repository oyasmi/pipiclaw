import { homedir } from "os";
import { join } from "path";

export const APP_NAME = "pipiclaw";
export const APP_HOME_DIR = process.env.PIPICLAW_HOME ?? join(homedir(), ".pi", APP_NAME);
export const WORKSPACE_DIR = join(APP_HOME_DIR, "workspace");
export const SUB_AGENTS_DIR_NAME = "sub-agents";
export const SUB_AGENTS_DIR = join(WORKSPACE_DIR, SUB_AGENTS_DIR_NAME);
export const CHANNEL_CONFIG_PATH = join(APP_HOME_DIR, "channel.json");
export const AUTH_CONFIG_PATH = join(APP_HOME_DIR, "auth.json");
export const MODELS_CONFIG_PATH = join(APP_HOME_DIR, "models.json");
export const SETTINGS_CONFIG_PATH = join(APP_HOME_DIR, "settings.json");
export const TOOLS_CONFIG_PATH = join(APP_HOME_DIR, "tools.json");
