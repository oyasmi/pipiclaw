import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { renderSubcommandUsage } from "../commands/catalog.js";
import { formatDuration } from "../shared/duration.js";
import { errorMessage } from "../shared/text-utils.js";
import type { SubAgentConfig, SubAgentDiscoveryResult } from "../subagents/discovery.js";
import { formatCost, formatRunDuration, harnessLabel } from "../subagents/format.js";
import { getSubAgentRunManager, type RunNotice, type RunRecord, type RunResolution } from "../subagents/runs.js";

/**
 * `/subagents` — the human control path that does not depend on the model (spec 040 D6, polished
 * by spec 041). Mirrors `task-commands.ts`'s shape: pure functions returning markdown, no
 * bot/event coupling.
 */

export interface HandleSubagentsCommandOptions {
	args: string;
	channelId: string;
	/** Best-effort role-directory snapshot for `roles` / the overview tail; omitted when no runner
	 *  is currently active for this channel (mirrors how `/status` degrades without a live runner). */
	discovery?: SubAgentDiscoveryResult;
	/** Fallback used only when `discovery` is absent: resolves the role directory from disk without
	 *  a live `ChannelRunner` (spec 041). Lazy — never called unless a `roles` view is actually rendered. */
	getDetachedDiscovery?: () => Promise<SubAgentDiscoveryResult>;
}

type ListFilter = "default" | "running" | "failed" | "all";

type SubagentsCommand =
	| { action: "list"; filter: ListFilter }
	| { action: "show"; ref: string }
	| { action: "output"; ref: string }
	| { action: "cancel"; ref: string }
	| { action: "roles"; name?: string };

function usage(): string {
	return `${renderSubcommandUsage("subagents")}\n\n\`runId\` 支持不带 \`run_\` 前缀的简写，只要能唯一匹配即可，例如 \`show a1b2c3\`。`;
}

/** Exported so `test/commands-subcommands.test.ts` can feed every broadcast example back through it. */
export function parseSubagentsCommand(args: string): SubagentsCommand {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const action = parts[0];

	if (!action || action === "list") {
		const filterArg = parts[1];
		if (!filterArg) {
			if (parts.length > 1) throw new Error("用法：/subagents [list] [running|failed|all]");
			return { action: "list", filter: "default" };
		}
		if ((filterArg !== "running" && filterArg !== "failed" && filterArg !== "all") || parts.length > 2) {
			throw new Error("用法：/subagents list [running|failed|all]");
		}
		return { action: "list", filter: filterArg };
	}
	if (action === "show") {
		if (!parts[1] || parts.length > 2) throw new Error("用法：/subagents show <runId>");
		return { action: "show", ref: parts[1] };
	}
	if (action === "output") {
		if (!parts[1] || parts.length > 2) throw new Error("用法：/subagents output <runId>");
		return { action: "output", ref: parts[1] };
	}
	if (action === "cancel") {
		if (!parts[1] || parts.length > 2) throw new Error("用法：/subagents cancel <runId|all>");
		return { action: "cancel", ref: parts[1] };
	}
	if (action === "roles") {
		if (parts.length > 2) throw new Error("用法：/subagents roles [name]");
		return { action: "roles", name: parts[1] };
	}
	throw new Error(`未知的 /subagents 子命令：${action}`);
}

function statusLabel(status: RunRecord["status"]): string {
	switch (status) {
		case "running":
			return "运行中";
		case "completed":
			return "已完成";
		case "failed":
			return "失败";
		case "cancelled":
			return "已取消";
		case "lost":
			return "丢失（daemon 重启或无法确认）";
	}
}

function formatRunLine(record: RunRecord): string {
	const bits = [harnessLabel(record), formatRunDuration(record)];
	if (record.taskId) bits.push(`task ${record.taskId}`);
	if (record.leaseKey) bits.push("持有写锁");
	const cost = formatCost(record);
	if (cost) bits.push(cost);
	const header = `- \`${record.runId}\` ${record.agent} (${bits.join(", ")}) — ${statusLabel(record.status)} — "${record.label}"`;
	if (record.status === "failed" && record.failureReason) {
		return `${header}（失败原因：${record.failureReason}）`;
	}
	return header;
}

