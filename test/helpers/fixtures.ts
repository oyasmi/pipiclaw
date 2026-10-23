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
 * A (desk, channel) pairing on disk for unit tests (spec 058): `deskDir` is the desk, the
 * conversation directory lives inside it as `conversations/<conversation>/`.
 */
export function testConversation(
	deskDir: string,
	overrides: { desk?: string; channelId?: string; conversation?: string } = {},
): import("../../src/desk/types.js").DeskConversation {
	const conversation = overrides.conversation ?? "dm-1";
	const conversationDir = join(deskDir, "conversations", conversation);
	mkdirSync(conversationDir, { recursive: true });
	return {
		desk: overrides.desk ?? "news",
		deskDir,
		cwd: deskDir,
		channelId: overrides.channelId ?? "dm_1",
		conversation,
		conversationDir,
	};
}

/**
 * Bind `channelId` to `desk` in a workspace the runtime is about to load (creating the desk and the
 * conversation when needed) — what `/desk new` + `/desk bind` leave on disk.
 */
export async function bindTestChannel(
	workspaceDir: string,
	channelId: string,
	desk = "news",
): Promise<import("../../src/desk/types.js").DeskConversation> {
	const registry = await import("../../src/desk/registry.js");
	await registry.createDesk(workspaceDir, desk, new Date());
	const kind = channelId === "tui" ? "tui" : channelId.startsWith("group_") ? "group" : "dm";
	const conversation = await registry.allocateConversation(workspaceDir, desk, channelId, kind, new Date());
	const bindingStore = await import("../../src/desk/bindings.js");
	const bindings = await bindingStore.loadBindings(workspaceDir);
	bindings.bindings[channelId] = { desk, boundAt: new Date().toISOString() };
	await bindingStore.writeBindings(workspaceDir, bindings);
	return conversation;
}
