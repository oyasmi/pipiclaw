import { renderSubcommandUsage } from "../commands/catalog.js";
import { capReply, flattenMarkdownForChat } from "../commands/reply-limits.js";
import type { DeskConversation } from "../desk/types.js";
import { localDayKey } from "../shared/local-time.js";
import { getDeskMemoryQueue } from "./desk-memory-queue.js";
import { buildMemoryIndexForBootstrap, MEMORY_INDEX_MAX_UNITS } from "./index-budget.js";
import { listJournalDates, readJournalDay } from "./journal.js";
import { readMemoryMaintenanceState } from "./maintenance-state.js";
import { appendMemoryReviewLog } from "./review-log.js";
import {
	applyMemoryOps,
	isValidMemoryName,
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
 * `store.ts` / `journal.ts`; `forget` is the one write, going through the same desk memory
 * queue as the tool and reflect so it never races them.
 */

interface MemoryCommandOptions {
	/** The asking conversation: memory is read from its desk, maintenance state from it. */
	conversation: DeskConversation;
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
	const entries = await listMemoryEntries(options.conversation.deskDir);
	const byType = new Map<MemoryType, number>(MEMORY_TYPE_ORDER.map((type) => [type, 0]));
	for (const entry of entries) {
		byType.set(entry.type, (byType.get(entry.type) ?? 0) + 1);
	}
	const probationary = entries
		.filter((entry): entry is MemoryEntry & { expires: string } => Boolean(entry.expires))
		.sort((a, b) => a.expires.localeCompare(b.expires));
	const malformed = entries.filter((entry) => entry.malformed);
	const tiered = buildMemoryIndexForBootstrap(entries, MEMORY_INDEX_MAX_UNITS);

	const state = options.appHomeDir
		? await readMemoryMaintenanceState(options.appHomeDir, options.conversation)
		: undefined;

	return [
		"**记忆状态**",
		"",
		`- 记忆条目：\`${entries.length}\`（${MEMORY_TYPE_ORDER.map((type) => `${type} ${byType.get(type) ?? 0}`).join(" / ")}）`,
		`- 观察期条目：\`${probationary.length}\`${probationary.length > 0 ? `（最早到期 \`${probationary[0].expires}\`）` : ""}`,
		`- 文件头解析异常：\`${malformed.length}\`${malformed.length > 0 ? `（${malformed.map((e) => e.name).join("、")}）` : ""}`,
		`- 上次后台整理：\`${state?.lastReflectAt ?? "从未"}\``,
		`- 索引大小：${tiered.overBudget ? "超出预算，注入时优先带最近更新的条目；下次整理会尝试合并" : "未超出预算，整份注入"}`,
	].join("\n");
}

async function handleList(options: MemoryCommandOptions, typeArg: string | undefined): Promise<string> {
	if (typeArg && !isMemoryType(typeArg)) {
		return `未知的记忆类型 \`${typeArg}\`。可用类型：${MEMORY_TYPE_ORDER.join(", ")}。`;
	}
	const entries = await listMemoryEntries(options.conversation.deskDir);
	const filtered = typeArg ? entries.filter((entry) => entry.type === typeArg) : entries;
	if (filtered.length === 0) {
		return typeArg
			? `暂无 \`${typeArg}\` 类型的记忆。\n用 \`/memory list\` 查看全部。`
			: "暂无生效的记忆。\n在对话里告诉我需要长期记住的事，我会保存下来。";
	}
	const lines = filtered.map((entry) => {
		const marker = entry.body.trim() ? "（有正文）" : "";
		const probation = entry.expires ? `（观察期至 \`${entry.expires}\`）` : "";
		return `- \`${entry.name}\` [${entry.type}]${probation} ${entry.description}${marker}`;
	});
	return capReply(`**记忆条目${typeArg ? `（${typeArg}）` : ""}**\n\n${lines.join("\n")}`, {
		nextStepHint: "用 `/memory show <name>` 查看单条记忆全文",
	}).text;
}

