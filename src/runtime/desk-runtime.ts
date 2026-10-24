/**
 * The daemon's one authority on desks (spec 058, D6): which desk a channel is bound to, which desks
 * are active, and how that changes. Disk I/O is `desk/registry.ts`'s; this joins it to the
 * lifecycles that depend on it — each active desk's events watcher, the interrupted-turn repair a
 * desk gets before its channels take traffic, and the binding guard every background notice
 * passes through.
 *
 * `desk-bindings.json` is read once at startup and the in-memory copy is authoritative from then on
 * (D4); it is written back on every change, by this process only.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadBindings, writeBindings } from "../desk/bindings.js";
import type { BindOutcome } from "../desk/commands.js";
import { getDeskDir, isDeskName, normalizeDeskName } from "../desk/paths.js";
import { allocateConversation, createDeskRecord, findConversation, readDeskRecord } from "../desk/registry.js";
import { StartupRefusal } from "../desk/startup-error.js";
import type {
	BindingsFile,
	ConversationKind,
	CreateDeskOutcome,
	DeskConversation,
	DeskSummary,
} from "../desk/types.js";
import { parseScheduledEventContent } from "../events/parse.js";
import * as log from "../log.js";
import { createSerialQueue } from "../shared/serial-queue.js";
import { errorMessage } from "../shared/text-utils.js";
import { readActiveTasks } from "../tasks/contract.js";

export type ChannelResolution =
	| { kind: "bound"; conversation: DeskConversation }
	/** Bound to a desk that is missing or broken on disk: never degraded to "unbound" (D4). */
	| { kind: "unavailable"; desk: string; reason: string }
	| { kind: "unbound" };

/** The desk a resolution names, bound or not; `undefined` for a channel with no binding. */
export function resolvedDesk(resolution: ChannelResolution): string | undefined {
	switch (resolution.kind) {
		case "bound":
			return resolution.conversation.desk;
		case "unavailable":
			return resolution.desk;
		case "unbound":
			return undefined;
	}
}

/**
 * The one admission rule for a synthetic event (a wake, a scheduled occurrence): it is let in only
 * while its channel is still bound to — and the desk is available for — the desk it was produced
 * for (spec 060 D7, INV-5). Covers a wake queued before a restart or a rebind, and a malformed
 * record that carries no owning desk.
 */
export function admitsSyntheticEvent(resolution: ChannelResolution, event: { desk?: string }): boolean {
	return resolution.kind === "bound" && event.desk !== undefined && resolution.conversation.desk === event.desk;
}

interface DeskWatcher {
	start(): void;
	stop(): void;
	flush?(): Promise<void>;
}

export interface DeskRuntimeOptions {
	workspaceDir: string;
	/**
	 * The conversation kind a channel's transport gives it (names its `conversations/<kind>-<n>/`
	 * directory); `undefined` for an address no active transport owns.
	 */
	conversationKindOf: (channelId: string) => ConversationKind | undefined;
	/** Repair interrupted turns in a desk's bound conversations; runs inside activation (D6 step 1). */
	recover: (conversations: DeskConversation[]) => Promise<void>;
	/** Build a desk's events watcher. It is started with the services and stopped at dormancy. */
	createWatcher: (target: { desk: string; deskDir: string }) => DeskWatcher;
	/** The transport's plain send, for background notices that pass the binding guard. */
	send: (channelId: string, text: string) => Promise<boolean>;
	/** Whether the channel has a turn in flight; `/desk bind` refuses then (D5 step 1). */
	isChannelBusy: (channelId: string) => boolean;
	/**
	 * Drop the channel's cached runner and dispose it — its final reflect lands in the desk it was
	 * bound to (D5 step 5). Called only after the new binding is on disk.
	 */
	releaseRunner: (channelId: string) => Promise<void>;
	/** A binding changed (the channel index rewrites its desk column). */
	onBindingChanged?: (channelId: string) => void;
}

