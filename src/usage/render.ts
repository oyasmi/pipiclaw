import type { UsageLedger, UsageSummary } from "./ledger.js";

export type UsageQueryMode = "default" | "7d" | "month";

export function parseUsageMode(args: string): UsageQueryMode {
	const normalized = args.trim().toLowerCase();
	if (normalized === "7d" || normalized === "7") return "7d";
	if (normalized === "month" || normalized === "monthly") return "month";
	return "default";
}

interface UsageWindow {
	title: string;
	since: Date;
	until: Date;
}

function startOfLocalDay(now: Date): Date {
	return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function startOfLocalMonth(now: Date): Date {
	return new Date(now.getFullYear(), now.getMonth(), 1);
}

export function usageWindows(mode: UsageQueryMode, now: Date): UsageWindow[] {
	const monthTitle = `本月（${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}）`;
	switch (mode) {
		case "7d":
			return [{ title: "最近 7 天", since: new Date(now.getTime() - 7 * 86_400_000), until: now }];
		case "month":
			return [{ title: monthTitle, since: startOfLocalMonth(now), until: now }];
		default:
			return [
				{ title: "今天", since: startOfLocalDay(now), until: now },
				{ title: monthTitle, since: startOfLocalMonth(now), until: now },
			];
	}
}

function money(n: number): string {
	return `$${n.toFixed(4)}`;
}

function tokens(n: number): string {
	return n >= 1_000_000
		? `${(n / 1_000_000).toFixed(1)}M tokens`
		: n >= 1_000
			? `${Math.round(n / 1_000)}k tokens`
			: `${n} tokens`;
}

function topEntries(map: Record<string, number>, limit: number): Array<[string, number]> {
	return Object.entries(map)
		.filter(([, cost]) => cost > 0)
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit);
}

function renderKindBreakdown(summary: UsageSummary): string | null {
	const parts = topEntries(summary.byKind, 3).map(([kind, cost]) => `${kind} ${money(cost)}`);
	return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Some harnesses cannot report tokens or cost at all (`exec` reports neither; `codex-cli` reports
 * no cost). Those runs are never dropped from the ledger (spec 040, T7) but their totals are
 * always 0 by construction, so the aggregate total must say so explicitly — otherwise "$0.0000"
 * reads as "these runs cost nothing" instead of "cost unknown for some of these runs".
 */
function unknownNote(summary: UsageSummary): string | null {
	const parts: string[] = [];
	if (summary.unknownCostCount > 0) parts.push(`${summary.unknownCostCount} 次成本未知`);
	if (summary.unknownUsageCount > 0) parts.push(`${summary.unknownUsageCount} 次用量未知`);
	return parts.length > 0 ? `（另有 ${parts.join("，")}，未计入以上合计）` : null;
}

async function renderWindow(window: UsageWindow, ledger: UsageLedger, channelId: string): Promise<string> {
	const [global, channel] = await Promise.all([
		ledger.summarize({ since: window.since, until: window.until }),
		ledger.summarize({ since: window.since, until: window.until, channelId }),
	]);

	const lines: string[] = [`**${window.title}**`];
	if (global.entryCount === 0) {
		lines.push("暂无用量记录。");
		return lines.join("\n");
	}

	// Tokens are reported next to cost because a local or pricing-less model bills nothing while
	// still consuming context — "$0.0000" alone would read as "nothing happened".
	let channelLine = `- 本频道：${money(channel.totalCost)} · ${tokens(channel.totalTokens)}`;
	const channelKinds = renderKindBreakdown(channel);
	if (channelKinds) {
		channelLine += ` · ${channelKinds}`;
	}
	const channelUnknown = unknownNote(channel);
	if (channelUnknown) {
		channelLine += channelUnknown;
	}
	lines.push(channelLine);

	const channelCount = Object.keys(global.byChannel).length;
	let globalLine = `- 全局：${money(global.totalCost)} · ${tokens(global.totalTokens)}，覆盖 ${channelCount} 个频道`;
	const topModels = topEntries(global.byModel, 3);
	if (topModels.length > 0) {
		globalLine += ` · 用量最高：${topModels.map(([model, cost]) => `${model} ${money(cost)}`).join("，")}`;
	}
	const globalUnknown = unknownNote(global);
	if (globalUnknown) {
		globalLine += globalUnknown;
	}
	lines.push(globalLine);
	return lines.join("\n");
}

export async function renderUsageReport(
	ledger: UsageLedger,
	channelId: string,
	mode: UsageQueryMode,
	now: Date,
): Promise<string> {
	const windows = usageWindows(mode, now);
	const rendered = await Promise.all(windows.map((window) => renderWindow(window, ledger, channelId)));
	return `**用量**\n\n${rendered.join("\n\n")}`;
}
