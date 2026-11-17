import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RecoverableToolError } from "../src/shared/recoverable-error.js";
import {
	acquireWorkspaceLease,
	assertPathWritableUnderLease,
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
		const first = acquireWorkspaceLease({ runId: "run-1", channelId: "dingtalk:dm:1", workingDirectory: dir });
		expect(first.ok).toBe(true);

		const second = acquireWorkspaceLease({ runId: "run-2", channelId: "dingtalk:dm:1", workingDirectory: dir });
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

		const outer = acquireWorkspaceLease({
			runId: "run-parent",
			channelId: "dingtalk:dm:1",
			workingDirectory: parent,
		});
		expect(outer.ok).toBe(true);

		const inner = acquireWorkspaceLease({ runId: "run-child", channelId: "dingtalk:dm:1", workingDirectory: child });
		expect(inner.ok).toBe(false);

		releaseWorkspaceLease(outer.ok ? outer.leaseKey : undefined, "run-parent");

		// And the reverse direction: child held first, parent conflicts too.
		const innerFirst = acquireWorkspaceLease({
			runId: "run-child-2",
			channelId: "dingtalk:dm:1",
			workingDirectory: child,
		});
		expect(innerFirst.ok).toBe(true);
		const outerSecond = acquireWorkspaceLease({
			runId: "run-parent-2",
			channelId: "dingtalk:dm:1",
			workingDirectory: parent,
		});
		expect(outerSecond.ok).toBe(false);

		releaseWorkspaceLease(innerFirst.ok ? innerFirst.leaseKey : undefined, "run-child-2");
	});

	it("resolves symlinked working directories to the same realpath, so a symlink cannot dodge a conflict", () => {
		const dir = createTempDir();
		const linkParent = createTempDir();
		const link = join(linkParent, "alias-checkout");
		symlinkSync(dir, link);
		const resolved = realpathSync(dir);
		const first = acquireWorkspaceLease({ runId: "run-1", channelId: "dingtalk:dm:1", workingDirectory: dir });
		expect(first.ok).toBe(true);
		if (first.ok) expect(first.leaseKey).toBe(resolved);
		// Even a not-yet-created nested file addressed through a symlink must conflict with the active lease,
		// while the owning worker itself (`excludeRunId`) and isolated `.git/pipiclaw-worktrees/` paths do not.
		expect(() => assertPathWritableUnderLease(join(link, "new-dir", "new-file.ts"))).toThrow(RecoverableToolError);
		expect(() =>
			assertPathWritableUnderLease(join(link, "new-dir", "new-file.ts"), { excludeRunId: "run-1" }),
		).not.toThrow();
		expect(() =>
			assertPathWritableUnderLease(join(dir, ".git", "pipiclaw-worktrees", "run-2", "file.ts")),
		).not.toThrow();
		expect(() => assertPathWritableUnderLease(join(dir, "tasks", "t1.md"), { deskDir: dir })).not.toThrow();
		releaseWorkspaceLease(first.ok ? first.leaseKey : undefined, "run-1");
	});

	it("findWorkspaceLeaseHolder is read-only, and shared read (verify) leases coexist while blocking writers", () => {
		const dir = createTempDir();
		expect(findWorkspaceLeaseHolder(dir)).toBeUndefined();

		const held = acquireWorkspaceLease({ runId: "run-1", channelId: "dingtalk:dm:1", workingDirectory: dir });
		expect(held.ok).toBe(true);
		expect(findWorkspaceLeaseHolder(dir)?.runId).toBe("run-1");
		const verifyWhileWriting = acquireWorkspaceLease({
			runId: "verify-blocked",
			channelId: "dingtalk:dm:1",
			workingDirectory: dir,
			mode: "read",
		});
		expect(verifyWhileWriting.ok).toBe(false);

		releaseWorkspaceLease(held.ok ? held.leaseKey : undefined, "run-1");
		expect(findWorkspaceLeaseHolder(dir)).toBeUndefined();

		// Two verify read leases coexist on the same checkout, while any writer is blocked until both release.
		const verify1 = acquireWorkspaceLease({
			runId: "verify-1",
			channelId: "dingtalk:dm:1",
			workingDirectory: dir,
			mode: "read",
		});
		const verify2 = acquireWorkspaceLease({
			runId: "verify-2",
			channelId: "dingtalk:dm:2",
			workingDirectory: dir,
			mode: "read",
		});
		expect(verify1.ok).toBe(true);
		expect(verify2.ok).toBe(true);
		// Pre-flight check ignores read holders so parallel verifiers are admitted.
		expect(findWorkspaceLeaseHolder(dir)).toBeUndefined();

		const writerWhileVerifying = acquireWorkspaceLease({
			runId: "writer-blocked",
			channelId: "dingtalk:dm:1",
			workingDirectory: dir,
		});
		expect(writerWhileVerifying.ok).toBe(false);
		if (!writerWhileVerifying.ok) {
			expect(formatWorkspaceLeaseConflict(writerWhileVerifying.heldBy)).toContain("read lease");
		}
		// Main/task write/edit check also rejects writes into a checkout held by a verification read lease.
		expect(() => assertPathWritableUnderLease(join(dir, "src", "app.ts"))).toThrow(
			/verification delegation verify-1/,
		);

		releaseWorkspaceLease(verify1.ok ? verify1.leaseKey : undefined, "verify-1");
		expect(
			acquireWorkspaceLease({ runId: "still-blocked", channelId: "dingtalk:dm:1", workingDirectory: dir }).ok,
		).toBe(false);
		releaseWorkspaceLease(verify2.ok ? verify2.leaseKey : undefined, "verify-2");

		const writerAfterVerify = acquireWorkspaceLease({
			runId: "writer-ok",
			channelId: "dingtalk:dm:1",
			workingDirectory: dir,
		});
		expect(writerAfterVerify.ok).toBe(true);
		releaseWorkspaceLease(writerAfterVerify.ok ? writerAfterVerify.leaseKey : undefined, "writer-ok");
	});

	// Spec 042, D5: a blind `leases.delete(key)` let a caller release someone else's lease — e.g. a
	// restart whose lease-rebuild failed (or, before this fix, any stale/duplicate release call)
	// could delete a *different* run's lease for the same key. `releaseWorkspaceLease` must verify
	// the caller is the current holder before deleting anything.
	it("release is a no-op when the caller does not currently hold the lease", () => {
		const dir = createTempDir();
		const holder = acquireWorkspaceLease({ runId: "real-holder", channelId: "dingtalk:dm:1", workingDirectory: dir });
		expect(holder.ok).toBe(true);

		// A caller that never actually held this lease (wrong runId, or a stale/duplicate release)
		// must not be able to delete the real holder's lease.
		releaseWorkspaceLease(holder.ok ? holder.leaseKey : undefined, "not-the-holder");
		expect(findWorkspaceLeaseHolder(dir)?.runId).toBe("real-holder");

		// The real holder can still release it, which frees the directory for the next writer.
		releaseWorkspaceLease(holder.ok ? holder.leaseKey : undefined, "real-holder");
		expect(findWorkspaceLeaseHolder(dir)).toBeUndefined();
		const next = acquireWorkspaceLease({ runId: "next-writer", channelId: "dingtalk:dm:1", workingDirectory: dir });
		expect(next.ok).toBe(true);
		releaseWorkspaceLease(next.ok ? next.leaseKey : undefined, "next-writer");
	});
});