async function resolveDiscovery(options: HandleSubagentsCommandOptions): Promise<SubAgentDiscoveryResult | undefined> {
	if (options.discovery) return options.discovery;
	if (!options.getDetachedDiscovery) return undefined;
	try {
		return await options.getDetachedDiscovery();
	} catch {
		return undefined;
	}
}

function formatRolesTail(discovery: SubAgentDiscoveryResult): string {
	const unavailable = discovery.agents.filter((agent) => agent.unavailable);
	const available = discovery.agents.length - unavailable.length;
	const parts = [`角色目录：${available} 个可用`];
	if (unavailable.length > 0) parts.push(`${unavailable.length} 个不可用`);
	let line = `${parts.join("，")} — 用 /subagents roles 查看`;
	for (const warning of discovery.warnings) {
		line += `\n⚠ discovery: ${warning}`;
	}
	return line;
}

const DEFAULT_LIST_COMPLETED_LIMIT = 5;
/** Spec 042 D9: `running`/`failed`/`all` had no cap at all — a long-lived channel with thousands
 *  of historical runs (GC now reclaims them after 7 days, but that is still a lot in a busy week)
 *  would otherwise dump an unbounded list into a single reply. */
const LIST_FILTER_CAP = 50;

function capListForDisplay<T>(records: T[]): { shown: T[]; truncatedNote?: string } {
	if (records.length <= LIST_FILTER_CAP) return { shown: records };
	return {
		shown: records.slice(0, LIST_FILTER_CAP),
		truncatedNote: `显示最近 ${LIST_FILTER_CAP} 条，共 ${records.length} 条——用更具体的筛选缩小范围。`,
	};
}

async function listRuns(options: HandleSubagentsCommandOptions, filter: ListFilter): Promise<string> {
	const records = getSubAgentRunManager(options.channelId).list();
	if (records.length === 0) return "**委派 Run**\n\n没有委派记录。";

	const running = records.filter((record) => record.status === "running").sort((a, b) => b.startedAt - a.startedAt);
	const terminal = records
		.filter((record) => record.status !== "running")
		.sort((a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt));

	const sections: string[] = [];

	if (filter === "running") {
		const { shown, truncatedNote } = capListForDisplay(running);
		sections.push(shown.length === 0 ? "没有正在运行的 run。" : shown.map(formatRunLine).join("\n"));
		if (truncatedNote) sections.push(truncatedNote);
		return `**委派 Run** · 运行中\n\n${sections.join("\n\n")}`;
	}
	if (filter === "failed") {
		const { shown, truncatedNote } = capListForDisplay(terminal.filter((record) => record.status === "failed"));
		sections.push(shown.length === 0 ? "没有失败的 run。" : shown.map(formatRunLine).join("\n"));
		if (truncatedNote) sections.push(truncatedNote);
		return `**委派 Run** · 失败\n\n${sections.join("\n\n")}`;
	}
	if (filter === "all") {
		const { shown, truncatedNote } = capListForDisplay([...running, ...terminal]);
		sections.push(shown.map(formatRunLine).join("\n"));
		if (truncatedNote) sections.push(truncatedNote);
		return `**委派 Run** · 全部（${records.length}）\n\n${sections.join("\n\n")}`;
	}

	// default: an overview — every running run, plus a capped tail of recent completions.
	if (running.length > 0) {
		sections.push(`**运行中**（${running.length}）\n${running.map(formatRunLine).join("\n")}`);
	}
	const shown = terminal.slice(0, DEFAULT_LIST_COMPLETED_LIMIT);
	if (shown.length > 0) {
		const countNote =
			terminal.length > shown.length ? `显示 ${shown.length} / 共 ${terminal.length}` : `${shown.length}`;
		sections.push(`**最近完成**（${countNote}）\n${shown.map(formatRunLine).join("\n")}`);
	}
	if (sections.length === 0) sections.push("没有委派记录。");

	const discovery = await resolveDiscovery(options);
	if (discovery) sections.push(formatRolesTail(discovery));
	sections.push("用 `/subagents show <runId>` 看详情，`/subagents output <runId>` 看产出。");

	return `**委派 Run**\n\n${sections.join("\n\n")}`;
}

const STDERR_TAIL_CHARS = 2_000;
const OUTPUT_TAIL_CHARS = 4_000;