async function handleShow(options: MemoryCommandOptions, name: string | undefined): Promise<string> {
	if (!name) return `缺少记忆名称。\n\n${renderUsage()}`;
	const entry = await readMemoryEntry(options.conversation.deskDir, name);
	if (!entry) return `未找到记忆 \`${name}\`。用 \`/memory list\` 查看可用名称。`;
	// Frontmatter keys stay visible (the user sees them when opening the file), introduced by a
	// Chinese label rather than shown bare (spec 053, D1).
	const lines = [
		`**记忆 ${name}**`,
		"",
		`- 类型（type）：\`${entry.type}\``,
		`- 来源（source）：\`${entry.source}\``,
		`- 创建（created）：\`${entry.created}\`；更新（updated）：\`${entry.updated}\``,
	];
	if (entry.expires) lines.push(`- 观察期至（expires）：\`${entry.expires}\``);
	if (entry.malformed) lines.push("- ⚠️ 文件头解析异常，以第一段作为描述");
	lines.push("", entry.description);
	if (entry.body.trim()) lines.push("", flattenMarkdownForChat(entry.body.trim()));
	return capReply(lines.join("\n"), { nextStepHint: "完整内容在工位目录的 `memory/` 下" }).text;
}

async function handleForget(options: MemoryCommandOptions, name: string | undefined): Promise<string> {
	if (!name) return `缺少记忆名称。\n\n${renderUsage()}`;
	const entry = await readMemoryEntry(options.conversation.deskDir, name);
	if (!entry) return `未找到记忆 \`${name}\`，未做任何改动。用 \`/memory list\` 查看可用名称。`;
	await getDeskMemoryQueue().run(options.conversation, () =>
		applyMemoryOps(options.conversation.deskDir, [{ op: "delete", name, reason: "/memory forget" }]),
	);
	await appendMemoryReviewLog(options.conversation.deskDir, {
		timestamp: new Date().toISOString(),
		channelId: options.conversation.channelId,
		reason: "memory-forget",
		actions: [{ op: "forget", name, contentHash: hashMemoryContent(entry.description) }],
	}).catch(() => {});
	return `已删除 \`${name}\`，并记入忽略名单，后台整理不会再自动写回；你之后重新说起这件事，仍然可以被记住。`;
}

async function handleJournal(options: MemoryCommandOptions, dateArg: string | undefined): Promise<string> {
	const date = dateArg ?? localDayKey();
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		return `日期格式应为 \`YYYY-MM-DD\`。\n\n${renderUsage()}`;
	}
	const content = await readJournalDay(options.conversation.deskDir, date);
	if (!content.trim()) {
		const dates = await listJournalDates(options.conversation.deskDir);
		const hint =
			dates.length > 0
				? `有记录的日期：${dates.slice(-10).join("、")}`
				: "工作日记由后台整理按天写入，有对话之后会出现。";
		return `暂无 ${date} 的工作日记。\n${hint}`;
	}
	return capReply(`**工作日记 ${date}**\n\n${flattenMarkdownForChat(content.trim())}`, {
		nextStepHint: "用 `/memory journal <YYYY-MM-DD>` 查看其他日期",
	}).text;
}

export async function handleMemoryCommand(options: MemoryCommandOptions): Promise<string> {
	const [action = "status", argument] = options.args.trim().split(/\s+/, 2);

	if (action === "status") return handleStatus(options);
	if (action === "list") return handleList(options, argument);
	if ((action === "show" || action === "forget") && argument && !isValidMemoryName(argument)) {
		return "记忆名称格式不正确。请用 `/memory list` 查找名称，再查看或删除对应记忆。";
	}
	if (action === "show") return handleShow(options, argument);
	if (action === "forget") return handleForget(options, argument);
	if (action === "journal") return handleJournal(options, argument);

	return `未知子命令 \`${action}\`。\n\n${renderUsage()}`;
}
