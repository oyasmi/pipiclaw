/**
 * Public API surface (spec 035 D4).
 *
 * Pipiclaw's product is the CLI/runtime, not an SDK. This barrel therefore
 * supports exactly one use case — embedding the daemon in another process — and
 * nothing else is a compatibility promise. Everything else is internal: import
 * it from its module and expect it to move.
 *
 * Keep this list small. Every name added here also becomes a knip blind spot,
 * because `src/index.ts` is a knip entry point.
 */

export { type BootstrapPaths, type BootstrapResult, isBootstrapExitError } from "./app/home.js";
export type { ChannelContext, FinalDelivery, ProgressStyle, ResponseMode } from "./channel/channel-context.js";
export type { PipiclawSettings } from "./config/settings.js";
export { DingTalkBot } from "./dingtalk/bot.js";
export type { DingTalkConfig } from "./dingtalk/config.js";
export type { DingTalkEvent, DingTalkHandler } from "./dingtalk/handler.js";
export {
	APP_HOME_DIR,
	APP_NAME,
	AUTH_CONFIG_PATH,
	CHANNEL_CONFIG_PATH,
	MODELS_CONFIG_PATH,
	SECURITY_CONFIG_PATH,
	SETTINGS_CONFIG_PATH,
	TOOLS_CONFIG_PATH,
	WORKSPACE_DIR,
} from "./paths.js";
export { type AppContext, type BootstrapOptions, bootstrap } from "./runtime/bootstrap.js";
