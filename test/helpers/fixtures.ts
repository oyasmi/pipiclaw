import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach } from "vitest";
import type { DingTalkEvent } from "../../src/dingtalk/handler.js";

export function createFakeEvent(overrides: Partial<DingTalkEvent> = {}): DingTalkEvent {
	return {
		type: "dm",
		channelId: "dm_123",
		ts: "1710000000000",
		user: "user_1",
		userName: "Alice",
		text: "hello",
		conversationId: "conv_123",
		conversationType: "1",
		...overrides,
	};
}

export function createTempWorkspace(prefix: string = "pipiclaw-test-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Registers an `afterEach` that removes every temp directory created through the returned factory,
 * replacing the per-file `const tempDirs: string[] = []` + manual `rmSync` cleanup idiom.
 */
export function useTempDirs(prefix: string = "pipiclaw-test-"): () => string {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	return () => {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		dirs.push(dir);
		return dir;
	};
}

export function setupChannelFiles(
	dir: string,
	content: {
		memory?: string;
		session?: string;
		history?: string;
	} = {},
): void {
	mkdirSync(dir, { recursive: true });
	if (content.memory !== undefined) {
		writeFileSync(join(dir, "MEMORY.md"), content.memory, "utf-8");
	}
	if (content.session !== undefined) {
		writeFileSync(join(dir, "SESSION.md"), content.session, "utf-8");
	}
	if (content.history !== undefined) {
		writeFileSync(join(dir, "HISTORY.md"), content.history, "utf-8");
	}
}

/**
 * A (dot, channel) pairing on disk for unit tests (spec 058): `dotDir` is the dot, the
 * conversation directory lives inside it as `conversations/<conversation>/`.
 */
export function testConversation(
	dotDir: string,
	overrides: { dot?: string; channelId?: string; conversation?: string } = {},
): import("../../src/dot/types.js").DotConversation {
	const conversation = overrides.conversation ?? "dm-1";
	const conversationDir = join(dotDir, "conversations", conversation);
	mkdirSync(conversationDir, { recursive: true });
	return {
		dot: overrides.dot ?? "news",
		dotDir,
		cwd: dotDir,
		channelId: overrides.channelId ?? "dm_1",
		conversation,
		conversationDir,
	};
}

/**
 * Bind `channelId` to `dot` in a workspace the runtime is about to load (creating the dot and the
 * conversation when needed) — what `/dot new` + `/dot bind` leave on disk.
 */
export async function bindTestChannel(
	workspaceDir: string,
	channelId: string,
	dot = "news",
): Promise<import("../../src/dot/types.js").DotConversation> {
	const registry = await import("../../src/dot/registry.js");
	await registry.createDot(workspaceDir, dot, new Date());
	const kind = channelId === "tui" ? "tui" : channelId.startsWith("group_") ? "group" : "dm";
	const conversation = await registry.allocateConversation(workspaceDir, dot, channelId, kind, new Date());
	const bindings = await registry.loadBindings(workspaceDir);
	bindings.bindings[channelId] = { dot, boundAt: new Date().toISOString() };
	await registry.writeBindings(workspaceDir, bindings);
	return conversation;
}
