export type BuiltInCommandName =
	| "help"
	| "steer"
	| "followup"
	| "stop"
	| "events"
	| "tasks"
	| "status"
	| "usage"
	| "context"
	| "subagents"
	| "project"
	| "skills";

/** The four transport commands handled by `ChannelRunner.handleBuiltinCommand`. */
export type RunnerBuiltInCommandName = "help" | "stop" | "steer" | "followup" | "context";

/**
 * The commands with no mid-turn state to touch: each renders a text report from disk/in-memory
 * state and is dispatched the same way whether a turn is running or the channel is idle. Derived
 * from `BuiltInCommandName` rather than hand-listed, so it can never drift from the source table.
 */
export type RuntimeCommandName = Exclude<BuiltInCommandName, "help" | "steer" | "followup" | "stop">;

export interface BuiltInCommand {
	name: BuiltInCommandName;
	args: string;
	rawText: string;
}

/** A parsed built-in whose name is one the runner handles directly. */
export type RunnerBuiltInCommand = BuiltInCommand & { name: RunnerBuiltInCommandName };

/** One subcommand entry, as broadcast by `/help <name>` and consumed by `renderSubcommandUsage`. */
export interface CommandSubSpec {
	name: string;
	/** Argument syntax after the subcommand name, e.g. `<id>` or `<id> <wake|next|deadline> <值>`. */
	args?: string;
	description: string;
	/** A concrete invocation; omitted only for the bare "no args" form. */
	example?: string;
}

/**
 * Single source of truth for a slash command's metadata. `HELP_TEXT`, the TUI
 * autocomplete list, the busy-time hint, and the known-command set are all
 * derived from these tables — do not hand-maintain those in parallel.
 *
 * `subcommands`, where present, is *also* the single source for that command's own `usage()`
 * text (via `renderSubcommandUsage`) and for `/help <name>`'s detail view — see
 * `test/commands-subcommands.test.ts`, which feeds every `subcommands[].example` back into the
 * matching parser so the broadcast list and the parser can never drift apart again (review
 * 2026-08-24 §1.1).
 */
