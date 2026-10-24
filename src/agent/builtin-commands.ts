/**
 * The runner-handled built-in slash commands typed on an idle channel (`/help`, `/context`, and the
 * "nothing to stop/steer" replies). The stateless report commands (`/tasks`, `/events`, …) never
 * reach here — they go through `commands/router.ts`.
 */
import {
	formatMissingQueueMessage,
	formatNoRunningTurn,
	type RunnerBuiltInCommand,
	renderBuiltInHelp,
} from "../commands/catalog.js";
import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";

/** The slice of the runner a built-in command reads; everything else it needs is the command itself. */
export interface BuiltinCommandHost {
	channelId: string;
	ensureSessionReady(): Promise<void>;
	promptTemplates(): ReadonlyArray<{ name: string }>;
	renderContextReport(args: string): string;
}

/** A `/steer` or `/followup` needs a message: the trimmed text, or an error telling the user how. */
export function requireQueuedMessage(text: string, commandName: "steer" | "followup"): string {
	const trimmedText = text.trim();
	if (!trimmedText) {
		throw new Error(formatMissingQueueMessage(commandName));
	}
	return trimmedText;
}

/**
 * `/help` — the static per-command listing from `commands.ts`, plus (top-level only) the
 * prompt templates this session can actually invoke via `/<template-name>`. Workspace skills
 * have their own dedicated command (`/skills`) and are deliberately not duplicated here.
 * Prompt templates aren't knowable to `renderBuiltInHelp` itself (it is a pure function with
 * no session state), so the runner appends them here (review 2026-08-24 §1.9).
 */
function renderHelpWithDiscovery(host: BuiltinCommandHost, args: string): string {
	const help = renderBuiltInHelp(args);
	if (args.trim()) {
		return help;
	}
	const sections: string[] = [help];
	const templates = host.promptTemplates();
	if (templates.length > 0) {
		sections.push(`**提示模板**\n\n${templates.map((template) => `- \`/${template.name}\``).join("\n")}`);
	}
	return sections.join("\n\n");
}

/**
 * The reply to a runner-handled built-in command. It is returned, not delivered: the caller sends
 * it as a command reply (titled, never archived — command echoes are ephemeral control-plane
 * traffic, not conversation, and must not be re-consumed as memory-extraction input; review
 * 2026-08-24 §1.2).
 */
export async function handleBuiltinCommand(host: BuiltinCommandHost, command: RunnerBuiltInCommand): Promise<string> {
	try {
		// `/help` and `/context` read the session (prompt templates, active model).
		// The session runtime is built asynchronously after construction, so a command
		// that lands before it is ready would otherwise hit a TypeError (spec 048 F2).
		await host.ensureSessionReady();
		switch (command.name) {
			case "help":
				return renderHelpWithDiscovery(host, command.args);
			case "context":
				return host.renderContextReport(command.args);
			case "stop":
				return formatNoRunningTurn("stop");
			case "steer":
				requireQueuedMessage(command.args, "steer");
				return formatNoRunningTurn("steer");
			case "followup":
				requireQueuedMessage(command.args, "followup");
				return formatNoRunningTurn("followup");
			default: {
				// The stateless report commands (events/tasks/status/usage/subagents/skills — see
				// `BUILT_IN_COMMANDS`'s `runnerHandled: false` entries) are routed to their own
				// handlers upstream and never reach here; the narrowed parameter type makes that a
				// compile-time guarantee.
				const _exhaustive: never = command.name;
				throw new Error(`Unhandled built-in command: ${String(_exhaustive)}`);
			}
		}
	} catch (err) {
		const errMsg = errorMessage(err);
		log.logWarn("agent.command.failed", "Built-in command failed", { channelId: host.channelId, reason: errMsg });
		return `命令执行失败：${errMsg}`;
	}
}
