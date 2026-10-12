/**
 * Bootstrap templates for the two workspace files the system prompt injects.
 *
 * They live here rather than inside bootstrap.ts because the prompt builder must
 * recognize an untouched template and skip it: a file that still says "replace
 * this" carries no user intent and only wastes prompt budget (spec 025 §6.9).
 */

export const DEFAULT_SOUL = `# SOUL.md

Configure Pipiclaw's identity, voice, and communication style here.

Suggested sections:

- Who the assistant is
- Default language
- Tone and personality
- Reply style
- Formatting preferences

Example topics you may want to define:

- "Answer in Chinese by default."
- "Be concise and direct."
- "Prefer Markdown."
- "Act as an engineering assistant for our team."

Replace this template with your actual identity prompt.
`;

export const DEFAULT_AGENTS = `# AGENTS.md

Configure Pipiclaw's operating rules here.

This file should define behavior and workflow. Identity, tone, and personality belong in \`SOUL.md\`.

Suggested sections:

- Tool usage policy
- Security constraints
- Scheduling/reminder policy
- Project-specific workflows
- Things the assistant must always or never do

Replace this template with your actual operating instructions.
`;

function normalize(content: string): string {
	return content.replace(/\r/g, "").trim();
}

/** True when the file is byte-equivalent (modulo trailing whitespace) to the shipped template. */
export function isDefaultWorkspaceTemplate(content: string, template: string): boolean {
	return normalize(content) === normalize(template);
}
