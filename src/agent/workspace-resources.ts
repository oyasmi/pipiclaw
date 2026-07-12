/**
 * Workspace skills.
 *
 * SOUL.md and AGENTS.md are loaded by the prompt pipeline itself
 * (`agent/prompt/resources.ts`), which owns their budgets and framing.
 */

import { loadSkillsFromDir, type ResourceDiagnostic, type Skill } from "@earendil-works/pi-coding-agent";
import { join } from "path";

export interface PipiclawSkillsResult {
	skills: Skill[];
	diagnostics: ResourceDiagnostic[];
}

/**
 * Load skills from the workspace-level skill directory.
 *
 * Diagnostics (an unreadable SKILL.md, bad frontmatter, a duplicate name) were
 * previously dropped on the floor, so a broken workspace skill silently vanished
 * from the prompt. They are returned now and surfaced by the runner.
 */
export function loadPipiclawSkills(channelDir: string): PipiclawSkillsResult {
	const workspaceSkillsDir = join(channelDir, "..", "skills");
	const loaded = loadSkillsFromDir({ dir: workspaceSkillsDir, source: "workspace" });
	return { skills: loaded.skills, diagnostics: loaded.diagnostics };
}

/**
 * Merge pi's auto-discovered skills with the workspace ones. Workspace wins on a
 * name collision (it is the layer the user actually edits), and the collision is
 * reported rather than resolved in silence.
 */
export function resolvePipiclawSkills(
	base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] },
	workspace: PipiclawSkillsResult,
): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
	const workspaceNames = new Set(workspace.skills.map((skill) => skill.name));
	const collisions = base.skills.filter((skill) => workspaceNames.has(skill.name));
	const diagnostics: ResourceDiagnostic[] = [...base.diagnostics, ...workspace.diagnostics];
	for (const skill of collisions) {
		diagnostics.push({
			type: "collision",
			message: `Skill "${skill.name}" is shadowed by the workspace skill of the same name.`,
			path: skill.filePath,
		});
	}
	const kept = base.skills.filter((skill) => !workspaceNames.has(skill.name));
	return { skills: [...kept, ...workspace.skills], diagnostics };
}
