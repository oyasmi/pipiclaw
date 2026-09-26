import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	commitProjectSelection,
	getProjectSelectionPath,
	readProjectSelection,
	resolveProjectScope,
} from "../src/channel/project-scope-store.js";
import { useTempDirs } from "./helpers/fixtures.js";

const makeTempDir = useTempDirs("pipiclaw-project-scope-store-");

function policyFor(root: string, configured = true) {
	return { policy: { defaultRoot: root, allowedRoots: [root] }, configured };
}

describe("resolveProjectScope", () => {
	it("materializes the app default as the channel's first selection when none exists", () => {
		const channelDir = makeTempDir();
		const defaultRoot = makeTempDir();

		const outcome = resolveProjectScope(channelDir, policyFor(defaultRoot));

		expect(outcome.kind).toBe("ready");
		if (outcome.kind !== "ready") throw new Error("unreachable");
		expect(outcome.scope.projectRoot).toBe(defaultRoot);
		expect(outcome.scope.boundary).toBe("project");
		expect(existsSync(getProjectSelectionPath(channelDir))).toBe(true);
		expect(JSON.parse(readFileSync(getProjectSelectionPath(channelDir), "utf-8"))).toMatchObject({
			projectRoot: defaultRoot,
			updatedBy: "migration",
		});
	});

	it("boundary is unbounded when the policy is unconfigured", () => {
		const channelDir = makeTempDir();
		const defaultRoot = makeTempDir();

		const outcome = resolveProjectScope(channelDir, policyFor(defaultRoot, false));

		expect(outcome.kind).toBe("ready");
		if (outcome.kind !== "ready") throw new Error("unreachable");
		expect(outcome.scope.boundary).toBe("unbounded");
	});

	it("honors an existing valid selection instead of re-migrating to the default", async () => {
		const channelDir = makeTempDir();
		const defaultRoot = makeTempDir();
		const chosenRoot = makeTempDir();
		await commitProjectSelection(channelDir, chosenRoot, "dingtalk-command");

		const outcome = resolveProjectScope(channelDir, {
			policy: { defaultRoot, allowedRoots: [defaultRoot, chosenRoot] },
			configured: true,
		});

		expect(outcome.kind).toBe("ready");
		if (outcome.kind !== "ready") throw new Error("unreachable");
		expect(outcome.scope.projectRoot).toBe(chosenRoot);
	});

	it("blocks (fail closed) when the persisted project directory no longer exists", async () => {
		const channelDir = makeTempDir();
		const goneRoot = join(makeTempDir(), "gone");
		await commitProjectSelection(channelDir, goneRoot, "dingtalk-command");

		const outcome = resolveProjectScope(channelDir, policyFor(goneRoot));

		expect(outcome.kind).toBe("blocked");
	});

	it("blocks when a symlinked project root has been re-pointed since selection", async () => {
		const channelDir = makeTempDir();
		const targetA = makeTempDir();
		const targetB = makeTempDir();
		const linkParent = makeTempDir();
		const link = join(linkParent, "current");
		symlinkSync(targetA, link, "dir");
		await commitProjectSelection(channelDir, link, "dingtalk-command");

		rmSync(link);
		symlinkSync(targetB, link, "dir");

		const outcome = resolveProjectScope(channelDir, policyFor(link));

		expect(outcome.kind).toBe("blocked");
	});

	// R7a: a corrupt selection file must never be treated the same as "never selected" — that
	// collapse used to make resolveProjectScope silently overwrite it with the app default,
	// moving a channel to a different project root the user never chose.
	it("blocks (never silently re-defaults) when the selection file exists but is not valid JSON", async () => {
		const channelDir = makeTempDir();
		const defaultRoot = makeTempDir();
		const chosenRoot = makeTempDir();
		await commitProjectSelection(channelDir, chosenRoot, "dingtalk-command");
		writeFileSync(getProjectSelectionPath(channelDir), "{not json");

		const outcome = resolveProjectScope(channelDir, policyFor(defaultRoot));

		expect(outcome.kind).toBe("blocked");
		// The corrupt file is left in place as evidence, not silently replaced.
		expect(readFileSync(getProjectSelectionPath(channelDir), "utf-8")).toBe("{not json");
	});

	it("blocks when the selection file is valid JSON but missing required fields", async () => {
		const channelDir = makeTempDir();
		const defaultRoot = makeTempDir();
		writeFileSync(getProjectSelectionPath(channelDir), JSON.stringify({ version: 1 }));

		const outcome = resolveProjectScope(channelDir, policyFor(defaultRoot));

		expect(outcome.kind).toBe("blocked");
	});

	it("readProjectSelection (display-only) still returns undefined for a corrupt file, distinct from blocking", () => {
		const channelDir = makeTempDir();
		writeFileSync(getProjectSelectionPath(channelDir), "{not json");
		expect(readProjectSelection(channelDir)).toBeUndefined();
	});

	it("blocks when the persisted root has fallen outside the configured allowed roots", async () => {
		const channelDir = makeTempDir();
		const chosenRoot = makeTempDir();
		await commitProjectSelection(channelDir, chosenRoot, "dingtalk-command");

		const otherAllowedRoot = makeTempDir();
		const outcome = resolveProjectScope(channelDir, {
			policy: { defaultRoot: otherAllowedRoot, allowedRoots: [otherAllowedRoot] },
			configured: true,
		});

		expect(outcome.kind).toBe("blocked");
	});
});
