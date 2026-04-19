import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { validateSkillFrontmatter, validateSkillName } from "./skill-security.js";

const skillListSchema = Type.Object({
	label: Type.String({ description: "Brief description of why you're listing workspace skills (shown to user)" }),
});

export interface WorkspaceSkillSummary {
	name: string;
	description: string;
	path: string;
	warning?: string;
}

export interface SkillListToolOptions {
	workspaceDir: string;
	workspacePath: string;
}

function extractDescription(content: string): string {
	const match = content.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---/);
	if (!match) {
		return "";
	}
	for (const line of (match[1] ?? "").split("\n")) {
		const fieldMatch = line.match(/^description:\s*(.*)$/);
		if (fieldMatch) {
			return fieldMatch[1]!.replace(/^["']|["']$/g, "").trim();
		}
	}
	return "";
}

export function listWorkspaceSkills(options: SkillListToolOptions): WorkspaceSkillSummary[] {
	const skillsDir = join(options.workspaceDir, "skills");
	if (!existsSync(skillsDir)) {
		return [];
	}

	const summaries: WorkspaceSkillSummary[] = [];
	for (const name of readdirSync(skillsDir).sort()) {
		const nameValidation = validateSkillName(name);
		if (!nameValidation.ok) {
			continue;
		}
		const skillDir = join(skillsDir, name);
		if (!statSync(skillDir).isDirectory()) {
			continue;
		}
		const skillPath = join(skillDir, "SKILL.md");
		if (!existsSync(skillPath)) {
			continue;
		}
		const content = readFileSync(skillPath, "utf-8");
		const validation = validateSkillFrontmatter(content, name);
		summaries.push({
			name,
			description: extractDescription(content),
			path: `${options.workspacePath}/skills/${name}/SKILL.md`,
			warning: validation.ok ? undefined : validation.error,
		});
	}

	return summaries;
}

export function createSkillListTool(options: SkillListToolOptions): AgentTool<typeof skillListSchema> {
	return {
		name: "skill_list",
		label: "skill_list",
		description: "List workspace-level Pipiclaw skills that can be viewed or managed.",
		parameters: skillListSchema,
		execute: async () => {
			const skills = listWorkspaceSkills(options);
			return {
				content: [{ type: "text", text: JSON.stringify({ skills }, null, 2) }],
				details: { kind: "skill_list", count: skills.length },
			};
		},
	};
}
