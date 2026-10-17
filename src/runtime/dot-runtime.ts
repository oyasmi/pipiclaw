/**
 * The daemon's one authority on dots (spec 058, D6): which dot a channel is bound to, which dots
 * are active, and how that changes. Disk I/O is `dot/registry.ts`'s; this joins it to the
 * lifecycles that depend on it — each active dot's events watcher, the interrupted-turn repair a
 * dot gets before its channels take traffic, and the binding guard every background notice
 * passes through.
 *
 * `bindings.json` is read once at startup and the in-memory copy is authoritative from then on
 * (D4); it is written back on every change, by this process only.
 */
import { channelKind } from "../channel/channel-id.js";
import { StartupRefusal } from "../dot/legacy-layout.js";
import { getDotDir } from "../dot/paths.js";
import { allocateConversation, findConversation, loadBindings, readDotRecord } from "../dot/registry.js";
import type { BindingsFile, DotConversation, DotSummary } from "../dot/types.js";
import * as log from "../log.js";
import { createSerialQueue } from "../shared/serial-queue.js";
import { errorMessage } from "../shared/text-utils.js";

export type ChannelResolution =
	| { kind: "bound"; conversation: DotConversation }
	/** Bound to a dot that is missing or broken on disk: never degraded to "unbound" (D4). */
	| { kind: "unavailable"; dot: string; reason: string }
	| { kind: "unbound" };

interface DotWatcher {
	start(): void;
	stop(): void;
	flush?(): Promise<void>;
}

export interface DotRuntimeOptions {
	workspaceDir: string;
	/** Repair interrupted turns in a dot's bound conversations; runs inside activation (D6 step 1). */
	recover: (conversations: DotConversation[]) => Promise<void>;
	/** Build a dot's events watcher. It is started with the services and stopped at dormancy. */
	createWatcher: (target: { dot: string; dotDir: string }) => DotWatcher;
	/** The transport's plain send, for background notices that pass the binding guard. */
	send: (channelId: string, text: string) => Promise<boolean>;
}

export class DotRuntime {
	private bindings: BindingsFile = { version: 1, bindings: {} };
	/** Every dot a binding points at, as last read from disk. */
	private readonly records = new Map<string, DotSummary>();
	private readonly active = new Set<string>();
	private readonly watchers = new Map<string, DotWatcher>();
	/** Activation and dormancy of one dot run in order, so interleaved calls settle on the last one. */
	private readonly lifecycle = createSerialQueue<string>();
	private servicesStarted = false;

	constructor(private readonly options: DotRuntimeOptions) {}

	/**
	 * Read the bindings and every bound dot. A corrupt or unknown-version bindings file refuses
	 * startup (D4). A binding whose channel has no conversation in its dot yet — hand-edited, or
	 * left by an interrupted bind — gets one allocated now, so `resolve` never has to.
	 */
	async load(): Promise<void> {
		try {
			this.bindings = await loadBindings(this.options.workspaceDir);
		} catch (error) {
			throw new StartupRefusal(errorMessage(error));
		}
		for (const dot of new Set(Object.values(this.bindings.bindings).map((binding) => binding.dot))) {
			await this.refreshRecord(dot);
		}
		for (const [channelId, binding] of Object.entries(this.bindings.bindings)) {
			const record = this.records.get(binding.dot)?.record;
			const kind = channelKind(channelId);
			if (!record || !kind || record.conversations[channelId]) continue;
			await allocateConversation(this.options.workspaceDir, binding.dot, channelId, kind, new Date());
			await this.refreshRecord(binding.dot);
		}
	}

	private async refreshRecord(dot: string): Promise<DotSummary> {
		const summary = await readDotRecord(this.options.workspaceDir, dot);
		this.records.set(dot, summary);
		if (summary.availability !== "available") {
			log.logWarn("dot.record.unavailable", "Bound dot is unavailable", {
				reason: summary.reason,
				fields: { dot },
			});
		}
		return summary;
	}

	resolve(channelId: string): ChannelResolution {
		const binding = this.bindings.bindings[channelId];
		if (!binding) return { kind: "unbound" };
		const summary = this.records.get(binding.dot);
		if (!summary?.record) {
			return { kind: "unavailable", dot: binding.dot, reason: summary?.reason ?? "dot not loaded" };
		}
		const conversation = findConversation(summary.record, summary.dotDir, channelId);
		if (!conversation) {
			return { kind: "unavailable", dot: binding.dot, reason: `no conversation registered for ${channelId}` };
		}
		return { kind: "bound", conversation };
	}

	/** The producer- and admission-side check of INV-5: is this channel bound to this (available) dot? */
	isBoundTo(channelId: string, dot: string): boolean {
		const resolution = this.resolve(channelId);
		return resolution.kind === "bound" && resolution.conversation.dot === dot;
	}

