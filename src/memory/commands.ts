import { renderSubcommandUsage } from "../agent/commands.js";
import { capReply } from "../agent/reply-limits.js";
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
	return renderSubcommandUsage("memory");
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
			"**记忆状态**",
			"",
			`- 生效条目：\`${entries.length}\``,
			`- 元数据记录：\`${records.length}\``,
			`- 观察期：\`${probationary.length}\`${probationary.length > 0 ? `（最早到期 \`${probationary[0].probationUntil}\`）` : ""}`,
			`- 最近 7 天：+${written} 写入 / -${dropped} 丢弃 / -${expired} 过期`,
			`- 墓碑：\`${tombstones.length}\``,
			`- 累计召回：\`${active.reduce((sum, entry) => sum + entry.recallCount, 0)}\``,
			`- 召回（30 天）：\`${recalls30d}\``,
			`- 查询多样性：\`${new Set(active.flatMap((entry) => entry.queryFingerprints)).size}\``,
			`- 最近一次召回：\`${
				active
					.map((entry) => entry.lastRecalledAt)
					.filter(Boolean)
					.sort()
					.at(-1) ?? "从未"
			}\``,
			`- 近期失败：${lastFailure ? "有，查看 memory-review.jsonl" : "无"}`,
			`- 生效文件：\`${getChannelMemoryPath(options.channelDir)}\``,
		].join("\n");
	}

	if (action === "list") {
		if (entries.length === 0) return "**记忆条目**\n\n暂无生效的频道记忆条目。";
		const visible = entries.slice(0, 50);
		const lines = visible.map((entry) => {
			const record = metadata.entries[entry.id];
			const probation = record?.probationUntil ? `（观察期至 \`${record.probationUntil}\`）` : "";
			return `- \`${entry.id}\` [${record?.kind ?? "fact"}]${probation} ${clipText(entry.content, 180, { headRatio: 1 })}`;
		});
		if (entries.length > visible.length) {
			lines.push(
				`- 另有 ${entries.length - visible.length} 条已省略；缩小范围后用 \`/memory show <entry-id>\` 查看。`,
			);
		}
		return capReply(`**记忆条目**\n\n${lines.join("\n")}`, {
			nextStepHint: "用 `/memory show <entry-id>` 查看单条记忆",
		}).text;
	}

	if (action === "show") {
		if (!argument) return `缺少 entry id。${renderUsage()}`;
		const entry = entries.find((candidate) => candidate.id === argument);
		const record = metadata.entries[argument];
		if (!entry && !record) return `未找到记忆条目 \`${argument}\`。用 \`/memory list\` 查看 id。`;
		return [
			`**记忆 ${argument}**`,
			"",
			entry?.content ?? "（未在 MEMORY.md 中生效）",
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
		if (recent.length === 0) return "**近期记忆活动**\n\n最近 7 天没有记忆活动。";
		return [
			"**近期记忆活动**",
			"",
			...recent.map((item) => {
				const when = item.timestamp ? `（${item.timestamp}）` : "";
				if (item.entryId) return `- ${when}遗忘 \`${item.entryId}\`（${item.reason}）`;
				const detail =
					item.action === "append"
						? `新增 ${item.entries ?? 0} 条`
						: item.action === "rewrite"
							? `重写${item.droppedEntryIds?.length ? `（丢弃 ${item.droppedEntryIds.join(", ")}）` : ""}`
							: item.action === "expire"
								? `过期 ${item.entries ?? 0} 条`
								: (item.action ?? "unknown");
				return `- ${when}${item.target ?? "?"}：${detail}（${item.reason}）`;
			}),
		].join("\n");
	}

	return `未知的 memory 命令 \`${action}\`。${renderUsage()}`;
}
