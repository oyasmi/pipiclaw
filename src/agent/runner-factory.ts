import type { MediaSender } from "../runtime/channel-context.js";
import { ChannelRunner } from "./channel-runner.js";
import type { AgentRunner } from "./types.js";

const channelRunners = new Map<string, AgentRunner>();

export interface RunnerFactoryPaths {
	appHomeDir: string;
	authConfigPath: string;
	modelsConfigPath: string;
	/** Optional, side-effect-free observer used by the behavior-eval harness. */
	onSessionEvent?: (event: unknown, channelId: string) => void;
	/**
	 * Transport that can deliver file attachments (the DingTalk bot, or the terminal).
	 * Present enables the `send_media` tool; absent, the tool is not built. Not part
	 * of the runner cache key — it is a stable per-process transport handle.
	 */
	mediaSender?: MediaSender;
}

function runnerKey(paths: RunnerFactoryPaths, channelId: string, channelDir: string): string {
	return `${paths.appHomeDir}\0${channelDir}\0${channelId}`;
}

export function getOrCreateRunner(channelId: string, channelDir: string, paths: RunnerFactoryPaths): AgentRunner {
	const key = runnerKey(paths, channelId, channelDir);
	const existing = channelRunners.get(key);
	if (existing) return existing;

	const runner = new ChannelRunner(channelId, channelDir, paths);
	channelRunners.set(key, runner);
	return runner;
}

export function resetRunner(channelId: string, paths?: RunnerFactoryPaths, channelDir?: string): void {
	if (paths && channelDir) {
		channelRunners.delete(runnerKey(paths, channelId, channelDir));
		return;
	}
	for (const key of channelRunners.keys()) {
		if (key.endsWith(`\0${channelId}`)) {
			channelRunners.delete(key);
		}
	}
}