function formatRunResolution(resolution: RunResolution, ref: string): string | undefined {
	if (resolution.kind === "not_found") return `未找到 run：\`${ref}\``;
	if (resolution.kind === "ambiguous") {
		const candidates = resolution.candidates.map((record) => `\`${record.runId}\` (${record.agent})`).join("、");
		return `"${ref}" 匹配到多个 run：${candidates}。请提供更完整的 runId。`;
	}
	return undefined;
}

async function showRun(channelId: string, ref: string): Promise<string> {
	const resolution = getSubAgentRunManager(channelId).resolveRef(ref);
	const error = formatRunResolution(resolution, ref);
	if (error || resolution.kind !== "found") return error ?? `未找到 run：\`${ref}\``;
	const record = resolution.record;

	const lines = [
		`**Run \`${record.runId}\`**`,
		`- 角色：${record.agent} (${harnessLabel(record)}, ${record.source})`,
		`- 标签：${record.label}`,
		`- 状态：${statusLabel(record.status)}（耗时 ${formatRunDuration(record)}）`,
	];
	if (record.failureReason) lines.push(`- 失败原因：${record.failureReason}`);
	if (record.verificationVerdict) {
		lines.push(
			`- 验收结论：${record.verificationVerdict === "pass" ? "PASS" : "FAIL"}${record.verificationStrength === "advisory" ? "（advisory）" : ""}`,
		);
	}
	lines.push(`- 开始：${new Date(record.startedAt).toLocaleString()}`);
	if (record.finishedAt) lines.push(`- 结束：${new Date(record.finishedAt).toLocaleString()}`);
	lines.push(
		`- purpose：${record.purpose}`,
		`- 工作目录：\`${record.workingDirectory}\``,
		`- 产物目录：\`${record.artifactDir}\``,
	);
	if (record.taskId) lines.push(`- 所属任务：${record.taskId}`);
	if (record.leaseKey) lines.push("- 持有写锁：是");
	if (record.model) lines.push(`- 模型：${record.model}`);
	const cost = formatCost(record);
	lines.push(
		`- usage：input=${record.usage.input} output=${record.usage.output}${cost ? ` cost=${cost}` : record.costKnown ? "" : "（cost 未知）"}`,
	);
	if (record.argv) lines.push("", "实际 argv：", "```", JSON.stringify(record.argv), "```");
	if (record.parserVersion !== undefined || record.cliVersion) {
		// Spec 042 D12: lets a human tell "the target CLI's own protocol drifted out from under this
		// adapter" apart from "the agent itself failed" — the two look identical from status alone.
		const parts = [];
		if (record.parserVersion !== undefined) parts.push(`parserVersion=${record.parserVersion}`);
		parts.push(`cliVersion=${record.cliVersion ?? "(未知)"}`);
		lines.push(`- 适配器/CLI：${parts.join("，")}`);
	}
	if (record.invocationWarnings?.length) {
		lines.push("", "⚠ 派发时的警告：", ...record.invocationWarnings.map((warning) => `- ${warning}`));
	}
	if (record.sessionId) lines.push(`- sessionId：\`${record.sessionId}\`（可用于 subagent_run op=follow_up）`);

	if (record.runtime === "external") {
		const stderrTail = await readFile(join(record.artifactDir, "stderr.log"), "utf-8")
			.then((text) => text.slice(-STDERR_TAIL_CHARS))
			.catch(() => undefined);
		if (stderrTail?.trim()) {
			lines.push("", "**stderr（尾部）**", "```", stderrTail, "```");
		}
	}
	return lines.join("\n");
}

async function showOutput(channelId: string, ref: string): Promise<string> {
	const resolution = getSubAgentRunManager(channelId).resolveRef(ref);
	const error = formatRunResolution(resolution, ref);
	if (error || resolution.kind !== "found") return error ?? `未找到 run：\`${ref}\``;
	const record = resolution.record;

	const outputText = await readFile(join(record.artifactDir, "output.md"), "utf-8").catch(() => undefined);
	if (!outputText?.trim()) {
		const runningNote = record.status === "running" ? "该 run 仍在运行，可能还没有产出。" : "该 run 没有文本产出。";
		return `**Run \`${record.runId}\` 的产出**\n\n${runningNote}产物目录：\`${record.artifactDir}\``;
	}
	const tail = outputText.slice(-OUTPUT_TAIL_CHARS);
	const truncatedNote =
		outputText.length > tail.length ? `（只显示末尾 ${OUTPUT_TAIL_CHARS} 字符，完整内容见上方产物目录）\n\n` : "";
	return `**Run \`${record.runId}\` 的产出**\n\n${truncatedNote}\`\`\`\n${tail}\n\`\`\``;
}

