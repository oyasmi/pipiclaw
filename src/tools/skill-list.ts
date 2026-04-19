import { readdir, readFile, stat } from "node:fs/promises";
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

export async function listWorkspaceSkills(options: SkillListToolOptions): Promise<WorkspaceSkillSummary[]> {
	const skillsDir = join(options.workspaceDir, "skills");
	let names: string[];
	try {
		names = await readdir(skillsDir);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return [];
		}
		throw error;
	}

	const summaries: WorkspaceSkillSummary[] = [];
	for (const name of names.sort()) {
		const nameValidation = validateSkillName(name);
		if (!nameValidation.ok) {
			continue;
		}
		const skillDir = join(skillsDir, name);
		const skillStats = await stat(skillDir).catch(() => null);
		if (!skillStats?.isDirectory()) {
			continue;
		}
		const skillPath = join(skillDir, "SKILL.md");
		let content: string;
		try {
			const skillFileStats = await stat(skillPath);
			if (!skillFileStats.isFile()) {
				continue;
			}
			content = await readFile(skillPath, "utf-8");
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") {
				continue;
			}
			throw error;
		}
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
			const skills = await listWorkspaceSkills(options);
			return {
				content: [{ type: "text", text: JSON.stringify({ skills }, null, 2) }],
				details: { kind: "skill_list", count: skills.length },
			};
		},
	};
}
