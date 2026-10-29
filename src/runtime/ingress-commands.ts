/**
 * The commands the runtime itself answers: `/new` (a fresh session for one channel) and the
 * stateless report commands (`/status`, `/tasks`, …), shared by the busy and the idle path of
 * `ingress.ts`.
 */
import { createFreshActiveSession } from "../channel/active-session-store.js";
import { type ChannelEvent, type HumanEvent, senderOf } from "../channel/channel-event.js";
import { formatNewSessionReply, type RuntimeCommandName } from "../commands/catalog.js";
import { runReportCommand } from "../commands/router.js";
import { formatNoDeskReply } from "../desk/commands.js";
import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";
import type { TaskControl } from "../tasks/control.js";
import { relativeImagePaths } from "./inbound-images.js";
import type { IngressDeps } from "./ingress-deps.js";

/**
 * The lane is built after the ingress, so a command resolves it when it runs. A command that lands
 * before the lane exists is refused with a retry hint rather than guessed at.
 */
function lazyTaskControl(get: () => TaskControl | undefined): TaskControl {
	const control = (): TaskControl => {
		const current = get();
		if (!current) throw new Error("任务服务尚未就绪，请稍后重试。");
		return current;
	};
	return {
		isRunning: (desk, id) => control().isRunning(desk, id),
		created: (...args) => control().created(...args),
		snapshot: (...args) => control().snapshot(...args),
		message: (...args) => control().message(...args),
		pause: (...args) => control().pause(...args),
		resume: (...args) => control().resume(...args),
		cancel: (...args) => control().cancel(...args),
	};
}

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
		getRuns,
	} = deps;

	const say = (event: ChannelEvent, text: string): Promise<boolean> =>
		deps.pushTo(event.channelId, {
			text,
			...(event.source === "human" && event.ref !== undefined ? { ref: event.ref } : {}),
		});

	/** The desk port a command runs with: a sender limited to some desks may bind only to those. */
	const deskPortFor = (event: ChannelEvent) => {
		const port = deskPort(event.channelId);
		const allowed = event.source === "human" ? event.allowedDesks : undefined;
		const bind = port.bind;
		if (!allowed || !bind) return port;
		return {
			...port,
			bind: async (name: string) =>
				allowed.includes(name) ? bind(name) : { kind: "forbidden" as const, desk: name },
		};
	};

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
					if (event.allowedDesks && !event.allowedDesks.includes(conversation.desk)) {
						await say(event, `当前身份无权使用工位 \`${conversation.desk}\`。`);
						return;
					}

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
					deskPort: deskPortFor(event),
					refusal: formatNoDeskReply(resolution),
				},
				name,
				args,
			);
		}
		const { conversation } = resolution;
		const { desk } = conversation;
		return runReportCommand(
			{
				kind: "bound",
				conversation,
				deskPort: deskPortFor(event),
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
				taskControl: lazyTaskControl(deps.getTaskControl),
				senderName: senderOf(event).userName,
			},
			name,
			args,
		);
	}

	return { handleNewSession, runRuntimeCommand };
}
