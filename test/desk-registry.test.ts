import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { initializeBindings, loadBindings, writeBindings } from "../src/desk/bindings.js";
import { buildDeskList } from "../src/desk/commands.js";
import { initializeDefaultDesk } from "../src/desk/default.js";
import { getBindingsPath, getDeskDir, getDeskLockPath, isDeskName } from "../src/desk/paths.js";
import { allocateConversation, createDesk, listDesks } from "../src/desk/registry.js";
import { useTempDirs } from "./helpers/fixtures.js";
import { spawnLockHolder } from "./helpers/lock-holder.js";

const NOW = new Date("2026-10-20T02:00:00.000Z");

describe("desk registry", () => {
	const makeWorkspace = useTempDirs("pipiclaw-desk-registry-");

	it("accepts exactly the D3 name grammar", () => {
		// Failure caught: a name that is a path segment must never carry `/`, `..`, upper case or a
		// leading/trailing hyphen, and the 32-character ceiling is part of the contract.
		const cases: Array<[string, boolean]> = [
			["a", true],
			["news", true],
			["invest-2", true],
			["a".repeat(32), true],
			["a".repeat(33), false],
			["", false],
			["-news", false],
			["news-", false],
			["News", false],
			["../x", false],
			["a/b", false],
			["新闻", false],
		];
		for (const [name, valid] of cases) expect(isDeskName(name), name).toBe(valid);
	});

	it("refuses to create a desk that already exists", async () => {
		const workspace = makeWorkspace();
		expect((await createDesk(workspace, "news", NOW)).kind).toBe("created");
		// Failure caught: a second /desk new silently overwriting desk.json would orphan every conversation.
		expect(await createDesk(workspace, "news", NOW)).toEqual({ kind: "exists", name: "news" });
		const bindings = await loadBindings(workspace);
		bindings.bindings.dm_1 = { desk: "news", boundAt: NOW.toISOString() };
		await writeBindings(workspace, bindings);
		rmSync(getDeskDir(workspace, "news"), { recursive: true });
		expect(await createDesk(workspace, "news", NOW)).toEqual({ kind: "unavailable", name: "news" });
	});

	it("does not erase a first binding when another process finishes initialization late", async () => {
		// A second daemon/TUI can finish setup and accept a channel before this initializer
		// publishes its empty table. Sequential idempotency checks cannot catch that data loss.
		// Mutation check (spec 060): overwriting on an EEXIST publication race loses dm_1.
		const workspaceDir = makeWorkspace();
		const child = spawn(
			process.execPath,
			[
				"--experimental-strip-types",
				fileURLToPath(new URL("./helpers/desk-init-worker.mjs", import.meta.url)),
				workspaceDir,
			],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		const exited = once(child, "exit");
		try {
			await Promise.race([
				once(child.stdout, "data"),
				exited.then(() => {
					throw new Error(stderr);
				}),
			]);
			initializeDefaultDesk({ workspaceDir });
			await allocateConversation(workspaceDir, "default", "dm_1", "dm", NOW);
			const bindings = await loadBindings(workspaceDir);
			bindings.bindings.dm_1 = { desk: "default", boundAt: NOW.toISOString() };
			await writeBindings(workspaceDir, bindings);
			child.stdin.end("\n");
			expect((await exited)[0], stderr).toBe(0);
			expect(await loadBindings(workspaceDir)).toEqual(bindings);
			expect((await listDesks(workspaceDir)).map((entry) => entry.name)).toEqual(["default"]);
		} finally {
			if (child.exitCode === null) {
				child.kill("SIGKILL");
				await exited;
			}
		}
	});

	it("allocates one conversation per channel, numbered per kind, idempotently", async () => {
		const workspace = makeWorkspace();
		await createDesk(workspace, "desk-news", NOW);
		const dm = await allocateConversation(workspace, "desk-news", "dm_1", "dm", NOW);
		const group = await allocateConversation(workspace, "desk-news", "group_cid/a+b==", "group", NOW);
		const dm2 = await allocateConversation(workspace, "desk-news", "dm_2", "dm", NOW);
		const again = await allocateConversation(workspace, "desk-news", "group_cid/a+b==", "group", NOW);
		// Failure caught (INV-7): re-binding a channel must resume its conversation, not open a new one,
		// and the directory name never derives from the channel id.
		expect([dm.conversation, group.conversation, dm2.conversation]).toEqual(["dm-1", "group-1", "dm-2"]);
		expect(again).toEqual(group);
		expect(group.conversationDir).toBe(join(getDeskDir(workspace, "desk-news"), "conversations", "group-1"));

		// Working directory: the desk directory unless desk.json sets an absolute `cwd`; state stays put.
		expect(dm.cwd).toBe(dm.deskDir);
		expect(dm.deskDir).toBe(join(workspace, "desk-desk-news"));
		const recordPath = join(dm.deskDir, "desk.json");
		const record = JSON.parse(readFileSync(recordPath, "utf8"));
		writeFileSync(recordPath, JSON.stringify({ ...record, cwd: "/srv/work" }));
		const moved = await allocateConversation(workspace, "desk-news", "dm_1", "dm", NOW);
		expect([moved.cwd, moved.deskDir]).toEqual(["/srv/work", dm.deskDir]);
		// Failure caught: a relative cwd would resolve against the daemon's own directory.
		writeFileSync(recordPath, JSON.stringify({ ...record, cwd: "work" }));
		await expect(allocateConversation(workspace, "desk-news", "dm_1", "dm", NOW)).rejects.toThrow(/absolute/);
	});

	it("waits for another process holding desk-json.lock before allocating", async () => {
		const workspace = makeWorkspace();
		await createDesk(workspace, "news", NOW);
		const holder = await spawnLockHolder(getDeskLockPath(getDeskDir(workspace, "news"), "desk-json.lock"));
		let settled = false;
		const allocation = allocateConversation(workspace, "news", "dm_1", "dm", NOW).finally(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 150));
		// Failure caught: a TUI allocating tui-N and the daemon allocating group-N without the lock
		// would each rewrite desk.json from a stale read and drop the other's entry.
		expect(settled).toBe(false);
		await holder.release();
		expect((await allocation).conversation).toBe("dm-1");
	});

	it("initializes a fresh binding table and refuses lost or corrupt state", async () => {
		const workspace = makeWorkspace();
		expect(initializeBindings(workspace)).toEqual({ version: 1, bindings: {} });
		writeFileSync(getBindingsPath(workspace), "{ not json");
		// Failure caught (D4): reading a corrupt file as "nothing bound" would silently suspend every
		// channel's background work.
		await expect(loadBindings(workspace)).rejects.toThrow(/bindings\.json/);
		writeFileSync(getBindingsPath(workspace), JSON.stringify({ version: 2, bindings: {} }));
		await expect(loadBindings(workspace)).rejects.toThrow(/version/);
		rmSync(getBindingsPath(workspace));
		initializeBindings(workspace);
		await createDesk(workspace, "default", NOW);
		rmSync(getBindingsPath(workspace));
		expect(() => initializeBindings(workspace)).toThrow(/restore/);
		expect(() => initializeBindings(workspace)).toThrow(/missing/);
	});

	it("marks a desk whose desk.json names another directory as invalid, and lists a bound desk that is gone", async () => {
		const workspace = makeWorkspace();
		await createDesk(workspace, "news", NOW);
		mkdirSync(join(workspace, "skills"));
		mkdirSync(join(workspace, ".desk-init-unpublished"));
		const deskDir = join(workspace, "desk-copy");
		mkdirSync(deskDir, { recursive: true });
		writeFileSync(
			join(deskDir, "desk.json"),
			JSON.stringify({ version: 1, name: "news", createdAt: NOW.toISOString(), conversations: {} }),
		);
		mkdirSync(join(workspace, "desk-empty"));
		const desks = await listDesks(workspace);
		const byName = Object.fromEntries(desks.map((desk) => [desk.name, desk.availability]));
		// Failure caught: a copied directory answering to the original's name would let two desks share
		// one identity in bindings and logs.
		expect(byName).toEqual({ copy: "invalid", empty: "missing", news: "available" });

		// D4: a channel bound to a desk whose directory was moved away still finds its row in `/desk`.
		const rows = buildDeskList(desks, { dm_1: { desk: "gone", boundAt: NOW.toISOString() } }, "gone", (id) => id);
		expect(rows.find((row) => row.name === "gone")).toEqual({
			name: "gone",
			availability: "missing",
			current: true,
			channels: [{ channelId: "dm_1", label: "dm_1" }],
		});
	});
});
