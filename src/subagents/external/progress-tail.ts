import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { sampleProcessGroupCpuMs } from "../../shared/host-process.js";
import type { RunHarness } from "../run-record.js";
import { getExternalHarness } from "./registry.js";

/**
 * P1a: turns an external run's `events.jsonl` — already being written incrementally by the child
 * process — into a trickle of human-readable "what is it doing right now" notices, instead of the
 * silence that today lasts the whole run. Polls rather than watches: correctness never depends on
 * catching every write, so a missed tick just costs one extra poll interval of staleness, and one
 * timer per run stays far simpler than a filesystem watcher per run.
 *
 * A fixed tail bounds the cost of a progress lookup. On prolonged silence we check whether the
 * process group is still using CPU before reporting a stall. Only the wall-time budget ends it.
 */

const POLL_MS = 15_000;
/** A run that finishes inside this window never gets a progress notice — the settled notice
 *  (P0-1) already covers it, and a 45s-or-shorter run does not need a running commentary. */
const FIRST_NOTICE_DELAY_MS = 45_000;
/** Floor between two progress notices for the same run, so a chatty harness cannot turn this into
 *  a stream of messages. */
const MIN_NOTICE_GAP_MS = 180_000;
/** Ceiling on notices for a single run — even a multi-hour run stops narrating after this many. */
const MAX_NOTICES = 6;
/** No output to either artifact file for this long reads as "possibly stuck". */
export const STALL_THRESHOLD_MS = 10 * 60_000;
/** A run that keeps stalling and recovering stops being reported after this many stall notices. */
const MAX_STALL_NOTICES = 3;
const PROGRESS_TAIL_BYTES = 65_536;
const CPU_ACTIVE_DELTA_MS = 50;
const CPU_RECHECK_INTERVAL_MS = 120_000;

const OUTPUT_FILENAMES = ["events.jsonl", "stderr.log"] as const;

/**
 * The pacing rules above, shared by the external tail and an internal run that has gone async
 * (its worker reports steps in-process, so it has labels but no file to poll).
 */
export interface ProgressPacer {
	/** Whether a label offered now could be reported — lets a caller skip the work of finding one. */
	ready(now?: number): boolean;
	/** Report `label` if pacing allows and it differs from the last one reported. */
	offer(label: string, now?: number): void;
}

export function createProgressPacer(startedAt: number, emit: (label: string) => void): ProgressPacer {
	let lastLabel: string | undefined;
	let lastNoticeAt = 0;
	let noticeCount = 0;
	const ready = (now = Date.now()): boolean =>
		noticeCount < MAX_NOTICES &&
		now - startedAt >= FIRST_NOTICE_DELAY_MS &&
		(!lastNoticeAt || now - lastNoticeAt >= MIN_NOTICE_GAP_MS);
	return {
		ready,
		offer(label, now = Date.now()) {
			if (!label || label === lastLabel || !ready(now)) return;
			lastLabel = label;
			lastNoticeAt = now;
			noticeCount++;
			emit(label);
		},
	};
}

/** When the run last wrote anything to its output files, or `undefined` if neither exists yet. */
export async function readLastOutputAt(artifactDir: string): Promise<number | undefined> {
	const times = await Promise.all(
		OUTPUT_FILENAMES.map((name) =>
			stat(join(artifactDir, name)).then(
				(info) => (info.size > 0 ? info.mtimeMs : undefined),
				() => undefined,
			),
		),
	);
	const known = times.filter((time): time is number => time !== undefined);
	return known.length > 0 ? Math.max(...known) : undefined;
}

export interface ExternalProgressTailInput {
	artifactDir: string;
	harnessId: RunHarness;
	/** Process start time, so the "don't bother for a short run" window is measured from when the
	 *  run actually started producing output, not from registration. */
	startedAt: number;
	pid?: number;
	sampleCpuMs?: (pgid: number) => Promise<number | undefined>;
	onActivityState?: (active: boolean) => void;
	onProgress: (label: string) => void;
	/** Called once per stall (re-armed when output resumes) with how long the run has been silent. */
	onStall?: (silentMs: number) => void;
}

export interface ExternalProgressTail {
	stop(): void;
	isStalled(): boolean;
}

async function readProgressTail(eventsPath: string): Promise<string> {
	const file = await open(eventsPath, "r");
	try {
		const { size } = await file.stat();
		const offset = Math.max(0, size - PROGRESS_TAIL_BYTES);
		const buffer = Buffer.alloc(size - offset);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
		const tail = buffer.subarray(0, bytesRead);
		const newline = offset > 0 ? tail.indexOf(10) : -1;
		if (offset > 0 && newline === -1) return "";
		return tail.toString("utf8", newline + 1);
	} finally {
		await file.close();
	}
}

