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
import { type BindOutcome, buildDeskList, type DeskListItem, type DeskRuntimeActivity } from "../desk/commands.js";
import { DEFAULT_DESK, DESK_RECORD_FILENAME, getDeskDir, isDeskName, normalizeDeskName } from "../desk/paths.js";
import {
	allocateConversation,
	createDeskRecord,
	findConversation,
	listDesks,
	readDeskRecord,
	readDeskRecordSync,
	setDeskArchived,
	setDeskCwd,
	validateCustomCwd,
} from "../desk/registry.js";
import { StartupRefusal } from "../desk/startup-error.js";
import type {
	ArchiveDeskOutcome,
	BindingsFile,
	ConversationKind,
	CreateDeskOutcome,
	DeskConversation,
	DeskCwdOutcome,
	DeskSummary,
	UnarchiveDeskOutcome,
} from "../desk/types.js";
import { parseScheduledEventContent } from "../events/parse.js";
import * as log from "../log.js";
import { fileStamp } from "../shared/format.js";
import { createSerialQueue } from "../shared/serial-queue.js";
import { errorMessage } from "../shared/text-utils.js";
import { readActiveTasks } from "../tasks/contract.js";
import { readTaskDeliveries } from "../tasks/delivery.js";

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
	createWatcher: (target: { desk: string; deskDir: string; cwd: string }) => DeskWatcher;
	/** The transport's plain send, for background notices that pass the binding guard. */
	send: (channelId: string, text: string) => Promise<boolean>;
	/** Whether the channel has a turn in flight; `/desk bind` refuses then (D5 step 1). */
	isChannelBusy: (channelId: string) => boolean;
	/**
	 * Optional check for active execution in `desk` (e.g. a running task step or checkout lease on
	 * `currentCwd`); returns a short Chinese reason to refuse mutating `cwd` or archiving mid-flight.
	 */
	isDeskBusy?: (desk: string, currentCwd: string) => string | undefined;
	/** Human-readable channel label for `/desk` messages. */
	describeChannel?: (channelId: string) => string;
	/**
	 * Drop the channel's cached runner and dispose it — its final reflect lands in the desk it was
	 * bound to (D5 step 5). Called only after the new binding is on disk.
	 */
	releaseRunner: (channelId: string) => Promise<void>;
	/** A binding changed (the channel index rewrites its desk column). */
	onBindingChanged?: (channelId: string) => void;
	/** A desk was activated or gained a bound channel (wakes the task lane to drain held deliveries). */
	onActivated?: (desk: string) => void;
}

