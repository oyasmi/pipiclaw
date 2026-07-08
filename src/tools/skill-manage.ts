import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { createAtomicTempPath, writeFileAtomically } from "../shared/atomic-file.js";
import {
	resolveSkillPath,
	resolveSkillSupportingFile,
	scanSkillContent,
	validateSkillFrontmatter,
	validateSkillMarkdown,
	validateSkillName,
} from "./skill-security.js";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.js";

const skillManageSchema = Type.Object({
	label: Type.String({ description: "Brief description of the skill action (shown to user)" }),
	action: Type.Union(
		[
			Type.Literal("list"),
			Type.Literal("view"),
			Type.Literal("create"),
			Type.Literal("patch"),
			Type.Literal("write_file"),
		],
		{
			description:
				'"list" workspace skills, "view" one skill\'s contents, or "create"/"patch"/"write_file" to author them.',
		},
	),
	name: Type.Optional(Type.String({ description: "Workspace skill name (required for all actions except list)." })),
	content: Type.Optional(Type.String({ description: "Full content for create/write_file." })),
	filePath: Type.Optional(
		Type.String({
			description:
				"Supporting file path inside the skill for view/patch/write_file. Defaults to SKILL.md. Supporting files must be under references/, templates/, scripts/, or assets/.",
		}),
	),
	find: Type.Optional(Type.String({ description: "Exact text to replace when action is patch." })),
	replace: Type.Optional(Type.String({ description: "Replacement text when action is patch." })),
});

type SkillWriteAction = "create" | "patch" | "write_file";

export interface SkillManageResult {
	action: SkillWriteAction;
	name: string;
	path: string;
	bytesWritten: number;
	requiresResourceRefresh: boolean;
	notice: string;
}

export interface SkillManageRequest {
	action: SkillWriteAction;
	name: string;
	content?: string;
	filePath?: string;
	find?: string;
	replace?: string;
}

export interface WorkspaceSkillSummary {
	name: string;
	description: string;
	path: string;
	warning?: string;
}

export interface SkillManageToolOptions {
	workspaceDir: string;
	workspacePath: string;
}

function toWorkspacePath(options: SkillManageToolOptions, hostPath: string): string {
	if (hostPath.startsWith(options.workspaceDir)) {
		return `${options.workspacePath}${hostPath.slice(options.workspaceDir.length)}`;
	}
	return hostPath;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
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

export async function listWorkspaceSkills(options: SkillManageToolOptions): Promise<WorkspaceSkillSummary[]> {
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
		summaries.push({
			name,
			description: extractDescription(content),
			path: `${options.workspacePath}/skills/${name}/SKILL.md`,
			warning: validation.ok ? undefined : validation.error,
		});
	}

	return summaries;
}

function parseWriteAction(action: string): SkillWriteAction {
	if (action === "create" || action === "patch" || action === "write_file") {
		return action;
	}
	throw new Error('Unsupported skill action. Use "list", "view", "create", "patch", or "write_file".');
}

function ensureSkillMarkdownSafe(content: string, name: string): void {
	const validation = validateSkillMarkdown(content, name);
	if (!validation.ok) {
		throw new Error(validation.error);
	}
}

function ensureSupportingFileSafe(content: string): void {
	const validation = scanSkillContent(content);
	if (!validation.ok) {
		throw new Error(validation.error);
	}
}

function applyUniquePatch(content: string, find: string, replace: string): string {
	if (!find) {
		throw new Error("Patch requires a non-empty find string.");
	}
	const first = content.indexOf(find);
	if (first < 0) {
		throw new Error("Patch find string was not found.");
	}
	if (content.indexOf(find, first + find.length) >= 0) {
		throw new Error("Patch find string matched multiple locations.");
	}
	return `${content.slice(0, first)}${replace}${content.slice(first + find.length)}`;
}

