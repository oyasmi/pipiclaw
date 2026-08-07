import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "../shared/text-utils.js";
import type { SubAgentDiscoveryResult } from "../subagents/discovery.js";
import { getSubAgentRunManager, type RunRecord } from "../subagents/runs.js";

/**
 * `/subagents` — the human control path that does not depend on the model (spec 040, D6).
 * `/stop` no longer kills a dispatched delegation (D2), so cancel needs a route that works even
 * when the model is unavailable or the turn is stuck. Mirrors `event-commands.ts`'s shape: pure
 * functions returning markdown, no bot/event coupling.
 */

export interface HandleSubagentsCommandOptions {
	args: string;
	channelId: string;
	/** Best-effort role-directory snapshot for the `list` health tail; omitted when no runner is
	 *  currently active for this channel (mirrors how `/status` degrades without a live runner). */
	discovery?: SubAgentDiscoveryResult;
}

type SubagentsCommand = { action: "list" } | { action: "show"; runId: string } | { action: "cancel"; runId: string };

function usage(): string {
	return `# Subagents

Usage:

- \`/subagents list\`
- \`/subagents show <runId>\`
- \`/subagents cancel <runId>\``;
}

function parseSubagentsCommand(args: string): SubagentsCommand {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const action = parts[0];

	if (!action || action === "list") {
		if (parts.length > 1) throw new Error("Usage: /subagents list");
		return { action: "list" };
	}
	if (action === "show") {
		if (!parts[1] || parts.length > 2) throw new Error("Usage: /subagents show <runId>");
		return { action: "show", runId: parts[1] };
	}
	if (action === "cancel") {
		if (!parts[1] || parts.length > 2) throw new Error("Usage: /subagents cancel <runId>");
		return { action: "cancel", runId: parts[1] };
	}
	throw new Error(`Unknown /subagents action: ${action}`);
}

function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

function elapsedMs(record: RunRecord): number {
	return (record.finishedAt ?? Date.now()) - record.startedAt;
}

function formatRunLine(record: RunRecord): string {
	const harness = record.harness ? `${record.runtime}/${record.harness}` : record.runtime;
	const task = record.taskId ? `, task ${record.taskId}` : "";
	return `- [${record.runId}] ${record.agent} (${harness}) — ${record.status} (${formatDuration(elapsedMs(record))}${task})`;
}

function formatHealthTail(discovery: SubAgentDiscoveryResult): string {
	const unavailable = discovery.agents.filter((agent) => agent.unavailable);
	const lines: string[] = [];
	if (unavailable.length > 0 || discovery.warnings.length > 0) {
		lines.push("", "## Role directory health");
	}
	for (const agent of unavailable) {
		lines.push(`- \`${agent.name}\`: unavailable (${agent.unavailable})`);
	}
	for (const warning of discovery.warnings) {
		lines.push(`- discovery warning: ${warning}`);
	}
	return lines.join("\n");
}

async function listRuns(channelId: string, discovery?: SubAgentDiscoveryResult): Promise<string> {
	const records = getSubAgentRunManager(channelId).list();
	const body =
		records.length === 0
			? "No delegation runs."
			: records
					.sort((a, b) => b.startedAt - a.startedAt)
					.map(formatRunLine)
					.join("\n");
	const tail = discovery ? formatHealthTail(discovery) : "";
	return `# Subagent runs\n\n${body}${tail}`;
}

const STDERR_TAIL_CHARS = 2_000;

async function formatRunDetail(record: RunRecord): Promise<string> {
	const parts = [`# Run ${record.runId}`, "", "```json", JSON.stringify(record, null, 2), "```"];
	// D6: "show" is the human/model escape hatch for a stuck or failed external run, so its
	// stderr belongs here even though it never rides the completion wake (that only carries
	// the harness's own parsed output).
	if (record.runtime === "external") {
		const stderrTail = await readFile(join(record.artifactDir, "stderr.log"), "utf-8")
			.then((text) => text.slice(-STDERR_TAIL_CHARS))
			.catch(() => undefined);
		if (stderrTail?.trim()) {
			parts.push("", "## stderr (tail)", "```", stderrTail, "```");
		}
	}
	return parts.join("\n");
}

async function showRun(channelId: string, runId: string): Promise<string> {
	const record = getSubAgentRunManager(channelId).get(runId);
	if (!record) return `Run not found: ${runId}`;
	return formatRunDetail(record);
}

async function cancelRun(channelId: string, runId: string): Promise<string> {
	const status = await getSubAgentRunManager(channelId).cancel(runId);
	if (status === "not_found") return `Run not found: ${runId}`;
	return `Cancel requested for run \`${runId}\`: ${status}`;
}

export async function handleSubagentsCommand(options: HandleSubagentsCommandOptions): Promise<string> {
	let command: SubagentsCommand;
	try {
		command = parseSubagentsCommand(options.args);
	} catch (error) {
		return `${errorMessage(error)}\n\n${usage()}`;
	}

	try {
		switch (command.action) {
			case "list":
				return await listRuns(options.channelId, options.discovery);
			case "show":
				return await showRun(options.channelId, command.runId);
			case "cancel":
				return await cancelRun(options.channelId, command.runId);
		}
	} catch (error) {
		return `Could not ${command.action} subagent run(s): ${errorMessage(error)}`;
	}
}
