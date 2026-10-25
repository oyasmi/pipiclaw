/**
 * `/status` rendering. Extracted verbatim from `runtime/bootstrap.ts` so both
 * the DingTalk runtime and the terminal TUI can render the same status block
 * from an `AgentRunner` status snapshot. Pure functions, no side effects.
 */
import { formatElapsedZh } from "../shared/format.js";
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

	const snapshot = runner?.getStatusSnapshot();
	if (runner && !snapshot) {
		lines.push("- 模型：会话正在启动，稍后再试");
	} else if (runner && snapshot) {
		try {
			let modelLine = `- 模型：\`${snapshot.model}\`（思考档位 \`${snapshot.thinkingLevel}\`）`;
			if (snapshot.fallback) {
				const until = new Date(snapshot.fallback.cooldownUntilMs);
				const hh = String(until.getHours()).padStart(2, "0");
				const mm = String(until.getMinutes()).padStart(2, "0");
				modelLine += ` · 正在使用备用模型（主模型 \`${snapshot.fallback.primary}\` 暂停到 ${hh}:${mm}）`;
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

	lines.push(`- 已运行 ${formatElapsedZh(uptimeMs)} · 版本 \`${version}\``);
	return lines.join("\n");
}