export class DeskRuntime {
	private bindings: BindingsFile = { version: 1, bindings: {} };
	/** Every desk a binding or scan has touched, kept fresh when `desk.json`'s stamp changes. */
	private readonly records = new Map<string, DeskSummary>();
	private readonly recordStamps = new Map<string, string>();
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
		if (summary.deskDir) this.recordStamps.set(desk, deskRecordStamp(summary.deskDir));
		if (summary.availability !== "available") {
			log.logWarn("desk.record.unavailable", "Bound desk is unavailable", {
				reason: summary.reason,
				fields: { desk },
			});
		}
		return summary;
	}

	private syncRecordIfChanged(desk: string): DeskSummary | undefined {
		if (!isDeskName(desk)) return this.records.get(desk);
		const deskDir = getDeskDir(this.options.workspaceDir, desk);
		const stamp = deskRecordStamp(deskDir);
		if (this.recordStamps.get(desk) === stamp && this.records.has(desk)) {
			return this.records.get(desk);
		}
		const prevCwd = this.records.get(desk)?.record?.cwd;
		const summary = readDeskRecordSync(this.options.workspaceDir, desk);
		this.records.set(desk, summary);
		this.recordStamps.set(desk, stamp);
		const nextCwd = summary.record?.cwd;
		if (prevCwd !== nextCwd && this.active.has(desk) && this.servicesStarted) {
			void this.stopWatcher(desk).then(() => {
				if (this.active.has(desk) && this.servicesStarted && !summary.record?.archivedAt) {
					this.startWatcher(desk);
				}
			});
		}
		return summary;
	}

	resolve(channelId: string): ChannelResolution {
		const binding = this.bindings.bindings[channelId];
		if (!binding) return { kind: "unbound" };
		const summary = this.syncRecordIfChanged(binding.desk);
		if (!summary?.record) {
			return { kind: "unavailable", desk: binding.desk, reason: summary?.reason ?? "desk not loaded" };
		}
		const conversation = findConversation(summary.record, summary.deskDir, channelId);
		if (!conversation) {
			return { kind: "unavailable", desk: binding.desk, reason: `no conversation registered for ${channelId}` };
		}
		return { kind: "bound", conversation };
	}

	/** Effective working directory of `desk`, independent of whether any channel is currently bound to it. */
	deskCwd(desk: string): string | undefined {
		const summary = this.syncRecordIfChanged(desk);
		return summary?.record ? (summary.record.cwd ?? summary.deskDir) : undefined;
	}

	/**
	 * Build the `DeskConversation` a task runner in `desk` needs for `channelId`, even after
	 * `channelId` has rebound to another desk (Direction 1.2: background task execution is decoupled
	 * from current chat binding; `desk.json` retains the registered conversation record).
	 */
	taskConversation(desk: string, channelId: string): DeskConversation | undefined {
		const summary = this.syncRecordIfChanged(desk);
		if (!summary?.record || summary.record.archivedAt) return undefined;
		return (
			findConversation(summary.record, summary.deskDir, channelId) ?? {
				desk,
				deskDir: summary.deskDir,
				cwd: summary.record.cwd ?? summary.deskDir,
				channelId,
				conversation: "task",
				conversationDir: join(summary.deskDir, "tasks", ".sessions"),
			}
		);
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

	/** Startup: activate every non-archived desk that has a binding or retained background work. */
	async activateBound(): Promise<void> {
		const candidates = new Set(Object.values(this.bindings.bindings).map((binding) => binding.desk));
		for (const summary of await listDesks(this.options.workspaceDir)) {
			this.records.set(summary.name, summary);
			if (summary.deskDir) this.recordStamps.set(summary.name, deskRecordStamp(summary.deskDir));
			if (
				summary.availability === "available" &&
				summary.record &&
				!summary.record.archivedAt &&
				!candidates.has(summary.name) &&
				(await hasRetainedBackgroundWork(summary.deskDir))
			) {
				candidates.add(summary.name);
			}
		}
		for (const desk of candidates) {
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
			if (!summary.record || summary.record.archivedAt) return;
			const conversations = this.boundChannelsOf(desk).flatMap((channelId) => {
				const resolution = this.resolve(channelId);
				return resolution.kind === "bound" ? [resolution.conversation] : [];
			});
			if (conversations.length > 0) {
				try {
					await this.options.recover(conversations);
				} catch (error) {
					log.logWarn("desk.activate.recover_failed", "Interrupted-turn repair failed during activation", {
						reason: errorMessage(error),
						fields: { desk },
					});
				}
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

	/** Put an unbound desk to sleep once its last runnable task and task-spawning event are gone. */
	reconcileActivity(desk: string): Promise<void> {
		if (!this.active.has(desk) || this.boundChannelsOf(desk).length > 0) return Promise.resolve();
		return this.lifecycle.run(desk, async () => {
			if (!this.active.has(desk) || this.boundChannelsOf(desk).length > 0) return;
			const summary = await this.refreshRecord(desk);
			if (!summary.record || summary.record.archivedAt || !(await hasRetainedBackgroundWork(summary.deskDir))) {
				await this.stopWatcher(desk);
				this.active.delete(desk);
				log.logInfoEvent("desk.deactivated", "Desk went dormant: background work finished", { fields: { desk } });
			}
		});
	}

	private startWatcher(desk: string): void {
		if (this.watchers.has(desk)) return;
		const deskDir = getDeskDir(this.options.workspaceDir, desk);
		const cwd = this.records.get(desk)?.record?.cwd ?? deskDir;
		const watcher = this.options.createWatcher({ desk, deskDir, cwd });
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
	create(name: string, cwd?: string): Promise<CreateDeskOutcome> {
		return Promise.resolve(createDeskRecord(this.options.workspaceDir, normalizeDeskName(name), new Date(), cwd));
	}

	/** `/desk list` rows enriched with live background task and pending-delivery counts. */
	async listDeskItems(askingChannelId: string, labelOf: (channelId: string) => string): Promise<DeskListItem[]> {
		const desks = await listDesks(this.options.workspaceDir);
		const activity = new Map<string, DeskRuntimeActivity>();
		await Promise.all(
			desks.map(async (summary) => {
				if (summary.availability !== "available" || !summary.record || summary.record.archivedAt) return;
				const activeTasks = (await readActiveTasks(join(summary.deskDir, "tasks")).catch(() => [])).filter(
					(entry) => !entry.fields.outcome && entry.fields.state !== "paused",
				).length;
				const pendingDeliveries = (await readTaskDeliveries(summary.deskDir).catch(() => [])).filter(
					(item) => !item.sentAt,
				).length;
				activity.set(summary.name, {
					activeTasks,
					pendingDeliveries,
					active: this.active.has(summary.name),
				});
			}),
		);
		return buildDeskList(desks, this.bindingTable(), this.boundDesk(askingChannelId), labelOf, activity);
	}

	/** `/desk cwd`: view or update the working directory of `channelId`'s bound desk. */
	async cwd(channelId: string, input: { cwd?: string; reset?: boolean }): Promise<DeskCwdOutcome> {
		const resolution = this.resolve(channelId);
		if (resolution.kind !== "bound") {
			return { kind: "unavailable", desk: resolvedDesk(resolution) ?? "" };
		}
		const { desk, deskDir } = resolution.conversation;
		const summary = await this.refreshRecord(desk);
		if (!summary.record) return { kind: "unavailable", desk };
		const currentEffective = summary.record.cwd ?? deskDir;
		if (!input.cwd && !input.reset) {
			return { kind: "ok", desk, cwd: currentEffective, isDefault: summary.record.cwd === undefined };
		}
		let targetEffective = deskDir;
		if (!input.reset) {
			const checked = validateCustomCwd(input.cwd ?? "");
			if (!checked.ok) return { kind: "invalid_cwd", cwd: input.cwd ?? "", reason: checked.reason };
			targetEffective = checked.cwd;
		}
		if (targetEffective === currentEffective) {
			return { kind: "ok", desk, cwd: currentEffective, isDefault: summary.record.cwd === undefined };
		}
		if (this.boundChannelsOf(desk).some((boundChannel) => this.options.isChannelBusy(boundChannel))) {
			return { kind: "busy", desk, reason: "有聊天回合正在运行" };
		}
		const busyReason = this.options.isDeskBusy?.(desk, currentEffective);
		if (busyReason) {
			return { kind: "busy", desk, reason: busyReason };
		}
		const outcome = await setDeskCwd(this.options.workspaceDir, desk, input.reset ? null : targetEffective);
		if (outcome.kind !== "ok") return outcome;
		await this.refreshRecord(desk);
		if (this.active.has(desk) && this.servicesStarted) {
			await this.stopWatcher(desk);
			this.startWatcher(desk);
		}
		for (const boundChannel of this.boundChannelsOf(desk)) {
			if (!this.options.isChannelBusy(boundChannel)) {
				await this.options.releaseRunner(boundChannel).catch(() => undefined);
			}
		}
		return outcome;
	}

	/** `/desk archive <name>`: retire an idle desk, unbinding stale terminal sessions and stopping events. */
	archive(askingChannelId: string | undefined, name: string): Promise<ArchiveDeskOutcome> {
		return this.bindingWrites.run("bindings", async () => {
			const desk = normalizeDeskName(name);
			if (!isDeskName(desk)) return { kind: "invalid", desk };
			if (desk === DEFAULT_DESK) return { kind: "default" };
			const summary = await readDeskRecord(this.options.workspaceDir, desk);
			if (summary.availability === "missing") return { kind: "unknown", desk };
			if (!summary.record) return { kind: "unavailable", desk };
			if (summary.record.archivedAt) return { kind: "already_archived", desk };

			const bound = this.boundChannelsOf(desk);
			if (askingChannelId && bound.includes(askingChannelId)) {
				return { kind: "current_channel", desk };
			}
			const nonTerminals = bound.filter((channelId) => this.options.conversationKindOf(channelId) !== "webapi");
			if (nonTerminals.length > 0) {
				return {
					kind: "bound_channels",
					desk,
					channels: nonTerminals.map((channelId) => this.options.describeChannel?.(channelId) ?? channelId),
				};
			}
			const terminals = bound.filter((channelId) => this.options.conversationKindOf(channelId) === "webapi");
			if (terminals.some((channelId) => this.options.isChannelBusy(channelId))) {
				return { kind: "busy", desk, reason: "有正在运行的终端回合" };
			}
			const busyReason = this.options.isDeskBusy?.(desk, summary.record.cwd ?? summary.deskDir);
			if (busyReason) return { kind: "busy", desk, reason: busyReason };

			const openTasks = (await readActiveTasks(join(summary.deskDir, "tasks")).catch(() => [])).filter(
				(entry) => !entry.fields.outcome,
			);
			if (openTasks.length > 0) {
				return { kind: "open_tasks", desk, count: openTasks.length, sampleId: openTasks[0]!.id };
			}

			if (terminals.length > 0) {
				const nextBindings = { ...this.bindings.bindings };
				for (const channelId of terminals) delete nextBindings[channelId];
				const next: BindingsFile = { ...this.bindings, bindings: nextBindings };
				await writeBindings(this.options.workspaceDir, next);
				this.bindings = next;
				for (const channelId of terminals) {
					log.logInfoEvent("desk.unbound", "Terminal channel unbound on desk archive", {
						channelId,
						fields: { desk },
					});
					this.options.onBindingChanged?.(channelId);
					await this.options.releaseRunner(channelId).catch(() => undefined);
				}
			}

			const stoppedEvents = await countScheduledEvents(summary.deskDir);
			await setDeskArchived(this.options.workspaceDir, desk, new Date().toISOString());
			await this.refreshRecord(desk);
			await this.deactivate(desk);
			log.logInfoEvent("desk.archived", "Desk archived", {
				fields: { desk, unboundTerminals: terminals.length, stoppedEvents },
			});
			return { kind: "archived", desk, unboundTerminals: terminals.length, stoppedEvents };
		});
	}

	/** `/desk unarchive <name>`: clear `archivedAt` and re-activate if work is waiting. */
	unarchive(name: string): Promise<UnarchiveDeskOutcome> {
		return this.bindingWrites.run("bindings", async () => {
			const desk = normalizeDeskName(name);
			if (!isDeskName(desk)) return { kind: "invalid", desk };
			const summary = await readDeskRecord(this.options.workspaceDir, desk);
			if (summary.availability === "missing") return { kind: "unknown", desk };
			if (!summary.record) return { kind: "unavailable", desk };
			if (!summary.record.archivedAt) return { kind: "not_archived", desk };

			await setDeskArchived(this.options.workspaceDir, desk, null);
			await this.refreshRecord(desk);
			if (this.boundChannelsOf(desk).length > 0 || (await hasRetainedBackgroundWork(summary.deskDir))) {
				await this.activate(desk);
				this.options.onActivated?.(desk);
			}
			log.logInfoEvent("desk.unarchived", "Desk unarchived", {
				fields: { desk, activated: this.active.has(desk) },
			});
			return { kind: "unarchived", desk, activated: this.active.has(desk) };
		});
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
			const outcome = await this.bindNow(channelId, desk);
			// The channel stays unbound and every message gets the no-desk reply. A sender's default
			// desk that does not exist is an operator's mistake (a Web API key's first desk): say so.
			if (outcome.kind !== "bound") {
				log.logWarn("desk.bind.default_failed", "Default desk binding failed", {
					channelId,
					reason: outcome.kind,
					fields: { desk },
				});
			}
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
		if (previous === desk && !summary.record.archivedAt) return { kind: "same", desk };
		let unarchived = false;
		if (summary.record.archivedAt) {
			await setDeskArchived(this.options.workspaceDir, desk, null);
			unarchived = true;
		}
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
			this.options.onActivated?.(desk);
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

		// 6. The old desk: stays active while it still has open tasks or task-spawning events; goes
		// dormant only when both bound channels and runnable background work are gone.
		if (!previous || previous === desk) {
			return { kind: "bound", desk, ...(unarchived ? { unarchived: true } : {}) };
		}
		const previousDir = getDeskDir(this.options.workspaceDir, previous);
		const departure = await inspectChannelDeparture(previousDir, channelId);
		if (this.boundChannelsOf(previous).length === 0 && !(await hasRetainedBackgroundWork(previousDir))) {
			await this.deactivate(previous);
			return {
				kind: "bound",
				desk,
				...(unarchived ? { unarchived: true } : {}),
				previousDesk: previous,
				previousDeskDormant: true,
			};
		}
		return {
			kind: "bound",
			desk,
			...(unarchived ? { unarchived: true } : {}),
			previousDesk: previous,
			...(departure.backgroundTasks > 0 ? { backgroundTasks: departure.backgroundTasks } : {}),
			...(departure.suspendedEvents > 0 ? { suspendedEvents: departure.suspendedEvents } : {}),
		};
	}

	/**
	 * The channel is gone for good (a Web API conversation was deleted): drop its binding, its
	 * runner, and — when it was the desk's last channel and no background work remains — the desk's
	 * activity. Its conversation directory stays in the desk as history. Whether there was a binding to drop.
	 */
	unbind(channelId: string): Promise<boolean> {
		return this.bindingWrites.run("bindings", async () => {
			const previous = this.bindings.bindings[channelId]?.desk;
			if (previous === undefined) return false;
			const { [channelId]: _dropped, ...rest } = this.bindings.bindings;
			const next: BindingsFile = { ...this.bindings, bindings: rest };
			await writeBindings(this.options.workspaceDir, next);
			this.bindings = next;
			log.logInfoEvent("desk.unbound", "Channel unbound from desk", { channelId, fields: { desk: previous } });
			this.options.onBindingChanged?.(channelId);
			try {
				await this.options.releaseRunner(channelId);
			} catch (error) {
				log.logWarn("desk.unbind.release_failed", "Releasing the runner of an unbound channel failed", {
					channelId,
					reason: errorMessage(error),
					fields: { desk: previous },
				});
			}
			if (
				this.boundChannelsOf(previous).length === 0 &&
				!(await hasRetainedBackgroundWork(getDeskDir(this.options.workspaceDir, previous)))
			) {
				await this.deactivate(previous);
			}
			return true;
		});
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

function deskRecordStamp(deskDir: string): string {
	return fileStamp(join(deskDir, DESK_RECORD_FILENAME)) ?? "missing";
}

/** Whether `deskDir` still owns work that can execute without any bound chat channel. */
async function hasRetainedBackgroundWork(deskDir: string): Promise<boolean> {
	try {
		const closing = await readdir(join(deskDir, "tasks", ".closing"));
		if (closing.some((name) => name.endsWith(".json"))) return true;
	} catch {
		// No `.closing` directory.
	}
	try {
		const open = await readActiveTasks(join(deskDir, "tasks"));
		if (open.some((entry) => !entry.fields.outcome && entry.fields.state !== "paused")) return true;
	} catch {
		// No readable tasks directory.
	}
	for (const event of await readValidScheduledEvents(deskDir)) {
		if (event.task) return true;
	}
	return false;
}

async function readValidScheduledEvents(deskDir: string) {
	const eventsDir = join(deskDir, "events");
	let filenames: string[] = [];
	try {
		filenames = (await readdir(eventsDir)).filter((filename) => filename.endsWith(".json"));
	} catch {
		return [];
	}
	const events: ReturnType<typeof parseScheduledEventContent>[] = [];
	for (const filename of filenames) {
		try {
			events.push(parseScheduledEventContent(await readFile(join(eventsDir, filename), "utf8"), filename));
		} catch {
			// An invalid definition never fires anyway.
		}
	}
	return events;
}

async function countScheduledEvents(deskDir: string): Promise<number> {
	return (await readValidScheduledEvents(deskDir)).length;
}

/**
 * Open tasks in `deskDir` that keep running in the background while `channelId` is away, plus
 * chat-wake events delivering to `channelId` that pause until `channelId` binds back.
 */
async function inspectChannelDeparture(
	deskDir: string,
	channelId: string,
): Promise<{ backgroundTasks: number; suspendedEvents: number }> {
	let backgroundTasks = 0;
	try {
		backgroundTasks = (await readActiveTasks(join(deskDir, "tasks"))).filter(
			(entry) => !entry.fields.outcome && entry.fields.state !== "paused" && entry.fields.channel === channelId,
		).length;
	} catch {
		// No readable tasks directory.
	}
	const events = await readValidScheduledEvents(deskDir);
	const suspendedEvents = events.filter((event) => event.channelId === channelId && !event.task).length;
	return { backgroundTasks, suspendedEvents };
}
