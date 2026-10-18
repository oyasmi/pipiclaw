import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { assertNoLegacyLayout, StartupRefusal } from "../src/dot/legacy-layout.js";
import { getBindingsPath, getDotDir } from "../src/dot/paths.js";
import { createDot } from "../src/dot/registry.js";
import { DotRuntime } from "../src/runtime/dot-runtime.js";
import { createTaskDocument } from "../src/tasks/create.js";
import { bindTestChannel, useTempDirs } from "./helpers/fixtures.js";

const tempDir = useTempDirs("pipiclaw-dot-runtime-");

function runtimeFor(workspaceDir: string) {
	const watchers: Array<{
		dot: string;
		start: ReturnType<typeof vi.fn>;
		stop: ReturnType<typeof vi.fn>;
		/** The dot each channel was bound to when this watcher started (and ran its recovery scan). */
		bindingsAtStart?: Record<string, string>;
	}> = [];
	const recover = vi.fn(async () => {});
	const send = vi.fn(async () => true);
	const busy = new Set<string>();
	const releaseRunner = vi.fn(async (_channelId: string) => {});
	const onBindingChanged = vi.fn();
	const runtime = new DotRuntime({
		workspaceDir,
		recover,
		createWatcher: ({ dot }) => {
			const watcher: (typeof watchers)[number] = {
				dot,
				start: vi.fn(() => {
					watcher.bindingsAtStart = Object.fromEntries(
						Object.entries(runtime.bindingTable()).map(([channelId, binding]) => [channelId, binding.dot]),
					);
				}),
				stop: vi.fn(),
			};
			watchers.push(watcher);
			return watcher;
		},
		send,
		isChannelBusy: (channelId) => busy.has(channelId),
		releaseRunner,
		onBindingChanged,
	});
	return { runtime, watchers, recover, send, busy, releaseRunner, onBindingChanged };
}

describe("DotRuntime (spec 058, D6/D7)", () => {
	it("activates a bound dot — repair first, watcher with the services — and dormancy undoes it", async () => {
		// Failure caught: a dormant dot that keeps its watcher (background work nobody receives) or an
		// activated dot whose channels take traffic before their interrupted turns are repaired.
		const workspaceDir = tempDir();
		const conversation = await bindTestChannel(workspaceDir, "dm_1", "news");
		const { runtime, watchers, recover } = runtimeFor(workspaceDir);
		await runtime.load();
		await runtime.activateBound();

		expect(recover).toHaveBeenCalledWith([conversation]);
		expect(runtime.activeDots().map((target) => target.dot)).toEqual(["news"]);
		expect(watchers).toHaveLength(0); // services not started yet
		runtime.startServices();
		expect(watchers.map((watcher) => watcher.dot)).toEqual(["news"]);
		expect(watchers[0]?.start).toHaveBeenCalledOnce();

		// Interleaved calls settle on the last one.
		await Promise.all([runtime.deactivate("news"), runtime.activate("news"), runtime.deactivate("news")]);
		expect(runtime.activeDots()).toEqual([]);
		expect(watchers.every((watcher) => watcher.stop.mock.calls.length === 1)).toBe(true);
	});

	it("sends a background notice only to a channel still bound to the notice's dot", async () => {
		// Failure caught (INV-5): a run, job or task of one dot reporting into a channel now bound to
		// another dot, or to none.
		const workspaceDir = tempDir();
		await bindTestChannel(workspaceDir, "dm_1", "news");
		const { runtime, send } = runtimeFor(workspaceDir);
		await runtime.load();

		await expect(runtime.sendFromDot("news", "dm_1", "done")).resolves.toBe(true);
		await expect(runtime.sendFromDot("other", "dm_1", "done")).resolves.toBe(false);
		await expect(runtime.sendFromDot("news", "dm_unbound", "done")).resolves.toBe(false);
		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith("dm_1", "done");
	});
});