export async function manageWorkspaceSkill(
	options: SkillManageToolOptions,
	request: SkillManageRequest,
): Promise<SkillManageResult> {
	const skillDir = resolveSkillPath(options.workspaceDir, request.name);
	const skillPath = join(skillDir, "SKILL.md");

	if (request.action === "create") {
		if (existsSync(skillPath)) {
			throw new Error(`Workspace skill "${request.name}" already exists.`);
		}
		const content = request.content ?? "";
		ensureSkillMarkdownSafe(content, request.name);
		await writeFileAtomically(skillPath, content);
		return {
			action: "create",
			name: request.name,
			path: toWorkspacePath(options, skillPath),
			bytesWritten: Buffer.byteLength(content, "utf-8"),
			requiresResourceRefresh: true,
			notice: `已沉淀：创建 workspace skill \`${request.name}\`。`,
		};
	}

	if (!existsSync(skillPath)) {
		throw new Error(`Workspace skill "${request.name}" does not exist.`);
	}

	if (request.action === "write_file") {
		if (!request.filePath) {
			throw new Error("write_file requires filePath.");
		}
		const content = request.content ?? "";
		const targetPath = resolveSkillSupportingFile(skillDir, request.filePath);
		ensureSupportingFileSafe(content);
		await writeFileAtomically(targetPath, content);
		return {
			action: "write_file",
			name: request.name,
			path: toWorkspacePath(options, targetPath),
			bytesWritten: Buffer.byteLength(content, "utf-8"),
			requiresResourceRefresh: true,
			notice: `已沉淀：更新 workspace skill \`${request.name}\` 的支持文件。`,
		};
	}

	const targetPath = request.filePath ? resolveSkillSupportingFile(skillDir, request.filePath) : skillPath;
	const original = await readFile(targetPath, "utf-8");
	const nextContent = applyUniquePatch(original, request.find ?? "", request.replace ?? "");
	if (targetPath === skillPath) {
		ensureSkillMarkdownSafe(nextContent, request.name);
	} else {
		ensureSupportingFileSafe(nextContent);
	}

	const tempPath = createAtomicTempPath(targetPath);
	await writeFileAtomically(targetPath, nextContent, tempPath);

	return {
		action: "patch",
		name: request.name,
		path: toWorkspacePath(options, targetPath),
		bytesWritten: Buffer.byteLength(nextContent, "utf-8"),
		requiresResourceRefresh: true,
		notice: `已沉淀：更新 workspace skill \`${request.name}\`。`,
	};
}

async function viewWorkspaceSkill(options: SkillManageToolOptions, name: string, filePath: string | undefined) {
	const skillDir = resolveSkillPath(options.workspaceDir, name);
	const targetPath = filePath ? resolveSkillSupportingFile(skillDir, filePath) : join(skillDir, "SKILL.md");
	const workspacePath = toWorkspacePath(options, targetPath);
	const content = await readFile(targetPath, "utf-8");

	// Cap with the shared truncation limits so a large supporting file cannot flood context.
	const truncation = truncateHead(content);
	let body = truncation.content;
	if (truncation.truncated) {
		body += `\n\n[Truncated at ${formatSize(DEFAULT_MAX_BYTES)}. Use the read tool on ${workspacePath} to page through the rest.]`;
	}
	return {
		content: [{ type: "text" as const, text: `Skill: ${name}\nPath: ${workspacePath}\n\n${body}` }],
		details: { kind: "skill_manage", action: "view", name, path: workspacePath, truncated: truncation.truncated },
	};
}

export function createSkillManageTool(options: SkillManageToolOptions): AgentTool<typeof skillManageSchema> {
	return {
		name: "skill_manage",
		label: "skill_manage",
		description:
			"Manage workspace-level Pipiclaw skills (procedural memory): list them, view one's contents, or author them " +
			"with create/patch/write_file. No channel-scoped skills.",
		parameters: skillManageSchema,
		execute: async (
			_toolCallId: string,
			args: {
				label: string;
				action: string;
				name?: string;
				content?: string;
				filePath?: string;
				find?: string;
				replace?: string;
			},
		) => {
			if (args.action === "list") {
				const skills = await listWorkspaceSkills(options);
				return {
					content: [{ type: "text", text: JSON.stringify({ skills }) }],
					details: { kind: "skill_manage", action: "list", count: skills.length },
				};
			}

			if (!args.name) {
				throw new Error(`Action "${args.action}" requires a skill name.`);
			}

			if (args.action === "view") {
				return viewWorkspaceSkill(options, args.name, args.filePath);
			}

			const result = await manageWorkspaceSkill(options, {
				action: parseWriteAction(args.action),
				name: args.name,
				content: args.content,
				filePath: args.filePath,
				find: args.find,
				replace: args.replace,
			});
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: { kind: "skill_manage", ...result },
			};
		},
	};
}