export class DeskRuntime {
	private bindings: BindingsFile = { version: 1, bindings: {} };
	/** Every desk a binding points at, as last read from disk. */
	private readonly records = new Map<string, DeskSummary>();
	private readonly active = new Set<string>();
	private readonly watchers = new Map<string, DeskWatcher>();
	/** Activation and dormancy of one desk run in order, so interleaved calls settle on the last one. */
	private readonly lifecycle = createSerialQueue<string>();
	/** Binds are read-modify-writes of the one bindings file: one at a time, whichever channel asks. */
	private readonly bindingWrites = createSerialQueue<string>();
	private servicesStarted = false;

	constructor(private readonly options: DeskRuntimeOptions) {}

	/**
	 * Read the bindings and every bound desk. A corrupt or unknown-version bindings file refuses
	 * startup (D4). A binding whose channel has no conversation in its desk yet — hand-edited, or
	 * left by an interrupted bind — gets one allocated now, so `resolve` never has to.
	 */
	async load(): Promise<void> {
		try {
			this.bindings = await loadBindings(this.options.workspaceDir);
		} catch (error) {
			throw new StartupRefusal(errorMessage(error));
		}
		for (const desk of new Set(Object.values(this.bindings.bindings).map((binding) => binding.desk))) {
			await this.refreshRecord(desk);
		}
		for (const [channelId, binding] of Object.entries(this.bindings.bindings)) {
			const record = this.records.get(binding.desk)?.record;
			const kind = this.options.conversationKindOf(channelId);
			if (!record || !kind || record.conversations[channelId]) continue;
			await allocateConversation(this.options.workspaceDir, binding.desk, channelId, kind, new Date());
			await this.refreshRecord(binding.desk);
		}
	}

	private async refreshRecord(desk: string): Promise<DeskSummary> {
		const summary = await readDeskRecord(this.options.workspaceDir, desk);
		this.records.set(desk, summary);
		if (summary.availability !== "available") {
			log.logWarn("desk.record.unavailable", "Bound desk is unavailable", {
				reason: summary.reason,
				fields: { desk },
			});
		}
		return summary;
	}

	resolve(channelId: string): ChannelResolution {
		const binding = this.bindings.bindings[channelId];
		if (!binding) return { kind: "unbound" };
		const summary = this.records.get(binding.desk);
		if (!summary?.record) {
			return { kind: "unavailable", desk: binding.desk, reason: summary?.reason ?? "desk not loaded" };
		}
		const conversation = findConversation(summary.record, summary.deskDir, channelId);
		if (!conversation) {
			return { kind: "unavailable", desk: binding.desk, reason: `no conversation registered for ${channelId}` };
		}
		return { kind: "bound", conversation };
	}

	/** The producer- and admission-side check of INV-5: is this channel bound to this (available) desk? */
	isBoundTo(channelId: string, desk: string): boolean {
		const resolution = this.resolve(channelId);
		return resolution.kind === "bound" && resolution.conversation.desk === desk;
	}

	/** The whole binding table, for `/desk list`. A copy: callers cannot change bindings through it. */
	bindingTable(): BindingsFile["bindings"] {
		return { ...this.bindings.bindings };
	}

	/** The desk a channel points at, available or not — for the channel index's desk column. */
	boundDesk(channelId: string): string | undefined {
		return this.bindings.bindings[channelId]?.desk;
	}

	activeDesks(): Array<{ desk: string; deskDir: string }> {
		return [...this.active].sort().map((desk) => ({ desk, deskDir: getDeskDir(this.options.workspaceDir, desk) }));
	}

	/** The memory scheduler's candidates (D12): every bound conversation of an active desk. */
	boundConversations(): DeskConversation[] {
		const conversations: DeskConversation[] = [];
		for (const channelId of Object.keys(this.bindings.bindings).sort()) {
			const resolution = this.resolve(channelId);
			if (resolution.kind === "bound" && this.active.has(resolution.conversation.desk)) {
				conversations.push(resolution.conversation);
			}
		}
		return conversations;
	}

	/** The channel a conversation directory of this desk belongs to (for `session_search` labels). */
	channelOfConversation(desk: string, conversation: string): string | undefined {
		const record = this.records.get(desk)?.record;
		if (!record) return undefined;
		return Object.entries(record.conversations).find(([, entry]) => entry.dir === conversation)?.[0];
	}

