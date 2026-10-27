import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_SECURITY_CONFIG } from "../security/config.js";
import type { SkillOptions, SkillSource } from "./types.js";

export function getSkillRoots(workspaceDir: string, sharedSkillsDir = join(homedir(), ".agents", "skills")) {
	return [
		{ dir: resolve(workspaceDir, "skills"), source: "workspace" },
		{ dir: resolve(sharedSkillsDir), source: "user" },
	] satisfies Array<{ dir: string; source: SkillSource }>;
}

export function skillSecurity(options: SkillOptions) {
	return {
		securityConfig: options.securityConfig ?? DEFAULT_SECURITY_CONFIG,
		securityContext: options.securityContext ?? {
			agentWorkspaceDir: options.workspaceDir,
			cwd: options.workspaceDir,
		},
	};
}
