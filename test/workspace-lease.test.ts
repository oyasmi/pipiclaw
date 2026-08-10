import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	acquireWorkspaceLease,
	findWorkspaceLeaseHolder,
	formatWorkspaceLeaseConflict,
	releaseWorkspaceLease,
} from "../src/subagents/workspace-lease.js";
import { useTempDirs } from "./helpers/fixtures.js";

/** Spec 040, D10.1: a process-wide, exclusive *write* lease keyed on the working directory's
 *  realpath. Only `mutates: write` runs take one; conflict is a prefix relationship either way. */

const createTempDir = useTempDirs("pipiclaw-workspace-lease-");

describe("workspace lease (spec 040, D10.1)", () => {
	it("a second write run competing for the same directory is rejected, naming the holder", () => {
		const dir = createTempDir();
		const first = acquireWorkspaceLease({ runId: "run-1", channelId: "dm_1", workingDirectory: dir });
		expect(first.ok).toBe(true);

		const second = acquireWorkspaceLease({ runId: "run-2", channelId: "dm_1", workingDirectory: dir });
		expect(second.ok).toBe(false);
		if (!second.ok) {
			expect(second.heldBy.runId).toBe("run-1");
			const message = formatWorkspaceLeaseConflict(second.heldBy);
			expect(message).toContain("run-1");
			expect(message).toContain(dir);
			expect(message).toContain("git worktree add");
		}

		releaseWorkspaceLease(first.ok ? first.leaseKey : undefined, "run-1");
	});

	it("a parent/child directory pair conflicts — they are the same resource, not two", () => {
		const parent = createTempDir();
		const child = join(parent, "pkg");
		mkdirSync(child, { recursive: true });

		const outer = acquireWorkspaceLease({ runId: "run-parent", channelId: "dm_1", workingDirectory: parent });
		expect(outer.ok).toBe(true);

		const inner = acquireWorkspaceLease({ runId: "run-child", channelId: "dm_1", workingDirectory: child });
		expect(inner.ok).toBe(false);

		releaseWorkspaceLease(outer.ok ? outer.leaseKey : undefined, "run-parent");

		// And the reverse direction: child held first, parent conflicts too.
		const innerFirst = acquireWorkspaceLease({ runId: "run-child-2", channelId: "dm_1", workingDirectory: child });
		expect(innerFirst.ok).toBe(true);
		const outerSecond = acquireWorkspaceLease({ runId: "run-parent-2", channelId: "dm_1", workingDirectory: parent });
		expect(outerSecond.ok).toBe(false);

		releaseWorkspaceLease(innerFirst.ok ? innerFirst.leaseKey : undefined, "run-child-2");
	});

	it("release frees the directory for the next writer", () => {
		const dir = createTempDir();
		const first = acquireWorkspaceLease({ runId: "run-1", channelId: "dm_1", workingDirectory: dir });
		expect(first.ok).toBe(true);
		releaseWorkspaceLease(first.ok ? first.leaseKey : undefined, "run-1");

		const second = acquireWorkspaceLease({ runId: "run-2", channelId: "dm_1", workingDirectory: dir });
		expect(second.ok).toBe(true);
		releaseWorkspaceLease(second.ok ? second.leaseKey : undefined, "run-2");
	});

	it("resolves symlinked working directories to the same realpath, so a symlink cannot dodge a conflict", () => {
		const dir = createTempDir();
		const resolved = realpathSync(dir);
		const first = acquireWorkspaceLease({ runId: "run-1", channelId: "dm_1", workingDirectory: dir });
		expect(first.ok).toBe(true);
		if (first.ok) expect(first.leaseKey).toBe(resolved);
		releaseWorkspaceLease(first.ok ? first.leaseKey : undefined, "run-1");
	});

	it("findWorkspaceLeaseHolder is read-only: it never itself takes a lease", () => {
		const dir = createTempDir();
		expect(findWorkspaceLeaseHolder(dir)).toBeUndefined();

		const held = acquireWorkspaceLease({ runId: "run-1", channelId: "dm_1", workingDirectory: dir });
		expect(held.ok).toBe(true);
		expect(findWorkspaceLeaseHolder(dir)?.runId).toBe("run-1");
		// A read run can still be admitted freely — this check does not itself register anything.
		expect(findWorkspaceLeaseHolder(dir)?.runId).toBe("run-1");

		releaseWorkspaceLease(held.ok ? held.leaseKey : undefined, "run-1");
		expect(findWorkspaceLeaseHolder(dir)).toBeUndefined();
	});

	// Spec 042, D5: a blind `leases.delete(key)` let a caller release someone else's lease — e.g. a
	// restart whose lease-rebuild failed (or, before this fix, any stale/duplicate release call)
	// could delete a *different* run's lease for the same key. `releaseWorkspaceLease` must verify
	// the caller is the current holder before deleting anything.
	it("release is a no-op when the caller does not currently hold the lease", () => {
		const dir = createTempDir();
		const holder = acquireWorkspaceLease({ runId: "real-holder", channelId: "dm_1", workingDirectory: dir });
		expect(holder.ok).toBe(true);

		// A caller that never actually held this lease (wrong runId, or a stale/duplicate release)
		// must not be able to delete the real holder's lease.
		releaseWorkspaceLease(holder.ok ? holder.leaseKey : undefined, "not-the-holder");
		expect(findWorkspaceLeaseHolder(dir)?.runId).toBe("real-holder");

		// The real holder can still release it.
		releaseWorkspaceLease(holder.ok ? holder.leaseKey : undefined, "real-holder");
		expect(findWorkspaceLeaseHolder(dir)).toBeUndefined();
	});
});
