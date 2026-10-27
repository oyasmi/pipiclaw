/** The sole skill discovery and name-resolution policy for Pipiclaw (spec 063). */
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { guardPath } from "../security/path-guard.js";
import { isNodeError } from "../shared/os.js";
import { errorMessage } from "../shared/text-utils.js";
import { getSkillRoots, skillSecurity } from "./roots.js";
import type { PipiclawSkill, PipiclawSkillsResult, SkillDiagnostic, SkillOptions } from "./types.js";
import { scanSkillContent } from "./validation.js";

/** SDK diagnostics may lack a name when parsing failed. Keep an actionable file identifier. */
function diagnosticName(path: string): string {
	return basename(path) === "SKILL.md" ? basename(dirname(path)) : basename(path, ".md");
}

export function loadPipiclawSkills(options: SkillOptions): PipiclawSkillsResult {
	const { securityConfig, securityContext } = skillSecurity(options);
	const guardContext = {
		...securityContext,
		config: { ...securityConfig.pathGuard, enabled: securityConfig.enabled && securityConfig.pathGuard.enabled },
	};
	const skills = new Map<string, PipiclawSkill>();
	const fileIdentities = new Map<string, string>();
	const diagnostics: SkillDiagnostic[] = [];
	for (const { dir, source } of getSkillRoots(options.workspaceDir, options.sharedSkillsDir)) {
		// The SDK swallows directory enumeration errors. Surface a failed source instead of
		// silently making it look empty. Missing optional roots are normal.
		try {
			readdirSync(dir);
		} catch (error) {
			if ((!isNodeError(error) || error.code !== "ENOENT") && guardPath(dir, "read", guardContext).allowed) {
				diagnostics.push({
					type: "warning",
					source,
					path: dir,
					rejected: true,
					message: `Skill directory could not be read: ${errorMessage(error)}. Check its permissions and reload.`,
				});
			}
			continue;
		}
		const loaded = loadSkillsFromDir({ dir, source });
		const candidates = new Map(loaded.skills.map((skill) => [skill.filePath, skill]));
		for (const diagnostic of loaded.diagnostics) {
			if (diagnostic.path && !guardPath(diagnostic.path, "read", guardContext).allowed) continue;
			const candidate = diagnostic.path ? candidates.get(diagnostic.path) : undefined;
			diagnostics.push({
				...diagnostic,
				source,
				name: candidate?.name ?? (diagnostic.path ? diagnosticName(diagnostic.path) : undefined),
				rejected: !candidate,
			});
		}
		// Workspace roots come first; within one root, prefer the first usable path in a
		// stable lexical order. Filtering precedes merging, so a broken override can fall back.
		for (const skill of loaded.skills.sort((a, b) =>
			a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0,
		)) {
			const guarded = guardPath(skill.filePath, "read", guardContext);
			if (!guarded.allowed || !guarded.resolvedPath) continue;
			let content: string;
			let fileIdentity: string;
			try {
				content = readFileSync(guarded.resolvedPath, "utf-8");
				fileIdentity = realpathSync(guarded.resolvedPath);
			} catch (error) {
				diagnostics.push({
					type: "warning",
					source,
					name: skill.name,
					path: skill.filePath,
					rejected: true,
					message: `Skill could not be read: ${errorMessage(error)}. Check the file and reload.`,
				});
				continue;
			}
			const scan = scanSkillContent(content);
			if (!scan.ok) {
				diagnostics.push({
					type: "warning",
					source,
					name: skill.name,
					path: skill.filePath,
					rejected: true,
					message: `Skill was not loaded: ${scan.error}. Revise the skill and reload.`,
				});
				continue;
			}
			const winner = skills.get(skill.name);
			if (winner) {
				if (fileIdentities.get(skill.name) !== fileIdentity) {
					diagnostics.push({
						type: "collision",
						source,
						name: skill.name,
						path: skill.filePath,
						message: `Skill "${skill.name}" is shadowed by ${winner.filePath}. Edit the winning file or choose another name.`,
						collision: {
							resourceType: "skill",
							name: skill.name,
							winnerPath: winner.filePath,
							loserPath: skill.filePath,
							winnerSource: winner.source,
							loserSource: source,
						},
					});
				}
				continue;
			}
			skills.set(skill.name, {
				...skill,
				source,
				filePath: guarded.resolvedPath,
				baseDir: dirname(guarded.resolvedPath),
			});
			fileIdentities.set(skill.name, fileIdentity);
		}
	}
	return {
		skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)),
		diagnostics: diagnostics.sort((a, b) =>
			a.source === b.source ? (a.path ?? "").localeCompare(b.path ?? "") : a.source === "workspace" ? -1 : 1,
		),
	};
}
