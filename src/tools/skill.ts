import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { DEFAULT_SECURITY_CONFIG } from "../security/config.js";
import { checkPathGuard } from "../security/path-guard-check.js";
import type { SecurityConfig, SecurityRuntimeContext } from "../security/types.js";
import { isNodeError } from "../shared/fs-utils.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { resolveSkillPath, scanSkillContent, validateSkillFrontmatter, validateSkillName } from "./skill-security.js";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.js";

/**
 * `skill` is deliberately read-only. Authoring a workspace skill goes through the generic
 * `write`/`edit` tools writing `workspace/skills/<name>/SKILL.md` directly — a low-frequency path
 * that does not need a dedicated action surface, and one where every write already goes through
 * the same path-guard every other file write does (unlike the old `skill_manage`, which wrote via
 * a hand-rolled path resolver that never consulted the guard at all).
 */
const skillSchema = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("read")], {
		description: '"list" workspace skills, or "read" one skill\'s full SKILL.md content.',
	}),
	name: Type.Optional(Type.String({ description: "Exact workspace skill name from the list (required for read)." })),
});

export interface WorkspaceSkillSummary {
	name: string;
	description: string;
	path: string;
	warning?: string;
}

export interface SkillToolOptions {
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

export async function listWorkspaceSkills(options: { workspaceDir: string }): Promise<WorkspaceSkillSummary[]> {
	const skillsDir = join(options.workspaceDir, "skills");
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
	content: string;
	truncated: boolean;
}

/**
 * Load one skill's `SKILL.md` bytes through the same path-guard every other file read goes
 * through. Shared by the `skill` tool's `read` action and the `/skills show` runtime command
 * (`src/runtime/skill-commands.ts`) — a `SKILL.md` that is itself a symlink pointing outside
 * `workspace/skills/` (planted via `bash ln -s`, not via `name` -- `resolveSkillPath` already
 * confines that) is caught here in both callers instead of being read verbatim.
 */
export async function loadWorkspaceSkillFile(options: SkillToolOptions, name: string): Promise<WorkspaceSkillFile> {
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
		projectRoot: options.workspaceDir,
	};
	const target = await checkPathGuard(rawPath, "read", securityConfig, securityContext, {
		tool: "skill",
		channelId: options.channelId,
	});

	const content = await readFile(target, "utf-8");
	const truncation = truncateHead(content);
	let body = truncation.content;
	if (truncation.truncated) {
		body += `\n\n[Truncated at ${formatSize(DEFAULT_MAX_BYTES)}. Use the read tool on ${target} to page through the rest.]`;
	}

	return { name, path: target, content: body, truncated: truncation.truncated };
}

async function readWorkspaceSkill(options: SkillToolOptions, name: string) {
	const file = await loadWorkspaceSkillFile(options, name);

	// Mirrors the framing pi's own skill loader gives a model-invoked skill: the location and the
	// relative-path rule are what let the model correctly `read` a skill's references/templates
	// afterward, and are the whole reason `skill read` is worth more than a plain `read` call.
	const envelope =
		`<skill name="${file.name}" location="${file.path}">\n` +
		`References are relative to ${dirname(file.path)}.\n\n` +
		`${file.content}\n` +
		`</skill>`;

	return {
		content: [{ type: "text" as const, text: envelope }],
		details: { action: "read", name: file.name, path: file.path, truncated: file.truncated },
	};
}

export function createSkillTool(options: SkillToolOptions): AgentTool<typeof skillSchema> {
	return {
		name: "skill",
		label: "skill",
		description:
			"List or read workspace-level Pipiclaw skills (procedural memory) under workspace/skills/. Read-only: " +
			"to author or update a skill, write workspace/skills/<name>/SKILL.md directly with the write/edit tools " +
			'(frontmatter needs "name" and "description" fields).',
		parameters: skillSchema,
		execute: async (_toolCallId: string, args: { action: string; name?: string }) => {
			if (args.action === "list") {
				const skills = await listWorkspaceSkills(options);
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ skills }) }],
					details: { action: "list", count: skills.length },
				};
			}
			if (args.action !== "read") {
				throw new RecoverableToolError('Unsupported skill action. Use "list" or "read".');
			}
			if (!args.name) {
				throw new RecoverableToolError('Action "read" requires a skill name.');
			}
			return readWorkspaceSkill(options, args.name);
		},
	};
}
