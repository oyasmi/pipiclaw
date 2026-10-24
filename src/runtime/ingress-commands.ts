/**
 * The commands the runtime itself answers: `/new` (a fresh session for one channel) and the
 * stateless report commands (`/status`, `/tasks`, …), shared by the busy and the idle path of
 * `ingress.ts`.
 */
import { join } from "path";
import { createFreshActiveSession } from "../channel/active-session-store.js";
import type { ChannelEvent, HumanEvent } from "../channel/channel-event.js";
import { formatNewSessionReply, type RuntimeCommandName } from "../commands/catalog.js";
import { runReportCommand } from "../commands/router.js";
import { formatNoDeskReply } from "../desk/commands.js";
import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";
import { readActiveTasks } from "../tasks/contract.js";
import { relativeImagePaths } from "./inbound-images.js";
import type { IngressDeps } from "./ingress-deps.js";
import { createTaskDriverEvent } from "./task-driver.js";

export function createCommandHandlers(deps: IngressDeps, resetChannelQueue: (channelId: string) => number) {
	const {
		options,
		channelRunners,
		sessionResetChains,
		activeTasks,
		archiveIncomingMessage,
		getRunner,
		resolveChannel,
		deskPort,
		describeChannel,
		cliVersion,
		startedAt,
		isShuttingDown,
		getDurableDispatch,
		getRuns,
	} = deps;

	const say = (event: ChannelEvent, text: string): Promise<boolean> =>
		deps.pushTo(event.channelId, {
			text,
			...(event.source === "human" && event.ref !== undefined ? { ref: event.ref } : {}),
		});

	/** `/new` bypasses the old per-channel queue and live SDK session. */
	async function handleNewSession(event: HumanEvent): Promise<void> {
		if (isShuttingDown()) return;
		const previous = sessionResetChains.get(event.channelId) ?? Promise.resolve();
		const reset = previous
			.catch(() => undefined)
			.then(async () => {
				try {
					const resolution = resolveChannel(event.channelId);
					if (resolution.kind !== "bound") {
						await say(event, formatNoDeskReply(resolution));
						return;
					}
					const { conversation } = resolution;

					// The empty session file and active pointer are committed before the old
					// generation is touched. A filesystem failure therefore leaves the live
					// session authoritative and retryable. `/new` resets only this channel's
					// conversation in the desk.
					const result = await createFreshActiveSession(conversation.conversationDir, conversation.cwd);
					const oldRunner = channelRunners.get(event.channelId);
					if (oldRunner) {
						channelRunners.delete(event.channelId);
						try {
							oldRunner.retireForNewSession();
						} catch (error) {
							// The active pointer already names the new session. Retirement is
							// best-effort cleanup and must not misreport the committed reset as failed.
							log.logWarn("agent.session.retire_failed", "Old runner retirement after /new failed", {
								channelId: event.channelId,
								reason: errorMessage(error),
							});
						}
					}
					const dropped = resetChannelQueue(event.channelId);
					if (dropped > 0) {
						log.logInfoEvent("agent.session.queue_dropped", "Old-session queued messages discarded by /new", {
							channelId: event.channelId,
							fields: { count: dropped },
						});
					}
					await say(event, formatNewSessionReply(result.sessionId));
					void archiveIncomingMessage(
						event.channelId,
						{
							date: new Date().toISOString(),
							ts: event.ts,
							user: event.user,
							userName: event.userName,
							text: event.text,
							isBot: false,
							images: relativeImagePaths(conversation.deskDir, event.images),
						},
						"/new command",
					);
				} catch (error) {
					const message = errorMessage(error);
					log.logWarn("agent.session.create_failed", "Fresh session creation failed", {
						channelId: event.channelId,
						reason: message,
					});
					await say(event, `新会话创建失败：${message}\n旧会话保持不变，可以重试 \`/new\`。`);
				}
			});
		sessionResetChains.set(event.channelId, reset);
		activeTasks.add(reset);
		try {
			await reset;
		} finally {
			activeTasks.delete(reset);
			if (sessionResetChains.get(event.channelId) === reset) {
				sessionResetChains.delete(event.channelId);
			}
		}
	}

	/**
	 * Render one of the stateless report commands (events/tasks/status/usage/subagents/skills/desk)
	 * to text. The single dispatch point behind both the busy-turn path and the idle-turn path.
	 */
	async function runRuntimeCommand(event: ChannelEvent, name: RuntimeCommandName, args: string): Promise<string> {
		const { channelId } = event;
		const resolution = resolveChannel(channelId);
		if (resolution.kind !== "bound") {
			return runReportCommand(
				{
					kind: "no-desk",
					deskPort: deskPort(channelId),
					refusal: formatNoDeskReply(resolution),
				},
				name,
				args,
			);
		}
		const { conversation } = resolution;
		const { desk, deskDir } = conversation;
		return runReportCommand(
			{
				kind: "bound",
				conversation,
				deskPort: deskPort(channelId),
				paths: options.paths,
				describeChannel: (target) => describeChannel(desk, target),
				version: cliVersion,
				startedAt,
				peekRunner: () => channelRunners.get(channelId),
				getRunner: () => {
					const runner = getRunner(channelId);
					if (!runner) throw new Error(`Channel ${channelId} lost its desk binding`);
					return runner;
				},
				runManager: getRuns().get(desk),
				dispatchTask: async (id) => {
					const entry = (await readActiveTasks(join(deskDir, "tasks"))).find((candidate) => candidate.id === id);
					// The step runs in the task's delivery channel, wherever `/tasks` was typed (D13);
					// a suspended task is not woken at all.
					const target = entry?.fields.channel;
					if (!entry || !target || !describeChannel(desk, target).boundHere) return false;
					// A human asking to run a task twice means twice, so this key is deliberately
					// unique per invocation rather than sharing the driver's occurrence key (D1).
					const now = Date.now();
					return (
						(await getDurableDispatch()?.dispatch({
							...createTaskDriverEvent(desk, target, entry, now),
							dispatchId: `task:${desk}:${entry.id}:manual:${new Date(now).toISOString()}`,
						})) ?? false
					);
				},
			},
			name,
			args,
		);
	}

	return { handleNewSession, runRuntimeCommand };
}
