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

export type { ChannelContext, FinalDelivery, ProgressStyle } from "./channel/channel-context.js";
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
export { type BootstrapPaths, type BootstrapResult, isBootstrapExitError } from "./runtime/app-home.js";
export { type AppContext, type BootstrapOptions, bootstrap } from "./runtime/bootstrap.js";
export {
	DingTalkBot,
	type DingTalkConfig,
	type DingTalkEvent,
	type DingTalkHandler,
	type ResponseMode,
} from "./runtime/dingtalk.js";
export type { PipiclawSettings } from "./settings.js";
