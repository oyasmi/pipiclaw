import { readOptionalTextFile } from "../shared/fs-utils.js";
import { localDayKey, parseLocalTime } from "../shared/local-time.js";
import { clipText } from "../shared/text-utils.js";
import { getChannelMemoryPath, parseChannelMemoryEntries, readChannelMemory } from "./files.js";
import { syncMemoryMetadata } from "./metadata.js";
import { getMemoryReviewLogPath, type MemoryReviewReason } from "./review-log.js";
import { readMemoryTombstones } from "./tombstones.js";

interface MemoryCommandOptions {
	channelDir: string;
	args: string;
}

interface RecentMemoryAction {
	timestamp?: string;
	reason: MemoryReviewReason;
	target?: string;
	action?: string;
	entries?: number;
	droppedEntryIds?: string[];
	entryId?: string;
}

async function reconcile(options: MemoryCommandOptions) {
	const entries = parseChannelMemoryEntries(await readChannelMemory(options.channelDir));
	const metadata = await syncMemoryMetadata(options.channelDir, entries);
	return { entries, metadata };
}

/**
 * Flattens `memory-review.jsonl` action entries for `/memory recent` and the `status` summary —
 * the only consumers of the review log's write history. `user-forget` actions carry `entryId`
 * instead of `target`/`action`; both shapes are tolerated here.
 */
async function readRecentMemoryActions(channelDir: string, sinceMs: number): Promise<RecentMemoryAction[]> {
	const raw = await readOptionalTextFile(getMemoryReviewLogPath(channelDir));
	const actions: RecentMemoryAction[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as {
				timestamp?: string;
				reason: MemoryReviewReason;
				actions?: unknown[];
			};
			const entryMs = entry.timestamp ? (parseLocalTime(entry.timestamp) ?? 0) : 0;
			if (entryMs < sinceMs) continue;
			for (const value of entry.actions ?? []) {
				if (value && typeof value === "object") {
					actions.push({ timestamp: entry.timestamp, reason: entry.reason, ...(value as object) });
				}
			}
		} catch {
			// A torn audit line should not break the management surface.
		}
	}
	return actions;
}

function renderUsage(): string {
	return "Use `/memory status`, `/memory list`, `/memory show <entry-id>`, or `/memory recent`.";
}

export async function handleMemoryCommand(options: MemoryCommandOptions): Promise<string> {
	const [action = "status", argument] = options.args.trim().split(/\s+/, 2);
	const { entries, metadata } = await reconcile(options);

	if (action === "status") {
		const tombstones = await readMemoryTombstones(options.channelDir);
		const records = Object.values(metadata.entries);
		const active = records.filter((entry) => entry.status === "active");
		const probationary = active
			.filter((entry) => entry.probationUntil)
			.sort((a, b) => (a.probationUntil ?? "").localeCompare(b.probationUntil ?? ""));
		const since = new Date();
		since.setDate(since.getDate() - 29);
		const sinceDay = localDayKey(since);
		const recalls30d = active.reduce(
			(sum, entry) =>
				sum +
				Object.entries(entry.recallByDay ?? {}).reduce(
					(entrySum, [day, count]) => entrySum + (day >= sinceDay ? count : 0),
					0,
				),
			0,
		);
		const last7d = new Date();
		last7d.setDate(last7d.getDate() - 7);
		const recent = await readRecentMemoryActions(options.channelDir, last7d.getTime());
		const written = recent
			.filter((item) => item.target === "MEMORY.md" && item.action === "append")
			.reduce((sum, item) => sum + (item.entries ?? 0), 0);
		const dropped = recent.reduce((sum, item) => {
			if (item.entryId) return sum + 1;
			if (item.target === "MEMORY.md" && item.action === "rewrite") return sum + (item.droppedEntryIds?.length ?? 0);
			return sum;
		}, 0);
		const expired = recent
			.filter((item) => item.target === "MEMORY.md" && item.action === "expire")
			.reduce((sum, item) => sum + (item.entries ?? 0), 0);
		const lastFailure = (await readOptionalTextFile(getMemoryReviewLogPath(options.channelDir)))
			.split("\n")
			.reverse()
			.find((line) => line.includes('"error"'));
		return [
			"# Memory Status",
			"",
			`- Active entries: \`${entries.length}\``,
			`- Metadata records: \`${records.length}\``,
			`- Probationary: \`${probationary.length}\`${probationary.length > 0 ? ` (earliest expiry \`${probationary[0].probationUntil}\`)` : ""}`,
			`- Last 7d: +${written} written / -${dropped} dropped / -${expired} expired`,
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
			const probation = record?.probationUntil ? ` (probation until \`${record.probationUntil}\`)` : "";
			return `- \`${entry.id}\` [${record?.kind ?? "fact"}]${probation} ${clipText(entry.content, 180, { headRatio: 1 })}`;
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

	if (action === "recent") {
		const last7d = new Date();
		last7d.setDate(last7d.getDate() - 7);
		const recent = (await readRecentMemoryActions(options.channelDir, last7d.getTime())).slice(-30).reverse();
		if (recent.length === 0) return "# Recent Memory Activity\n\nNo memory activity in the last 7 days.";
		return [
			"# Recent Memory Activity",
			"",
			...recent.map((item) => {
				const when = item.timestamp ? `(${item.timestamp}) ` : "";
				if (item.entryId) return `- ${when}forget \`${item.entryId}\` [${item.reason}]`;
				const detail =
					item.action === "append"
						? `append ${item.entries ?? 0} entr${(item.entries ?? 0) === 1 ? "y" : "ies"}`
						: item.action === "rewrite"
							? `rewrite${item.droppedEntryIds?.length ? ` (dropped ${item.droppedEntryIds.join(", ")})` : ""}`
							: item.action === "expire"
								? `expire ${item.entries ?? 0} entr${(item.entries ?? 0) === 1 ? "y" : "ies"}`
								: (item.action ?? "unknown");
				return `- ${when}${item.target ?? "?"}: ${detail} [${item.reason}]`;
			}),
		].join("\n");
	}

	return `Unknown memory command \`${action}\`. ${renderUsage()}`;
}
