import { renderSubcommandUsage } from "../commands/catalog.js";
import { capReply, flattenMarkdownForChat } from "../commands/reply-limits.js";
import { GuardBlockedError, renderGuardBlockForUser } from "../security/block-message.js";
import { loadSecurityConfigWithDiagnostics } from "../security/config.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { errorMessage } from "../shared/text-utils.js";
import { loadSkillFile, skillSourceLabel } from "./catalog.js";
import { loadPipiclawSkills } from "./loader.js";
import type { SkillDiagnostic, SkillOptions } from "./types.js";

/** Stateless disk inspection remains usable without an active session. */

export interface HandleSkillsCommandOptions extends Pick<SkillOptions, "sharedSkillsDir"> {
	args: string;
	workspaceDir: string;
	appHomeDir: string;
	channelId?: string;
}

type SkillsCommand = { action: "list" } | { action: "show"; name: string };

function usage(): string {
	return renderSubcommandUsage("skills");
}

/** Exported so `test/commands-subcommands.test.ts` can feed every broadcast example back through it. */
export function parseSkillsCommand(args: string): SkillsCommand {
	const trimmed = args.trim();
	if (!trimmed || trimmed.toLowerCase() === "list") return { action: "list" };
	const parts = trimmed.split(/\s+/);
	if (parts[0]?.toLowerCase() === "show") {
		if (!parts[1] || parts.length > 2) throw new Error("用法：/skills show <name>");
		return { action: "show", name: parts[1] };
	}
	throw new Error(`未知子命令 \`${parts[0]}\`。`);
}

function diagnosticForUser(
	diagnostic: SkillDiagnostic,
	skills: ReturnType<typeof loadPipiclawSkills>["skills"],
): string {
	const label = diagnostic.name ? `\`${diagnostic.name}\`` : "技能目录";
	const source = skillSourceLabel(diagnostic.source);
	if (diagnostic.type === "collision") {
		return `- ${label}（${source}）：同名版本已被覆盖；使用${skillSourceLabel(skills.find((skill) => skill.name === diagnostic.name)!.source)}版本。`;
	}
	const active = skills.find((skill) => skill.name === diagnostic.name);
	const status = diagnostic.rejected
		? `该版本未加载${active ? `；当前使用${skillSourceLabel(active.source)}版本` : ""}`
		: "格式提醒，仍可使用";
	return `- ${label}（${source}）：${status}。请检查${diagnostic.path ? ` \`${diagnostic.path}\`` : "目录权限或文件内容"}，修改后发送 \`/reload\`。`;
}

function listSkills(options: SkillOptions): string {
	const { skills, diagnostics } = loadPipiclawSkills(options);
	if (skills.length === 0 && diagnostics.length === 0) {
		return (
			"暂无技能。\n" +
			`让我帮你创建，或放到 \`${options.workspaceDir}/skills/<name>/SKILL.md\`；也支持 \`~/.agents/skills/\`。`
		);
	}
	const lines = [`**技能**（${skills.length} 个）· 用 \`/skill:<名称>\` 调用`, ""];
	for (const skill of skills) {
		lines.push(
			`- \`${skill.name}\`（${skillSourceLabel(skill.source)}${skill.disableModelInvocation ? "，仅显式调用" : ""}）— ${skill.description.replace(/\s+/g, " ")}`,
		);
	}
	if (diagnostics.length > 0) {
		lines.push("", "加载提醒", "", ...diagnostics.map((item) => diagnosticForUser(item, skills)));
	}
	return capReply(lines.join("\n"), {
		nextStepHint: "用 `/skills show <name>` 查看单个技能；外部修改后发送 `/reload` 更新当前会话",
	}).text;
}

async function showSkill(options: HandleSkillsCommandOptions, name: string): Promise<string> {
	try {
		const securityConfig = loadSecurityConfigWithDiagnostics(options.appHomeDir).config;
		const file = await loadSkillFile(
			{
				workspaceDir: options.workspaceDir,
				sharedSkillsDir: options.sharedSkillsDir,
				securityConfig,
				channelId: options.channelId,
			},
			name,
			true,
		);
		const body = `**Skill \`${file.name}\`**\n\n来源：${skillSourceLabel(file.source)}${file.loaded ? "" : "（未加载，仅供排错）"}\n\n路径：\`${file.path}\`\n\n${flattenMarkdownForChat(file.content)}`;
		return capReply(body, { nextStepHint: `完整内容在 \`${file.path}\`` }).text;
	} catch (error) {
		// The loader's errors are written for the model (`Use action "list"…`); say it in the user's terms.
		if (error instanceof RecoverableToolError) return `未找到 skill \`${name}\`。用 \`/skills\` 查看可用的 skill。`;
		if (error instanceof GuardBlockedError) return renderGuardBlockForUser(error.blocked);
		return `无法读取 skill \`${name}\`。请检查文件权限和内容后重试。`;
	}
}

export async function handleSkillsCommand(options: HandleSkillsCommandOptions): Promise<string> {
	let command: SkillsCommand;
	try {
		command = parseSkillsCommand(options.args);
	} catch (error) {
		return `${errorMessage(error)}\n\n${usage()}`;
	}

	switch (command.action) {
		case "list":
			return listSkills({
				workspaceDir: options.workspaceDir,
				sharedSkillsDir: options.sharedSkillsDir,
				securityConfig: loadSecurityConfigWithDiagnostics(options.appHomeDir).config,
			});
		case "show":
			return showSkill(options, command.name);
	}
}
