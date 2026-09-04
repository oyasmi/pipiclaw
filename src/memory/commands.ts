import { renderSubcommandUsage } from "../commands/catalog.js";
import { capReply } from "../commands/reply-limits.js";
import { localDayKey } from "../shared/local-time.js";
import { getDefaultChannelMemoryQueue } from "./channel-maintenance-queue.js";
import { buildChannelIndexForBootstrap, CHANNEL_INDEX_MAX_UNITS } from "./index-budget.js";
import { listJournalDates, readJournalDay } from "./journal.js";
import { readMemoryMaintenanceState } from "./maintenance-state.js";
import { appendMemoryReviewLog } from "./review-log.js";
import {
	applyMemoryOps,
	listMemoryEntries,
	MEMORY_TYPE_ORDER,
	type MemoryEntry,
	type MemoryType,
	readMemoryEntry,
} from "./store.js";
import { hashMemoryContent } from "./tombstones.js";

/**
 * Spec 050, D10: `/memory` is the no-LLM control surface — it must work even when the model or
 * the reflect pass is unavailable. `status` / `list` / `show` / `journal` are pure reads over
 * `store.ts` / `journal.ts`; `forget` is the one write, going through the same channel memory
 * queue as the tool and reflect so it never races them.
 */

interface MemoryCommandOptions {
	channelId: string;
	channelDir: string;
	appHomeDir?: string;
	args: string;
}

function renderUsage(): string {
	return renderSubcommandUsage("memory");
}

function isMemoryType(value: string | undefined): value is MemoryType {
	return value !== undefined && (MEMORY_TYPE_ORDER as readonly string[]).includes(value);
}

async function handleStatus(options: MemoryCommandOptions): Promise<string> {
	const entries = await listMemoryEntries(options.channelDir);
	const byType = new Map<MemoryType, number>(MEMORY_TYPE_ORDER.map((type) => [type, 0]));
	for (const entry of entries) {
		byType.set(entry.type, (byType.get(entry.type) ?? 0) + 1);
	}
	const probationary = entries
		.filter((entry): entry is MemoryEntry & { expires: string } => Boolean(entry.expires))
		.sort((a, b) => a.expires.localeCompare(b.expires));
	const malformed = entries.filter((entry) => entry.malformed);
	const tiered = buildChannelIndexForBootstrap(entries, CHANNEL_INDEX_MAX_UNITS);

	const state = options.appHomeDir
		? await readMemoryMaintenanceState(options.appHomeDir, options.channelId)
		: undefined;

	return [
		"**记忆状态**",
		"",
		`- 频道条目：\`${entries.length}\`（${MEMORY_TYPE_ORDER.map((type) => `${type} ${byType.get(type) ?? 0}`).join(" / ")}）`,
		`- 试用期条目：\`${probationary.length}\`${probationary.length > 0 ? `（最早到期 \`${probationary[0].expires}\`）` : ""}`,
		`- frontmatter 解析异常的文件：\`${malformed.length}\`${malformed.length > 0 ? `（${malformed.map((e) => e.name).join(", ")}）` : ""}`,
		`- 上次反思：\`${state?.lastReflectAt ?? "从未"}\`${state?.lastReflectedEntryId ? `（游标 \`${state.lastReflectedEntryId}\`）` : ""}`,
		`- 索引预算：${tiered.overBudget ? `超出，注入时按 updated 降序分层；下次反思会尝试合并` : "未超出，整份注入"}`,
	].join("\n");
}

async function handleList(options: MemoryCommandOptions, typeArg: string | undefined): Promise<string> {
	if (typeArg && !isMemoryType(typeArg)) {
		return `未知的记忆类型 \`${typeArg}\`。可用类型：${MEMORY_TYPE_ORDER.join(", ")}。`;
	}
	const entries = await listMemoryEntries(options.channelDir);
	const filtered = typeArg ? entries.filter((entry) => entry.type === typeArg) : entries;
	if (filtered.length === 0) {
		return typeArg ? `**记忆条目（${typeArg}）**\n\n暂无该类型的记忆。` : "**记忆条目**\n\n暂无生效的频道记忆。";
	}
	const lines = filtered.map((entry) => {
		const marker = entry.body.trim() ? " (+)" : "";
		const probation = entry.expires ? `（观察期至 \`${entry.expires}\`）` : "";
		return `- \`${entry.name}\` [${entry.type}]${probation} ${entry.description}${marker}`;
	});
	return capReply(`**记忆条目${typeArg ? `（${typeArg}）` : ""}**\n\n${lines.join("\n")}`, {
		nextStepHint: "用 `/memory show <name>` 查看单条记忆全文",
	}).text;
}

