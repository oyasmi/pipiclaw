import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSessionCorpus } from "../src/memory/session-corpus.js";
import { useTempDirs } from "./helpers/fixtures.js";

const makeWorkspace = useTempDirs("pipiclaw-corpus-limit-");

function createChannelDir(): string {
	const workspaceDir = makeWorkspace();
	const channelDir = join(workspaceDir, "dm_123");
	mkdirSync(channelDir, { recursive: true });
	return channelDir;
}

function writeJsonl(path: string, entries: unknown[]): void {
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf-8");
}

describe("session corpus limits", () => {
	it("caps documents at maxDocumentsTotal and keeps newest", async () => {
		const channelDir = createChannelDir();
		const entries = Array.from({ length: 200 }, (_, i) => ({
			date: new Date(Date.now() - (200 - i) * 60_000).toISOString(),
			userName: "Alice",
			text: `message number ${i}`,
			isBot: false,
		}));
		writeJsonl(join(channelDir, "log.jsonl"), entries);

		const docs = await buildSessionCorpus({
			channelDir,
			maxFiles: 6,
			maxDocumentsTotal: 50,
		});

		expect(docs.length).toBeLessThanOrEqual(50);
		// Should keep newest (tail) entries
		const lastDoc = docs[docs.length - 1];
		expect(lastDoc?.text).toContain("message number 199");
	});

	it("returns all documents when under the limit", async () => {
		const channelDir = createChannelDir();
		const entries = Array.from({ length: 10 }, (_, i) => ({
			date: new Date(Date.now() - (10 - i) * 60_000).toISOString(),
			text: `short message ${i}`,
			isBot: false,
		}));
		writeJsonl(join(channelDir, "log.jsonl"), entries);

		const docs = await buildSessionCorpus({
			channelDir,
			maxFiles: 6,
			maxDocumentsTotal: 5000,
		});

		expect(docs.length).toBe(10);
	});
});
