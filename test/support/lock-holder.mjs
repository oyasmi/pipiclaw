// A separate process holding a lock through the real `src/shared/file-lock.ts` (loaded with
// Node's type stripping): cross-process exclusion is only proven by a second process.
//   node --experimental-strip-types lock-holder.mjs <lockPath> [--pause-in-reclaim]
// Prints `held <pid>` once it holds the lock, releases it on a `release` line from stdin and then
// exits; exits without releasing when killed (the stale-lock case). With `--pause-in-reclaim` it
// stops inside its reclaim guard, just before unlinking the stale lock, prints `in-guard` and
// waits for a `resume` line — a reclaimer descheduled at the worst moment.
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createInterface } from "node:readline";

const lockPath = process.argv[2];
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
async function waitForLine(expected) {
	for (;;) {
		const { value, done } = await lines.next();
		if (done) process.exit(1);
		if (value.trim() === expected) return;
	}
}

if (process.argv[3] === "--pause-in-reclaim") {
	const unlink = fs.unlink;
	let paused = false;
	fs.unlink = async (path) => {
		if (path === lockPath && !paused) {
			paused = true;
			process.stdout.write("in-guard\n");
			await waitForLine("resume");
		}
		return unlink(path);
	};
	syncBuiltinESMExports();
}

const { acquireFileLock } = await import(new URL("../../src/shared/file-lock.ts", import.meta.url).href);
const result = await acquireFileLock(lockPath);
if (result.kind !== "acquired") {
	process.stdout.write(`busy ${result.heldBy?.pid ?? "?"}\n`);
	process.exit(2);
}
process.stdout.write(`held ${process.pid}\n`);
await waitForLine("release");
await result.handle.release();
process.stdout.write("released\n");
process.exit(0);
