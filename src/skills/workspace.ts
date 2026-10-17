/**
 * Workspace skill catalog access: list the skills under `workspace/skills/` and load one
 * `SKILL.md`, both through the path guard. The `skill` tool and `/skills` are thin adapters over
 * this file (spec 054 D8/D10).
 */
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_SECURITY_CONFIG } from "../security/config.js";
import { checkPathGuard } from "../security/path-guard-check.js";
import { readGuardAllows } from "../security/path-guard-filter.js";
import type { SecurityConfig, SecurityRuntimeContext } from "../security/types.js";
import { isNodeError } from "../shared/os.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { resolveSkillPath, scanSkillContent, validateSkillFrontmatter, validateSkillName } from "./validation.js";

export interface WorkspaceSkillSummary {
	name: string;
	description: string;
	path: string;
	warning?: string;
}

export interface WorkspaceSkillOptions {
	workspaceDir: string;
	securityConfig?: SecurityConfig;
	securityContext?: SecurityRuntimeContext;
	channelId?: string;
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

export async function listWorkspaceSkills(options: {
	workspaceDir: string;
	securityConfig?: SecurityConfig;
	securityContext?: SecurityRuntimeContext;
}): Promise<WorkspaceSkillSummary[]> {
	const skillsDir = join(options.workspaceDir, "skills");
	// `skill read` runs each SKILL.md through the path guard (`loadWorkspaceSkillFile`); `list`
	// must apply the same guard so a skill whose SKILL.md is a symlink out of `workspace/skills/`
	// is silently omitted here too, rather than being advertised and then refused on read.
	const guardConfig = options.securityConfig ?? DEFAULT_SECURITY_CONFIG;
	const guardContext = options.securityContext ?? {
		agentWorkspaceDir: options.workspaceDir,
		cwd: options.workspaceDir,
	};
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
		if (!readGuardAllows(skillPath, guardConfig, guardContext)) {
			continue;
		}
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
		const scan = validation.ok ? scanSkillContent(content) : validation;
		summaries.push({
			name,
			description: extractDescription(content),
			path: `${options.workspaceDir}/skills/${name}/SKILL.md`,
			warning: scan.ok ? undefined : scan.error,
		});
	}

	return summaries;
}

export interface WorkspaceSkillFile {
	name: string;
	/** The guard-resolved path actually opened — never the raw pre-guard path. */
	path: string;
	/** The whole file; callers that need a size cap (the `skill` tool) apply it themselves. */
	content: string;
}

/**
 * Load one skill's `SKILL.md` bytes through the same path-guard every other file read goes
 * through. Shared by the `skill` tool's `read` action and the `/skills show` runtime command
 * (`skills/commands.ts`) — a `SKILL.md` that is itself a symlink pointing outside
 * `workspace/skills/` (planted via `bash ln -s`, not via `name` -- `resolveSkillPath` already
 * confines that) is caught here in both callers instead of being read verbatim.
 */
export async function loadWorkspaceSkillFile(
	options: WorkspaceSkillOptions,
	name: string,
): Promise<WorkspaceSkillFile> {
	const nameValidation = validateSkillName(name);
	if (!nameValidation.ok) {
		throw new RecoverableToolError(nameValidation.error ?? `Invalid skill name "${name}".`);
	}
	const skillDir = resolveSkillPath(options.workspaceDir, name);
	const rawPath = join(skillDir, "SKILL.md");
	if (!existsSync(rawPath)) {
		throw new RecoverableToolError(
			`Workspace skill "${name}" does not exist. Use action "list" to see what's available.`,
		);
	}

	const securityConfig = options.securityConfig ?? DEFAULT_SECURITY_CONFIG;
	const securityContext = options.securityContext ?? {
		agentWorkspaceDir: options.workspaceDir,
		cwd: options.workspaceDir,
	};
	const target = await checkPathGuard(rawPath, "read", securityConfig, securityContext, {
		tool: "skill",
		channelId: options.channelId,
	});

	const content = await readFile(target, "utf-8");
	return { name, path: target, content };
}
