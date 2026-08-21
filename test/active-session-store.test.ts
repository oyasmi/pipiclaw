import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	type ActiveSessionRefV1,
	commitActiveSessionRef,
	createFreshActiveSession,
	getActiveSessionRefPath,
	resolveActiveSessionFile,
} from "../src/runtime/active-session-store.js";
import { useTempDirs } from "./helpers/fixtures.js";

const makeTempDir = useTempDirs("pipiclaw-active-session-");

function readRef(channelDir: string): ActiveSessionRefV1 {
	return JSON.parse(readFileSync(getActiveSessionRefPath(channelDir), "utf-8"));
}

describe("resolveActiveSessionFile", () => {
	it("migrates a channel with no ref to context.jsonl and materializes it", () => {
		const channelDir = makeTempDir();

		const file = resolveActiveSessionFile(channelDir);

		expect(file).toBe("context.jsonl");
		expect(existsSync(join(channelDir, "context.jsonl"))).toBe(true);
		expect(statSync(join(channelDir, "context.jsonl")).size).toBe(0);
		// Migration is interpretive, not eager: no ref file is written just from resolving.
		expect(existsSync(getActiveSessionRefPath(channelDir))).toBe(false);
	});

	it("does not truncate an existing session file", () => {
		const channelDir = makeTempDir();
		writeFileSync(join(channelDir, "context.jsonl"), '{"type":"session"}\n');

		resolveActiveSessionFile(channelDir);

		expect(readFileSync(join(channelDir, "context.jsonl"), "utf-8")).toBe('{"type":"session"}\n');
	});

	it("honors a committed ref instead of the context.jsonl default", () => {
		const channelDir = makeTempDir();
		writeFileSync(
			getActiveSessionRefPath(channelDir),
			JSON.stringify({
				version: 1,
				file: "20260101_abc.jsonl",
				sessionId: "abc",
				updatedAt: new Date().toISOString(),
			}),
		);

		const file = resolveActiveSessionFile(channelDir);

		expect(file).toBe("20260101_abc.jsonl");
		expect(existsSync(join(channelDir, "20260101_abc.jsonl"))).toBe(true);
	});

	it("falls back to context.jsonl for a malformed ref instead of throwing", () => {
		const channelDir = makeTempDir();
		writeFileSync(getActiveSessionRefPath(channelDir), "not json");

		expect(resolveActiveSessionFile(channelDir)).toBe("context.jsonl");
	});

	it.each([
		["absolute path", "/etc/passwd.jsonl"],
		["parent traversal", "../outside.jsonl"],
		["nested separator", "sub/dir.jsonl"],
		["wrong extension", "context.txt"],
	])("rejects a ref with %s and falls back to context.jsonl", (_label, file) => {
		const channelDir = makeTempDir();
		writeFileSync(
			getActiveSessionRefPath(channelDir),
			JSON.stringify({ version: 1, file, sessionId: "x", updatedAt: new Date().toISOString() }),
		);

		expect(resolveActiveSessionFile(channelDir)).toBe("context.jsonl");
	});
});

describe("commitActiveSessionRef", () => {
	it("creates a header-backed fresh session before switching the active ref", async () => {
		const channelDir = makeTempDir();

		const result = await createFreshActiveSession(channelDir, channelDir);

		const ref = readRef(channelDir);
		expect(ref.sessionId).toBe(result.sessionId);
		const sessionFile = join(channelDir, ref.file);
		expect(existsSync(sessionFile)).toBe(true);
		const header = JSON.parse(readFileSync(sessionFile, "utf-8").split("\n")[0] as string);
		expect(header).toMatchObject({ type: "session", id: result.sessionId });
	});

	it("writes a ref pointing at the session's own file, atomically", async () => {
		const channelDir = makeTempDir();
		const manager = SessionManager.open(join(channelDir, "next.jsonl"), channelDir);

		await commitActiveSessionRef(channelDir, manager);

		const ref = readRef(channelDir);
		expect(ref).toMatchObject({ version: 1, file: "next.jsonl", sessionId: manager.getSessionId() });
		expect(typeof ref.updatedAt).toBe("string");
	});

	it("rejects a session file outside the channel directory and writes nothing", async () => {
		const channelDir = makeTempDir();
		const outsideDir = makeTempDir();
		const manager = SessionManager.open(join(outsideDir, "other.jsonl"), outsideDir);

		await expect(commitActiveSessionRef(channelDir, manager)).rejects.toThrow(/channel directory/);
		expect(existsSync(getActiveSessionRefPath(channelDir))).toBe(false);
	});

	it("rejects a session with no backing file", async () => {
		const channelDir = makeTempDir();
		const handle = { getSessionFile: () => undefined, getSessionId: () => "x" };

		await expect(commitActiveSessionRef(channelDir, handle)).rejects.toThrow(/no backing file/);
	});

	it("round-trips through resolveActiveSessionFile after commit", async () => {
		const channelDir = makeTempDir();
		const manager = SessionManager.open(join(channelDir, "next.jsonl"), channelDir);
		await commitActiveSessionRef(channelDir, manager);

		expect(resolveActiveSessionFile(channelDir)).toBe("next.jsonl");
	});
});

describe("F4: durable header materialization unblocks synchronous first-message persistence", () => {
	it("lets a freshly materialized session's first user message be read back by another process's SessionManager", () => {
		const channelDir = makeTempDir();
		mkdirSync(channelDir, { recursive: true });

		const file = resolveActiveSessionFile(channelDir);
		const manager = SessionManager.open(join(channelDir, file), channelDir);
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() } as never);

		// Simulate a crash right after the user message: open a fresh SessionManager over the same
		// file, as a new process would on restart, without any explicit flush/close call.
		const reopened = SessionManager.open(join(channelDir, file), channelDir);
		const branch = reopened.getBranch();
		const userEntry = branch.find((entry) => entry.type === "message" && entry.message.role === "user");

		expect(userEntry).toBeDefined();
	});
});
