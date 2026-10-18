// A separate process holding a lock through the real `src/shared/file-lock.ts` (loaded with
// Node's type stripping): cross-process exclusion is only proven by a second process.
//   node --experimental-strip-types lock-holder.mjs <lockPath>
// Prints `held <pid>` once it holds the lock, releases it on a `release` line from stdin and then
// exits; exits without releasing when killed (the stale-lock case).
import { createInterface } from "node:readline";

const lockPath = process.argv[2];
const { acquireFileLock } = await import(new URL("../../src/shared/file-lock.ts", import.meta.url).href);
const result = await acquireFileLock(lockPath);
if (result.kind !== "acquired") {
	process.stdout.write(`busy ${result.heldBy?.pid ?? "?"}\n`);
	process.exit(2);
}
process.stdout.write(`held ${process.pid}\n`);
const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
	if (line.trim() === "release") {
		await result.handle.release();
		process.stdout.write("released\n");
		process.exit(0);
	}
});
