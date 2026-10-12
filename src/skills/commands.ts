import { renderSubcommandUsage } from "../commands/catalog.js";
import { capReply, flattenMarkdownForChat } from "../commands/reply-limits.js";
import { GuardBlockedError, renderGuardBlockForUser } from "../security/block-message.js";
import { loadSecurityConfigWithDiagnostics } from "../security/config.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { errorMessage } from "../shared/text-utils.js";
import { listWorkspaceSkills, loadWorkspaceSkillFile } from "./workspace.js";

/**
 * `/skills` — the human control path for a workspace's skill catalog (spec 045's read-only
 * `skill` tool has no channel-command counterpart until now). Mirrors `channel/commands.ts`'s
 * shape: pure-ish functions returning markdown, no bot/event coupling.
 *
 * Deliberately a disk scan via `listWorkspaceSkills`, not the live `ChannelRunner`'s already-
 * loaded catalog: that keeps `/skills` usable while a turn is streaming and for a channel with no
 * active runner, and — the whole reason this exists rather than reusing `/help`'s discovery tail
 * — it is the only place that shows a skill that failed the content scan and was silently dropped
 * from the prompt's skill list (`src/skills/loader.ts`).
 */

export interface HandleSkillsCommandOptions {
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

async function listSkills(workspaceDir: string): Promise<string> {
	const skills = await listWorkspaceSkills({ workspaceDir });
	if (skills.length === 0) {
		return (
			"暂无工作区 skill。\n" +
			`让我帮你创建，或手动放到 \`${workspaceDir}/skills/<name>/SKILL.md\`（文件头需要非空的 \`name\`，与目录名一致，以及 \`description\`）。`
		);
	}

	const loaded = skills.filter((skill) => !skill.warning);
	const rejected = skills.filter((skill) => skill.warning);

	const lines = [`**工作区 skills**（${loaded.length} 个）· 用 \`/skill:<名称>\` 调用`, ""];
	if (loaded.length > 0) {
		lines.push(...loaded.map((skill) => `- \`${skill.name}\` — ${skill.description || "（无 description）"}`));
	} else {
		lines.push("（全部未通过加载，见下）");
	}
	if (rejected.length > 0) {
		lines.push("", "⚠️ 未加载（助手看不到，也无法用 `/skill:名称` 调用）", "");
		lines.push(...rejected.map((skill) => `- \`${skill.name}\` — ${skill.warning}`));
	}
	return capReply(lines.join("\n"), { nextStepHint: "用 `/skills show <name>` 查看单个 skill 的完整正文" }).text;
}

async function showSkill(options: HandleSkillsCommandOptions, name: string): Promise<string> {
	try {
		const securityConfig = loadSecurityConfigWithDiagnostics(options.appHomeDir).config;
		const file = await loadWorkspaceSkillFile(
			{
				workspaceDir: options.workspaceDir,
				securityConfig,
				channelId: options.channelId,
			},
			name,
		);
		const body = `**Skill \`${file.name}\`**\n\n路径：\`${file.path}\`\n\n${flattenMarkdownForChat(file.content)}`;
		return capReply(body, { nextStepHint: `完整内容在 \`${file.path}\`` }).text;
	} catch (error) {
		// The loader's errors are written for the model (`Use action "list"…`); say it in the user's terms.
		if (error instanceof RecoverableToolError) return `未找到 skill \`${name}\`。用 \`/skills\` 查看可用的 skill。`;
		if (error instanceof GuardBlockedError) return renderGuardBlockForUser(error.blocked);
		return `无法读取 skill \`${name}\`：${errorMessage(error)}`;
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
			return listSkills(options.workspaceDir);
		case "show":
			return showSkill(options, command.name);
	}
}
