import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getBindingsPath, getDotDir, getDotLockPath, isDotName } from "../src/dot/paths.js";
import { allocateConversation, createDot, listDots, loadBindings } from "../src/dot/registry.js";
import { useTempDirs } from "./helpers/fixtures.js";
import { spawnLockHolder } from "./helpers/lock-holder.js";

const NOW = new Date("2026-10-20T02:00:00.000Z");

describe("dot registry", () => {
	const makeWorkspace = useTempDirs("pipiclaw-dot-registry-");

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
		for (const [name, valid] of cases) expect(isDotName(name), name).toBe(valid);
	});

	it("refuses to create a dot that already exists", async () => {
		const workspace = makeWorkspace();
		expect((await createDot(workspace, "news", NOW)).kind).toBe("created");
		// Failure caught: a second /dot new silently overwriting dot.json would orphan every conversation.
		expect(await createDot(workspace, "news", NOW)).toEqual({ kind: "exists", name: "news" });
	});

	it("allocates one conversation per channel, numbered per kind, idempotently", async () => {
		const workspace = makeWorkspace();
		await createDot(workspace, "news", NOW);
		const dm = await allocateConversation(workspace, "news", "dm_1", "dm", NOW);
		const group = await allocateConversation(workspace, "news", "group_cid/a+b==", "group", NOW);
		const dm2 = await allocateConversation(workspace, "news", "dm_2", "dm", NOW);
		const again = await allocateConversation(workspace, "news", "group_cid/a+b==", "group", NOW);
		// Failure caught (INV-7): re-binding a channel must resume its conversation, not open a new one,
		// and the directory name never derives from the channel id.
		expect([dm.conversation, group.conversation, dm2.conversation]).toEqual(["dm-1", "group-1", "dm-2"]);
		expect(again).toEqual(group);
		expect(group.conversationDir).toBe(join(getDotDir(workspace, "news"), "conversations", "group-1"));
	});

	it("waits for another process holding dot-json.lock before allocating", async () => {
		const workspace = makeWorkspace();
		await createDot(workspace, "news", NOW);
		const holder = await spawnLockHolder(getDotLockPath(getDotDir(workspace, "news"), "dot-json.lock"));
		let settled = false;
		const allocation = allocateConversation(workspace, "news", "dm_1", "dm", NOW).finally(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 150));
		// Failure caught: a TUI allocating tui-N and the daemon allocating group-N without the lock
		// would each rewrite dot.json from a stale read and drop the other's entry.
		expect(settled).toBe(false);
		await holder.release();
		expect((await allocation).conversation).toBe("dm-1");
	});

	it("treats a missing bindings file as empty and a corrupt one as fatal", async () => {
		const workspace = makeWorkspace();
		expect(await loadBindings(workspace)).toEqual({ version: 1, bindings: {} });
		mkdirSync(join(workspace, "dots"), { recursive: true });
		writeFileSync(getBindingsPath(workspace), "{ not json");
		// Failure caught (D4): reading a corrupt file as "nothing bound" would silently suspend every
		// channel's background work.
		await expect(loadBindings(workspace)).rejects.toThrow(/bindings\.json/);
		writeFileSync(getBindingsPath(workspace), JSON.stringify({ version: 2, bindings: {} }));
		await expect(loadBindings(workspace)).rejects.toThrow(/version/);
	});

	it("marks a dot whose dot.json names another directory as invalid", async () => {
		const workspace = makeWorkspace();
		await createDot(workspace, "news", NOW);
		const dotDir = join(workspace, "dots", "copy");
		mkdirSync(dotDir, { recursive: true });
		writeFileSync(
			join(dotDir, "dot.json"),
			JSON.stringify({ version: 1, name: "news", createdAt: NOW.toISOString(), conversations: {} }),
		);
		mkdirSync(join(workspace, "dots", "empty"));
		const byName = Object.fromEntries((await listDots(workspace)).map((dot) => [dot.name, dot.availability]));
		// Failure caught: a copied directory answering to the original's name would let two dots share
		// one identity in bindings and logs.
		expect(byName).toEqual({ copy: "invalid", empty: "missing", news: "available" });
	});
});
