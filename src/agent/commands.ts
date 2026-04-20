export type BuiltInCommandName = "help" | "steer" | "followup" | "stop";

export interface BuiltInCommand {
	name: BuiltInCommandName;
	args: string;
	rawText: string;
}

const HELP_TEXT = `# Slash Commands

Pipiclaw supports two command groups.

## Transport Commands

These are handled directly by the DingTalk transport/runtime layer.

- \`/help\`
  Show command help
  Example: \`/help\`
- \`/stop\`
  Stop the current task
  Example: \`/stop\`
- \`/steer <message>\`
  Change the current task after the current tool step finishes
  Example: \`/steer Use the Shanghai time zone and summarize only the latest updates\`
- \`/followup <message>\`
  Queue another request to run after the current task completes
  Example: \`/followup After that, draft a short executive summary\`

While a task is running, plain messages use the configured busy-message default. The default is \`steer\`; set \`busyMessageDefault\` in channel.json to \`followUp\` or \`followup\` to queue plain messages after the current task.

Set \`progressDisplay\` in channel.json to \`rolling\` for compact AI Card progress: recent entries while running, then a short summary after completion.

## Session Commands

These are handled inside the Pipiclaw session layer:

- \`/session\`
  Show current session state, message stats, token usage, and model info
  Example: \`/session\`
- \`/model [provider/modelId|modelId]\`
  Show the current model, or switch models using an exact match or a uniquely matching substring
  Example: \`/model\`
  Example: \`/model anthropic/claude-opus-4-6\`
- \`/new\`
  Start a new session
  Example: \`/new\`
- \`/compact [instructions]\`
  Manually compact the current session context, with optional custom instructions
  Example: \`/compact\`
  Example: \`/compact Keep the latest TODOs and decisions\`
`;

export function parseBuiltInCommand(text: string): BuiltInCommand | null {
	const rawText = text.trim();
	if (!rawText.startsWith("/")) {
		return null;
	}

	const spaceIndex = rawText.indexOf(" ");
	const rawName = spaceIndex === -1 ? rawText.slice(1) : rawText.slice(1, spaceIndex);
	const args = spaceIndex === -1 ? "" : rawText.slice(spaceIndex + 1).trim();

	switch (rawName) {
		case "help":
		case "steer":
		case "followup":
		case "stop":
			return { name: rawName, args, rawText };
		default:
			return null;
	}
}

export function renderBuiltInHelp(): string {
	return HELP_TEXT;
}
