/**
 * Workspace skills.
 *
 * SOUL.md and AGENTS.md are loaded by the prompt pipeline itself
 * (`agent/prompt/resources.ts`), which owns their budgets and framing.
 */

import { readFileSync } from "node:fs";
import { loadSkillsFromDir, type ResourceDiagnostic, type Skill } from "@earendil-works/pi-coding-agent";
import { join } from "path";
import { scanSkillContent } from "../tools/skill-security.js";

export interface PipiclawSkillsResult {
	skills: Skill[];
	diagnostics: ResourceDiagnostic[];
}

/**
 * Content scanning moved here from the old `skill_manage` write path (spec 045): `skill` is now
 * read-only and workspace skills are authored through the generic `write`/`edit` tools, which have
 * no reason to know about skill-specific content rules. `Skill` (from pi's resource loader) carries
 * only catalog metadata, not the file body, so this reads each candidate's `SKILL.md` itself --
 * that read is also what keeps a scan-failing skill out of the `<available_skills>` catalog
 * entirely, not just out of the (optional) `skill read` tool: the catalog is what tells the model
 * the skill exists in the first place. An unreadable file is treated as "keep it" here -- a race or
 * permission glitch should not itself become a silent content-policy rejection.
 */
function filterScannedSkills(skills: Skill[]): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
	const kept: Skill[] = [];
	const diagnostics: ResourceDiagnostic[] = [];
	for (const skill of skills) {
		let content: string;
		try {
			content = readFileSync(skill.filePath, "utf-8");
		} catch {
			kept.push(skill);
			continue;
		}
		const scan = scanSkillContent(content);
		if (scan.ok) {
			kept.push(skill);
			continue;
		}
		diagnostics.push({
			type: "warning",
			message: `Skill "${skill.name}" was not loaded: ${scan.error}.`,
			path: skill.filePath,
		});
	}
	return { skills: kept, diagnostics };
}

/**
 * Load skills from the workspace-level skill directory.
 *
 * Diagnostics (an unreadable SKILL.md, bad frontmatter, a duplicate name, content that failed the
 * scan above) were previously dropped on the floor, so a broken workspace skill silently vanished
 * from the prompt. They are returned now and surfaced by the runner.
 */
export function loadPipiclawSkills(channelDir: string): PipiclawSkillsResult {
	const workspaceSkillsDir = join(channelDir, "..", "skills");
	const loaded = loadSkillsFromDir({ dir: workspaceSkillsDir, source: "workspace" });
	const scanned = filterScannedSkills(loaded.skills);
	return { skills: scanned.skills, diagnostics: [...loaded.diagnostics, ...scanned.diagnostics] };
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
