import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startExternalProgressTail } from "../src/subagents/external/progress-tail.js";
import { useTempDirs } from "./helpers/fixtures.js";

/**
 * P1a: polling/pacing contract for `startExternalProgressTail` — the first-notice delay, the
 * minimum gap between notices, and label-unchanged suppression. `codex-cli-harness.test.ts` and
 * `claude-code-harness.test.ts` cover the label mapping itself; this file only exercises the
 * poller wrapped around it.
 *
 * The tail does real `fs/promises` reads on every tick, which resolve through Node's actual I/O
 * poll phase — a phase fake timers do not drive. `vi.advanceTimersByTimeAsync` alone can return
 * before that real read (and the tick's continuation) has actually completed, so every advance
 * here is followed by `flushIO()`, which yields through the real event loop long enough for
 * already-pending real I/O to finish and its promise continuation to run.
 */

const realSetImmediate = globalThis.setImmediate;
const realSetTimeout = globalThis.setTimeout;

/** A handful of real event-loop turns plus one short real timer, so a real (if tiny) fs read has
 *  room to complete even under a loaded CI box — a fixed pair of `setImmediate` hops was not
 *  reliably enough under full-suite parallel load. */
async function flushIO(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await new Promise<void>((resolve) => realSetImmediate(resolve));
	}
	await new Promise<void>((resolve) => realSetTimeout(resolve, 50));
	for (let i = 0; i < 5; i++) {
		await new Promise<void>((resolve) => realSetImmediate(resolve));
	}
}

async function advance(ms: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
	await flushIO();
}

const tempDir = useTempDirs("pipiclaw-progress-tail-");

function codexLine(command: string): string {
	return JSON.stringify({ type: "item.started", item: { id: "x", type: "command_execution", command } });
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("startExternalProgressTail", () => {
	it("waits out the first-notice delay, then reports a changed label at most once per gap", async () => {
		const artifactDir = tempDir();
		const eventsPath = join(artifactDir, "events.jsonl");
		writeFileSync(eventsPath, `${codexLine("npm run build")}\n`);

		const startedAt = Date.now();
		const labels: string[] = [];
		const tail = startExternalProgressTail({
			artifactDir,
			harnessId: "codex-cli",
			startedAt,
			onProgress: (label) => labels.push(label),
		});

		// Still inside the "don't bother for a short run" window.
		await advance(30_000);
		expect(labels).toEqual([]);

		// Crosses the window; the next poll picks up the current label.
		await advance(30_000);
		expect(labels).toEqual(["npm run build"]);

		// A new label inside the minimum-gap window is not reported yet.
		writeFileSync(eventsPath, `${codexLine("npm run build")}\n${codexLine("npm test")}\n`);
		await advance(60_000);
		expect(labels).toEqual(["npm run build"]);

		// Once the gap has elapsed, the new label is picked up.
		await advance(150_000);
		expect(labels).toEqual(["npm run build", "npm test"]);

		tail.stop();
	});

	it("caps at MAX_NOTICES even across a long run with constantly changing labels", async () => {
		const artifactDir = tempDir();
		const eventsPath = join(artifactDir, "events.jsonl");
		const startedAt = Date.now();
		const labels: string[] = [];
		const tail = startExternalProgressTail({
			artifactDir,
			harnessId: "codex-cli",
			startedAt,
			onProgress: (label) => labels.push(label),
		});

		for (let step = 0; step < 10; step++) {
			writeFileSync(eventsPath, `${codexLine(`step ${step}`)}\n`);
			await advance(200_000); // Past both the first-notice delay and the gap, every iteration.
		}

		expect(labels.length).toBeLessThanOrEqual(6);
		tail.stop();
	});

	it("stop() halts further notices", async () => {
		const artifactDir = tempDir();
		writeFileSync(join(artifactDir, "events.jsonl"), `${codexLine("npm run build")}\n`);
		const labels: string[] = [];
		const tail = startExternalProgressTail({
			artifactDir,
			harnessId: "codex-cli",
			startedAt: Date.now(),
			onProgress: (label) => labels.push(label),
		});

		tail.stop();
		await advance(600_000);
		expect(labels).toEqual([]);
	});

	it("is a safe no-op for a harness with no progress labeling (exec)", () => {
		const tail = startExternalProgressTail({
			artifactDir: tempDir(),
			harnessId: "exec",
			startedAt: Date.now(),
			onProgress: () => {
				throw new Error("must never fire for exec");
			},
		});
		expect(() => tail.stop()).not.toThrow();
	});

	it("tolerates a missing artifact file instead of throwing", async () => {
		const tail = startExternalProgressTail({
			artifactDir: join(tempDir(), "never-created"),
			harnessId: "codex-cli",
			startedAt: Date.now(),
			onProgress: () => {
				throw new Error("must never fire");
			},
		});
		await advance(600_000);
		tail.stop();
	});
});
