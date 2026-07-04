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

function startOfUtcDay(now: Date): Date {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function startOfUtcMonth(now: Date): Date {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function usageWindows(mode: UsageQueryMode, now: Date): UsageWindow[] {
	const monthTitle = `This month (${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")})`;
	switch (mode) {
		case "7d":
			return [{ title: "Last 7 days", since: new Date(now.getTime() - 7 * 86_400_000), until: now }];
		case "month":
			return [{ title: monthTitle, since: startOfUtcMonth(now), until: now }];
		default:
			return [
				{ title: "Today (UTC)", since: startOfUtcDay(now), until: now },
				{ title: monthTitle, since: startOfUtcMonth(now), until: now },
			];
	}
}

function money(n: number): string {
	return `$${n.toFixed(4)}`;
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

function renderWindow(window: UsageWindow, ledger: UsageLedger, channelId: string): string {
	const global = ledger.summarize({ since: window.since, until: window.until });
	const channel = ledger.summarize({ since: window.since, until: window.until, channelId });

	const lines: string[] = [`## ${window.title}`];
	if (global.entryCount === 0) {
		lines.push("No recorded usage.");
		return lines.join("\n");
	}

	lines.push(`This channel: ${money(channel.totalCost)}`);
	const channelKinds = renderKindBreakdown(channel);
	if (channelKinds) {
		lines.push(`  ${channelKinds}`);
	}

	const channelCount = Object.keys(global.byChannel).length;
	lines.push(`Global: ${money(global.totalCost)} across ${channelCount} channel${channelCount === 1 ? "" : "s"}`);
	const topModels = topEntries(global.byModel, 3);
	if (topModels.length > 0) {
		lines.push(`  Top models: ${topModels.map(([model, cost]) => `${model} ${money(cost)}`).join(", ")}`);
	}
	return lines.join("\n");
}

export function renderUsageReport(ledger: UsageLedger, channelId: string, mode: UsageQueryMode, now: Date): string {
	const windows = usageWindows(mode, now);
	const body = windows.map((window) => renderWindow(window, ledger, channelId)).join("\n\n");
	return `# Usage\n\n${body}`;
}
