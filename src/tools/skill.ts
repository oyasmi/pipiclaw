import { dirname } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { loadSkillFile } from "../skills/catalog.js";
import { loadPipiclawSkills } from "../skills/loader.js";
import type { SkillOptions } from "../skills/types.js";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.js";

/**
 * `skill` is deliberately read-only. Authoring a workspace skill goes through the generic
 * `write`/`edit` tools writing `workspace/skills/<name>/SKILL.md` directly — a low-frequency path
 * that does not need a dedicated action surface, and one where every write already goes through
 * the same path-guard every other file write does (unlike the old `skill_manage`, which wrote via
 * a hand-rolled path resolver that never consulted the guard at all).
 */
const skillSchema = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("read")], {
		description: '"list" available skills, or "read" one skill\'s full SKILL.md content.',
	}),
	name: Type.Optional(Type.String({ description: "Exact skill name from the list (required for read)." })),
});

async function readSkill(options: SkillOptions, name: string) {
	const file = await loadSkillFile(options, name);
	const truncation = truncateHead(file.content);
	let body = truncation.content;
	if (truncation.truncated) {
		body += `\n\n[Truncated at ${formatSize(DEFAULT_MAX_BYTES)}. Use the read tool on ${file.path} to page through the rest.]`;
	}

	// Mirrors the framing pi's own skill loader gives a model-invoked skill: the location and the
	// relative-path rule are what let the model correctly `read` a skill's references/templates
	// afterward, and are the whole reason `skill read` is worth more than a plain `read` call.
	const envelope =
		`<skill name="${file.name}" location="${file.path}">\n` +
		`References are relative to ${dirname(file.path)}.\n\n` +
		`${body}\n` +
		`</skill>`;

	return {
		content: [{ type: "text" as const, text: envelope }],
		details: {
			action: "read",
			name: file.name,
			path: file.path,
			source: file.source,
			truncated: truncation.truncated,
		},
	};
}

export function createSkillTool(options: SkillOptions): AgentTool<typeof skillSchema> {
	return {
		name: "skill",
		label: "skill",
		description:
			"List or read Pipiclaw skills from ~/.agents/skills/ and workspace/skills/. Valid workspace skills override shared names. Read-only: " +
			"to author or update a skill, write workspace/skills/<name>/SKILL.md directly with the write/edit tools " +
			'(frontmatter needs "name" and "description" fields).',
		parameters: skillSchema,
		execute: async (_toolCallId: string, args: { action: string; name?: string }) => {
			if (args.action === "list") {
				const catalog = loadPipiclawSkills(options);
				const skills = catalog.skills.map((skill) => ({
					name: skill.name,
					description: skill.description,
					path: skill.filePath,
					source: skill.source,
					disableModelInvocation: skill.disableModelInvocation,
				}));
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ skills, diagnostics: catalog.diagnostics }) }],
					details: { action: "list", count: skills.length },
				};
			}
			if (args.action !== "read") {
				throw new RecoverableToolError('Unsupported skill action. Use "list" or "read".');
			}
			if (!args.name) {
				throw new RecoverableToolError('Action "read" requires a skill name.');
			}
			return readSkill(options, args.name);
		},
	};
}
