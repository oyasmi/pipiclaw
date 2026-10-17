import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { assertNoLegacyLayout, StartupRefusal } from "../src/dot/legacy-layout.js";
import { DotRuntime } from "../src/runtime/dot-runtime.js";
import { bindTestChannel, useTempDirs } from "./helpers/fixtures.js";

const tempDir = useTempDirs("pipiclaw-dot-runtime-");

function runtimeFor(workspaceDir: string) {
	const watchers: Array<{ dot: string; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
	const recover = vi.fn(async () => {});
	const send = vi.fn(async () => true);
	const runtime = new DotRuntime({
		workspaceDir,
		recover,
		createWatcher: ({ dot }) => {
			const watcher = { dot, start: vi.fn(), stop: vi.fn() };
			watchers.push(watcher);
			return watcher;
		},
		send,
	});
	return { runtime, watchers, recover, send };
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
