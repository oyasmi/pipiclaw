/**
 * The `/stop` watchdog: a stopped turn that never ends is force-released after a grace window, so
 * the channel does not keep reporting "a turn is already running".
 */

import type { AgentRunner } from "../agent/types.js";
import { sleepUnref } from "../shared/with-timeout.js";

/**
 * How long `/stop` waits for the turn to actually end before force-releasing it.
 * `requestStop` + `abort` only reach the agent loop; a turn wedged in its
 * epilogue (delivery drain, session-resource reload, memory flush) ignores both
 * and would otherwise keep the channel reporting "已有回合在运行" indefinitely.
 */
const STOP_FORCE_END_GRACE_MS = 15_000;
const STOP_FORCE_END_POLL_MS = 250;

/**
 * Watchdog for `/stop`: release the channel if the stopped turn has not ended
 * once the grace window elapses. Returns true when it had to force the release.
 */
export async function forceEndStuckTurnAfterStop(input: {
	channelId: string;
	runner: AgentRunner;
	graceMs?: number;
	pollMs?: number;
	notify?: (text: string) => Promise<unknown>;
}): Promise<boolean> {
	const graceMs = input.graceMs ?? STOP_FORCE_END_GRACE_MS;
	const pollMs = input.pollMs ?? STOP_FORCE_END_POLL_MS;
	const deadline = Date.now() + graceMs;
	while (input.runner.isBusy() && Date.now() < deadline) {
		await sleepUnref(Math.min(pollMs, Math.max(1, deadline - Date.now())));
	}
	if (!input.runner.forceEndTurn(`/stop did not take effect within ${graceMs}ms`)) {
		return false;
	}
	await input
		.notify?.(
			`⚠️ 上一个回合的收尾卡住了，已强制结束以释放会话（后台清理仍在继续）。现在可以正常发消息或使用 \`/new\`、\`/model\`。`,
		)
		.catch(() => undefined);
	return true;
}
