/** Request-owned generations share the normal runner/tools, without creating channel state. */
import { join } from "node:path";
import type { AgentRunner } from "../agent/types.js";
import type { ChannelContext } from "../channel/channel-context.js";
import type { InboundMessage, IngressResult } from "../channel/ingress.js";
import type { ChannelStore } from "../channel/store.js";
import { DEFAULT_DESK } from "../desk/paths.js";
import { readDeskRecord } from "../desk/registry.js";
import type { DeskConversation } from "../desk/types.js";
import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";
import { createEmptyUsageTotals } from "../usage/totals.js";
import type { TransportRegistry } from "./transports.js";

export interface RequestExecution {
	execute(message: InboundMessage): Promise<IngressResult>;
	cancel(channelId: string): Promise<boolean>;
	isIdle(): boolean;
}

export function createRequestExecution(deps: {
	workspaceDir: string;
	runners: Map<string, AgentRunner>;
	activeTasks: Set<Promise<void>>;
	transports: TransportRegistry;
	store: ChannelStore;
	isShuttingDown: () => boolean;
	createRunner: (conversation: DeskConversation) => AgentRunner;
}): RequestExecution {
	const running = new Map<string, AgentRunner>();
	let admitting = 0;
	return {
		async execute(message) {
			if (deps.isShuttingDown()) return { kind: "rejected", reason: { code: "shutting_down" } };
			if (running.size + admitting >= 32) return { kind: "rejected", reason: { code: "request_capacity" } };
			admitting++;
			try {
				const desk = message.desk ?? message.allowedDesks?.[0] ?? DEFAULT_DESK;
				if (message.allowedDesks && !message.allowedDesks.includes(desk))
					return { kind: "rejected", reason: { code: "desk_not_allowed", desk } };
				const summary = await readDeskRecord(deps.workspaceDir, desk);
				if (!summary.record) throw new Error(`Desk ${desk} is unavailable; repair it before sending API requests.`);
				if (deps.isShuttingDown()) return { kind: "rejected", reason: { code: "shutting_down" } };
				const conversation: DeskConversation = {
					desk,
					deskDir: summary.deskDir,
					cwd: summary.record.cwd ?? summary.deskDir,
					channelId: message.channelId,
					conversation: "request",
					conversationDir: join(summary.deskDir, ".requests"),
				};
				const runner = deps.createRunner(conversation);
				running.set(message.channelId, runner);
				deps.runners.set(message.channelId, runner);
				runner.beginTurn(message.text);
				const run = async () => {
					let output: ChannelContext | undefined;
					try {
						output = deps.transports.forChannel(message.channelId)?.openTurn(message, { quiet: false });
						if (!output) throw new Error("The request's transport is unavailable.");
						await runner.run(message, output, deps.store);
					} catch (error) {
						log.logWarn("runtime.request.failed", "Request execution failed", {
							channelId: message.channelId,
							reason: errorMessage(error),
						});
						await output?.finish({
							kind: "failed",
							usage: createEmptyUsageTotals(),
							message: "请求执行失败，请稍后重试或让部署者检查服务日志。",
						});
					} finally {
						runner.endTurn();
						try {
							await runner.dispose();
						} finally {
							running.delete(message.channelId);
							deps.runners.delete(message.channelId);
						}
					}
				};
				const task = run();
				deps.activeTasks.add(task);
				void task.finally(() => deps.activeTasks.delete(task)).catch(() => undefined);
				return { kind: "started" };
			} finally {
				admitting--;
			}
		},
		async cancel(channelId) {
			const runner = running.get(channelId);
			if (!runner) return false;
			runner.requestStop();
			await runner.abort();
			return true;
		},
		isIdle: () => admitting === 0 && running.size === 0,
	};
}
