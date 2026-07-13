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
		description: "Show command help",
		examples: ["/help"],
		availableWhileBusy: true,
	},
	{
		name: "stop",
		description: "Stop the current task",
		examples: ["/stop"],
		availableWhileBusy: true,
	},
	{
		name: "steer",
		argumentHint: "<message>",
		description: "Adjust the running task after the current tool step finishes",
		examples: ["/steer Use the Shanghai time zone and summarize only the latest updates"],
		availableWhileBusy: true,
	},
	{
		name: "followup",
		argumentHint: "<message>",
		description: "Queue a request to run after the current task completes",
		examples: ["/followup After that, draft a short executive summary"],
		availableWhileBusy: true,
	},
	{
		name: "events",
		argumentHint: "<list|show|delete|history>",
		description: "Manage scheduled event files and inspect event history",
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
		argumentHint: "[show <id>|archive|approve <id>|pause <id>|resume <id>|run <id>|stats [id]|doctor]",
		description: "View and diagnose the channel's task ledger; `approve` gates external side effects",
		examples: [
			"/tasks",
			"/tasks show weekly-report",
			"/tasks archive",
			"/tasks approve publish-release",
			"/tasks pause weekly-report",
			"/tasks resume weekly-report",
			"/tasks run weekly-report",
			"/tasks stats weekly-report",
			"/tasks doctor",
		],
		availableWhileBusy: true,
	},
	{
		name: "status",
		description: "Show run state, current model, context usage, uptime, and version",
		examples: ["/status"],
		availableWhileBusy: true,
	},
	{
		name: "usage",
		argumentHint: "[7d|month]",
		description: "Show LLM cost for this channel and globally, broken down by kind and top models",
		examples: ["/usage", "/usage 7d", "/usage month"],
		availableWhileBusy: true,
	},
	{
		name: "context",
		argumentHint: "[detail]",
		description: "Show what the model is being sent: system prompt sections, tool schemas, and last-turn context",
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
		description: "Inspect active memory, metadata, recall statistics, tombstones, and pending suggestions",
		examples: ["/memory status", "/memory list", "/memory show m-1234abcd", "/memory pending"],
	},
	{
		name: "session",
		description: "Show current session state, message stats, token usage, and model info",
		examples: ["/session"],
	},
	{
		name: "model",
		argumentHint: "[provider/modelId|modelId]",
		description: "Show the current model, or switch models using an exact or uniquely matching substring",
		examples: ["/model", "/model anthropic/claude-opus-4-6"],
	},
	{
		name: "new",
		description: "Start a new session",
		examples: ["/new"],
	},
	{
		name: "compact",
		argumentHint: "[instructions]",
		description: "Manually compact the current session context, with optional custom instructions",
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
		lines.push(`  Example: \`${example}\``);
	}
	return lines.join("\n");
}

function renderHelpText(): string {
	const transport = BUILT_IN_COMMANDS.map(renderCommandEntry).join("\n");
	const session = SESSION_COMMANDS.map(renderCommandEntry).join("\n");
	return `# Slash Commands

Pipiclaw supports two command groups.

## Transport Commands

These are handled directly by the DingTalk transport/runtime layer.

${transport}

While a task is running, plain messages use the configured busy-message default. The default is \`steer\`; set \`busyMessageDefault\` in channel.json to \`followUp\` or \`followup\` to queue plain messages after the current task.

Set \`responseMode\` in channel.json to control output shape: \`full_progress_then_plain_final\` (default) streams full progress then sends a plain final message; \`rolling_progress_then_plain_final\` shows only the most recent progress entries, then a short summary; \`final_card_only\` hides progress and delivers the final answer in the AI Card.

## Session Commands

These are handled inside the Pipiclaw session layer:

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
