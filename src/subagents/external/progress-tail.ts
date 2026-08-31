import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunHarness } from "../runs.js";
import { getExternalHarness } from "./registry.js";

/**
 * P1a: turns an external run's `events.jsonl` — already being written incrementally by the child
 * process — into a trickle of human-readable "what is it doing right now" notices, instead of the
 * silence that today lasts the whole run. Polls rather than watches: correctness never depends on
 * catching every write, so a missed tick just costs one extra poll interval of staleness, and one
 * timer per run stays far simpler than a filesystem watcher per run.
 *
 * Deliberately re-reads the whole file each tick instead of tracking a byte offset: an offset read
 * has to handle a half-written trailing line, this doesn't, and a run's artifact file is small
 * enough (single-digit MB even for a long run) that re-reading it every `POLL_MS` costs nothing a
 * background process needs to care about.
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

export interface ExternalProgressTailInput {
	artifactDir: string;
	harnessId: RunHarness;
	/** Process start time, so the "don't bother for a short run" window is measured from when the
	 *  run actually started producing output, not from registration. */
	startedAt: number;
	onProgress: (label: string) => void;
}

export interface ExternalProgressTail {
	stop(): void;
}

const NOOP_TAIL: ExternalProgressTail = { stop() {} };

/** Starts polling; returns a handle whose `stop()` is idempotent and always safe to call. */
export function startExternalProgressTail(input: ExternalProgressTailInput): ExternalProgressTail {
	const harness = getExternalHarness(input.harnessId);
	const toProgressLabel = harness?.toProgressLabel;
	if (!toProgressLabel) return NOOP_TAIL; // exec, or a harness that hasn't implemented this.

	const eventsPath = join(input.artifactDir, "events.jsonl");
	let lastLabel: string | undefined;
	let lastNoticeAt = 0;
	let noticeCount = 0;
	let stopped = false;

	const tick = async (): Promise<void> => {
		if (stopped || noticeCount >= MAX_NOTICES) return;
		const now = Date.now();
		if (now - input.startedAt < FIRST_NOTICE_DELAY_MS) return;
		if (lastNoticeAt && now - lastNoticeAt < MIN_NOTICE_GAP_MS) return;

		let text: string;
		try {
			text = await readFile(eventsPath, "utf-8");
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
		if (!label || label === lastLabel || stopped) return;
		lastLabel = label;
		lastNoticeAt = now;
		noticeCount++;
		input.onProgress(label);
	};

	// `tick` is async and its result is discarded: a rejection here (a throwing `onProgress`
	// callback, say) would otherwise surface as an unhandled rejection and reach the process-level
	// fatal handler. Swallow it — a failed tick just costs one skipped progress notice.
	const timer = setInterval(() => {
		tick().catch(() => undefined);
	}, POLL_MS);
	timer.unref?.();
	return {
		stop() {
			stopped = true;
			clearInterval(timer);
		},
	};
}
