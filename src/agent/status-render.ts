/**
 * `/status` rendering. Extracted verbatim from `runtime/bootstrap.ts` so both
 * the DingTalk runtime and the terminal TUI can render the same status block
 * from an `AgentRunner` status snapshot. Pure functions, no side effects.
 */
import type { SandboxConfig } from "../sandbox.js";
import { errorMessage } from "../shared/text-utils.js";
import type { AgentRunner } from "./types.js";

/** Minimal per-channel run state the status renderer needs. */
export interface StatusRenderState {
	running: boolean;
	currentTaskText?: string;
	runner: Pick<AgentRunner, "getStatusSnapshot">;
}

export interface RenderStatusOptions {
	state: StatusRenderState | undefined;
	version: string;
	uptimeMs: number;
	sandbox: SandboxConfig;
}

export function formatTokenCount(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatUptime(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const days = Math.floor(totalSeconds / 86400);
	const hours = Math.floor((totalSeconds % 86400) / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const parts: string[] = [];
	if (days > 0) parts.push(`${days}d`);
	if (hours > 0) parts.push(`${hours}h`);
	parts.push(`${minutes}m`);
	return parts.join(" ");
}

export function renderStatus(options: RenderStatusOptions): string {
	const { state, version, uptimeMs, sandbox } = options;
	const lines = ["# Status"];

	if (state?.running) {
		const task = state.currentTaskText?.trim();
		const preview = task ? `: ${task.length > 80 ? `${task.slice(0, 79)}…` : task}` : "";
		lines.push(`- Run state: running${preview}`);
	} else {
		lines.push("- Run state: idle");
	}

	if (state) {
		try {
			const snapshot = state.runner.getStatusSnapshot();
			lines.push(`- Model: ${snapshot.model}`);
			if (snapshot.fallback) {
				const until = new Date(snapshot.fallback.cooldownUntilMs);
				const hh = String(until.getHours()).padStart(2, "0");
				const mm = String(until.getMinutes()).padStart(2, "0");
				lines.push(`- Fallback: active（primary ${snapshot.fallback.primary} 冷却至 ${hh}:${mm}）`);
			}
			if (snapshot.thinkingLevel && snapshot.thinkingLevel !== "off") {
				lines.push(`- Thinking: ${snapshot.thinkingLevel}`);
			}
			if (snapshot.contextTokens !== undefined && snapshot.contextWindow > 0) {
				const percent = ((snapshot.contextTokens / snapshot.contextWindow) * 100).toFixed(1);
				lines.push(
					`- Context: ${formatTokenCount(snapshot.contextTokens)} / ${formatTokenCount(snapshot.contextWindow)} (${percent}%)`,
				);
			}
		} catch (err) {
			lines.push(`- Model: unavailable (${errorMessage(err)})`);
		}
	} else {
		lines.push("- Model: no session started for this channel yet");
	}

	lines.push(`- Sandbox: ${sandbox.type === "host" ? "host" : `docker:${sandbox.container}`}`);
	lines.push(`- Uptime: ${formatUptime(uptimeMs)}`);
	lines.push(`- Version: ${version}`);
	return lines.join("\n");
}
