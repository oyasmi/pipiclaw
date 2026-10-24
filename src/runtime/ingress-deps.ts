/**
 * Everything the ingress needs from `createRuntimeContext`'s scope, as a reviewable typed list
 * instead of "however many closures happen to be in scope". The `get*`/`is*` accessors exist only
 * for state the composition root assigns *after* the ingress is built (`durableDispatch`, the
 * task driver) or mutates later (`shuttingDown`): a method only ever runs long after all of them
 * are set, but a value captured at construction would freeze a stale snapshot.
 */
import type { AgentRunner } from "../agent/types.js";
import type { BootstrapPaths } from "../app/home.js";
import type { ChannelDescription } from "../channel/channel-id.js";
import type { ChannelIndex } from "../channel/channel-index.js";
import type { ChannelStore } from "../channel/store.js";
import type { PushMessage } from "../channel/transport.js";
import type { DeskCommandPort } from "../desk/commands.js";
import type { JobRuntime } from "../jobs/manager.js";
import type { SubAgentRuntime } from "../subagents/run-registry.js";
import type { ChannelResolution } from "./desk-runtime.js";
import type { DurableDispatchService } from "./durable-dispatch.js";
import type { WakeTaskTransitionHooks } from "./task-wake.js";
import type { TransportRegistry } from "./transports.js";
import type { ArchivedMessage } from "./turn-run.js";

export interface IngressOptions {
	paths: BootstrapPaths;
	/** Override the `/stop` watchdog's grace window (tests use a short one). */
	stopForceEndGraceMs?: number;
	/** Test-only fault seams for the atomic structured-wake task transition. */
	wakeTransitionHooks?: Partial<Record<"job" | "subagent", WakeTaskTransitionHooks>>;
}

export interface IngressDeps {
	options: IngressOptions;
	transports: TransportRegistry;
	store: ChannelStore;
	channelRunners: Map<string, AgentRunner>;
	sessionResetChains: Map<string, Promise<void>>;
	activeTasks: Set<Promise<void>>;
	stopWatchdogs: Set<string>;
	channelIndex: ChannelIndex;
	archiveIncomingMessage: (channelId: string, message: ArchivedMessage, contextLabel: string) => Promise<void>;
	/** The channel's runner; `undefined` when it is not bound to an available desk — none is ever built then. */
	getRunner: (channelId: string) => AgentRunner | undefined;
	resolveChannel: (channelId: string) => ChannelResolution;
	/** Bind a channel that has no binding yet to `desk`; a no-op when it already has one. */
	ensureBinding: (channelId: string, desk: string) => Promise<void>;
	/** `/desk` as asked from `channelId` (spec 058, D5). */
	deskPort: (channelId: string) => DeskCommandPort;
	/** Names a channel and says whether it is bound to `desk` — the asking channel's desk. */
	describeChannel: (desk: string, channelId: string) => ChannelDescription;
	cliVersion: string;
	startedAt: number;
	isShuttingDown: () => boolean;
	getDurableDispatch: () => DurableDispatchService | undefined;
	getJobs: () => JobRuntime;
	getRuns: () => SubAgentRuntime;
	getTaskDriver: () => { nudge?(): void };
	/** Say something to a channel outside any turn; whether it was delivered. */
	pushTo: (channelId: string, message: PushMessage) => Promise<boolean>;
}