export interface CommandSpec {
	name: string;
	/** Argument syntax shown after the name, e.g. `<message>` or `[7d|month]`. */
	argumentHint?: string;
	/** One-line description; used for `/help` and for editor autocomplete. */
	description: string;
	/** Concrete invocations shown under the command in `/help`; only used when `subcommands` is absent. */
	examples?: string[];
	/** Whether the command is accepted while a task is streaming. */
	availableWhileBusy?: boolean;
	/**
	 * True for the built-ins `ChannelRunner.handleBuiltinCommand` handles directly (help/stop/
	 * steer/followup/context); false for the stateless runtime reports (events/tasks/status/
	 * usage/subagents/project) dispatched through `runRuntimeCommand`. Meaningful only within
	 * `BUILT_IN_COMMANDS`.
	 */
	runnerHandled?: boolean;
	/** Broadcast list of this command's subcommands, for commands with a `/<name> <action> ...` shape. */
	subcommands?: CommandSubSpec[];
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
		runnerHandled: true,
	},
	{
		name: "stop",
		description: "停止当前回合；若该回合由任务驱动，同时暂停该任务",
		examples: ["/stop"],
		availableWhileBusy: true,
		runnerHandled: true,
	},
	{
		name: "steer",
		argumentHint: "<消息>",
		description: "在当前工具步骤结束后调整正在运行的回合",
		examples: ["/steer Use the Shanghai time zone and summarize only the latest updates"],
		availableWhileBusy: true,
		runnerHandled: true,
	},
	{
		name: "followup",
		argumentHint: "<消息>",
		description: "排队一条请求，等当前回合结束后再执行",
		examples: ["/followup After that, draft a short executive summary"],
		availableWhileBusy: true,
		runnerHandled: true,
	},
	{
		name: "events",
		argumentHint: "<list|show|delete|history>",
		description: "管理定时事件文件，查看事件历史",
		availableWhileBusy: true,
		subcommands: [
			{ name: "list", description: "列出所有定时事件", example: "/events list" },
			{ name: "show", args: "<name>", description: "查看单个事件的完整内容", example: "/events show weekly-review" },
			{
				name: "delete",
				args: "<name>",
				description: "删除一个事件（回显被删内容，误删可从聊天记录恢复）",
				example: "/events delete weekly-review",
			},
			{
				name: "history",
				args: "[name]",
				description: "查看事件触发历史，不带参数显示全部",
				example: "/events history weekly-review",
			},
		],
	},
	{
		name: "tasks",
		argumentHint: "[show <id>|archive|pause <id>|resume <id>|run <id>|set <id> <字段> <值>|doctor]",
		description: "查看、诊断并直接编辑本频道的任务台账；pause 只停用执行，保留阶段与 wake",
		availableWhileBusy: true,
		subcommands: [
			{ name: "list", description: "列出本频道进行中的任务（默认动作，可省略）", example: "/tasks" },
			{
				name: "show",
				args: "<id>",
				description: "查看单个任务文件（进行中或已归档）",
				example: "/tasks show weekly-report",
			},
			{ name: "archive", description: "列出已归档（已关闭）的任务", example: "/tasks archive" },
			{
				name: "pause",
				args: "<id>",
				description: "停止该任务的自动执行（保留当前阶段与 wake）",
				example: "/tasks pause weekly-report",
			},
			{
				name: "resume",
				args: "<id>",
				description: "重新启用该任务，按当前阶段继续",
				example: "/tasks resume weekly-report",
			},
			{
				name: "run",
				args: "<id>",
				description: "恢复并立即排入一次执行（需要运行时可用）",
				example: "/tasks run weekly-report",
			},
			{
				name: "set",
				args: "<id> <wake|next|deadline> <值>",
				description: "直接改一个字段，不花一个 LLM 回合",
				example: "/tasks set weekly-report wake 2026-07-28T09:00:00+08:00",
			},
			{ name: "doctor", description: "只读检查任务/事件一致性", example: "/tasks doctor" },
		],
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
		runnerHandled: true,
	},
	{
		name: "subagents",
		argumentHint: "<list [running|failed|all]|show <id>|output <id>|cancel <id|all>|roles [name]>",
		description: "查看与控制委派 run（内置与外部）、浏览角色目录；cancel 不经过模型，直接终止",
		// A human control path independent of the model (spec 040, D6): /stop no longer kills a
		// dispatched delegation, so cancel must work even when the model/turn is unavailable.
		availableWhileBusy: true,
		subcommands: [
			{
				name: "list",
				args: "[running|failed|all]",
				description: "运行中的 run + 最近完成的几条（不带筛选时）",
				example: "/subagents list failed",
			},
			{
				name: "show",
				args: "<runId>",
				description: "单个 run 的完整详情（含实际 argv、stderr 尾部）",
				example: "/subagents show run_a1b2c3",
			},
			{
				name: "output",
				args: "<runId>",
				description: "该 run 的文本产出（output.md 尾部）",
				example: "/subagents output run_a1b2c3",
			},
			{
				name: "cancel",
				args: "<runId|all>",
				description: "直接终止，不经过模型",
				example: "/subagents cancel run_a1b2c3",
			},
			{
				name: "roles",
				args: "[name]",
				description: "角色目录；带 name 时查看单个角色的详情",
				example: "/subagents roles builder-hard",
			},
		],
	},
	{
		name: "project",
		argumentHint: "[set <absolute-path>|reset]",
		description: "查看或切换本频道的项目目录（文件工具/shell 的工作面）；set/reset 需频道空闲",
		// The read form answers like /status; set/reset validate idleness themselves and reply
		// with a plain error instead of blocking the built-in-command dispatch path.
		availableWhileBusy: true,
		subcommands: [
			{ name: "show", description: "查看当前频道的项目目录与访问边界（默认动作，可省略）", example: "/project" },
			{
				name: "set",
				args: "<absolute-path>",
				description: "切换项目目录（需频道空闲，且目录在允许的可选根内）",
				example: "/project set /home/me/projects/foo",
			},
			{ name: "reset", description: "切回 app 默认项目目录", example: "/project reset" },
		],
	},
	{
		name: "skills",
		argumentHint: "[list|show <name>]",
		description: "列出工作区 skills（含未加载及原因），或查看单个 skill 的完整正文",
		availableWhileBusy: true,
		subcommands: [
			{ name: "list", description: "列出工作区 skills（默认动作，可省略）", example: "/skills" },
			{
				name: "show",
				args: "<name>",
				description: "查看单个 skill 的元信息与正文",
				example: "/skills show release-checklist",
			},
		],
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
		argumentHint: "[status|list|show <id>|recent]",
		description: "查看生效记忆、元数据、召回统计、墓碑与近期写入/删除活动",
		subcommands: [
			{ name: "status", description: "记忆状态概览", example: "/memory status" },
			{ name: "list", description: "列出生效的记忆条目", example: "/memory list" },
			{
				name: "show",
				args: "<entry-id>",
				description: "查看单条记忆的内容与元数据",
				example: "/memory show m-1234abcd",
			},
			{ name: "recent", description: "查看最近 7 天的记忆写入/删除活动", example: "/memory recent" },
		],
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
		availableWhileBusy: true,
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
const ALL_COMMANDS: readonly CommandSpec[] = [...BUILT_IN_COMMANDS, ...SESSION_COMMANDS];

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

const SESSION_COMMAND_NAMES = new Set<string>(SESSION_COMMANDS.map((command) => command.name));

/** True for a session-layer command name (`/model`, `/compact`, …) — needs the idle session layer. */
export function isSessionCommandName(name: string): boolean {
	return SESSION_COMMAND_NAMES.has(name);
}

const RUNNER_BUILT_IN_NAMES = new Set<string>(
	BUILT_IN_COMMANDS.filter((command) => command.runnerHandled).map((command) => command.name),
);

/** Narrow a parsed built-in to one `ChannelRunner.handleBuiltinCommand` accepts. */
export function isRunnerBuiltInCommand(command: BuiltInCommand): command is RunnerBuiltInCommand {
	return RUNNER_BUILT_IN_NAMES.has(command.name);
}

/** Comma-separated list of commands usable while a task is streaming (names only). */
export function formatBusyCommandList(): string {
	return [...BUILT_IN_COMMANDS, ...SESSION_COMMANDS]
		.filter((command) => command.availableWhileBusy)
		.map((command) => `\`/${command.name}\``)
		.join(", ");
}

/**
 * Renders a command's subcommand table as its `usage()` text — the single source `task-commands.ts`,
 * `event-commands.ts`, `subagent-commands.ts`, `project-commands.ts`, and `memory/commands.ts` call
 * on a parse error, replacing five hand-written `usage()` bodies (review 2026-08-24 §3.1).
 */
export function renderSubcommandUsage(name: string): string {
	const spec = ALL_COMMANDS.find((command) => command.name === name);
	if (!spec?.subcommands?.length) {
		return `**/${name}**`;
	}
	const lines = spec.subcommands.map(
		(sub) => `- \`/${name} ${sub.name}${sub.args ? ` ${sub.args}` : ""}\` — ${sub.description}`,
	);
	return `**/${name}**\n\n${lines.join("\n")}`;
}

/** One line per command: name + description, no args/examples. Used by the top-level `/help`. */
function renderCommandSummaryLine(spec: CommandSpec): string {
	return `- \`/${spec.name}\` — ${spec.description}`;
}

/** The full detail for one command: argument syntax, subcommands or examples. Used by `/help <name>`. */
function renderCommandDetail(spec: CommandSpec): string {
	const header = `**/${spec.name}${spec.argumentHint ? ` ${spec.argumentHint}` : ""}**`;
	const lines = [header, spec.description];
	if (spec.subcommands?.length) {
		for (const sub of spec.subcommands) {
			const base = `- \`/${spec.name} ${sub.name}${sub.args ? ` ${sub.args}` : ""}\` — ${sub.description}`;
			lines.push(sub.example ? `${base}（例：\`${sub.example}\`）` : base);
		}
	} else if (spec.examples?.length) {
		for (const example of spec.examples) {
			lines.push(`- 示例：\`${example}\``);
		}
	}
	return lines.join("\n");
}

/** `/help <name>`'s content, or `undefined` for an unknown command name. */
export function renderCommandHelp(name: string): string | undefined {
	const spec = ALL_COMMANDS.find((command) => command.name === name);
	return spec ? renderCommandDetail(spec) : undefined;
}

function renderHelpText(): string {
	const transport = BUILT_IN_COMMANDS.map(renderCommandSummaryLine).join("\n");
	const session = SESSION_COMMANDS.map(renderCommandSummaryLine).join("\n");
	return `**斜杠命令**

Pipiclaw 的命令分为两组；用 \`/help <命令名>\` 查看某个命令的详细用法和示例（例如 \`/help tasks\`）。

**传输层命令** · 由钉钉传输层／运行时直接处理，回合进行中也可以用

${transport}

回合进行中发送的普通消息按 \`busyMessageDefault\` 处理，默认是 \`steer\`；在 channel.json 里设为 \`followUp\`（或 \`followup\`）则改为排队到当前回合之后执行。channel.json 的 \`responseMode\` 控制输出形态，详见文档。

**会话层命令** · 由 Pipiclaw 会话层处理，需要在空闲时使用

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
 * True if `text` is a slash command the runtime or session layer knows how to handle: a built-in
 * transport command, a session command, or a skill invocation (`/skill:name`) naming a skill
 * actually present in `knownSkillNames`. Prompt-template names are resolved separately by the
 * runner, which has the session's live template list.
 *
 * `knownSkillNames` used to be unchecked — any `/skill:<anything>` counted as known and got a full
 * LLM turn, bypassing the "unknown command never reaches the model" guarantee this function exists
 * to provide (review 2026-08-24 §1.9). Omitting `knownSkillNames` (no roster available) rejects
 * every `skill:` name rather than trusting it.
 */
export function isKnownCommandName(name: string, knownSkillNames?: Iterable<string>): boolean {
	if (KNOWN_COMMAND_NAMES.has(name)) {
		return true;
	}
	if (!name.startsWith("skill:") || !knownSkillNames) {
		return false;
	}
	const skillName = name.slice("skill:".length);
	for (const candidate of knownSkillNames) {
		if (candidate === skillName) return true;
	}
	return false;
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

/**
 * `/help` (top-level command listing) or `/help <name>` (that command's subcommands/examples) —
 * two-level help so the top level stays scannable instead of the ~40-line wall of every example
 * (review 2026-08-24 §2.2.1). `args` is the raw text after `/help`.
 */
export function renderBuiltInHelp(args = ""): string {
	const name = args.trim().toLowerCase();
	if (!name) {
		return HELP_TEXT;
	}
	const detail = renderCommandHelp(name);
	if (detail) {
		return detail;
	}
	return `未找到命令 \`/${name}\`。\n\n${HELP_TEXT}`;
}
