import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startExternalProgressTail } from "../src/subagents/external/progress-tail.js";
import { useTempDirs } from "./helpers/fixtures.js";

// Pacing is the subject here. Keep real file contents and mtimes, but resolve the fs port
// in the microtask queue so advancing a fake timer also finishes its read. The old fixture
// waited 50 real milliseconds after every clock advance and still depended on host I/O load.
vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs/promises")>()),
	readFile: async (path: string, encoding: BufferEncoding) => readFileSync(path, encoding),
	stat: async (path: string) => statSync(path),
}));

const realSetImmediate = globalThis.setImmediate;
async function advance(ms: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
	// Give Node one real turn to publish any unhandled rejection from a discarded tick.
	await new Promise<void>((resolve) => realSetImmediate(resolve));
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

		expect(labels).toHaveLength(6);
		expect(labels).toEqual(["step 0", "step 1", "step 2", "step 3", "step 4", "step 5"]);
		writeFileSync(eventsPath, `${codexLine("step 10")}\n`);
		await advance(200_000);
		expect(labels).toHaveLength(6);
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

	it("a throwing onProgress callback never surfaces as an unhandled rejection", async () => {
		const artifactDir = tempDir();
		const eventsPath = join(artifactDir, "events.jsonl");
		writeFileSync(eventsPath, `${codexLine("npm run build")}\n`);
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown): void => {
			rejections.push(reason);
		};
		process.on("unhandledRejection", onRejection);
		let explode = true;
		const seen: string[] = [];
		try {
			const tail = startExternalProgressTail({
				artifactDir,
				harnessId: "codex-cli",
				startedAt: Date.now(),
				onProgress: (label) => {
					if (explode) throw new Error("boom");
					seen.push(label);
				},
			});
			await advance(60_000); // cross the first-notice delay so a tick actually calls onProgress
			await advance(1);
			expect(rejections).toEqual([]);
			expect(seen).toEqual([]); // the throwing tick delivered nothing

			// The poller is not wedged: a later tick with a new label still fires.
			explode = false;
			writeFileSync(eventsPath, `${codexLine("npm run build")}\n${codexLine("npm test")}\n`);
			await advance(200_000); // past the min-notice gap
			expect(seen).toEqual(["npm test"]);
			expect(rejections).toEqual([]);
			tail.stop();
		} finally {
			process.off("unhandledRejection", onRejection);
		}
	});

	// A process can be alive and silent for its whole wall-time budget (an hour by default) with
	// nothing telling anyone it is stuck; one warning per stall, re-armed once output resumes.
	it("warns once per stall, including for exec, and re-arms once output resumes", async () => {
		const artifactDir = tempDir();
		const stderrPath = join(artifactDir, "stderr.log");
		writeFileSync(stderrPath, "starting\n");
		const stalls: number[] = [];
		const progress = vi.fn();
		const tail = startExternalProgressTail({
			artifactDir,
			harnessId: "exec",
			startedAt: Date.now(),
			onProgress: progress,
			onStall: (silentMs) => stalls.push(silentMs),
		});

		await advance(9 * 60_000);
		expect(stalls).toEqual([]);
		await advance(2 * 60_000);
		expect(stalls).toHaveLength(1);
		expect(stalls[0]).toBeGreaterThanOrEqual(10 * 60_000);
		await advance(20 * 60_000);
		expect(stalls).toHaveLength(1); // the same stall is reported once

		// Output resumes (the file's mtime moves to the faked "now"), then stops again.
		writeFileSync(stderrPath, "starting\nprogress\n");
		utimesSync(stderrPath, new Date(Date.now()), new Date(Date.now()));
		await advance(30_000);
		expect(stalls).toHaveLength(1);
		await advance(11 * 60_000);
		expect(stalls).toHaveLength(2);
		expect(progress).not.toHaveBeenCalled();
		tail.stop();
	});

	it("tolerates a missing artifact file without inventing progress", async () => {
		const progress = vi.fn();
		const tail = startExternalProgressTail({
			artifactDir: join(tempDir(), "never-created"),
			harnessId: "codex-cli",
			startedAt: Date.now(),
			onProgress: progress,
		});
		await advance(600_000);
		expect(progress).not.toHaveBeenCalled();
		tail.stop();
	});
});
