import type { MediaSender } from "../runtime/channel-context.js";
import type { PipiclawSettingsManager } from "../settings.js";
import { ChannelRunner } from "./channel-runner.js";
import type { AgentRunner } from "./types.js";

export interface RunnerFactoryPaths {
	appHomeDir: string;
	authConfigPath: string;
	modelsConfigPath: string;
	/**
	 * The single app-level settings manager (from `prepareAppServices`), shared across every
	 * channel's runner rather than each constructing its own. Keeps `drainErrors()`/diagnostics
	 * ordering and `reload()`'s file-stamp guard meaningful instead of racing N independent copies.
	 */
	settingsManager: PipiclawSettingsManager;
	/** Optional, side-effect-free observer used by the behavior-eval harness. */
	onSessionEvent?: (event: unknown, channelId: string) => void;
	/**
	 * Transport that can deliver file attachments (the DingTalk bot, or the terminal).
	 * Present enables the `send_media` tool; absent, the tool is not built.
	 */
	mediaSender?: MediaSender;
	/** Runtime callback that durably enqueues an independent task verifier. */
	dispatchVerification?: (taskId: string) => Promise<boolean>;
}

/**
 * Stateless: always constructs a fresh runner. The daemon (`runtime/bootstrap.ts`) and the TUI
 * (`tui/app.ts`) are the only two callers, and each already owns exactly one cache appropriate to
 * its own lifecycle (the daemon's runtime channel map with LRU eviction; the TUI's single local
 * `const`, one channel per process) — a second cache here just duplicated that ownership and
 * could hold a stale entry the real owner had already disposed.
 */
export function createRunner(channelId: string, channelDir: string, paths: RunnerFactoryPaths): AgentRunner {
	return new ChannelRunner(channelId, channelDir, paths);
}
