export type BuiltInCommandName =
	| "help"
	| "steer"
	| "followup"
	| "stop"
	| "events"
	| "tasks"
	| "status"
	| "usage"
	| "context";

/** The four transport commands handled by `ChannelRunner.handleBuiltinCommand`. */
export type RunnerBuiltInCommandName = "help" | "stop" | "steer" | "followup" | "context";

export interface BuiltInCommand {
	name: BuiltInCommandName;
	args: string;
	rawText: string;
}

/** A parsed built-in whose name is one the runner handles directly. */
export type RunnerBuiltInCommand = BuiltInCommand & { name: RunnerBuiltInCommandName };

/**
 * Single source of truth for a slash command's metadata. `HELP_TEXT`, the TUI
 * autocomplete list, the busy-time hint, and the known-command set are all
 * derived from these tables — do not hand-maintain those in parallel.
 */
export interface CommandSpec {
	name: string;
	/** Argument syntax shown after the name, e.g. `<message>` or `[7d|month]`. */
	argumentHint?: string;
	/** One-line description; used for `/help` and for editor autocomplete. */
	description: string;
	/** Concrete invocations shown under the command in `/help`. */
	examples?: string[];
	/** Whether the command is accepted while a task is streaming. */
	availableWhileBusy?: boolean;
}

/**
 * Transport commands: handled directly by the runtime layer (never sent to the
 * LLM). All of them are accepted while a task is streaming.
 */
export const BUILT_IN_COMMANDS: readonly CommandSpec[] = [
	{
		name: "help",
		description: "显示命令帮助",
		examples: ["/help"],
		availableWhileBusy: true,
	},
	{
		name: "stop",
		description: "停止当前回合；若该回合由任务驱动，同时暂停该任务",
		examples: ["/stop"],
		availableWhileBusy: true,
	},
	{
		name: "steer",
		argumentHint: "<消息>",
		description: "在当前工具步骤结束后调整正在运行的回合",
		examples: ["/steer Use the Shanghai time zone and summarize only the latest updates"],
		availableWhileBusy: true,
	},
	{
		name: "followup",
		argumentHint: "<消息>",
		description: "排队一条请求，等当前回合结束后再执行",
		examples: ["/followup After that, draft a short executive summary"],
		availableWhileBusy: true,
	},
	{
		name: "events",
		argumentHint: "<list|show|delete|history>",
		description: "管理定时事件文件，查看事件历史",
		examples: [
			"/events list",
			"/events show weekly-review",
			"/events delete weekly-review",
			"/events history weekly-review",
		],
		availableWhileBusy: true,
	},
	{
		name: "tasks",
		argumentHint:
			"[show <id>|archive|approve <id>|pause <id>|resume <id>|run <id>|set <id> <字段> <值>|stats [id]|doctor]",
		description: "查看、诊断并直接编辑本频道的任务台账；`approve` 用于放行外部副作用",
		examples: [
			"/tasks",
			"/tasks show weekly-report",
			"/tasks archive",
			"/tasks approve publish-release",
			"/tasks pause weekly-report",
			"/tasks resume weekly-report",
			"/tasks run weekly-report",
			"/tasks set weekly-report wake 2026-07-28T09:00:00+08:00",
			"/tasks set weekly-report next 跑一遍构建并贴出失败堆栈",
			"/tasks stats weekly-report",
			"/tasks doctor",
		],
		availableWhileBusy: true,
	},
	{
		name: "status",
		description: "显示运行状态、当前模型、上下文占用、运行时长与版本",
		examples: ["/status"],
		availableWhileBusy: true,
	},
	{
		name: "usage",
		argumentHint: "[7d|month]",
		description: "显示本频道与全局的模型花费和 token，按类型与模型分解",
		examples: ["/usage", "/usage 7d", "/usage month"],
		availableWhileBusy: true,
	},
	{
		name: "context",
		argumentHint: "[detail]",
		description: "显示实际发给模型的内容：system prompt 分段、工具 schema、上一回合上下文",
		examples: ["/context", "/context detail"],
		// Read-only accounting of state the runner already holds: no LLM call, no session
		// access, so it answers mid-turn like /status and /usage do.
		availableWhileBusy: true,
	},
];

/**
 * Session commands: handled inside the Pipiclaw session layer (SDK command
 * extension) during the turn. Descriptions here are the source shared with the
 * extension registration in `command-extension.ts`.
 */
