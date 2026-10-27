/** On-demand catalog reads, shared by the skill tool and /skills. */
import { readFile } from "node:fs/promises";
import { checkPathGuard } from "../security/path-guard-check.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { errorMessage } from "../shared/text-utils.js";
import { loadPipiclawSkills } from "./loader.js";
import { skillSecurity } from "./roots.js";
import type { SkillOptions, SkillSource } from "./types.js";

export async function loadSkillFile(options: SkillOptions, name: string, inspectRejected = false) {
	const catalog = loadPipiclawSkills(options);
	const skill = catalog.skills.find((item) => item.name === name);
	const rejected = inspectRejected
		? catalog.diagnostics.find((item) => item.rejected && item.name === name && item.path)
		: undefined;
	const path = skill?.filePath ?? rejected?.path;
	if (!path) {
		throw new RecoverableToolError(
			`Skill "${name}" does not exist or could not be loaded. Use action "list" to inspect skills and diagnostics.`,
		);
	}
	const { securityConfig, securityContext } = skillSecurity(options);
	const target = await checkPathGuard(path, "read", securityConfig, securityContext, {
		tool: "skill",
		channelId: options.channelId,
	});
	let content: string;
	try {
		content = await readFile(target, "utf-8");
	} catch (error) {
		throw new RecoverableToolError(
			`Skill "${name}" could not be read: ${errorMessage(error)}. Use action "list" to refresh the catalog before retrying.`,
		);
	}
	return { name, path: target, source: (skill ?? rejected)!.source, content, loaded: !!skill };
}

export function skillSourceLabel(source: SkillSource): string {
	return source === "workspace" ? "工作区" : "用户共享";
}
