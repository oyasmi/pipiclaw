import { parseLocalTime } from "../shared/local-time.js";
import { parseTaskItems, type TaskItem } from "./ledger.js";
import { readTaskLog, type TaskDispatchRecord, type TaskSettleRecord } from "./log.js";

/**
 * The team board (spec 052, D5): what the leader's delegations and jobs are doing right now.
 *
 * It is derived from the loop log, never from the run registry — settled runs are garbage
 * collected after a week, while a project can outlive that (INV-5). Every row is one `ref`
 * (a run or job id) with its latest state; rows are grouped under the Work Item they were
 * dispatched for. The board carries status and output *paths*, never output bodies: the leader
 * reads what it needs, and the fixed cost of a step stays small.
 */
export interface BoardRef {
	ref: string;
	item?: string;
	agent?: string;
	purpose?: "work" | "verify";
	dispatchedAtMs: number;
	settled?: TaskSettleRecord;
	/** Settled since the previous step ended — i.e. what this step was (probably) woken for. */
	isNew: boolean;
}

export interface TaskBoard {
	items: Array<{ item: TaskItem; refs: BoardRef[] }>;
	/** Dispatches that named no Work Item (or one that no longer exists). */
	unlinked: BoardRef[];
	/** Settled, already-seen refs left out to respect the line budget. */
	hiddenSettled: number;
}

/** Ref lines the board renders before folding old, already-seen results away. */
export const BOARD_REF_LINE_BUDGET = 12;

export async function buildTaskBoard(channelDir: string, taskId: string, body: string): Promise<TaskBoard | undefined> {
	const records = await readTaskLog(channelDir, taskId, { kinds: ["dispatch", "settle", "step"] });
	const dispatches = new Map<string, TaskDispatchRecord>();
	const settles = new Map<string, { record: TaskSettleRecord; index: number }>();
	let lastStepIndex = -1;
	records.forEach((record, index) => {
		if (record.kind === "dispatch") dispatches.set(record.ref, record);
		else if (record.kind === "settle") settles.set(record.ref, { record, index });
		else if (record.kind === "step") lastStepIndex = index;
	});

	const refs: BoardRef[] = [];
	for (const [ref, dispatch] of dispatches) {
		const settle = settles.get(ref);
		refs.push({
			ref,
			item: dispatch.item,
			agent: dispatch.agent,
			purpose: dispatch.purpose,
			dispatchedAtMs: parseLocalTime(dispatch.ts) ?? 0,
			settled: settle?.record,
			isNew: settle !== undefined && settle.index > lastStepIndex,
		});
	}
	// A settle with no dispatch record (a run bound before this version) still belongs on the board.
	for (const [ref, settle] of settles) {
		if (dispatches.has(ref)) continue;
		refs.push({
			ref,
			item: settle.record.item,
			dispatchedAtMs: parseLocalTime(settle.record.ts) ?? 0,
			settled: settle.record,
			isNew: settle.index > lastStepIndex,
		});
	}
	if (refs.length === 0) return undefined;

	// Fold: running and new results always show; then the newest settled ones, up to the budget.
	const mandatory = new Set(refs.filter((entry) => !entry.settled || entry.isNew).map((entry) => entry.ref));
	const room = Math.max(0, BOARD_REF_LINE_BUDGET - mandatory.size);
	const optional = refs
		.filter((entry) => !mandatory.has(entry.ref))
		.sort((a, b) => b.dispatchedAtMs - a.dispatchedAtMs)
		.slice(0, room);
	const shown = new Set([...mandatory, ...optional.map((entry) => entry.ref)]);
	const visible = refs.filter((entry) => shown.has(entry.ref)).sort((a, b) => a.dispatchedAtMs - b.dispatchedAtMs);

	const parsed = parseTaskItems(body)?.items ?? [];
	const known = new Set(parsed.map((item) => item.id.toUpperCase()));
	return {
		items: parsed.map((item) => ({
			item,
			refs: visible.filter((entry) => entry.item?.toUpperCase() === item.id.toUpperCase()),
		})),
		unlinked: visible.filter((entry) => !entry.item || !known.has(entry.item.toUpperCase())),
		hiddenSettled: refs.length - visible.length,
	};
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 90) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 90) return `${minutes}m`;
	return `${Math.round(minutes / 60)}h`;
}

function renderRef(entry: BoardRef, nowMs: number): string {
	const who = [entry.agent, entry.purpose === "verify" ? "verify" : undefined].filter(Boolean).join(", ");
	const label = `${entry.ref}${who ? ` ${who}` : ""}`;
	if (!entry.settled) return `${label} running ${formatDuration(nowMs - entry.dispatchedAtMs)}`;
	const settle = entry.settled;
	const parts = [settle.status];
	if (settle.verdict) parts.push(`VERDICT ${settle.verdict.toUpperCase()}`);
	if (settle.exitCode !== undefined) parts.push(`exit ${settle.exitCode}`);
	if (settle.durationMs !== undefined) parts.push(formatDuration(settle.durationMs));
	const tail = [entry.isNew ? "★新" : undefined, settle.output ? `output: ${settle.output}` : undefined]
		.filter(Boolean)
		.join(" · ");
	return `${label} ${parts.join(" ")}${tail ? ` ${tail}` : ""}`;
}

const ITEM_MARKER: Record<TaskItem["status"], string> = { todo: " ", done: "x", blocked: "!", dropped: "~" };

/** Render the `<task_board>` block body. */
export function renderTaskBoard(board: TaskBoard, nowMs: number = Date.now()): string {
	const lines: string[] = [];
	for (const { item, refs } of board.items) {
		const head = `- [${ITEM_MARKER[item.status]}] ${item.id} ${item.text}`;
		if (refs.length === 0) {
			lines.push(head);
			continue;
		}
		lines.push(`${head} — ${renderRef(refs[0] as BoardRef, nowMs)}`);
		for (const extra of refs.slice(1)) lines.push(`    ↳ ${renderRef(extra, nowMs)}`);
	}
	for (const entry of board.unlinked) lines.push(`- （未关联工作项）${renderRef(entry, nowMs)}`);
	if (board.hiddenSettled > 0) lines.push(`- （另有 ${board.hiddenSettled} 项已结算且已看过，见 task_log）`);
	return lines.join("\n");
}
