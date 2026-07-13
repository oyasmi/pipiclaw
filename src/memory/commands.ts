import { createHash } from "node:crypto";
import { readOptionalTextFile } from "../shared/fs-utils.js";
import { clipText } from "../shared/text-utils.js";
import { getChannelMemoryPath, parseChannelMemoryEntries, readChannelMemory } from "./files.js";
import { syncMemoryMetadata } from "./metadata.js";
import { getMemoryReviewLogPath } from "./review-log.js";
import { readMemoryTombstones } from "./tombstones.js";

interface MemoryCommandOptions {
	channelDir: string;
	args: string;
}

interface PendingSuggestion {
	id: string;
	timestamp?: string;
	value: unknown;
}

async function reconcile(options: MemoryCommandOptions) {
	const entries = parseChannelMemoryEntries(await readChannelMemory(options.channelDir));
	const metadata = await syncMemoryMetadata(options.channelDir, entries);
	return { entries, metadata };
}

async function readPendingSuggestions(channelDir: string): Promise<PendingSuggestion[]> {
	const raw = await readOptionalTextFile(getMemoryReviewLogPath(channelDir));
	const suggestions: PendingSuggestion[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as { timestamp?: string; suggestions?: unknown[] };
			for (const value of entry.suggestions ?? []) {
				const id = `p-${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 8)}`;
				suggestions.push({ id, timestamp: entry.timestamp, value });
			}
		} catch {
			// A torn audit line should not break the management surface.
		}
	}
	return suggestions.slice(-50);
}

function renderUsage(): string {
	return "Use `/memory status`, `/memory list`, `/memory show <entry-id>`, or `/memory pending`.";
}

export async function handleMemoryCommand(options: MemoryCommandOptions): Promise<string> {
	const [action = "status", argument] = options.args.trim().split(/\s+/, 2);
	const { entries, metadata } = await reconcile(options);

	if (action === "status") {
		const pending = await readPendingSuggestions(options.channelDir);
		const tombstones = await readMemoryTombstones(options.channelDir);
		const records = Object.values(metadata.entries);
		const active = records.filter((entry) => entry.status === "active");
		const since = new Date();
		since.setUTCDate(since.getUTCDate() - 29);
		const sinceDay = since.toISOString().slice(0, 10);
		const recalls30d = active.reduce(
			(sum, entry) =>
				sum +
				Object.entries(entry.recallByDay ?? {}).reduce(
					(entrySum, [day, count]) => entrySum + (day >= sinceDay ? count : 0),
					0,
				),
			0,
		);
		const lastFailure = (await readOptionalTextFile(getMemoryReviewLogPath(options.channelDir)))
			.split("\n")
			.reverse()
			.find((line) => line.includes('"error"'));
		return [
			"# Memory Status",
			"",
			`- Active entries: \`${entries.length}\``,
			`- Metadata records: \`${records.length}\``,
			`- Pending suggestions: \`${pending.length}\``,
			`- Tombstones: \`${tombstones.length}\``,
			`- Total recalls: \`${active.reduce((sum, entry) => sum + entry.recallCount, 0)}\``,
			`- Recalls (30d): \`${recalls30d}\``,
			`- Query diversity: \`${new Set(active.flatMap((entry) => entry.queryFingerprints)).size}\``,
			`- Last recalled: \`${
				active
					.map((entry) => entry.lastRecalledAt)
					.filter(Boolean)
					.sort()
					.at(-1) ?? "never"
			}\``,
			`- Recent failure: ${lastFailure ? "yes; inspect memory-review.jsonl" : "none"}`,
			`- Active file: \`${getChannelMemoryPath(options.channelDir)}\``,
		].join("\n");
	}

	if (action === "list") {
		if (entries.length === 0) return "# Memory Entries\n\nNo active channel memory entries.";
		const visible = entries.slice(0, 50);
		const lines = visible.map((entry) => {
			const record = metadata.entries[entry.id];
			return `- \`${entry.id}\` [${record?.kind ?? "fact"}] ${clipText(entry.content, 180, { headRatio: 1 })}`;
		});
		if (entries.length > visible.length) {
			lines.push(
				`- ${entries.length - visible.length} more omitted; use \`/memory show <entry-id>\` after narrowing the file.`,
			);
		}
		return `# Memory Entries\n\n${lines.join("\n")}`;
	}

	if (action === "show") {
		if (!argument) return `Missing entry id. ${renderUsage()}`;
		const entry = entries.find((candidate) => candidate.id === argument);
		const record = metadata.entries[argument];
		if (!entry && !record) return `Memory entry \`${argument}\` was not found. Use \`/memory list\` to see ids.`;
		return [
			`# Memory ${argument}`,
			"",
			entry?.content ?? "(not active in MEMORY.md)",
			"",
			"```json",
			JSON.stringify(record ?? { id: argument, status: "unknown" }, null, 2),
			"```",
		].join("\n");
	}

	if (action === "pending") {
		const pending = await readPendingSuggestions(options.channelDir);
		if (pending.length === 0) return "# Pending Memory Suggestions\n\nNo pending suggestions.";
		return [
			"# Pending Memory Suggestions",
			"",
			...pending.map(
				(item) =>
					`- \`${item.id}\`${item.timestamp ? ` (${item.timestamp})` : ""}: ${clipText(JSON.stringify(item.value), 300)}`,
			),
		].join("\n");
	}

	return `Unknown memory command \`${action}\`. ${renderUsage()}`;
}