	/** The dot a channel points at, available or not — for the channel index's dot column. */
	boundDot(channelId: string): string | undefined {
		return this.bindings.bindings[channelId]?.dot;
	}

	activeDots(): Array<{ dot: string; dotDir: string }> {
		return [...this.active].sort().map((dot) => ({ dot, dotDir: getDotDir(this.options.workspaceDir, dot) }));
	}

	/** The memory scheduler's candidates (D12): every bound conversation of an active dot. */
	boundConversations(): DotConversation[] {
		const conversations: DotConversation[] = [];
		for (const channelId of Object.keys(this.bindings.bindings).sort()) {
			const resolution = this.resolve(channelId);
			if (resolution.kind === "bound" && this.active.has(resolution.conversation.dot)) {
				conversations.push(resolution.conversation);
			}
		}
		return conversations;
	}

	/** The channel a conversation directory of this dot belongs to (for `session_search` labels). */
	channelOfConversation(dot: string, conversation: string): string | undefined {
		const record = this.records.get(dot)?.record;
		if (!record) return undefined;
		return Object.entries(record.conversations).find(([, entry]) => entry.dir === conversation)?.[0];
	}

	/** Channels that have ever had a conversation in this dot — `/events history`'s pre-058 fallback. */
	conversationChannels(dot: string): string[] {
		return Object.keys(this.records.get(dot)?.record?.conversations ?? {});
	}

	private boundChannelsOf(dot: string): string[] {
		return Object.entries(this.bindings.bindings)
			.filter(([, binding]) => binding.dot === dot)
			.map(([channelId]) => channelId);
	}

	/** Startup: activate every dot that has at least one binding. */
	async activateBound(): Promise<void> {
		for (const dot of new Set(Object.values(this.bindings.bindings).map((binding) => binding.dot))) {
			await this.activate(dot);
		}
	}

	/**
	 * D6 activation: repair the dot's bound conversations, then mark it active (the task driver and
	 * memory scheduler read the active set on every pass) and start its watcher once services run.
	 */
	activate(dot: string): Promise<void> {
		return this.lifecycle.run(dot, async () => {
			if (this.active.has(dot)) return;
			const summary = await this.refreshRecord(dot);
			if (!summary.record) return;
			const conversations = this.boundChannelsOf(dot).flatMap((channelId) => {
				const resolution = this.resolve(channelId);
				return resolution.kind === "bound" ? [resolution.conversation] : [];
			});
			try {
				await this.options.recover(conversations);
			} catch (error) {
				log.logWarn("dot.activate.recover_failed", "Interrupted-turn repair failed during activation", {
					reason: errorMessage(error),
					fields: { dot },
				});
			}
			this.active.add(dot);
			if (this.servicesStarted) this.startWatcher(dot);
			log.logInfoEvent("dot.activated", "Dot activated", { fields: { dot, channels: conversations.length } });
		});
	}

	/** D6 dormancy: stop the watcher and leave the background scans. Running runs and jobs are untouched. */
	deactivate(dot: string): Promise<void> {
		return this.lifecycle.run(dot, async () => {
			if (!this.active.has(dot)) return;
			await this.stopWatcher(dot);
			this.active.delete(dot);
			log.logInfoEvent("dot.deactivated", "Dot went dormant: no bound channel", { fields: { dot } });
		});
	}

	private startWatcher(dot: string): void {
		if (this.watchers.has(dot)) return;
		const watcher = this.options.createWatcher({ dot, dotDir: getDotDir(this.options.workspaceDir, dot) });
		this.watchers.set(dot, watcher);
		watcher.start();
	}

	private async stopWatcher(dot: string): Promise<void> {
		const watcher = this.watchers.get(dot);
		if (!watcher) return;
		this.watchers.delete(dot);
		watcher.stop();
		await watcher.flush?.().catch(() => undefined);
	}

	/** Start the event watchers of every active dot; later activations start theirs directly. */
	startServices(): void {
		this.servicesStarted = true;
		for (const dot of this.active) this.startWatcher(dot);
	}

	/**
	 * D7's guard for every background notice that bypasses durable dispatch (run notices, stop and
	 * skip receipts, exhausted-dispatch notices): sent only while `channelId` is bound to `dot`.
	 */
	async sendFromDot(dot: string, channelId: string, text: string): Promise<boolean> {
		if (!this.isBoundTo(channelId, dot)) {
			log.logInfoEvent("dot.notice.dropped", "Background notice dropped: channel not bound to its dot", {
				channelId,
				fields: { dot },
			});
			return false;
		}
		return this.options.send(channelId, text);
	}

	/** Shutdown: stop every watcher (synchronously), then let `flush` drain their history. */
	stop(): void {
		this.servicesStarted = false;
		for (const watcher of this.watchers.values()) watcher.stop();
	}

	async flush(): Promise<void> {
		await Promise.all([...this.watchers.values()].map((watcher) => watcher.flush?.() ?? Promise.resolve()));
	}
}
