import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import { resolveSkillPath, resolveSkillSupportingFile } from "./skill-security.js";

const skillViewSchema = Type.Object({
	label: Type.String({ description: "Brief description of why you're viewing this skill (shown to user)" }),
	name: Type.String({ description: "Workspace skill name" }),
	filePath: Type.Optional(
		Type.String({
			description:
				"Optional file path inside the skill directory. Defaults to SKILL.md. Supporting files must be under references/, templates/, scripts/, or assets/.",
		}),
	),
});

export interface SkillViewToolOptions {
	workspaceDir: string;
	workspacePath: string;
}

function toWorkspacePath(options: SkillViewToolOptions, hostPath: string): string {
	if (hostPath.startsWith(options.workspaceDir)) {
		return `${options.workspacePath}${hostPath.slice(options.workspaceDir.length)}`;
	}
	return hostPath;
}

export function createSkillViewTool(options: SkillViewToolOptions): AgentTool<typeof skillViewSchema> {
	return {
		name: "skill_view",
		label: "skill_view",
		description: "View a workspace-level skill SKILL.md file or an allowed supporting file.",
		parameters: skillViewSchema,
		execute: async (_toolCallId: string, { name, filePath }: { label: string; name: string; filePath?: string }) => {
			const skillDir = resolveSkillPath(options.workspaceDir, name);
			const targetPath = filePath ? resolveSkillSupportingFile(skillDir, filePath) : join(skillDir, "SKILL.md");
			const content = await readFile(targetPath, "utf-8");
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								name,
								path: toWorkspacePath(options, targetPath),
								content,
							},
							null,
							2,
						),
					},
				],
				details: { kind: "skill_view", name, path: toWorkspacePath(options, targetPath) },
			};
		},
	};
}
