import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { createAtomicTempPath, writeFileAtomically } from "../shared/atomic-file.js";
import {
	resolveSkillPath,
	resolveSkillSupportingFile,
	scanSkillContent,
	validateSkillMarkdown,
} from "./skill-security.js";

const skillManageSchema = Type.Object({
	label: Type.String({ description: "Brief description of the skill management change (shown to user)" }),
	action: Type.String({ description: 'Supported actions: "create", "patch", or "write_file".' }),
	name: Type.String({ description: "Workspace skill name" }),
	content: Type.Optional(Type.String({ description: "Full content for create/write_file." })),
	filePath: Type.Optional(
		Type.String({
			description:
				"Optional supporting file path for patch/write_file. Defaults to SKILL.md for patch. Supporting files must be under references/, templates/, scripts/, or assets/.",
		}),
	),
	find: Type.Optional(Type.String({ description: "Exact text to replace when action is patch." })),
	replace: Type.Optional(Type.String({ description: "Replacement text when action is patch." })),
});

export type SkillManageAction = "create" | "patch" | "write_file";

export interface SkillManageResult {
	action: SkillManageAction;
	name: string;
	path: string;
	bytesWritten: number;
	requiresResourceRefresh: boolean;
	notice: string;
}

export interface SkillManageRequest {
	action: SkillManageAction;
	name: string;
	content?: string;
	filePath?: string;
	find?: string;
	replace?: string;
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

function parseAction(action: string): SkillManageAction {
	if (action === "create" || action === "patch" || action === "write_file") {
		return action;
	}
	throw new Error('Unsupported skill action. Use "create", "patch", or "write_file".');
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

export function createSkillManageTool(options: SkillManageToolOptions): AgentTool<typeof skillManageSchema> {
	return {
		name: "skill_manage",
		label: "skill_manage",
		description:
			"Create or update workspace-level Pipiclaw skills as procedural memory. Supports create, patch, and write_file only; no channel-scoped skills.",
		parameters: skillManageSchema,
		execute: async (
			_toolCallId: string,
			args: {
				label: string;
				action: string;
				name: string;
				content?: string;
				filePath?: string;
				find?: string;
				replace?: string;
			},
		) => {
			const result = await manageWorkspaceSkill(options, {
				action: parseAction(args.action),
				name: args.name,
				content: args.content,
				filePath: args.filePath,
				find: args.find,
				replace: args.replace,
			});
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: {
					kind: "skill_manage",
					...result,
				},
			};
		},
	};
}