async function handleShow(options: MemoryCommandOptions, name: string | undefined): Promise<string> {
	if (!name) return `缺少记忆名称。${renderUsage()}`;
	const entry = await readMemoryEntry(options.channelDir, name);
	if (!entry) return `未找到记忆 \`${name}\`。用 \`/memory list\` 查看可用名称。`;
	const lines = [
		`**记忆 ${name}**`,
		"",
		`- type: \`${entry.type}\``,
		`- source: \`${entry.source}\``,
		`- created: \`${entry.created}\` / updated: \`${entry.updated}\``,
	];
	if (entry.expires) lines.push(`- expires: \`${entry.expires}\``);
	if (entry.malformed) lines.push("- ⚠️ frontmatter 解析异常，以第一段作为 description");
	lines.push("", entry.description);
	if (entry.body.trim()) lines.push("", entry.body.trim());
	return lines.join("\n");
}

async function handleForget(options: MemoryCommandOptions, name: string | undefined): Promise<string> {
	if (!name) return `缺少记忆名称。${renderUsage()}`;
	const entry = await readMemoryEntry(options.channelDir, name);
	if (!entry) return `未找到记忆 \`${name}\`；未做任何改动。`;
	await getDefaultChannelMemoryQueue().run(options.channelId, () =>
		applyMemoryOps(options.channelDir, [{ op: "delete", name, reason: "/memory forget" }]),
	);
	await appendMemoryReviewLog(options.channelDir, {
		timestamp: new Date().toISOString(),
		channelId: options.channelId,
		reason: "memory-forget",
		actions: [{ op: "forget", name, contentHash: hashMemoryContent(entry.description) }],
	}).catch(() => {});
	return `已删除 \`${name}\`。内容按哈希墓碑化，避免被反思重新写入；重新说出该事实仍可被学到。`;
}

async function handleJournal(options: MemoryCommandOptions, dateArg: string | undefined): Promise<string> {
	const date = dateArg ?? localDayKey();
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		return `日期格式应为 \`YYYY-MM-DD\`。${renderUsage()}`;
	}
	const content = await readJournalDay(options.channelDir, date);
	if (!content.trim()) {
		const dates = await listJournalDates(options.channelDir);
		const hint = dates.length > 0 ? `\n\n有记录的日期：${dates.slice(-10).join(", ")}` : "";
		return `**日志 ${date}**\n\n当天没有记录。${hint}`;
	}
	return capReply(`**日志 ${date}**\n\n${content.trim()}`, {
		nextStepHint: "用 `/memory journal <YYYY-MM-DD>` 查看其他日期",
	}).text;
}

export async function handleMemoryCommand(options: MemoryCommandOptions): Promise<string> {
	const [action = "status", argument] = options.args.trim().split(/\s+/, 2);

	if (action === "status") return handleStatus(options);
	if (action === "list") return handleList(options, argument);
	if (action === "show") return handleShow(options, argument);
	if (action === "forget") return handleForget(options, argument);
	if (action === "journal") return handleJournal(options, argument);

	return `未知的 memory 命令 \`${action}\`。${renderUsage()}`;
}
