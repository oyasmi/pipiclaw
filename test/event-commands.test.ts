import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { handleEventsCommand } from "../src/runtime/event-commands.js";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pipiclaw-event-commands-"));
	tempDirs.push(dir);
	return dir;
}

function createWorkspace(): { workspaceDir: string; eventsDir: string; historyPath: string } {
	const appHome = createTempDir();
	const workspaceDir = join(appHome, "workspace");
	const eventsDir = join(workspaceDir, "events");
	const historyPath = join(appHome, "state", "events", "history.jsonl");
	mkdirSync(eventsDir, { recursive: true });
	mkdirSync(join(appHome, "state", "events"), { recursive: true });
	return { workspaceDir, eventsDir, historyPath };
}

async function runCommand(workspaceDir: string, historyPath: string, args: string): Promise<string> {
	return await handleEventsCommand({ args, workspaceDir, historyPath });
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("event commands", () => {
	it("lists event summaries and marks invalid event files", async () => {
		const { workspaceDir, eventsDir, historyPath } = createWorkspace();
		writeFileSync(
			join(eventsDir, "weekly-review.json"),
			JSON.stringify({
				type: "periodic",
				channelId: "dm_123",
				text: "Review current channel memory and prune stale notes.",
				schedule: "0 9 * * 1",
				timezone: "Asia/Shanghai",
			}),
			{ flag: "w" },
		);
		writeFileSync(
			join(eventsDir, "release-check.json"),
			JSON.stringify({
				type: "one-shot",
				channelId: "group_456",
				text: "Check release result.",
				at: "2026-07-05T18:00:00+08:00",
			}),
		);
		writeFileSync(join(eventsDir, "broken.json"), "{");

		const result = await runCommand(workspaceDir, historyPath, "list");

		expect(result).toContain("# Events");
		expect(result).toContain("- weekly-review");
		expect(result).toContain("type: periodic");
		expect(result).toContain("schedule: 0 9 * * 1");
		expect(result).toContain("- release-check");
		expect(result).toContain("at: 2026-07-05T18:00:00+08:00");
		expect(result).toContain("- broken");
		expect(result).toContain("invalid:");
	});

	it("shows formatted event JSON", async () => {
		const { workspaceDir, eventsDir, historyPath } = createWorkspace();
		writeFileSync(
			join(eventsDir, "now.json"),
			JSON.stringify({ type: "immediate", channelId: "dm_123", text: "Run now." }),
		);

		const result = await runCommand(workspaceDir, historyPath, "show now");

		expect(result).toContain("# Event: now");
		expect(result).toContain('"type": "immediate"');
		expect(result).toContain('"channelId": "dm_123"');
	});

	it("deletes only normalized event files inside workspace events", async () => {
		const { workspaceDir, eventsDir, historyPath } = createWorkspace();
		const eventPath = join(eventsDir, "old.json");
		writeFileSync(eventPath, JSON.stringify({ type: "immediate", channelId: "dm_123", text: "Run now." }));

		expect(await runCommand(workspaceDir, historyPath, "delete old.json")).toBe("Deleted event: old");
		expect(existsSync(eventPath)).toBe(false);

		const rejected = await runCommand(workspaceDir, historyPath, "delete ../old");
		expect(rejected).toContain("Invalid event name");
	});

	it("shows recent event history and filters by event name", async () => {
		const { workspaceDir, historyPath } = createWorkspace();
		writeFileSync(
			historyPath,
			[
				JSON.stringify({
					ts: "2026-07-01T09:00:00.000+08:00",
					eventName: "weekly-review",
					eventPath: "/tmp/weekly-review.json",
					eventType: "periodic",
					channelId: "dm_123",
					action: "triggered",
					result: "ok",
					schedule: "0 9 * * 1",
					timezone: "Asia/Shanghai",
					nextRunAt: "2026-07-08T09:00:00.000+08:00",
					textPreview: "Review memory.",
				}),
				JSON.stringify({
					ts: "2026-07-01T10:00:00.000+08:00",
					eventName: "other",
					eventPath: "/tmp/other.json",
					eventType: "immediate",
					action: "deleted",
					result: "ok",
				}),
			].join("\n"),
		);

		const allHistory = await runCommand(workspaceDir, historyPath, "history");
		expect(allHistory).toContain("other deleted ok");
		expect(allHistory).toContain("weekly-review triggered ok");

		const filtered = await runCommand(workspaceDir, historyPath, "history weekly-review");
		expect(filtered).toContain("# Event History: weekly-review");
		expect(filtered).toContain("weekly-review triggered ok");
		expect(filtered).not.toContain("other deleted ok");
	});

	it("returns usage for invalid events subcommands", async () => {
		const { workspaceDir, historyPath } = createWorkspace();

		const result = await runCommand(workspaceDir, historyPath, "create foo {}");

		expect(result).toContain("Unknown /events action: create");
		expect(result).toContain("/events list");
	});
});