async function cancelRun(channelId: string, ref: string): Promise<string> {
	const manager = getSubAgentRunManager(channelId);
	if (ref === "all") {
		const running = manager.list().filter((record) => record.status === "running");
		if (running.length === 0) return "没有正在运行的 run。";
		const results = await Promise.all(
			running.map(async (record) => {
				const status = await manager.cancel(record.runId);
				return `- \`${record.runId}\` (${record.agent})：${status}`;
			}),
		);
		return `**已请求终止 ${running.length} 个 run**\n\n${results.join("\n")}`;
	}
	const resolution = manager.resolveRef(ref);
	const error = formatRunResolution(resolution, ref);
	if (error || resolution.kind !== "found") return error ?? `未找到 run：\`${ref}\``;
	const status = await manager.cancel(resolution.record.runId);
	return `已请求终止 run \`${resolution.record.runId}\`：${status}`;
}

function formatRoleSummaryLine(agent: SubAgentConfig): string {
	const kind = agent.runtime === "external" ? `外部/${agent.harness}` : "内置";
	const mutates = agent.mutates ?? (agent.tools.includes("write") || agent.tools.includes("edit") ? "write" : "read");
	const unavailable = agent.unavailable ? ` — ⚠ 不可用：${agent.unavailable}` : "";
	const modelLabel =
		agent.runtime === "external" ? (agent.externalModelRef ?? "CLI 决定") : (agent.modelRef ?? "默认");
	const thinkingLabel = agent.thinkingLevel ?? (agent.runtime === "external" ? "未设置" : "默认 medium");
	// Keyless by design: the four positions are fixed — runtime, mutates, model, thinking.
	return `- \`${agent.name}\` (${kind}, ${mutates}, ${modelLabel}, ${thinkingLabel}) — ${agent.description}${unavailable}`;
}

function formatRoleDetail(agent: SubAgentConfig): string {
	const kind = agent.runtime === "external" ? `外部/${agent.harness}` : "内置";
	const lines = [
		`**角色 \`${agent.name}\`**`,
		`- runtime：${kind}`,
		`- 来源：${agent.source} (${agent.filePath ?? "inline"})`,
		`- 说明：${agent.description}`,
	];
	if (agent.unavailable) lines.push(`- ⚠ 不可用：${agent.unavailable}`);
	lines.push(`- mutates：${agent.mutates ?? "(未声明，由 tools 推断)"}`);
	if (agent.runtime === "internal") {
		lines.push(
			`- model：${agent.modelRef ?? "默认"}`,
			`- thinking：${agent.thinkingLevel ?? "默认 medium"}`,
			`- tools：${agent.tools.join(", ") || "(none)"}`,
			`- 预算：maxTurns=${agent.maxTurns} maxToolCalls=${agent.maxToolCalls} maxWallTimeSec=${agent.maxWallTimeSec} bashTimeoutSec=${agent.bashTimeoutSec}`,
			`- contextMode：${agent.contextMode}，memory：${agent.memory}`,
		);
	} else {
		lines.push(
			`- command：\`${agent.command ?? ""}\`${agent.shell ? "（通过 shell 执行）" : ""}`,
			`- maxWallTimeSec：${agent.maxWallTimeSec}`,
		);
		lines.push(`- model：${agent.externalModelRef ?? "CLI 决定"}`);
		lines.push(`- thinking：${agent.thinkingLevel ?? "未设置（verify 派发默认 medium）"}`);
		// spec 042 D4: contextMode/memory are effective for external roles too (memory 默认 none，
		// 显式声明 session/relevant 才会把频道会话状态发给外部进程) — 显示出来而不是只在内置分支里说明。
		lines.push(`- contextMode：${agent.contextMode}，memory：${agent.memory}`);
		if (agent.memory !== "none") {
			lines.push(`- ⚠ 该角色会把频道会话状态/记忆片段发送给外部进程（memory: ${agent.memory}）`);
		}
	}
	if (agent.paths.length > 0) lines.push(`- paths：${agent.paths.join(", ")}`);
	// A full system prompt can be several KB; a role backed by a file is shown as a head snippet
	// with a pointer to that file instead (review 2026-08-24 §2.4/§3.2). Inline roles have no file
	// to point to, so they get a plain truncation note instead.
	lines.push("", "system prompt：", renderCappedPromptBlock(agent));
	return lines.join("\n");
}