describe("DotRuntime.bind (spec 058, D5)", () => {
	it("refuses without side effects, then rebinds: old runner released, old dot suspended or dormant", async () => {
		// Failure caught: a refused bind that still writes bindings or drops the runner; a release
		// failure that rolls back a committed binding; an old dot left active with no channel, or
		// its suspended work not reported; a target whose watcher starts (and skips this channel's
		// overdue one-shots as unbound) before the binding is committed.
		const workspaceDir = tempDir();
		await bindTestChannel(workspaceDir, "dm_1", "news");
		await bindTestChannel(workspaceDir, "dm_2", "news");
		await createDot(workspaceDir, "lab", new Date());
		const newsDir = getDotDir(workspaceDir, "news");
		await createTaskDocument({
			dotDir: newsDir,
			id: "weekly",
			input: { title: "Weekly", goal: "g", dod: "d" },
			channel: "dm_1",
		});
		mkdirSync(join(newsDir, "events"), { recursive: true });
		writeFileSync(
			join(newsDir, "events", "digest.json"),
			JSON.stringify({ type: "periodic", channelId: "dm_1", schedule: "0 9 * * *", text: "digest" }),
		);
		const { runtime, watchers, busy, releaseRunner, onBindingChanged } = runtimeFor(workspaceDir);
		await runtime.load();
		await runtime.activateBound();
		runtime.startServices();
		const bindingsBefore = readFileSync(getBindingsPath(workspaceDir), "utf8");

		busy.add("dm_1");
		await expect(runtime.bind("dm_1", "lab")).resolves.toMatchObject({ kind: "busy" });
		busy.clear();
		await expect(runtime.bind("dm_1", "news")).resolves.toMatchObject({ kind: "same" });
		await expect(runtime.bind("dm_1", "nope")).resolves.toMatchObject({ kind: "unknown" });
		await expect(runtime.bind("dm_1", "-bad-")).resolves.toMatchObject({ kind: "invalid" });
		expect(readFileSync(getBindingsPath(workspaceDir), "utf8")).toBe(bindingsBefore);
		expect(releaseRunner).not.toHaveBeenCalled();

		releaseRunner.mockRejectedValueOnce(new Error("dispose failed"));
		await expect(runtime.bind("dm_1", "lab")).resolves.toEqual({
			kind: "bound",
			dot: "lab",
			previousDot: "news",
			suspendedTasks: 1,
			suspendedEvents: 1,
		});
		expect(runtime.isBoundTo("dm_1", "lab")).toBe(true);
		expect(releaseRunner).toHaveBeenCalledWith("dm_1");
		expect(onBindingChanged).toHaveBeenCalledWith("dm_1");
		expect(runtime.activeDots().map((target) => target.dot)).toEqual(["lab", "news"]);
		expect(watchers.find((watcher) => watcher.dot === "lab")?.bindingsAtStart?.dm_1).toBe("lab");

		await expect(runtime.bind("dm_2", "lab")).resolves.toMatchObject({ previousDotDormant: true });
		expect(runtime.activeDots().map((target) => target.dot)).toEqual(["lab"]);
		// What is on disk is what the next process starts from.
		const restarted = runtimeFor(workspaceDir).runtime;
		await restarted.load();
		expect(restarted.isBoundTo("dm_1", "lab") && restarted.isBoundTo("dm_2", "lab")).toBe(true);
	});

	it("leaves the binding, the runner and the target's dormancy alone when the bindings write fails", async () => {
		// Failure caught: a bind that half-happens — the runner disposed or the target dot left
		// active while the channel still points at its old dot.
		const workspaceDir = tempDir();
		await bindTestChannel(workspaceDir, "dm_1", "news");
		await createDot(workspaceDir, "lab", new Date());
		const { runtime, releaseRunner } = runtimeFor(workspaceDir);
		await runtime.load();
		await runtime.activateBound();
		// A directory where the file should be: the atomic rename onto it fails.
		const bindingsPath = getBindingsPath(workspaceDir);
		rmSync(bindingsPath);
		mkdirSync(join(bindingsPath, "blocker"), { recursive: true });

		await expect(runtime.bind("dm_1", "lab")).rejects.toThrow();
		expect(runtime.isBoundTo("dm_1", "news")).toBe(true);
		expect(releaseRunner).not.toHaveBeenCalled();
		expect(runtime.activeDots().map((target) => target.dot)).toEqual(["news"]);
	});
});

describe("legacy layout refusal (spec 058, D21)", () => {
	it("refuses each pre-dot layout and an interrupted migration, and lets a fresh home start", () => {
		// Failure caught: a daemon starting on an un-migrated home would ignore every channel's memory
		// and tasks without a word.
		const cases: Array<[string, (home: string) => void]> = [
			["channel directory", (home) => mkdirSync(join(home, "workspace", "group_cid__x=="), { recursive: true })],
			[
				"workspace event",
				(home) => {
					mkdirSync(join(home, "workspace", "events"), { recursive: true });
					writeFileSync(join(home, "workspace", "events", "weekly.json"), "{}");
				},
			],
			[
				"interrupted migration",
				(home) => {
					mkdirSync(join(home, "state"), { recursive: true });
					writeFileSync(join(home, "state", "dots-migration.inprogress"), "");
				},
			],
		];
		for (const [label, seed] of cases) {
			const home = tempDir();
			seed(home);
			expect(() => assertNoLegacyLayout({ appHomeDir: home, workspaceDir: join(home, "workspace") }), label).toThrow(
				StartupRefusal,
			);
		}
		const fresh = tempDir();
		mkdirSync(join(fresh, "workspace", "dots"), { recursive: true });
		expect(() => assertNoLegacyLayout({ appHomeDir: fresh, workspaceDir: join(fresh, "workspace") })).not.toThrow();
	});
});