/** Starts polling; returns a handle whose `stop()` is idempotent and always safe to call. */
export function startExternalProgressTail(input: ExternalProgressTailInput): ExternalProgressTail {
	const harness = getExternalHarness(input.harnessId);
	// exec has no structured protocol to read mid-run, so it gets stall detection only.
	const toProgressLabel = harness?.toProgressLabel;
	const eventsPath = join(input.artifactDir, "events.jsonl");
	const pacer = createProgressPacer(input.startedAt, input.onProgress);
	const sampleCpuMs = input.sampleCpuMs ?? sampleProcessGroupCpuMs;
	let lastTickAt = Date.now();
	let accumulatedSleepMs = 0;
	let sleepBaseOutputAt = input.startedAt;
	let pendingCpuMs: number | undefined;
	let cpuRecheckAt = 0;
	let cpuActive = false;
	let stopped = false;
	let ticking = false;
	/** Output time the current stall was reported against; a newer write re-arms detection. */
	let stalledSince: number | undefined;
	let stallCount = 0;

	const checkStall = async (now: number): Promise<void> => {
		if (!input.onStall && !input.onActivityState) return;
		const lastOutputAt = (await readLastOutputAt(input.artifactDir)) ?? input.startedAt;
		if (stopped) return;
		if (lastOutputAt > sleepBaseOutputAt) {
			sleepBaseOutputAt = lastOutputAt;
			accumulatedSleepMs = 0;
			stalledSince = undefined;
			pendingCpuMs = undefined;
			cpuRecheckAt = 0;
			if (cpuActive) {
				cpuActive = false;
				input.onActivityState?.(false);
			}
		}
		if (stalledSince !== undefined) return;
		const silentMs = Math.max(0, now - lastOutputAt - accumulatedSleepMs);
		if (silentMs < STALL_THRESHOLD_MS) return;

		if (input.pid !== undefined) {
			if (now < cpuRecheckAt) return;
			const cpuMs = await sampleCpuMs(input.pid).catch(() => undefined);
			if (stopped) return;
			const previous = pendingCpuMs;
			pendingCpuMs = undefined;
			if (cpuMs !== undefined && previous === undefined) {
				pendingCpuMs = cpuMs;
				return;
			}
			cpuActive = cpuMs !== undefined && previous !== undefined && cpuMs - previous >= CPU_ACTIVE_DELTA_MS;
			input.onActivityState?.(cpuActive);
			if (cpuActive) {
				cpuRecheckAt = now + CPU_RECHECK_INTERVAL_MS;
				return;
			}
		}
		stalledSince = lastOutputAt;
		if (stallCount < MAX_STALL_NOTICES) {
			stallCount++;
			input.onStall?.(silentMs);
		}
	};

	const checkProgress = async (now: number): Promise<void> => {
		if (!toProgressLabel || !pacer.ready(now)) return;
		let text: string;
		try {
			text = await readProgressTail(eventsPath);
		} catch {
			return; // Not written yet, or already cleaned up — try again next tick.
		}

		// Walk from the end: the most recent line that actually maps to a label wins, so a trailing
		// run of unlabeled lines (a text message, a torn final line) does not hide real progress.
		const lines = text.split("\n");
		let label: string | undefined;
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i]?.trim();
			if (!line) continue;
			try {
				label = toProgressLabel(line);
			} catch {
				label = undefined;
			}
			if (label) break;
		}
		if (!label || stopped) return;
		pacer.offer(label, now);
	};

	const tick = async (): Promise<void> => {
		if (stopped || ticking) return;
		ticking = true;
		const now = Date.now();
		const gap = now - lastTickAt;
		lastTickAt = now;
		if (gap > 3 * POLL_MS) {
			accumulatedSleepMs += gap - POLL_MS;
			pendingCpuMs = undefined;
		}
		try {
			await checkStall(now);
			if (!stopped) await checkProgress(now);
		} finally {
			ticking = false;
		}
	};

	// `tick` is async and its result is discarded: a rejection here (a throwing `onProgress`
	// callback, say) would otherwise surface as an unhandled rejection and reach the process-level
	// fatal handler. Swallow it — a failed tick just costs one skipped progress notice.
	const timer = setInterval(() => {
		tick().catch(() => undefined);
	}, POLL_MS);
	timer.unref?.();
	return {
		isStalled: () => stalledSince !== undefined,
		stop() {
			stopped = true;
			clearInterval(timer);
		},
	};
}