const SYSTEM_PROMPT_SHOW_MAX_CHARS = 4_000;

function renderCappedPromptBlock(agent: SubAgentConfig): string {
	const prompt = agent.systemPrompt;
	if (prompt.length <= SYSTEM_PROMPT_SHOW_MAX_CHARS) {
		return `\`\`\`\n${prompt}\n\`\`\``;
	}
	const lastNewline = prompt.lastIndexOf("\n", SYSTEM_PROMPT_SHOW_MAX_CHARS);
	const head = prompt.slice(0, lastNewline > 0 ? lastNewline : SYSTEM_PROMPT_SHOW_MAX_CHARS).trimEnd();
	const nextStep = agent.filePath ? `完整内容见 \`${agent.filePath}\`` : "该角色内联定义，无文件可查看完整内容";
	return `\`\`\`\n${head}\n\`\`\`\n\n（内容过长已截断；${nextStep}）`;
}

async function showRoles(options: HandleSubagentsCommandOptions, name?: string): Promise<string> {
	const discovery = await resolveDiscovery(options);
	if (!discovery) {
		return "角色目录不可用：本频道尚未激活过运行时，且无法在离线状态下解析模型引用。先给这个频道发一条消息，再重试。";
	}
	if (name) {
		const agent = discovery.agents.find((candidate) => candidate.name === name);
		if (!agent) {
			const available = discovery.agents.length > 0 ? discovery.agents.map((a) => a.name).join(", ") : "(none)";
			return `未找到角色 "${name}"。可用角色：${available}`;
		}
		return formatRoleDetail(agent);
	}

	const internal = discovery.agents.filter((agent) => agent.runtime === "internal");
	const external = discovery.agents.filter((agent) => agent.runtime === "external");
	const sections = [`**角色目录**\n\n目录：\`${discovery.directory}\``];
	if (external.length > 0) sections.push(`**外部**\n${external.map(formatRoleSummaryLine).join("\n")}`);
	if (internal.length > 0) sections.push(`**内置**\n${internal.map(formatRoleSummaryLine).join("\n")}`);
	if (discovery.agents.length === 0) sections.push("目录为空。");
	for (const warning of discovery.warnings) sections.push(`⚠ discovery: ${warning}`);
	sections.push("用 `/subagents roles <name>` 看单个角色的详情。");
	return sections.join("\n\n");
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
				return await listRuns(options, command.filter);
			case "show":
				return await showRun(options.channelId, command.ref);
			case "output":
				return await showOutput(options.channelId, command.ref);
			case "cancel":
				return await cancelRun(options.channelId, command.ref);
			case "roles":
				return await showRoles(options, command.name);
		}
	} catch (error) {
		return `执行 /subagents ${command.action} 失败：${errorMessage(error)}`;
	}
}

/**
 * Render a `RunNotice` (P0-1/P1a) as a one-line reply — a confirmation, per the command reply
 * conventions. `notices: "off"` is enforced by the caller not invoking this at all; a `"settled"`
 * caller filters `kind: "progress"` out before calling. Returns `undefined` for a notice with
 * nothing worth showing (a progress step that never resolved to a label).
 */
export function renderRunNotice(notice: RunNotice): string | undefined {
	if (notice.kind === "progress") {
		return notice.step ? `⏳ ${notice.agent} · ${notice.step}` : undefined;
	}
	const durationText = formatDuration(notice.durationMs);
	switch (notice.status) {
		case "completed":
			return `✅ ${notice.agent} 完成 · ${durationText}`;
		case "cancelled":
			return `🛑 ${notice.agent} 已取消 · ${durationText}`;
		default:
			return `⚠️ ${notice.agent} 失败 · ${durationText}`;
	}
}
