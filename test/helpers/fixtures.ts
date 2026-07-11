import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach } from "vitest";
import type { DingTalkEvent } from "../../src/runtime/dingtalk.js";

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
