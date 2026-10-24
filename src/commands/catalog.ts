/**
 * The product-wide slash-command catalog: every command's name, description, subcommands and
 * examples, plus the parsing and usage/help rendering built on top of them.
 *
 * It lives in its own domain, not in `src/agent/`, because the catalog describes commands handled
 * in three different layers — the runtime (`/tasks`, `/events`, `/subagents`, `/skills`), the agent session (`/model`, `/compact`, `/new`) and memory (`/memory`) — and is read
 * by all of them plus the TUI. Only the catalog and the reply shape are shared: each *handler*
 * still lives in the layer that owns the state it touches (`runtime/*-commands.ts`,
 * `memory/commands.ts`, `agent/session/command-extension.ts`). This file has no imports at all, so nothing
 * here can drag a layer into another one.
 *
 * The user-facing copy conventions these commands follow are recorded in AGENTS.md; `reply-limits.ts`
 * next to this file enforces rule 5 (the length budget).
 */

export type BuiltInCommandName =
	| "help"
	| "steer"
	| "followup"
	| "stop"
	| "desk"
	| "events"
	| "tasks"
	| "status"
	| "usage"
	| "context"
	| "subagents"
	| "skills";

/** The five transport commands handled by `ChannelRunner.handleBuiltinCommand`. */
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
 * autocomplete list, the busy-time hint (`formatBusyHint`), and the known-command set are all
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
	 * usage/subagents/skills) dispatched through `runRuntimeCommand`. Meaningful only within
	 * `BUILT_IN_COMMANDS`.
	 */
	runnerHandled?: boolean;
	/** Broadcast list of this command's subcommands, for commands with a `/<name> <action> ...` shape. */
	subcommands?: CommandSubSpec[];
	/** Extra paragraph shown only in `/help <name>`, for context too specific for the top-level list. */
	note?: string;
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
		description: "停止当前回合；若该回合是某个任务的一步，同时暂停该任务",
		examples: ["/stop"],
		availableWhileBusy: true,
		runnerHandled: true,
	},
	{
		name: "steer",
		argumentHint: "<消息>",
		description: "在当前工具调用结束后调整正在运行的回合",
		examples: ["/steer 改用上海时区，只汇总最新的更新"],
		note: "回合进行中直接发送的普通消息默认按 `/steer` 处理。部署者可以在 channel.json 的 `dingtalk` 段把 `busyMessageDefault` 设为 `followUp`，改为排到当前回合之后执行；`responseMode` 控制答复的输出形态。",
		availableWhileBusy: true,
		runnerHandled: true,
	},
	{
		name: "followup",
		argumentHint: "<消息>",
		description: "排队一条请求，等当前回合结束后再执行",
		examples: ["/followup 完成后再写一份简短的总结"],
		availableWhileBusy: true,
		runnerHandled: true,
	},
	{
		name: "desk",
		argumentHint: "[list|new <名字>|bind <名字>]",
		description: "进阶：创建工位，或把本频道切换到另一个工位",
		// list/new answer mid-turn; bind refuses by itself while this channel is busy (spec 058, D5).
		availableWhileBusy: true,
		subcommands: [
			{ name: "list", description: "列出所有工位和各自绑定的频道（默认动作，可省略）", example: "/desk" },
			{ name: "new", args: "<名字>", description: "创建一个空工位，不绑定任何频道", example: "/desk new research" },
			{
				name: "bind",
				args: "<名字>",
				description: "把本频道绑定到这个工位，同时解除原来的绑定；回合进行中不能执行",
				example: "/desk bind research",
			},
		],
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
		argumentHint:
			"[show <id>|log <id>|steer <id> <内容>|reply <id> <内容>|pause <id>|resume <id> [+steps N|+usd X]|archive|doctor]",
		description: "查看、指挥并诊断本工位的长程任务；pause 只停止自动执行，保留等待条件",
		availableWhileBusy: true,
		subcommands: [
			{ name: "list", description: "列出本工位进行中的任务（默认动作，可省略）", example: "/tasks" },
			{
				name: "show",
				args: "<id>",
				description: "查看任务说明、工作项、最近记录与用量",
				example: "/tasks show weekly-report",
			},
			{
				name: "log",
				args: "<id>",
				description: "查看该任务的记录（含每次委派的开始与结束）",
				example: "/tasks log weekly-report",
			},
			{ name: "archive", description: "列出已归档（已关闭）的任务", example: "/tasks archive" },
			{
				name: "pause",
				args: "<id>",
				description: "停止该任务的自动执行（保留等待条件）",
				example: "/tasks pause weekly-report",
			},
			{
				name: "resume",
				args: "<id> [+steps N|+usd X]",
				description: "重新启用该任务，可同时追加预算",
				example: "/tasks resume weekly-report +steps 20",
			},
			{
				name: "steer",
				args: "<id> <内容>",
				description: "把一条指示排给该任务的下一步，不打断正在执行的这一步",
				example: "/tasks steer weekly-report 先跑一遍 npm run check",
			},
			{
				name: "reply",
				args: "<id> <内容>",
				description: "回答该任务提出的问题，并让它继续",
				example: "/tasks reply weekly-report 合并到 master",
			},
			{ name: "doctor", description: "只读检查手工编辑造成的任务问题", example: "/tasks doctor" },
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
		description: "显示本工位与全局的模型花费和 token，按类型与模型分解",
		examples: ["/usage", "/usage 7d", "/usage month"],
		availableWhileBusy: true,
	},
	{
		name: "context",
		argumentHint: "[detail]",
		description: "显示实际发给模型的内容：系统提示词分段、工具定义、上一回合的上下文",
		examples: ["/context", "/context detail"],
		// Read-only accounting of state the runner already holds: no LLM call, no session
		// access, so it answers mid-turn like /status and /usage do.
		availableWhileBusy: true,
		runnerHandled: true,
	},
	{
		name: "subagents",
		argumentHint: "<list [running|failed|all]|show <id>|output <id>|cancel <id|all>|roles [name]>",
		description: "查看与控制委派（内置与外部）、浏览角色目录；cancel 不经过模型，直接终止",
		// A human control path independent of the model (spec 040, D6): /stop no longer kills a
		// dispatched delegation, so cancel must work even when the model/turn is unavailable.
		availableWhileBusy: true,
		subcommands: [
			{
				name: "list",
				args: "[running|failed|all]",
				description: "运行中的委派，以及最近完成的几条（不带筛选时）",
				example: "/subagents list failed",
			},
			{
				name: "show",
				args: "<runId>",
				description: "单个委派的详情（含实际命令行、stderr 尾部）",
				example: "/subagents show run_a1b2c3",
			},
			{
				name: "output",
				args: "<runId>",
				description: "该委派的文本产出（output.md 尾部）",
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
		argumentHint: "[status|list [type]|show <name>|forget <name>|journal [date]]",
		description: "查看本工位的记忆、观察期条目与后台整理状态；不经过模型的记忆管理入口",
		subcommands: [
			{
				name: "status",
				description: "记忆状态概览：分类计数、观察期条目、上次整理、索引大小",
				example: "/memory status",
			},
			{
				name: "list",
				args: "[type]",
				description: "列出生效的记忆条目，可选按 user/feedback/project/reference 过滤",
				example: "/memory list feedback",
			},
			{
				name: "show",
				args: "<name>",
				description: "查看单条记忆的全文与元信息",
				example: "/memory show deploy-window-thursday",
			},
			{
				name: "forget",
				args: "<name>",
				description: "不经过模型直接删除一条记忆，并记入忽略名单，后台整理不会再自动写回",
				example: "/memory forget deploy-window-thursday",
			},
			{
				name: "journal",
				args: "[YYYY-MM-DD]",
				description: "查看某天的工作日记，默认今天",
				example: "/memory journal",
			},
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
		examples: ["/compact", "/compact 保留最新的待办和决定"],
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

const RUNNER_BUILT_IN_NAMES = new Set<string>(
	BUILT_IN_COMMANDS.filter((command) => command.runnerHandled).map((command) => command.name),
);

/** Narrow a parsed built-in to one `ChannelRunner.handleBuiltinCommand` accepts. */
export function isRunnerBuiltInCommand(command: BuiltInCommand): command is RunnerBuiltInCommand {
	return RUNNER_BUILT_IN_NAMES.has(command.name);
}

function commandList(specs: readonly CommandSpec[]): string {
	return specs.map((command) => `\`/${command.name}\``).join("、");
}

/**
 * The reply to a slash command that cannot run mid-turn — one source for DingTalk and the TUI
 * (spec 053, D8). Both lists are derived from `availableWhileBusy`, so a command whose busy
 * behaviour changes moves between them on its own instead of a hand-kept list going stale.
 */
export function formatBusyHint(): string {
	const whileBusy = ALL_COMMANDS.filter((command) => command.availableWhileBusy);
	const idleOnly = ALL_COMMANDS.filter((command) => !command.availableWhileBusy);
	return `当前已有回合在运行。运行中可用：${commandList(whileBusy)}。${commandList(idleOnly)} 需要等空闲后再用。`;
}

/**
 * Renders a command's subcommand table as its `usage()` text — the single source `tasks/commands.ts`,
 * `events/commands.ts`, `subagents/commands.ts`, and `memory/commands.ts` call
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
	const lines = [`**/${spec.name}**`, spec.description];
	// With subcommands, each bullet already spells out its own syntax.
	if (spec.argumentHint && !spec.subcommands?.length) lines.push(`用法：\`/${spec.name} ${spec.argumentHint}\``);
	if (spec.note) lines.push(spec.note);
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

/**
 * Grouped by when a command can be used — the one thing a user needs to know before sending it —
 * rather than by which layer handles it (spec 053, D4/D8).
 */
function renderHelpText(): string {
	const anytime = ALL_COMMANDS.filter((command) => command.availableWhileBusy).map(renderCommandSummaryLine);
	const idleOnly = ALL_COMMANDS.filter((command) => !command.availableWhileBusy).map(renderCommandSummaryLine);
	return `**斜杠命令**

助手处理一条消息的完整过程称为一个回合。用 \`/help <命令名>\` 查看某个命令的用法和示例，例如 \`/help tasks\`。

**随时可用** · 回合进行中也可以发送

${anytime.join("\n")}

**空闲时可用** · 需要等当前回合结束

${idleOnly.join("\n")}
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

/**
 * Replies around queueing that DingTalk and the TUI both give (spec 053, D10). One wording per
 * situation, so the two surfaces cannot drift into two languages again.
 */
export function formatMissingQueueMessage(name: "steer" | "followup"): string {
	return `缺少消息内容。用法：\`/${name} <消息>\``;
}

/** `explainFollowup`: a plain busy-time message was steered implicitly, so say how to defer it instead. */
export function formatSteerQueued(explainFollowup: boolean): string {
	const base = "已作为 steer 排队，当前工具调用结束后生效。";
	return explainFollowup ? `${base}想等整个回合结束再执行，用 \`/followup <消息>\`。` : base;
}

export function formatFollowupQueued(): string {
	return "已排队，当前回合结束后执行。";
}

export function formatNoRunningTurn(name: "stop" | "steer" | "followup"): string {
	switch (name) {
		case "stop":
			return "当前没有运行中的回合，`/stop` 只在回合进行中有用。";
		case "steer":
			return "当前没有运行中的回合，直接发消息即可，不用 `/steer`。";
		case "followup":
			return "当前没有运行中的回合，直接发消息即可；`/followup` 用于回合进行中排队。";
	}
}

/** The `/new` confirmation, shared by the DingTalk runtime path and the session-layer command. */
export function formatNewSessionReply(sessionId: string): string {
	return `已开启新会话（会话 ID：\`${sessionId}\`）。`;
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
