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
} from "../src/channel/active-session-store.js";
import { useTempDirs } from "./helpers/fixtures.js";

const makeTempDir = useTempDirs("pipiclaw-active-session-");

function readRef(dotDir: string): ActiveSessionRefV1 {
	return JSON.parse(readFileSync(getActiveSessionRefPath(dotDir), "utf-8"));
}

describe("resolveActiveSessionFile", () => {
	it("migrates a channel with no ref to context.jsonl and materializes it", () => {
		const dotDir = makeTempDir();

		const file = resolveActiveSessionFile(dotDir);

		expect(file).toBe("context.jsonl");
		expect(existsSync(join(dotDir, "context.jsonl"))).toBe(true);
		expect(statSync(join(dotDir, "context.jsonl")).size).toBe(0);
		// Migration is interpretive, not eager: no ref file is written just from resolving.
		expect(existsSync(getActiveSessionRefPath(dotDir))).toBe(false);
	});

	it("does not truncate an existing session file", () => {
		const dotDir = makeTempDir();
		writeFileSync(join(dotDir, "context.jsonl"), '{"type":"session"}\n');

		resolveActiveSessionFile(dotDir);

		expect(readFileSync(join(dotDir, "context.jsonl"), "utf-8")).toBe('{"type":"session"}\n');
	});

	it("honors a committed ref instead of the context.jsonl default", () => {
		const dotDir = makeTempDir();
		writeFileSync(
			getActiveSessionRefPath(dotDir),
			JSON.stringify({
				version: 1,
				file: "20260101_abc.jsonl",
				sessionId: "abc",
				updatedAt: new Date().toISOString(),
			}),
		);

		const file = resolveActiveSessionFile(dotDir);

		expect(file).toBe("20260101_abc.jsonl");
		expect(existsSync(join(dotDir, "20260101_abc.jsonl"))).toBe(true);
	});

	it("falls back to context.jsonl for any unusable ref instead of throwing", () => {
		const updatedAt = new Date().toISOString();
		for (const ref of [
			// Malformed JSON...
			"not json",
			// ...and parseable refs whose file is unsafe: absolute path, parent traversal,
			// nested separator, or wrong extension.
			JSON.stringify({ version: 1, file: "/etc/passwd.jsonl", sessionId: "x", updatedAt }),
			JSON.stringify({ version: 1, file: "../outside.jsonl", sessionId: "x", updatedAt }),
			JSON.stringify({ version: 1, file: "sub/dir.jsonl", sessionId: "x", updatedAt }),
			JSON.stringify({ version: 1, file: "context.txt", sessionId: "x", updatedAt }),
		]) {
			const dotDir = makeTempDir();
			writeFileSync(getActiveSessionRefPath(dotDir), ref);
			expect(resolveActiveSessionFile(dotDir), ref).toBe("context.jsonl");
		}
	});
});

describe("commitActiveSessionRef", () => {
	it("creates a header-backed fresh session before switching the active ref", async () => {
		const dotDir = makeTempDir();

		const result = await createFreshActiveSession(dotDir, dotDir);

		const ref = readRef(dotDir);
		expect(ref.sessionId).toBe(result.sessionId);
		const sessionFile = join(dotDir, ref.file);
		expect(existsSync(sessionFile)).toBe(true);
		const header = JSON.parse(readFileSync(sessionFile, "utf-8").split("\n")[0] as string);
		expect(header).toMatchObject({ type: "session", id: result.sessionId });
	});

	it("writes a ref pointing at the session's own file, atomically", async () => {
		const dotDir = makeTempDir();
		const manager = SessionManager.open(join(dotDir, "next.jsonl"), dotDir);

		await commitActiveSessionRef(dotDir, manager);

		const ref = readRef(dotDir);
		expect(ref).toMatchObject({ version: 1, file: "next.jsonl", sessionId: manager.getSessionId() });
		expect(resolveActiveSessionFile(dotDir)).toBe("next.jsonl");
		expect(typeof ref.updatedAt).toBe("string");
	});

	it("rejects an unusable session (outside the channel dir or with no backing file) and writes nothing", async () => {
		const dotDir = makeTempDir();
		const outsideDir = makeTempDir();
		const manager = SessionManager.open(join(outsideDir, "other.jsonl"), outsideDir);

		await expect(commitActiveSessionRef(dotDir, manager)).rejects.toThrow(/channel directory/);

		const handle = { getSessionFile: () => undefined, getSessionId: () => "x" };
		await expect(commitActiveSessionRef(dotDir, handle)).rejects.toThrow(/no backing file/);

		expect(existsSync(getActiveSessionRefPath(dotDir))).toBe(false);
	});
});

describe("F4: durable header materialization unblocks synchronous first-message persistence", () => {
	it("lets a freshly materialized session's first user message be read back by another process's SessionManager", () => {
		const dotDir = makeTempDir();
		mkdirSync(dotDir, { recursive: true });

		const file = resolveActiveSessionFile(dotDir);
		const manager = SessionManager.open(join(dotDir, file), dotDir);
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() } as never);

		// Simulate a crash right after the user message: open a fresh SessionManager over the same
		// file, as a new process would on restart, without any explicit flush/close call.
		const reopened = SessionManager.open(join(dotDir, file), dotDir);
		const branch = reopened.getBranch();
		const userEntry = branch.find((entry) => entry.type === "message" && entry.message.role === "user");

		expect(userEntry).toBeDefined();
	});
});
