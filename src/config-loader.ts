/**
 * Configuration file loaders for pipiclaw workspace files:
 * SOUL.md, AGENTS.md, skills/, and API key resolution.
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import { loadSkillsFromDir, type ModelRegistry, type Skill } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import * as log from "./log.js";

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
 * Load skills from both workspace-level and channel-level skill directories.
 * Channel-level skills override global skills with the same name.
 */
export function loadPipiclawSkills(channelDir: string, workspacePath: string): Skill[] {
	const skillMap = new Map<string, Skill>();
	const hostWorkspacePath = join(channelDir, "..");

	const translatePath = (hostPath: string): string => {
		if (hostPath.startsWith(hostWorkspacePath)) {
			return workspacePath + hostPath.slice(hostWorkspacePath.length);
		}
		return hostPath;
	};

	// Load workspace-level skills (global)
	const workspaceSkillsDir = join(hostWorkspacePath, "skills");
	for (const skill of loadSkillsFromDir({ dir: workspaceSkillsDir, source: "workspace" }).skills) {
		skill.filePath = translatePath(skill.filePath);
		skill.baseDir = translatePath(skill.baseDir);
		skillMap.set(skill.name, skill);
	}

	// Load channel-specific skills
	const channelSkillsDir = join(channelDir, "skills");
	for (const skill of loadSkillsFromDir({ dir: channelSkillsDir, source: "channel" }).skills) {
		skill.filePath = translatePath(skill.filePath);
		skill.baseDir = translatePath(skill.baseDir);
		skillMap.set(skill.name, skill);
	}

	return Array.from(skillMap.values());
}

/**
 * Resolve an API key for the given model's provider.
 * Checks ModelRegistry first, then falls back to ANTHROPIC_API_KEY env var.
 */
export async function getApiKeyForModel(modelRegistry: ModelRegistry, model: Model<Api>): Promise<string> {
	const key = await modelRegistry.getApiKeyForProvider(model.provider);
	if (key) return key;
	// Fallback: try anthropic env var
	const envKey = process.env.ANTHROPIC_API_KEY;
	if (envKey) return envKey;
	throw new Error(
		`No API key found for provider: ${model.provider}.\n\n` +
			"Configure credentials in ~/.pi/pipiclaw/auth.json or ~/.pi/pipiclaw/models.json, or set the matching provider environment variable.",
	);
}
