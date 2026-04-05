/**
 * Workspace resource loaders for pipiclaw:
 * SOUL.md, AGENTS.md, and workspace-level skills.
 */

import { loadSkillsFromDir, type Skill } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import * as log from "../log.js";

/**
 * Load SOUL.md — defines the agent's identity, personality, and communication style.
 * Only loaded from workspace root (global).
 */
export function getSoul(workspaceDir: string): string {
	const soulPath = join(workspaceDir, "SOUL.md");
	if (existsSync(soulPath)) {
		try {
			const content = readFileSync(soulPath, "utf-8").trim();
			if (content) return content;
		} catch (error) {
			log.logWarning("Failed to read SOUL.md", `${soulPath}: ${error}`);
		}
	}
	return "";
}

/**
 * Load AGENTS.md — defines the agent's behavior instructions, capabilities, and constraints.
 * Only loaded from workspace root (global).
 */
export function getAgentConfig(channelDir: string): string {
	const workspaceAgentPath = join(channelDir, "..", "AGENTS.md");
	if (existsSync(workspaceAgentPath)) {
		try {
			const content = readFileSync(workspaceAgentPath, "utf-8").trim();
			if (content) {
				return content;
			}
		} catch (error) {
			log.logWarning("Failed to read workspace AGENTS.md", `${workspaceAgentPath}: ${error}`);
		}
	}
	return "";
}

/**
 * Load skills from the workspace-level skill directory only.
 */
export function loadPipiclawSkills(channelDir: string, workspacePath: string): Skill[] {
	const hostWorkspacePath = join(channelDir, "..");

	const translatePath = (hostPath: string): string => {
		if (hostPath.startsWith(hostWorkspacePath)) {
			return workspacePath + hostPath.slice(hostWorkspacePath.length);
		}
		return hostPath;
	};

	const workspaceSkillsDir = join(hostWorkspacePath, "skills");
	const skills = loadSkillsFromDir({ dir: workspaceSkillsDir, source: "workspace" }).skills;
	for (const skill of skills) {
		skill.filePath = translatePath(skill.filePath);
		skill.baseDir = translatePath(skill.baseDir);
	}

	return skills;
}