	private boundChannelsOf(desk: string): string[] {
		return Object.entries(this.bindings.bindings)
			.filter(([, binding]) => binding.desk === desk)
			.map(([channelId]) => channelId);
	}

	/** Startup: activate every desk that has at least one binding. */
	async activateBound(): Promise<void> {
		for (const desk of new Set(Object.values(this.bindings.bindings).map((binding) => binding.desk))) {
			await this.activate(desk);
		}
	}

	/**
	 * D6 activation: repair the desk's bound conversations, then mark it active (the task driver and
	 * memory scheduler read the active set on every pass) and start its watcher once services run.
	 */
	activate(desk: string): Promise<void> {
		return this.lifecycle.run(desk, async () => {
			if (this.active.has(desk)) return;
			const summary = await this.refreshRecord(desk);
			if (!summary.record) return;
			const conversations = this.boundChannelsOf(desk).flatMap((channelId) => {
				const resolution = this.resolve(channelId);
				return resolution.kind === "bound" ? [resolution.conversation] : [];
			});
			try {
				await this.options.recover(conversations);
			} catch (error) {
				log.logWarn("desk.activate.recover_failed", "Interrupted-turn repair failed during activation", {
					reason: errorMessage(error),
					fields: { desk },
				});
			}
			this.active.add(desk);
			if (this.servicesStarted) this.startWatcher(desk);
			log.logInfoEvent("desk.activated", "Desk activated", { fields: { desk, channels: conversations.length } });
		});
	}

	/** D6 dormancy: stop the watcher and leave the background scans. Running runs and jobs are untouched. */
	deactivate(desk: string): Promise<void> {
		return this.lifecycle.run(desk, async () => {
			if (!this.active.has(desk)) return;
			await this.stopWatcher(desk);
			this.active.delete(desk);
			log.logInfoEvent("desk.deactivated", "Desk went dormant: no bound channel", { fields: { desk } });
		});
	}

	private startWatcher(desk: string): void {
		if (this.watchers.has(desk)) return;
		const watcher = this.options.createWatcher({ desk, deskDir: getDeskDir(this.options.workspaceDir, desk) });
		this.watchers.set(desk, watcher);
		watcher.start();
	}

	private async stopWatcher(desk: string): Promise<void> {
		const watcher = this.watchers.get(desk);
		if (!watcher) return;
		this.watchers.delete(desk);
		watcher.stop();
		await watcher.flush?.().catch(() => undefined);
	}

	/** `/desk new`: an empty desk, bound to nothing and therefore dormant (D5). */
	create(name: string): Promise<CreateDeskOutcome> {
		return Promise.resolve(createDeskRecord(this.options.workspaceDir, normalizeDeskName(name), new Date()));
	}

	/** `/desk bind` from `channelId`, in D5's order. Throws only when the bindings write itself fails. */
	bind(channelId: string, name: string): Promise<BindOutcome> {
		return this.bindingWrites.run("bindings", () => this.bindNow(channelId, normalizeDeskName(name)));
	}

	/**
	 * Human ingress only: bind a channel that has no binding yet to `desk` (the sender's default).
	 * Background work and reads must never manufacture a binding.
	 */
	async ensureDefaultBinding(channelId: string, desk: string): Promise<void> {
		if (this.bindings.bindings[channelId]) return;
		await this.bindingWrites.run("bindings", async () => {
			// Another first message or an explicit bind may have committed while this one waited.
			if (this.bindings.bindings[channelId]) return;
			await this.bindNow(channelId, desk);
		});
	}