export const SESSION_COMMANDS: readonly CommandSpec[] = [
	{
		name: "memory",
		argumentHint: "[status|list|show <id>|pending]",
		description: "查看生效记忆、元数据、召回统计、墓碑与待确认建议",
		examples: ["/memory status", "/memory list", "/memory show m-1234abcd", "/memory pending"],
	},
	{
		name: "session",
		description: "显示当前会话状态、消息统计、token 用量与模型信息",
		examples: ["/session"],
	},
	{
		name: "thinking",
		argumentHint: "[off|minimal|low|medium|high|xhigh|max|cycle]",
		description: "查看或修改当前模型的思考档位",
		examples: ["/thinking", "/thinking medium", "/thinking cycle"],
	},
	{
		name: "model",
		argumentHint: "[provider/modelId|modelId]",
		description: "查看当前模型，或用精确名/唯一匹配的子串切换模型",
		examples: ["/model", "/model anthropic/claude-opus-4-6"],
	},
	{
		name: "new",
		description: "开启新会话",
		examples: ["/new"],
	},
	{
		name: "compact",
		argumentHint: "[压缩要求]",
		description: "手动压缩当前会话上下文，可附加自定义要求",
		examples: ["/compact", "/compact Keep the latest TODOs and decisions"],
	},
];

const BUILT_IN_NAMES = new Set<string>(BUILT_IN_COMMANDS.map((command) => command.name));
const KNOWN_COMMAND_NAMES = new Set<string>([...BUILT_IN_NAMES, ...SESSION_COMMANDS.map((command) => command.name)]);

/** Look up the shared description for a session command (used by the SDK extension). */
export function sessionCommandDescription(name: string): string {
	const spec = SESSION_COMMANDS.find((command) => command.name === name);
	if (!spec) {
		throw new Error(`Unknown session command: ${name}`);
	}
	return spec.description;
}

export function isBuiltInCommandName(name: string): name is BuiltInCommandName {
	return BUILT_IN_NAMES.has(name);
}

const RUNNER_BUILT_IN_NAMES = new Set<string>(["help", "stop", "steer", "followup", "context"]);

/** Narrow a parsed built-in to one `ChannelRunner.handleBuiltinCommand` accepts. */
export function isRunnerBuiltInCommand(command: BuiltInCommand): command is RunnerBuiltInCommand {
	return RUNNER_BUILT_IN_NAMES.has(command.name);
}

/** Comma-separated list of commands usable while a task is streaming (names only). */
export function formatBusyCommandList(): string {
	return BUILT_IN_COMMANDS.filter((command) => command.availableWhileBusy)
		.map((command) => `\`/${command.name}\``)
		.join(", ");
}

function renderCommandEntry(spec: CommandSpec): string {
	const header = `- \`/${spec.name}${spec.argumentHint ? ` ${spec.argumentHint}` : ""}\``;
	const lines = [header, `  ${spec.description}`];
	for (const example of spec.examples ?? []) {
		lines.push(`  示例：\`${example}\``);
	}
	return lines.join("\n");
}

function renderHelpText(): string {
	const transport = BUILT_IN_COMMANDS.map(renderCommandEntry).join("\n");
	const session = SESSION_COMMANDS.map(renderCommandEntry).join("\n");
	return `# 斜杠命令

Pipiclaw 的命令分为两组。

## 传输层命令

由钉钉传输层／运行时直接处理，回合进行中也可以用。

${transport}

回合进行中发送的普通消息按 \`busyMessageDefault\` 处理，默认是 \`steer\`；在 channel.json 里设为 \`followUp\`（或 \`followup\`）则改为排队到当前回合之后执行。

channel.json 的 \`responseMode\` 控制输出形态：\`full_progress_then_plain_final\`（默认）流式展示完整进度，再发一条纯文本结论；\`rolling_progress_then_plain_final\` 只保留最近几条进度，收尾给一行摘要；\`final_card_only\` 隐藏进度，只在 AI 卡片里给最终结果。

## 会话层命令

由 Pipiclaw 会话层处理，需要在空闲时使用：

${session}
`;
}

const HELP_TEXT = renderHelpText();

/** Extract the lower-cased command name from a slash input, or `null` if not a slash command. */
export function slashCommandName(text: string): string | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) {
		return null;
	}
	const match = /^\/(\S+)/.exec(trimmed);
	return match ? match[1].toLowerCase() : null;
}

/**
 * True if `text` is a slash command the runtime or session layer knows how to
 * handle: a built-in transport command, a session command, or a skill
 * invocation (`/skill:name`). Prompt-template names are resolved separately by
 * the runner, which has the session's live template list.
 */
export function isKnownCommandName(name: string): boolean {
	return KNOWN_COMMAND_NAMES.has(name) || name.startsWith("skill:");
}

export function formatUnknownCommandMessage(name: string): string {
	return `未知命令 \`/${name}\`。发送 \`/help\` 查看可用命令。`;
}

export function parseBuiltInCommand(text: string): BuiltInCommand | null {
	const rawText = text.trim();
	if (!rawText.startsWith("/")) {
		return null;
	}

	// Split on the first run of whitespace (space, tab, or newline) so that a
	// mobile client that inserts a newline after the command — `/steer⏎msg` —
	// still parses instead of silently falling through to the model.
	const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(rawText);
	if (!match) {
		return null;
	}

	const rawName = match[1].toLowerCase();
	const args = (match[2] ?? "").trim();

	if (isBuiltInCommandName(rawName)) {
		return { name: rawName, args, rawText };
	}
	return null;
}

export function renderBuiltInHelp(): string {
	return HELP_TEXT;
}
