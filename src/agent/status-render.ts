/**
 * `/status` rendering. Extracted verbatim from `runtime/bootstrap.ts` so both
 * the DingTalk runtime and the terminal TUI can render the same status block
 * from an `AgentRunner` status snapshot. Pure functions, no side effects.
 */
import { errorMessage } from "../shared/text-utils.js";
import type { AgentRunner } from "./types.js";

/** Run state and snapshot both come from the runner's own turn state machine. */
export type StatusRenderRunner = Pick<AgentRunner, "getStatusSnapshot" | "isBusy" | "getTurnStatus">;

export interface RenderStatusOptions {
	runner: StatusRenderRunner | undefined;
	version: string;
	uptimeMs: number;
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
	const { runner, version, uptimeMs } = options;

	let runState: string;
	if (runner?.isBusy()) {
		const task = runner.getTurnStatus().taskText?.trim();
		const preview = task ? `：${task.length > 80 ? `${task.slice(0, 79)}…` : task}` : "";
		runState = `运行中${preview}`;
	} else {
		runState = "空闲";
	}
	const lines = [`**状态** · ${runState}`];

	if (runner) {
		try {
			const snapshot = runner.getStatusSnapshot();
			let modelLine = `- 模型：\`${snapshot.model}\`（thinking \`${snapshot.thinkingLevel}\`）`;
			if (snapshot.fallback) {
				const until = new Date(snapshot.fallback.cooldownUntilMs);
				const hh = String(until.getHours()).padStart(2, "0");
				const mm = String(until.getMinutes()).padStart(2, "0");
				modelLine += ` · fallback 生效中（primary ${snapshot.fallback.primary} 冷却至 ${hh}:${mm}）`;
			}
			lines.push(modelLine);
			if (snapshot.contextTokens !== undefined && snapshot.contextWindow > 0) {
				const percent = ((snapshot.contextTokens / snapshot.contextWindow) * 100).toFixed(1);
				lines.push(
					`- 上下文：${formatTokenCount(snapshot.contextTokens)} / ${formatTokenCount(snapshot.contextWindow)}（${percent}%）`,
				);
			}
		} catch (err) {
			lines.push(`- 模型：不可用（${errorMessage(err)}）`);
		}
	} else {
		lines.push("- 模型：本频道尚未开始过会话");
	}

	lines.push(`- 已运行 ${formatUptime(uptimeMs)} · 版本 \`${version}\``);
	return lines.join("\n");
}