	private async bindNow(channelId: string, desk: string): Promise<BindOutcome> {
		const kind = this.options.conversationKindOf(channelId);
		if (!kind) throw new Error(`Not a channel id: ${channelId}`);
		// 1. Validate. A desk that went missing or broken since startup is caught here, not later.
		if (!isDeskName(desk)) return { kind: "invalid", desk };
		const summary = await readDeskRecord(this.options.workspaceDir, desk);
		if (summary.availability === "missing") return { kind: "unknown", desk };
		if (!summary.record) return { kind: "unavailable", desk };
		if (this.options.isChannelBusy(channelId)) return { kind: "busy", desk };
		const previous = this.bindings.bindings[channelId]?.desk;
		if (previous === desk) return { kind: "same", desk };
		this.records.set(desk, summary);

		// 2–3. Give the channel its conversation in the target, then commit the binding. Until the
		// write succeeds nothing has changed for the channel and nothing in the target has started.
		const now = new Date();
		await allocateConversation(this.options.workspaceDir, desk, channelId, kind, now);
		await this.refreshRecord(desk);
		const next: BindingsFile = {
			...this.bindings,
			bindings: { ...this.bindings.bindings, [channelId]: { desk, boundAt: now.toISOString() } },
		};
		await writeBindings(this.options.workspaceDir, next);
		this.bindings = next;
		log.logInfoEvent("desk.bound", "Channel bound to desk", { channelId, fields: { desk, previousDesk: previous } });
		this.options.onBindingChanged?.(channelId);

		// 4. Only now may the target produce work: its watcher's startup scan recovers overdue
		// one-shots for this channel, which it would skip as `channel_not_bound` before the commit.
		// The channel queue holds this channel's next message until `/desk bind` returns, so the
		// activation's repair still runs before any turn opens the conversation. A failure here
		// cannot undo the committed binding; the next restart activates the desk again.
		try {
			await this.activate(desk);
		} catch (error) {
			log.logWarn("desk.bind.activate_failed", "Activating the desk after a bind failed", {
				channelId,
				reason: errorMessage(error),
				fields: { desk },
			});
		}

		// 5. The old runner goes; a failure here cannot undo the committed binding.
		try {
			await this.options.releaseRunner(channelId);
		} catch (error) {
			log.logWarn("desk.bind.release_failed", "Releasing the previous runner after a bind failed", {
				channelId,
				reason: errorMessage(error),
				fields: { desk, previousDesk: previous },
			});
		}

		// 6. The old desk: dormant if it lost its last channel, otherwise report what is now suspended.
		if (!previous) return { kind: "bound", desk };
		if (this.boundChannelsOf(previous).length === 0) {
			await this.deactivate(previous);
			return { kind: "bound", desk, previousDesk: previous, previousDeskDormant: true };
		}
		const suspended = await countDeliveringTo(getDeskDir(this.options.workspaceDir, previous), channelId);
		return {
			kind: "bound",
			desk,
			previousDesk: previous,
			suspendedTasks: suspended.tasks,
			suspendedEvents: suspended.events,
		};
	}

	/** Start the event watchers of every active desk; later activations start theirs directly. */
	startServices(): void {
		this.servicesStarted = true;
		for (const desk of this.active) this.startWatcher(desk);
	}

	/**
	 * D7's guard for every background notice that bypasses durable dispatch (run notices, stop and
	 * skip receipts, exhausted-dispatch notices): sent only while `channelId` is bound to `desk`.
	 */
	async sendFromDesk(desk: string, channelId: string, text: string): Promise<boolean> {
		if (!this.isBoundTo(channelId, desk)) {
			log.logInfoEvent("desk.notice.dropped", "Background notice dropped: channel not bound to its desk", {
				channelId,
				fields: { desk },
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

/**
 * Open tasks and events in a desk whose delivery channel is `channelId` — what a rebind away from
 * the desk suspends (D8). Read-only, and best effort: an unreadable file is simply not counted.
 */
async function countDeliveringTo(deskDir: string, channelId: string): Promise<{ tasks: number; events: number }> {
	let tasks = 0;
	try {
		tasks = (await readActiveTasks(join(deskDir, "tasks"))).filter(
			(entry) => entry.fields.channel === channelId,
		).length;
	} catch {
		// No readable tasks directory: nothing suspended there.
	}
	let events = 0;
	const eventsDir = join(deskDir, "events");
	let filenames: string[] = [];
	try {
		filenames = (await readdir(eventsDir)).filter((filename) => filename.endsWith(".json"));
	} catch {
		// No events directory.
	}
	for (const filename of filenames) {
		try {
			const event = parseScheduledEventContent(await readFile(join(eventsDir, filename), "utf8"), filename);
			if (event.channelId === channelId) events++;
		} catch {
			// An invalid definition never fires anyway.
		}
	}
	return { tasks, events };
}
