import type { SandboxConfig } from "../sandbox.js";
import { ChannelRunner } from "./channel-runner.js";
import type { AgentRunner } from "./types.js";

const channelRunners = new Map<string, AgentRunner>();

export function getOrCreateRunner(sandboxConfig: SandboxConfig, channelId: string, channelDir: string): AgentRunner {
	const existing = channelRunners.get(channelId);
	if (existing) return existing;

	const runner = new ChannelRunner(sandboxConfig, channelId, channelDir);
	channelRunners.set(channelId, runner);
	return runner;
}
