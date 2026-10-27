import type { ResourceDiagnostic, Skill } from "@earendil-works/pi-coding-agent";
import type { SecurityConfig, SecurityRuntimeContext } from "../security/types.js";

export type SkillSource = "workspace" | "user";

export interface SkillOptions {
	workspaceDir: string;
	/** Internal override for isolated callers/tests, not a user setting. */
	sharedSkillsDir?: string;
	securityConfig?: SecurityConfig;
	securityContext?: SecurityRuntimeContext;
	channelId?: string;
}

export interface PipiclawSkill extends Skill {
	source: SkillSource;
}

export interface SkillDiagnostic extends ResourceDiagnostic {
	source: SkillSource;
	name?: string;
	/** A load failure, distinct from an SDK warning on a usable skill. */
	rejected?: boolean;
}

export interface PipiclawSkillsResult {
	skills: PipiclawSkill[];
	diagnostics: SkillDiagnostic[];
}
